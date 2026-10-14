'use strict'

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const createTestnet = require('hyperdht/testnet')
const HyperswarmRPC = require('@hyperswarm/rpc')
const { createServer } = require('../../mock/server')
const createState = require('../../mock/state')
const keys = require('../../mock/keys')
const { startFoundryWorker, FOUNDRY_POOL } = require('../..')
const { ACTIONS, MESSAGE_TYPES, build, serialize, deserialize } = require('../../src/mdk').protocol
const { previousDay } = require('../../src/utils/dates')
const { GHS } = require('../../src/constants')

for (const credential of [keys.apiKey, keys.pat]) {
  const label = credential.startsWith('fdpat_') ? 'personal access token' : 'sub-account API key'
  test(`worker serves telemetry over HRPC with a ${label}`, { timeout: 60000 }, async t => {
    const testnet = await createTestnet(3, t.teardown)
    const mock = await createServer({ port: 0, workerCount: 4 })
    t.teardown(() => mock.app.close())
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-foundry-test-'))
    t.teardown(() => fs.rmSync(storeDir, { recursive: true, force: true }))

    const worker = await startFoundryWorker({
      workerId: 'foundry-test',
      rack: 'test',
      storeDir,
      root: storeDir,
      bootstrap: testnet.bootstrap,
      conf: { foundry: { apiUrl: mock.apiUrl, accounts: [{ name: keys.subAccount, apiKey: credential }] } }
    })
    t.teardown(() => worker.stop())
    worker.pool._logErr = () => {}

    const rpc = new HyperswarmRPC({ bootstrap: testnet.bootstrap })
    t.teardown(() => rpc.destroy())
    const send = async query => {
      const envelope = build({
        type: MESSAGE_TYPES.REQUEST,
        sender: 'kernel:kernel:test',
        action: ACTIONS.TELEMETRY_PULL,
        deviceId: 'foundry-test',
        payload: { query }
      })
      return deserialize(await rpc.request(worker.runtime.getPublicKey(), 'mdk', serialize(envelope)))
    }

    const initial = await send({ type: 'metrics' })
    t.ok(initial.payload.metrics.hashrate.error.includes('E_POOL_API'), 'no fabricated startup zeros')

    const now = new Date()
    await worker.pool.fetchWorkers(now)
    await worker.pool.fetchStats(now)
    await worker.pool.fetchTransactions(now)

    const { metrics } = (await send({ type: 'metrics' })).payload
    const state = mock.accounts[keys.subAccount]
    t.is(metrics.hashrate, state.stats.hashrate5minAvg * GHS)
    t.is(metrics.workers_online, 4)
    t.is(metrics.balance, state.balance.balance)
    t.ok(metrics.estimated_earnings > 0)

    const ext = await send({ type: 'ext_data', key: 'stats' })
    t.is(ext.payload.extData.stats[0].poolType, 'foundry')
    t.is(ext.payload.extData.stats[0].yearlyBalances.length, 12)

    const workers = await worker.pool.getWorkers({})
    t.is(workers.workers.length, 4)
    t.is(workers.workers[0].poolType, 'foundry')

    const { start, end } = previousDay(now)
    const transactions = await worker.pool.getWrkExtData({ query: { key: 'transactions', start, end } })
    t.ok(transactions[0].transactions.length >= 1)
    t.ok(transactions[0].transactions.every(tx => tx.username === keys.subAccount))
  })
}

test('a rejected credential fails the poll and keeps metrics unavailable', { timeout: 60000 }, async t => {
  const mock = await createServer({
    port: 0,
    accounts: { one: createState({ name: 'one', workerCount: 1 }), two: createState({ name: 'two', workerCount: 1 }) },
    apiKeys: { one: 'key-one', two: 'key-two' }
  })
  t.teardown(() => mock.app.close())
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-foundry-bad-'))
  t.teardown(() => fs.rmSync(storeDir, { recursive: true, force: true }))
  const logged = []
  const pool = new FOUNDRY_POOL(
    { foundry: { apiUrl: mock.apiUrl, accounts: [{ name: 'one', apiKey: 'key-one' }, { name: 'two', apiKey: 'wrong' }] } },
    { rack: 'test', root: storeDir, storeDir }
  )
  pool._logErr = (msg, detail) => logged.push(`${msg} ${detail}`)
  t.teardown(() => new Promise(resolve => pool.stop(resolve)))
  await pool.init()
  await t.exception(pool.fetchStats(new Date()), /ERR_FOUNDRY_ACCOUNT two: .*403 AUTH \(Invalid API key\)/)
  t.ok(logged.some(line => line.startsWith('ERR_FOUNDRY_ACCOUNT two')))
  t.exception(() => pool.getMetric('hashrate'), /E_POOL_API/)
})

test('stopping the pool aborts an in-flight HTTP request and removes signal listeners', { timeout: 30000 }, async t => {
  let received
  const requestReceived = new Promise(resolve => { received = resolve })
  const server = http.createServer(() => received())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-foundry-stop-'))
  t.teardown(() => fs.rmSync(storeDir, { recursive: true, force: true }))

  const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }
  const pool = new FOUNDRY_POOL(
    { foundry: { apiUrl: `http://127.0.0.1:${server.address().port}`, accounts: ['a'], apiKey: 'k' } },
    { rack: 'test', root: storeDir, storeDir }
  )
  pool._logErr = () => {}
  await pool.init()
  t.is(process.listenerCount('SIGINT'), before.int + 1)

  // Register the expectation before stop() rejects the poll, or Node reports
  // the rejection as unhandled in the window before the assertion attaches.
  const aborted = t.exception(pool.fetchStats(new Date()), /abort/i)
  await requestReceived
  await new Promise(resolve => pool.stop(resolve))
  await aborted
  t.is(process.listenerCount('SIGINT'), before.int)
  t.is(process.listenerCount('SIGTERM'), before.term)
})

'use strict'

const test = require('brittle')
const FoundryPool = require('../../src/pool')
const { FOUNDRY_POOL } = require('../..')
const { GHS, STATS_MAX_AGE_MS, POOL_TYPE } = require('../../src/constants')
const { monthKey } = require('../../src/utils/dates')
const { FoundryApiError } = require('../../src/errors')

const ACCT = {
  name: 'sub1',
  activeWorkers: 2,
  offline15MinWorkerCount: 1,
  offline24HrWorkerCount: 3,
  hashrate5minAvg: 100,
  hashrate15minAvg: 110,
  hashrate1hrAvg: 120,
  hashrate24hrAvg: 130,
  stale1hrAvg: 4,
  reject1hrAvg: 2,
  lastShareTime: '2024-06-28T14:49:05.000+00:00'
}
const BAL = { balance: '0.5', totalEarned: 10, totalWithdrawn: 9.5, totalPoolFees: 0.2 }
const EARNING = { startTime: '2024-06-27T00:00:00.000+00:00', totalAmount: 0.01, hashrate: 65 }

function makeDb () {
  const puts = []
  return { puts, put: async (k, v) => puts.push(JSON.parse(v.toString())) }
}

// A pool wired for unit tests: no facilities, a fake API, silent logging.
function newPool (accounts = [{ name: 'sub1', apiKey: 'k1' }], api = {}) {
  const pool = new FoundryPool({ foundry: { accounts } }, { rack: 'r1' })
  pool._logErr = () => {}
  pool.accounts = accounts.map(a => ({ name: a.name, credential: a.apiKey }))
  pool.foundryApi = {
    getSubAccountStats: async () => ACCT,
    getBalance: async () => BAL,
    getEarnings: async () => [EARNING],
    getWorkers: async () => [],
    getTransactions: async () => [],
    ...api
  }
  pool.workersCountDb = makeDb()
  pool.transactionsDb = makeDb()
  pool.data.workersData = { ts: Date.now(), workers: [{ username: 'sub1' }, { username: 'sub1' }, { username: 'other' }] }
  return pool
}

test('index exports the pool class, boot and plugin', t => {
  t.is(FOUNDRY_POOL, FoundryPool)
  t.is(typeof require('../..').startFoundryWorker, 'function')
  t.is(typeof require('../..').plugin.connect, 'function')
})

test('wtype defaults to foundry and the http url to the production API', t => {
  const pool = new FoundryPool({ foundry: { accounts: ['a'], apiKey: 'k' } }, { rack: 'r1' })
  t.is(pool.wtype, POOL_TYPE)
  t.is(pool.getHttpUrl(), 'https://api.pool.foundrydigital.com')
  t.is(new FoundryPool({ foundry: { apiUrl: 'https://api.example.test' } }, { rack: 'r' }).getHttpUrl(), 'https://api.example.test')
  t.is(pool.appendPoolType([{}])[0].poolType, 'foundry')
})

test('fetchStats builds a stats row per account in H/s and BTC', async t => {
  const credentials = []
  const pool = newPool(undefined, {
    getSubAccountStats: async (u, c) => { credentials.push(c); return ACCT },
    // The 12-month ledger call spans more than the 3-day latest-earnings call.
    getEarnings: async (u, c, start, end) => (end - start > 4 * 86400000
      ? [{ startTime: new Date(end - 86400000).toISOString(), totalAmount: 0.01 }, { startTime: new Date(start).toISOString(), totalAmount: 0.2 }]
      : [EARNING])
  })
  const time = new Date()
  await pool.fetchStats(time)
  t.alike(credentials, ['k1'])
  t.is(pool.data.statsData.ts, Math.floor(time.getTime() / 1000) * 1000)
  const [s] = pool.data.statsData.stats
  t.is(s.username, 'sub1')
  t.is(s.balance, 0.5)
  t.is(s.unsettled, null)
  t.is(s.hashrate, 100 * GHS)
  t.is(s.hashrate_15m, 110 * GHS)
  t.is(s.hashrate_1h, 120 * GHS)
  t.is(s.hashrate_24h, 130 * GHS)
  t.is(s.hashrate_stale_1h, 4 * GHS)
  t.is(s.hashrate_stale_24h, null)
  t.is(s.hashrate_reject_1h, 2 * GHS)
  t.is(s.worker_count, 2)
  t.is(s.active_workers_count, 2)
  t.is(s.offline_workers_count, 4)
  t.is(s.revenue_24h, 0.01)
  t.is(s.estimated_today_income, 0.01 * (130 / 65))
  t.is(s.total_earned, 10)
  t.is(s.total_withdrawn, 9.5)
  t.is(s.total_pool_fees, 0.2)
  t.is(s.last_share_time, Date.UTC(2024, 5, 28, 14, 49, 5))
  t.is(s.yearlyBalances.length, 12)
  t.is(s.yearlyBalances[0].month, monthKey(time))
  t.is(s.yearlyBalances[0].balance, 0.01)
  t.is(s.yearlyBalances[11].balance, 0.2)
  t.is(pool.getMetric('hashrate'), 100 * GHS)
  t.is(pool.getMetric('balance'), 0.5)
})

test('worker_count is null until the first workers poll', async t => {
  const pool = newPool()
  pool.data.workersData = { ts: 0, workers: [] }
  await pool.fetchStats(new Date())
  t.is(pool.data.statsData.stats[0].worker_count, null)
  t.is(pool.getMetric('active_workers_count'), 2, 'active workers come from the stats endpoint and stay live')
})

test('estimated income falls back to the settled amount without a hashrate ratio', async t => {
  const pool = newPool(undefined, { getEarnings: async () => [{ startTime: '2024-06-27T00:00:00.000+00:00', totalAmount: 0.01 }] })
  await pool.fetchStats(new Date())
  t.is(pool.data.statsData.stats[0].estimated_today_income, 0.01)
  const empty = newPool(undefined, { getEarnings: async () => [] })
  await empty.fetchStats(new Date())
  t.is(empty.data.statsData.stats[0].revenue_24h, 0)
  t.is(empty.data.statsData.stats[0].estimated_today_income, 0)
  t.is(FoundryPool.estimateTodayIncome({ revenue: 1, hashrate: 50 }, 100), 2)
  t.is(FoundryPool.estimateTodayIncome({ revenue: 1, hashrate: 0 }, 100), 1)
})

test('fetchStats fails the whole poll when one account fails, naming it, and metrics go E_POOL_API', async t => {
  const pool = newPool([{ name: 'good', apiKey: 'k' }, { name: 'bad', apiKey: 'k' }], {
    getSubAccountStats: async (u) => { if (u === 'bad') throw new Error('ERR_FOUNDRY_API /subaccount_stats/bad 403 AUTH (Invalid API key)'); return ACCT }
  })
  await pool.fetchStats(new Date())
    .then(() => t.fail('should throw'), err => {
      t.ok(/ERR_FOUNDRY_ACCOUNT bad: .*Invalid API key/.test(err.message), err.message)
    })
  t.alike(pool.data.statsData, {}, 'no partial snapshot published')
  t.exception(() => pool.getMetric('hashrate'), /E_POOL_API/)

  // A clean poll clears the error.
  pool.foundryApi.getSubAccountStats = async () => ACCT
  await pool.fetchStats(new Date())
  t.is(pool.getMetric('hashrate'), 200 * GHS)
})

test('a credential without financial access keeps hashrate and nulls the money fields', async t => {
  const denied = path => { throw new FoundryApiError(path, 403, 'AUTH', 'Forbidden') }
  const logs = []
  const pool = newPool(undefined, {
    getBalance: async () => denied('/balance/sub1'),
    getEarnings: async () => denied('/v2/earnings/sub1'),
    getTransactions: async () => denied('/transactions/sub1')
  })
  pool._logErr = (...args) => logs.push(args.join(' '))

  await pool.fetchStats(new Date())
  const [s] = pool.data.statsData.stats
  t.is(s.hashrate, 100 * GHS)
  t.is(s.active_workers_count, 2)
  t.is(s.balance, null)
  t.is(s.revenue_24h, null)
  t.is(s.estimated_today_income, null)
  t.is(s.total_earned, null)
  t.is(s.total_withdrawn, null)
  t.is(s.total_pool_fees, null)
  t.alike(s.yearlyBalances, [])
  t.is(s.financial_access, false)
  t.is(pool.getMetric('hashrate'), 100 * GHS, 'hashrate telemetry still answers')
  t.exception(() => pool.getMetric('balance'), /E_POOL_API: Foundry balance is unavailable/)
  t.exception(() => pool.getMetric('estimated_today_income'), /E_POOL_API/)
  t.is((await pool.getWrkExtData({ query: { key: 'stats' } })).error, null, 'the poll counts as clean')

  await pool.fetchStats(new Date())
  t.is(logs.length, 1, 'the refusal is logged once, not every minute')
  t.ok(/WARN_FOUNDRY_FINANCIAL sub1/.test(logs[0]), logs[0])

  await pool.fetchTransactions(new Date(Date.UTC(2024, 5, 28, 0, 0, 5)))
  t.alike(pool.transactionsDb.puts[0].transactions, [], 'the daily ledger stores an empty day')

  // Access restored: the flag clears and the figures come back.
  pool.foundryApi.getBalance = async () => BAL
  pool.foundryApi.getEarnings = async () => [EARNING]
  await pool.fetchStats(new Date())
  t.is(pool.data.statsData.stats[0].balance, 0.5)
  t.is(pool.data.statsData.stats[0].financial_access, true)

  // Only an AUTH refusal is tolerated; any other money-endpoint failure still fails the poll.
  pool.foundryApi.getBalance = async () => { throw new FoundryApiError('/balance/sub1', 500, 'SERVER') }
  await t.exception(pool.fetchStats(new Date()), /ERR_FOUNDRY_ACCOUNT sub1: .*500 SERVER/)
  const plain = newPool(undefined, { getBalance: async () => { throw new Error('ERR_FOUNDRY_API /balance/sub1 403 AUTH') } })
  await t.exception(plain.fetchStats(new Date()), /ERR_FOUNDRY_ACCOUNT sub1/, 'a non-client error is never read as a scope refusal')
})

test('fetchStats rejects a malformed field instead of recording zero', async t => {
  const pool = newPool(undefined, { getBalance: async () => ({ ...BAL, balance: undefined }) })
  await t.exception(pool.fetchStats(new Date()), /ERR_FOUNDRY_DATA balance.balance/)
  const bad = newPool(undefined, { getSubAccountStats: async () => ({ ...ACCT, hashrate5minAvg: 'n/a' }) })
  await t.exception(bad.fetchStats(new Date()), /ERR_FOUNDRY_DATA stats.hashrate5minAvg/)
})

test('getMetric refuses an empty, failed or stale snapshot and a missing field', async t => {
  const pool = newPool()
  t.exception(() => pool.getMetric('hashrate'), /E_POOL_API/, 'before the first poll')
  await pool.fetchStats(new Date())
  t.is(pool.getMetric('active_workers_count'), 2)
  pool.data.statsData.stats[0].balance = null
  t.exception(() => pool.getMetric('balance'), /E_POOL_API: Foundry balance is unavailable/)
  pool.data.statsData.ts = Date.now() - STATS_MAX_AGE_MS - 1
  t.exception(() => pool.getMetric('hashrate'), /unavailable or stale/)
})

test('yearly balances are cached per account and refreshed on month rollover', async t => {
  const calls = []
  const pool = newPool([{ name: 'a', apiKey: 'ka' }, { name: 'b', apiKey: 'kb' }], {
    getEarnings: async (u, c, start, end) => {
      calls.push(u)
      return [{ startTime: new Date(start).toISOString(), totalAmount: u === 'a' ? 1 : 2 }]
    }
  })
  const june = new Date(Date.UTC(2024, 5, 15))
  const a = await pool.getYearlyBalances('a', 'ka', june)
  const b = await pool.getYearlyBalances('b', 'kb', june)
  t.is(a[11].balance, 1, 'oldest month holds account a figure')
  t.is(b[11].balance, 2, 'account b has its own history, not a cached copy of a')
  t.is(a[0].balance, 0)
  await pool.getYearlyBalances('a', 'ka', june)
  t.alike(calls, ['a', 'b'], 'second call for a served from cache')
  await pool.getYearlyBalances('a', 'ka', new Date(Date.UTC(2024, 6, 1)))
  t.alike(calls, ['a', 'b', 'a'], 'month rollover refetches')
})

test('fetchWorkers merges accounts, saves the count, and fails whole on one bad account', async t => {
  const pool = newPool([{ name: 'a', apiKey: 'k' }, { name: 'b', apiKey: 'k' }], {
    getWorkers: async (u) => [{ workerId: `${u}-1`, hashrate_5m: 1, hashrate_15m: 1, hashrate_1h: 1, lastShareTime: new Date().toISOString() }]
  })
  const time = new Date()
  await pool.fetchWorkers(time)
  t.is(pool.data.workersData.workers.length, 2)
  t.alike(pool.data.workersData.workers.map(w => w.username), ['a', 'b'])
  t.alike(pool.workersCountDb.puts, [{ ts: Math.floor(time.getTime() / 1000) * 1000, count: 2 }])

  pool.foundryApi.getWorkers = async (u) => { if (u === 'b') throw new Error('ERR_FOUNDRY_API /workers/b 404 NOT_FOUND'); return [] }
  await t.exception(pool.fetchWorkers(new Date()), /ERR_FOUNDRY_ACCOUNT b/)
  t.is(pool.data.workersData.workers.length, 2, 'previous list kept')
})

test('fetchTransactions stores the previous UTC day with satoshis for credits only', async t => {
  const pool = newPool(undefined, {
    getTransactions: async (u, c, start, end) => [
      { time: '2024-06-27T01:00:00.000+00:00', amount: 0.001, type: 'FPPS', txId: null },
      { time: '2024-06-27T12:00:00.000+00:00', amount: -0.0005, type: 'WITHDRAWAL', txId: 'abc', address: 'bc1q' },
      { time: '2024-06-28T00:00:00.000+00:00', amount: 9, type: 'FPPS' }
    ]
  })
  await pool.fetchTransactions(new Date(Date.UTC(2024, 5, 28, 0, 0, 5)))
  const [saved] = pool.transactionsDb.puts
  t.is(saved.ts, Date.UTC(2024, 5, 27))
  t.is(saved.transactions.length, 2, 'the row on the next day is excluded')
  t.alike(saved.transactions[0], {
    username: 'sub1', id: null, type: 'FPPS', changed_balance: 0.001, created_at: Date.UTC(2024, 5, 27, 1) / 1000, satoshis_net_earned: 100000, address: null
  })
  t.is(saved.transactions[1].id, 'abc')
  t.is(saved.transactions[1].satoshis_net_earned, 0)
  t.is(saved.transactions[1].address, 'bc1q')
})

test('hourly revenue aggregation works on stored transactions', async t => {
  const pool = newPool()
  const day = Date.UTC(2024, 5, 27)
  pool.transactionsDb = {
    createReadStream: () => (async function * () {
      yield { value: Buffer.from(JSON.stringify({ ts: day, transactions: [{ satoshis_net_earned: 240000 }] })) }
    })()
  }
  const res = await pool.getWrkExtData({ query: { key: 'transactions', start: day, end: day + 86400000, aggrHourly: true } })
  t.is(res.hourlyRevenues.length, 24)
  t.is(res.hourlyRevenues[0].revenue, 0.0001)
})

test('overlapping ticks share one in-flight poll', async t => {
  let n = 0
  const pool = newPool(undefined, {
    getSubAccountStats: async () => { n++; await new Promise(resolve => setTimeout(resolve, 20)); return ACCT }
  })
  await Promise.all([pool.fetchStats(new Date()), pool.fetchStats(new Date())])
  t.is(n, 1)
  await pool.fetchStats(new Date())
  t.is(n, 2)
})

test('hashrate-history validates bounds and maps rows per account; pool-stats maps pool-wide figures', async t => {
  const pool = newPool(undefined, {
    getHashrateHour: async (u, c, start, end) => [{ unixTime: start, hashrateAccepted: 10, hashrateStale: 1, hashrateRejected: null, averageWorkers: null }],
    getHashrateDay: async (u, c, start, end) => [{ time: `${start}T00:00:00.000+00:00`, hashrateAccepted: 20, averageWorkers: 3 }],
    getPoolStats: async () => ({ activeWorkers: 5, hashrate5minAvg: 1, hashrate1hrAvg: 2, hashrate24hrAvg: 3, stale1hrAvg: 0.5, lastShareTime: '2024-06-28 14:49:05.0' })
  })
  await t.exception(pool.getWrkExtData({ query: { key: 'hashrate-history', end: 2 } }), /ERR_START_INVALID/)
  await t.exception(pool.getWrkExtData({ query: { key: 'hashrate-history', start: 1 } }), /ERR_END_INVALID/)
  await t.exception(pool.getWrkExtData({ query: { key: 'hashrate-history', start: 1, end: 2, interval: 'week' } }), /ERR_INTERVAL_INVALID/)
  const hour = await pool.getWrkExtData({ query: { key: 'hashrate-history', start: 1000, end: 2000 } })
  t.is(hour.interval, 'hour')
  t.alike(hour.accounts[0].hashrates[0], { ts: 1000, hashrate: 10 * GHS, hashrate_stale: GHS, hashrate_rejected: null, average_workers: null })
  const day = await pool.getWrkExtData({ query: { key: 'hashrate-history', start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 0, 3), interval: 'day' } })
  t.is(day.accounts[0].hashrates[0].ts, Date.UTC(2024, 0, 1))
  t.is(day.accounts[0].hashrates[0].average_workers, 3)
  const ps = await pool.getWrkExtData({ query: { key: 'pool-stats' } })
  t.is(ps.poolType, 'foundry')
  t.is(ps.hashrate, GHS)
  t.is(ps.hashrate_reject_1h, null)
  t.is(ps.last_share_time, Date.UTC(2024, 5, 28, 14, 49, 5))
  const projected = await pool.getWrkExtData({ query: { key: 'pool-stats', fields: { hashrate: 1 } } })
  t.alike(Object.keys(projected), ['hashrate'])
})

test('stats ext_data appends the pool type and reports the last poll error', async t => {
  const pool = newPool()
  await pool.fetchStats(new Date())
  const data = await pool.getWrkExtData({ query: { key: 'stats' } })
  t.is(data.stats[0].poolType, 'foundry')
  t.is(data.error, null)

  pool.foundryApi.getBalance = async () => { throw new Error('ERR_FOUNDRY_API /balance/sub1 403 AUTH') }
  await t.exception(pool.fetchStats(new Date()), /ERR_FOUNDRY_ACCOUNT sub1/)
  const held = await pool.getWrkExtData({ query: { key: 'stats' } })
  t.is(held.stats.length, 1, 'last good snapshot is held')
  t.ok(/403 AUTH/.test(held.error), 'and flagged')
})

test('saveStats writes nothing while the snapshot is failed or empty', async t => {
  const pool = newPool()
  const puts = []
  pool.statsDb = { put: async (k, v) => puts.push(JSON.parse(v.toString())) }
  await pool.saveStats(new Date())
  t.is(puts.length, 0, 'before the first poll')
  await pool.fetchStats(new Date())
  await pool.saveStats(new Date())
  t.is(puts.length, 1)
  t.is(puts[0].stats.length, 1)
  pool.foundryApi.getBalance = async () => { throw new Error('boom') }
  await pool.fetchStats(new Date()).catch(() => {})
  await pool.saveStats(new Date())
  t.is(puts.length, 1, 'nothing written for a failed poll')
})

test('hashrate-history rejects a null row and a malformed unixTime', async t => {
  const nullRow = newPool(undefined, { getHashrateHour: async () => [null] })
  await t.exception(nullRow.getWrkExtData({ query: { key: 'hashrate-history', start: 1, end: 2 } }), /ERR_FOUNDRY_DATA hashrate.row/)
  const badTs = newPool(undefined, { getHashrateHour: async () => [{ unixTime: 'soon', hashrateAccepted: 1 }] })
  await t.exception(badTs.getWrkExtData({ query: { key: 'hashrate-history', start: 1, end: 2 } }), /ERR_FOUNDRY_DATA hashrate.unixTime/)
  const strTs = newPool(undefined, { getHashrateHour: async () => [{ unixTime: '1700000000000', hashrateAccepted: 1 }] })
  const ok = await strTs.getWrkExtData({ query: { key: 'hashrate-history', start: 1, end: 2 } })
  t.is(ok.accounts[0].hashrates[0].ts, 1700000000000, 'a numeric string timestamp is parsed, not passed through')
})

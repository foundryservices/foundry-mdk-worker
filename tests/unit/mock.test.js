'use strict'

const test = require('brittle')
const { createServer } = require('../../mock/server')
const keys = require('../../mock/keys')

test('mock enforces the Foundry auth gate with its status codes and envelopes', async t => {
  const { app, apiUrl } = await createServer({ port: 0, workerCount: 3 })
  t.teardown(() => app.close())
  const get = (path, headers = {}) => fetch(`${apiUrl}${path}`, { headers })

  const pub = await get('/pool_stats')
  t.is(pub.status, 200)

  const noKey = await get('/subaccount_stats/test')
  t.is(noKey.status, 403)
  t.is((await noKey.json()).message, 'Not authenticated')

  const badKey = await get('/subaccount_stats/test', { 'X-API-KEY': 'wrong' })
  t.is(badKey.status, 403)
  t.is((await badKey.json()).message, 'Invalid API key')

  const badPat = await get('/subaccount_stats/test', { Authorization: 'Bearer fdpat_wrong' })
  t.is(badPat.status, 401)

  const ok = await get('/subaccount_stats/test', { 'X-API-KEY': keys.apiKey })
  t.is(ok.status, 200)
  t.is((await ok.json()).name, 'test')

  const pat = await get('/workers/test', { Authorization: `Bearer ${keys.pat}` })
  t.is(pat.status, 200)
  t.is((await pat.json()).workersList.length, 3)

  const unknown = await get('/balance/nope', { 'X-API-KEY': keys.apiKey })
  t.is(unknown.status, 404)
})

test('a technician key authenticates but is refused on the money routes', async t => {
  const { app, apiUrl } = await createServer({ port: 0, workerCount: 1 })
  t.teardown(() => app.close())
  const get = path => fetch(`${apiUrl}${path}`, { headers: { 'X-API-KEY': keys.technicianKey } })
  t.is((await get('/subaccount_stats/test')).status, 200)
  t.is((await get('/workers/test')).status, 200)
  t.is((await get('/subaccount_hashrate_hour/test')).status, 200)
  for (const path of ['/balance/test', '/v2/earnings/test', '/earnings/test', '/transactions/test']) {
    const res = await get(path)
    t.is(res.status, 403, path)
    t.is((await res.json()).message, 'API key provided does not have permission to view payments.', path)
  }
  t.is((await get('/balance/nope')).status, 404, 'unknown sub-account still wins over scope')
})

test('the mock meters requests per credential and answers 429 with the rate-limit headers', async t => {
  const { app, apiUrl } = await createServer({ port: 0, workerCount: 1, rateLimit: 2 })
  t.teardown(() => app.close())
  const get = key => fetch(`${apiUrl}/subaccount_stats/test`, { headers: { 'X-API-KEY': key } })
  const first = await get(keys.apiKey)
  t.is(first.status, 200)
  t.is(first.headers.get('x-ratelimit-limit'), '2')
  t.is(first.headers.get('x-ratelimit-remaining'), '1')
  t.ok(Number(first.headers.get('x-ratelimit-reset')) * 1000 > Date.now(), 'reset is a future unix-seconds timestamp')
  t.is((await get(keys.apiKey)).status, 200)
  const third = await get(keys.apiKey)
  t.is(third.status, 429)
  t.is(third.headers.get('x-ratelimit-remaining'), '0')
  t.is((await third.json()).message, 'Rate limit exceeded')
  t.is((await get(keys.technicianKey)).status, 200, 'another credential has its own window')
  t.is((await fetch(`${apiUrl}/pool_stats`)).status, 200, 'public routes are not metered')
})

test('a key issued for another sub-account is forbidden; a PAT sees every account', async t => {
  const createState = require('../../mock/state')
  const { app, apiUrl } = await createServer({
    port: 0,
    accounts: { one: createState({ name: 'one', workerCount: 1 }), two: createState({ name: 'two', workerCount: 2 }) },
    apiKeys: { one: 'key-one', two: 'key-two' },
    pats: ['fdpat_x']
  })
  t.teardown(() => app.close())
  const get = (path, headers) => fetch(`${apiUrl}${path}`, { headers })
  t.is((await get('/balance/two', { 'X-API-KEY': 'key-one' })).status, 403)
  t.is((await get('/balance/one', { 'X-API-KEY': 'key-one' })).status, 200)
  t.is((await get('/balance/two', { Authorization: 'Bearer fdpat_x' })).status, 200)
  const err = await get('/balance/one', { 'X-API-KEY': 'key-one' }).then(() => createServer({ port: 0, error: true }))
  t.teardown(() => err.app.close())
  t.is((await fetch(`${err.apiUrl}/pool_stats`)).status, 500)
})

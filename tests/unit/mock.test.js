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

'use strict'

const test = require('brittle')
const FoundryApi = require('../../src/api/client')

function makeHttp (handler) {
  const calls = []
  return {
    calls,
    get: async (url, opts) => {
      calls.push({ url: new URL(url), opts })
      return { body: await handler(url, opts, calls.length) }
    }
  }
}

test('validateConfig rejects an unsupported coin or a URL with extras', t => {
  t.exception(() => new FoundryApi({}, { coin: 'LTC' }), /ERR_FOUNDRY_COIN_UNSUPPORTED/)
  t.exception(() => new FoundryApi({}, { apiUrl: 'ftp://x' }), /ERR_FOUNDRY_API_URL_INVALID/)
  t.exception(() => new FoundryApi({}, { apiUrl: 'https://u:p@x.io' }), /ERR_FOUNDRY_API_URL_INVALID/)
  t.exception(() => new FoundryApi({}, { apiUrl: 'https://x.io/?a=1' }), /ERR_FOUNDRY_API_URL_INVALID/)
  t.ok(new FoundryApi({}, { apiUrl: 'https://api.example.test/' }))
})

test('getSubAccountStats builds the URL with coin, sends the credential header and no redirects', async t => {
  const http = makeHttp(async () => ({ name: 'sub1', hashrate5minAvg: 10 }))
  const api = new FoundryApi(http, { apiUrl: 'https://api.example/', requestIntervalMs: 0 })
  const res = await api.getSubAccountStats('sub 1', 'key-1')
  t.is(res.name, 'sub1')
  const [{ url, opts }] = http.calls
  t.is(url.pathname, '/subaccount_stats/sub%201')
  t.is(url.searchParams.get('coin'), 'BTC')
  t.is(opts.headers['X-API-KEY'], 'key-1')
  t.is(opts.headers.Authorization, undefined)
  t.is(opts.encoding, 'json')
  t.is(opts.redirect, false)
  t.is(opts.timeout, 30000)
})

test('an fdpat_ credential is sent as Authorization: Bearer', async t => {
  const http = makeHttp(async () => ({}))
  const api = new FoundryApi(http, { requestIntervalMs: 0 })
  await api.getBalance('sub1', 'fdpat_abc')
  t.is(http.calls[0].opts.headers.Authorization, 'Bearer fdpat_abc')
  t.is(http.calls[0].opts.headers['X-API-KEY'], undefined)
})

test('getPoolStats sends no credential', async t => {
  const http = makeHttp(async () => ({ activeWorkers: 1 }))
  const api = new FoundryApi(http, { requestIntervalMs: 0 })
  t.is((await api.getPoolStats()).activeWorkers, 1)
  t.is(http.calls[0].url.pathname, '/pool_stats')
  t.is(http.calls[0].opts.headers['X-API-KEY'], undefined)
  t.is(http.calls[0].opts.headers.Authorization, undefined)
})

test('getWorkers disables paging and validates the list; ranged endpoints pass bounds', async t => {
  const http = makeHttp(async (url) => {
    const { pathname } = new URL(url)
    if (pathname.startsWith('/workers/')) return { workersList: [{ workerId: 1 }], totalWorkerCount: 1 }
    if (pathname.startsWith('/subaccount_hashrate_day/')) return []
    return []
  })
  const api = new FoundryApi(http, { requestIntervalMs: 0 })
  t.is((await api.getWorkers('s', 'k')).length, 1)
  t.is(http.calls[0].url.searchParams.get('pageSize'), '-1')
  t.is(http.calls[0].url.searchParams.get('status'), 'all')
  await api.getEarnings('s', 'k', 1000, 2000)
  t.is(http.calls[1].url.pathname, '/v2/earnings/s')
  t.is(http.calls[1].url.searchParams.get('startDateUnixMs'), '1000')
  t.is(http.calls[1].url.searchParams.get('endDateUnixMs'), '2000')
  await api.getTransactions('s', 'k', 1, 2)
  t.is(http.calls[2].url.pathname, '/transactions/s')
  await api.getHashrateHour('s', 'k', 1, 2)
  t.is(http.calls[3].url.pathname, '/subaccount_hashrate_hour/s')
  await api.getHashrateDay('s', 'k', '2024-01-01', '2024-01-31')
  t.is(http.calls[4].url.searchParams.get('start'), '2024-01-01')
  t.is(http.calls[4].url.searchParams.get('end'), '2024-01-31')
})

test('a payload of the wrong shape is a FoundryApiError, not a silent empty', async t => {
  const http = makeHttp(async () => ({ nope: true }))
  const api = new FoundryApi(http, { requestIntervalMs: 0 })
  await t.exception(api.getWorkers('s', 'k'), /ERR_FOUNDRY_API \/workers\/s 200 INVALID_WORKERS/)
  await t.exception(api.getEarnings('s', 'k', 1, 2), /INVALID_RESPONSE/)
  const nullHttp = makeHttp(async () => null)
  await t.exception(new FoundryApi(nullHttp, { requestIntervalMs: 0 }).getBalance('s', 'k'), /INVALID_RESPONSE/)
})

test('transport errors carry status, a code and the API message but no headers', async t => {
  const err = Object.assign(new Error('ERR_HTTP: 403 - Forbidden'), {
    status: 403,
    headers: { 'x-api-key': 'secret' },
    response: JSON.stringify({ status: 403, error: '403 FORBIDDEN', message: 'Invalid API key' })
  })
  const http = makeHttp(async () => { throw err })
  const api = new FoundryApi(http, { requestIntervalMs: 0 })
  try {
    await api.getBalance('s', 'secret')
    t.fail('should throw')
  } catch (e) {
    t.is(e.status, 403)
    t.is(e.code, 'AUTH')
    t.is(e.detail, 'Invalid API key')
    t.is(e.path, '/balance/s')
    t.absent(e.headers)
    t.absent(String(e.message).includes('secret'))
  }
  const codes = []
  for (const status of [401, 404, 429, 500, 0]) {
    const h = makeHttp(async () => { throw Object.assign(new Error('x'), { status }) })
    await new FoundryApi(h, { requestIntervalMs: 0 }).getBalance('s', 'k').catch(e => codes.push(e.code))
  }
  t.alike(codes, ['AUTH', 'NOT_FOUND', 'RATE_LIMITED', 'SERVER', 'REQUEST_FAILED'])
  const refused = makeHttp(async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  const e1 = await new FoundryApi(refused, { requestIntervalMs: 0 }).getBalance('s', 'k').catch(e => e)
  t.is(e1.detail, 'ECONNREFUSED')
  const timedOut = makeHttp(async () => { throw Object.assign(new Error('network timeout'), { type: 'request-timeout' }) })
  const e2 = await new FoundryApi(timedOut, { requestIntervalMs: 0 }).getBalance('s', 'k').catch(e => e)
  t.is(e2.detail, 'request-timeout')
})

test('a worker list shorter than the reported total is rejected as truncated', async t => {
  const http = makeHttp(async () => ({ workersList: [{ workerId: 1 }], totalWorkerCount: 2 }))
  const api = new FoundryApi(http, { requestIntervalMs: 0 })
  await t.exception(api.getWorkers('s', 'k'), /TRUNCATED_WORKERS/)
  const noTotal = makeHttp(async () => ({ workersList: [{ workerId: 1 }] }))
  t.is((await new FoundryApi(noTotal, { requestIntervalMs: 0 }).getWorkers('s', 'k')).length, 1)
})

test('requests are serialized through one queue and spaced by the interval', async t => {
  const starts = []
  const http = makeHttp(async () => {
    starts.push(Date.now())
    await new Promise(resolve => setTimeout(resolve, 5))
    return {}
  })
  const api = new FoundryApi(http, { requestIntervalMs: 40 })
  await Promise.all([api.getBalance('a', 'k'), api.getBalance('b', 'k'), api.getBalance('c', 'k')])
  t.is(starts.length, 3)
  t.ok(starts[1] - starts[0] >= 35, `spaced ${starts[1] - starts[0]}ms`)
  t.ok(starts[2] - starts[1] >= 35, `spaced ${starts[2] - starts[1]}ms`)
  t.alike(http.calls.map(c => c.url.pathname), ['/balance/a', '/balance/b', '/balance/c'])
})

test('a failed request does not stall the queue', async t => {
  let n = 0
  const http = makeHttp(async () => {
    if (++n === 1) throw Object.assign(new Error('boom'), { status: 500 })
    return { ok: true }
  })
  const api = new FoundryApi(http, { requestIntervalMs: 0 })
  await t.exception(api.getBalance('a', 'k'), /SERVER/)
  t.is((await api.getBalance('b', 'k')).ok, true)
})

test('an aborted signal surfaces as the abort, not as a transport error', async t => {
  const controller = new AbortController()
  const http = makeHttp(async () => { controller.abort(); throw new Error('socket hang up') })
  const api = new FoundryApi(http, { requestIntervalMs: 0, signal: controller.signal })
  await t.exception(api.getBalance('a', 'k'), /abort/i)
})

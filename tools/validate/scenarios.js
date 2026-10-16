'use strict'

// Time-window and failure scenarios with a fake clock. A replay server answers
// with crafted API responses for each edge case, the real worker polls it at
// the scenario's time, and the output is judged by the independent expected
// values plus the README's explicit promises. Run by
// tests/integration/scenarios.test.js.

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { expectedFor } = require('./expected')
const { compare } = require('./compare')

const DAY = 86400000
const SUB = 'scn'
const iso = ms => new Date(ms).toISOString().replace('Z', '+00:00')
const U = s => Date.parse(s)

// ---- API state builders (shapes from the public OpenAPI spec)
const stats = (t, over = {}) => ({
  name: SUB,
  activeWorkers: 2,
  offline15MinWorkerCount: 1,
  offline24HrWorkerCount: 1,
  offline24HrTo1WkWorkerCount: 0,
  offline1WkWorkerCount: 1,
  hashrate5minAvg: 250000,
  hashrate15minAvg: 249000,
  stale15minAvg: 100,
  reject15minAvg: 10,
  hashrate1hrAvg: 248000,
  hashrate24hrAvg: 220000,
  stale1hrAvg: 90,
  reject1hrAvg: 9,
  lastShareTime: iso(t - 5000),
  updatedAt: iso(t),
  fcmOptIn: false,
  isActive: true,
  ...over
})
const worker = (id, lastShareMs, ghs) => ({
  workerId: String(id),
  workerName: `w${id}`,
  hashrate_5m: ghs,
  hashrate_15m: ghs,
  stale_15m: 0,
  stale15mPercent: 0.1,
  reject_15m: 0,
  reject15mPercent: 0.01,
  rejectDetail_15m: '{}',
  hashrate_1h: ghs,
  stale_1h: 1,
  reject_1h: 0,
  rejectDetail_1h: '{}',
  lastShareTime: iso(lastShareMs),
  updatedAt: iso(lastShareMs),
  tag: 'Untagged'
})
const workers = t => ({
  workersList: [worker(1, t - 60000, 125000), worker(2, t - 120000, 125000), worker(3, t - 3600000, 0), worker(4, t - 9 * DAY, 0)],
  totalWorkerCount: 4
})
const balance = { balance: 0.0123, totalEarned: 1.5, totalFCMFees: 0, totalDebits: 0, totalPoolFees: 0.03, totalWithdrawn: 1.4877, totalOptifleetFees: 0 }
const fpps = (dayStart, amount, ghs) => ({
  startTime: iso(dayStart),
  endTime: iso(dayStart + DAY - 1),
  totalAmount: amount,
  hashrate: ghs,
  ppsBaseAmount: amount * 0.9,
  txFeeRewardAmount: amount * 0.12,
  fppsRatePercent: 113.33,
  poolFeeAmount: amount * 0.02,
  feeRatePercent: 2,
  grossEarnings: amount * 1.02,
  payoutSchema: 'FPPS'
})
const zeroFilled = dayStart => ({ ...fpps(dayStart, 0, 0), ppsBaseAmount: 0, txFeeRewardAmount: 0, fppsRatePercent: 0, poolFeeAmount: 0, grossEarnings: 0, payoutSchema: null })

const D = U('2026-10-17T00:00:00Z') // "today" in most scenarios; yesterday = D - DAY
const PROMISE = (what, got, want) => ({ what, got, want, ok: typeof want === 'number' ? Math.abs(got - want) < 1e-12 : got === want })

const SCENARIOS = [
  {
    id: 'S1',
    title: '00:30 UTC, before the daily earnings run: revenue_24h shows the day before yesterday',
    t: D + 30 * 60000,
    // The API leaves yesterday out of its zero-fill until the earnings run.
    earnings: () => [fpps(D - 2 * DAY, 0.00045, 210000), fpps(D - 3 * DAY, 0.00044, 205000)],
    promises: a => [PROMISE('revenue_24h = day-before-yesterday amount', a.stats[0].revenue_24h, 0.00045)]
  },
  {
    id: 'S2',
    title: 'earnings run late: yesterday is a zero-filled row, revenue_24h = 0',
    t: D + 2 * 3600000,
    earnings: () => [zeroFilled(D - DAY), fpps(D - 2 * DAY, 0.00045, 210000), fpps(D - 3 * DAY, 0.00044, 205000)],
    promises: a => [PROMISE('revenue_24h = 0 while the run is late', a.stats[0].revenue_24h, 0), PROMISE('estimated_today_income = 0', a.stats[0].estimated_today_income, 0)]
  },
  {
    id: 'S3',
    title: 'normal day: revenue_24h = yesterday, estimate scaled by the 24h hashrate',
    t: D + 2 * 3600000,
    earnings: () => [fpps(D - DAY, 0.0005, 200000), fpps(D - 2 * DAY, 0.00045, 210000), fpps(D - 3 * DAY, 0.00044, 205000)],
    promises: a => [PROMISE('revenue_24h = yesterday', a.stats[0].revenue_24h, 0.0005), PROMISE('estimate = revenue × 24h hashrate / settled hashrate', a.stats[0].estimated_today_income, 0.0005 * 220000 / 200000)]
  },
  {
    id: 'S4',
    title: 'month rollover: the last day of a month counts toward that month',
    t: U('2026-11-01T02:00:00Z'),
    earnings: () => [fpps(U('2026-10-31T00:00:00Z'), 0.0006, 200000), fpps(U('2026-10-30T00:00:00Z'), 0.0005, 200000), fpps(U('2026-10-29T00:00:00Z'), 0.0004, 200000)],
    year: () => [fpps(U('2026-10-31T00:00:00Z'), 0.0006, 200000), fpps(U('2026-10-30T00:00:00Z'), 0.0005, 200000), fpps(U('2025-12-01T00:00:00Z'), 0.0003, 200000), fpps(U('2025-11-30T00:00:00Z'), 0.0009, 200000)],
    promises: (a) => {
      const yb = a.stats[0].yearlyBalances
      return [
        PROMISE('12 months', yb.length, 12),
        PROMISE('newest month is the current one, still 0', JSON.stringify(yb[0]), JSON.stringify({ month: '11-2026', balance: 0 })),
        PROMISE('previous month includes its last day', yb[1].balance, 0.0011),
        PROMISE('oldest month is 11 months back; earlier days excluded', JSON.stringify(yb[11]), JSON.stringify({ month: '12-2025', balance: 0.0003 }))
      ]
    }
  },
  {
    id: 'S5',
    title: 'withdrawal created 23:59:30, confirmed 00:00:10: it stays in the day it was created',
    t: D + 30000,
    transactions: () => [
      { time: iso(D - DAY + 3600000 + 1000), broadcastTime: null, amount: 0.0005, type: 'FPPS', description: 'FPPS', txId: null, address: null },
      { time: iso(D + 10000), broadcastTime: iso(D - 30000), amount: -0.01, type: 'Auto-Withdraw', description: 'Auto-Withdraw', txId: 'ab'.repeat(32), address: 'bc1qexampleexampleexampleexampleexample00' }
    ],
    promises: a => [PROMISE('withdrawal kept in the day it was created', a.transactions.some(tx => tx.type === 'Auto-Withdraw'), true)]
  },
  {
    id: 'S6',
    title: 'worker list shorter than totalWorkerCount: TRUNCATED_WORKERS fails the workers poll',
    t: D + 2 * 3600000,
    workers: t => ({ ...workers(t), totalWorkerCount: 10 }),
    promises: a => [PROMISE('workers error mentions TRUNCATED_WORKERS', /TRUNCATED_WORKERS/.test(a.errors.workers || ''), true)]
  },
  {
    id: 'S7',
    title: 'malformed field (hashrate5minAvg null): the stats poll fails',
    t: D + 2 * 3600000,
    stats: t => stats(t, { hashrate5minAvg: null }),
    promises: a => [PROMISE('stats error is ERR_FOUNDRY_DATA stats.hashrate5minAvg', /ERR_FOUNDRY_DATA stats\.hashrate5minAvg/.test(a.errors.stats || ''), true)]
  },
  {
    id: 'S8',
    title: 'invalid key answered with 401: the poll fails with AUTH',
    t: D + 2 * 3600000,
    fail: { path: `/subaccount_stats/${SUB}`, status: 401, message: 'Invalid API key' },
    promises: a => [PROMISE('error is "401 AUTH (Invalid API key)"', /401 AUTH \(Invalid API key\)/.test(a.errors.stats || ''), true)]
  },
  {
    id: 'S9',
    title: 'expired key (401 "API key expired"): the poll fails with AUTH',
    t: D + 2 * 3600000,
    fail: { path: `/subaccount_stats/${SUB}`, status: 401, message: 'API key expired' },
    promises: a => [PROMISE('error is "401 AUTH (API key expired)"', /401 AUTH \(API key expired\)/.test(a.errors.stats || ''), true)]
  },
  {
    id: 'S10',
    title: '429 with x-ratelimit-reset 2 s out: the worker waits, retries and the poll succeeds',
    t: D + 2 * 3600000,
    rateLimitOnce: `/subaccount_stats/${SUB}`,
    promises: (a, records) => [
      PROMISE('first /subaccount_stats answered 429, then retried', records.filter(r => r.path === `/subaccount_stats/${SUB}`).map(r => r.status).join(','), '429,200'),
      PROMISE('stats poll succeeded', a.errors.stats === undefined, true)
    ]
  }
]

function startReplay (scenario) {
  const records = []
  let limited = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://replay')
    const q = Object.fromEntries(url.searchParams)
    const p = url.pathname
    const t = scenario.t
    const headers = { 'x-ratelimit-limit': '300', 'x-ratelimit-remaining': '299', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) }
    let status = 200
    let body
    if (scenario.fail && p === scenario.fail.path) {
      status = scenario.fail.status
      body = { timestamp: new Date().toISOString(), status, error: 'Unauthorized', message: scenario.fail.message, path: p }
    } else if (scenario.rateLimitOnce === p && !limited) {
      limited = true
      status = 429
      headers['x-ratelimit-remaining'] = '0'
      headers['x-ratelimit-reset'] = String(Math.ceil(Date.now() / 1000) + 2)
      body = { timestamp: new Date().toISOString(), status, error: 'Too Many Requests', message: 'Rate limit exceeded', path: p }
    } else if (p === `/subaccount_stats/${SUB}`) {
      body = (scenario.stats || stats)(t)
    } else if (p === `/workers/${SUB}`) {
      body = (scenario.workers || workers)(t)
    } else if (p === `/balance/${SUB}`) {
      body = balance
    } else if (p === `/v2/earnings/${SUB}`) {
      const latestWindow = Number(q.endDateUnixMs) - Number(q.startDateUnixMs) <= 7 * DAY
      const latest = scenario.earnings ? scenario.earnings() : [fpps(D - DAY, 0.0005, 200000)]
      body = latestWindow ? latest : (scenario.year ? scenario.year() : latest)
    } else if (p === `/transactions/${SUB}`) {
      body = scenario.transactions ? scenario.transactions() : []
    } else if (p === `/subaccount_hashrate_hour/${SUB}` || p === `/subaccount_hashrate_day/${SUB}`) {
      body = []
    } else if (p === '/pool_stats') {
      body = { activeWorkers: 1, hashrate5minAvg: 1, hashrate15minAvg: 1, stale15minAvg: 0, reject15minAvg: 0, hashrate1hrAvg: 1, hashrate24hrAvg: 1, stale1hrAvg: 0, reject1hrAvg: 0, lastShareTime: '2026-10-17 00:00:00.0', updatedAt: '2026-10-17 00:00:00.0' }
    } else {
      status = 404
      body = { message: 'Sub-account not found', path: p }
    }
    records.push({ ts: Date.now(), ms: 0, method: req.method, path: p, query: q, status, bytes: 0, credential: 'key:scenario', headers, body })
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    records,
    close: () => new Promise(resolve => server.close(resolve))
  })))
}

/**
 * Runs one scenario against the worker class given (the package's FOUNDRY_POOL).
 * @returns {Promise<{ promises: object[], drift: object[], errors: object }>}
 */
async function runScenario (FoundryPool, scenario) {
  const replay = await startReplay(scenario)
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-scenario-'))
  const pool = new FoundryPool({ foundry: { apiUrl: replay.url, accounts: [{ name: SUB, apiKey: 'scenario-key' }] } }, { rack: 'scn', root: storeDir, storeDir })
  pool._logErr = () => {}
  const errors = {}
  const attempt = async (name, fn) => { try { return await fn() } catch (err) { errors[name] = err.message; return null } }
  try {
    await pool.init()
    for (const key of ['1m', '5m', '1D']) pool.scheduler_0.del(key)
    const now = new Date(scenario.t)
    await attempt('workers', () => pool.fetchWorkers(now))
    await attempt('stats', () => pool.fetchStats(now))
    await attempt('transactions', () => pool.fetchTransactions(now))
    const dayStart = Math.floor(scenario.t / DAY) * DAY - DAY
    const txExt = await attempt('ext transactions', () => pool.getWrkExtData({ query: { key: 'transactions', start: dayStart, end: dayStart + DAY } }))
    const actual = {
      errors,
      stats: errors.stats ? null : pool.data.statsData.stats,
      workers: errors.workers ? null : pool.data.workersData.workers,
      transactions: Array.isArray(txExt) && txExt[0] ? txExt[0].transactions : []
    }
    const expected = expectedFor({ records: replay.records, accounts: [SUB], t0: scenario.t })
    // Metrics go stale against the real clock and history is not exercised here;
    // a section is only judged when its poll succeeded.
    const drift = errors.stats || errors.workers
      ? []
      : compare({ ...expected, metrics: null, hashrateHour: null, hashrateDay: null, poolStats: null }, { ...actual, metrics: null, hashrateHour: null, hashrateDay: null, poolStats: null })
        .filter(section => section.mismatches.length)
    return { promises: scenario.promises(actual, replay.records), drift, errors }
  } finally {
    await new Promise(resolve => pool.stop(resolve))
    await replay.close()
    fs.rmSync(storeDir, { recursive: true, force: true })
  }
}

module.exports = { SCENARIOS, runScenario }

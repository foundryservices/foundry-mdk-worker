'use strict'

// Expected worker output, derived only from recorded API responses and the
// behaviour the README and mdk-contract.json promise. It deliberately shares
// no code with src/: a bug copied into both sides would otherwise pass.

const GHS = 1e9
const DAY = 86400000
const ONLINE_WINDOW_MS = 15 * 60 * 1000

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return undefined
}
const optional = v => (v === null || v === undefined || v === '' ? null : num(v))
const hs = (v) => { const n = num(v); return n === undefined ? undefined : n * GHS }
const optionalHs = (v) => { const n = optional(v); return n === null || n === undefined ? n : n * GHS }

// ISO with offset on most endpoints, JDBC "YYYY-MM-DD HH:MM:SS.f" (UTC) on pool_stats.
const parseTime = (v) => {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s)
  return Number.isFinite(ms) ? ms : undefined
}
const optionalTime = v => (v === null || v === undefined || v === '' ? null : parseTime(v))

const utcDayStart = ms => Math.floor(ms / DAY) * DAY
const monthKey = (ms) => { const d = new Date(ms); return `${d.getUTCMonth() + 1}-${d.getUTCFullYear()}` }
const isoDay = ms => new Date(ms).toISOString().slice(0, 10)

/** The windows the README promises, relative to the poll time t0 (ms). */
function windows (t0) {
  const d = new Date(t0)
  const today = utcDayStart(t0)
  return {
    // "stores the transactions of the day that just ended, keyed by that day's UTC start"
    previousDay: { start: today - DAY, end: today },
    // "earnings per month for the current month and the eleven before it"
    year: {
      start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1),
      end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
      months: Array.from({ length: 12 }, (_, i) => monthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)))
    },
    hour: { start: t0 - DAY, end: t0 },
    day: { start: t0 - 7 * DAY, end: t0 }
  }
}

/**
 * @param {object} opts
 * @param {object[]} opts.records  recorded API calls (see proxy.js)
 * @param {string[]} opts.accounts sub-account names, in configuration order
 * @param {number} opts.t0         poll time (ms) the worker was given
 */
function expectedFor ({ records, accounts, t0 }) {
  const w = windows(t0)
  const forPath = path => records.filter(r => r.path === path)
  const last = (path, pred = () => true) => forPath(path).filter(pred).at(-1)
  const checks = []
  const note = (account, check, ok, detail) => checks.push({ account, check, ok, detail })

  const statsRows = []
  const workerRows = []
  const txRows = []
  const hourAccounts = []
  const dayAccounts = []

  for (const name of accounts) {
    const p = encodeURIComponent(name)
    const stats = last(`/subaccount_stats/${p}`)
    const balance = last(`/balance/${p}`)
    const earnings = forPath(`/v2/earnings/${p}`)
    const latestCall = earnings.find(r => Number(r.query.endDateUnixMs) === t0)
    const yearCall = earnings.find(r => Number(r.query.startDateUnixMs) === w.year.start)
    const workers = last(`/workers/${p}`)
    const tx = last(`/transactions/${p}`)

    // --- the requests themselves match what the README says the worker asks for
    note(name, 'requested /subaccount_stats', Boolean(stats && stats.status === 200), stats && stats.status)
    note(name, 'requested /workers for the online workers (pageSize=-1, status=online<15min)', Boolean(workers && workers.query.pageSize === '-1' && workers.query.status === 'online<15min'), workers && workers.query)
    note(name, 'requested /v2/earnings for the latest settled day (window ends at poll time)', Boolean(latestCall), latestCall && `${isoDay(Number(latestCall.query.startDateUnixMs))}..now`)
    note(name, 'requested /v2/earnings for the current month and the 11 before', Boolean(yearCall && Number(yearCall.query.endDateUnixMs) === w.year.end), yearCall && yearCall.query)
    note(name, 'requested /transactions for the previous UTC day', Boolean(tx && Number(tx.query.startDateUnixMs) === w.previousDay.start && Number(tx.query.endDateUnixMs) === w.previousDay.end), tx && tx.query)

    const financial = Boolean(balance && balance.status === 200)
    const s = stats ? stats.body : {}

    // --- stats row (README "Telemetry" and the field list)
    const latestRows = financial && latestCall && Array.isArray(latestCall.body) ? latestCall.body : []
    let latest = null
    for (const row of latestRows) {
      if (!latest || parseTime(row.startTime) > parseTime(latest.startTime)) latest = row
    }
    const revenue = financial ? (latest ? num(latest.totalAmount) : 0) : null
    const hashrate24h = hs(s.hashrate24hrAvg)
    const settledHs = latest ? optionalHs(latest.hashrate) : null
    // "revenue_24h adjusted for your hashrate now ... Without a hashrate to compare, it equals revenue_24h"
    const estimate = !financial ? null : (settledHs > 0 && hashrate24h > 0 ? revenue * (hashrate24h / settledHs) : revenue)

    let yearlyBalances = []
    if (financial && yearCall && Array.isArray(yearCall.body)) {
      const totals = new Map(w.year.months.map(m => [m, 0]))
      for (const row of yearCall.body) {
        const m = monthKey(parseTime(row.startTime))
        if (totals.has(m)) totals.set(m, totals.get(m) + num(row.totalAmount))
      }
      yearlyBalances = Array.from(totals, ([month, value]) => ({ month, balance: value }))
    }

    const off15 = optional(s.offline15MinWorkerCount)
    const off24 = optional(s.offline24HrWorkerCount)
    const list = workers && workers.body && Array.isArray(workers.body.workersList) ? workers.body.workersList : null

    statsRows.push({
      username: name,
      balance: financial ? num(balance.body.balance) : null,
      unsettled: null,
      revenue_24h: revenue,
      estimated_today_income: estimate,
      hashrate: hs(s.hashrate5minAvg),
      hashrate_15m: hs(s.hashrate15minAvg),
      hashrate_1h: hs(s.hashrate1hrAvg),
      hashrate_24h: hashrate24h,
      hashrate_stale_1h: optionalHs(s.stale1hrAvg),
      hashrate_stale_24h: null,
      hashrate_reject_1h: optionalHs(s.reject1hrAvg),
      // "every worker the pool knows ... active_workers_count plus offline_workers_count"
      worker_count: off15 === null && off24 === null ? null : num(s.activeWorkers) + (off15 || 0) + (off24 || 0),
      active_workers_count: num(s.activeWorkers),
      offline_workers_count: off15 === null && off24 === null ? null : (off15 || 0) + (off24 || 0),
      last_share_time: optionalTime(s.lastShareTime),
      total_earned: financial ? num(balance.body.totalEarned) : null,
      total_withdrawn: financial ? num(balance.body.totalWithdrawn) : null,
      total_pool_fees: financial ? num(balance.body.totalPoolFees) : null,
      yearlyBalances,
      financial_access: financial
    })

    // --- worker rows ("a share in the last 15 minutes"; every hashrate in H/s)
    if (list) {
      let onlineAtPoll = 0
      for (const wk of list) {
        const lastShare = optionalTime(wk.lastShareTime)
        const online = lastShare !== null && t0 - lastShare <= ONLINE_WINDOW_MS ? 1 : 0
        onlineAtPoll += online
        workerRows.push({
          username: name,
          id: String(wk.workerId),
          name: typeof wk.workerName === 'string' && wk.workerName ? wk.workerName : String(wk.workerId),
          online,
          last_updated: optionalTime(wk.updatedAt) ?? lastShare,
          last_share_time: lastShare,
          hashrate: hs(wk.hashrate_5m),
          hashrate_15m: hs(wk.hashrate_15m),
          hashrate_1h: hs(wk.hashrate_1h),
          hashrate_24h: null,
          hashrate_stale_1h: optionalHs(wk.stale_1h),
          hashrate_stale_24h: null,
          hashrate_reject_1h: optionalHs(wk.reject_1h),
          stale_15m_percent: optional(wk.stale15mPercent),
          reject_15m_percent: optional(wk.reject15mPercent),
          tag: typeof wk.tag === 'string' ? wk.tag : ''
        })
      }
      // API-level consistency, not worker behaviour
      const active = num(s.activeWorkers)
      // The two requests are seconds apart, so a worker can cross the 15-minute line in between.
      note(name, 'API: online workers returned ≈ activeWorkers (±1%)', Math.abs(list.length - active) <= Math.max(2, active * 0.01), `${list.length} vs ${active}`)
      note(name, 'API: workers online at poll time (15 min) ≈ activeWorkers (±1%)', Math.abs(onlineAtPoll - active) <= Math.max(2, active * 0.01), `${onlineAtPoll} vs ${active}`)
      note(name, 'API: totalWorkerCount = rows returned', workers.body.totalWorkerCount === list.length, `${workers.body.totalWorkerCount} vs ${list.length}`)
    }

    // --- transactions of the previous UTC day, each dated by its creation
    // ("A withdrawal belongs to the day it was created")
    if (financial && tx && Array.isArray(tx.body)) {
      for (const r of tx.body) {
        const created = optionalTime(r.broadcastTime) ?? parseTime(r.time)
        if (created < w.previousDay.start || created >= w.previousDay.end) continue
        txRows.push({
          username: name,
          id: typeof r.txId === 'string' && r.txId ? r.txId : null,
          type: typeof r.type === 'string' ? r.type : 'unknown',
          changed_balance: num(r.amount),
          created_at: Math.floor(created / 1000),
          satoshis_net_earned: num(r.amount) > 0 ? Math.round(num(r.amount) * 1e8) : 0,
          address: typeof r.address === 'string' ? r.address : null
        })
      }
    }

    // --- API-level: balance identity and zero-filled earnings days
    if (financial) {
      const b = balance.body
      const identity = num(b.totalEarned) - num(b.totalWithdrawn) - num(b.totalDebits)
      note(name, 'API: balance = totalEarned - totalWithdrawn - totalDebits', Math.abs(identity - num(b.balance)) < 5e-9, `${identity.toFixed(8)} vs ${num(b.balance)}`)
      const zeroFilled = latestRows.filter(r => r.payoutSchema === null).length
      note(name, 'info: zero-filled (payoutSchema null) rows in the latest-day window', true, `${zeroFilled} of ${latestRows.length}; latest settled day ${latest ? isoDay(parseTime(latest.startTime)) : 'none'}`)
    }

    // --- hashrate history
    const mapHistory = rows => (Array.isArray(rows) ? rows : []).map(r => ({
      ts: optional(r.unixTime) ?? parseTime(r.time),
      hashrate: hs(r.hashrateAccepted),
      hashrate_stale: optionalHs(r.hashrateStale),
      hashrate_rejected: optionalHs(r.hashrateRejected),
      average_workers: optional(r.averageWorkers)
    }))
    const hour = last(`/subaccount_hashrate_hour/${p}`)
    const day = last(`/subaccount_hashrate_day/${p}`)
    if (hour) hourAccounts.push({ username: name, poolType: 'foundry', hashrates: mapHistory(hour.body) })
    if (day) dayAccounts.push({ username: name, poolType: 'foundry', hashrates: mapHistory(day.body) })
    if (day) note(name, 'requested /subaccount_hashrate_day with YYYY-MM-DD bounds', day.query.start === isoDay(w.day.start) && day.query.end === isoDay(w.day.end), day.query)
  }

  // --- the four MDK metrics: sums across sub-accounts, E_POOL_API if any is missing
  const sum = field => statsRows.some(r => !Number.isFinite(r[field])) ? 'E_POOL_API' : statsRows.reduce((a, r) => a + r[field], 0)
  const metrics = {
    hashrate: sum('hashrate'),
    workers_online: sum('active_workers_count'),
    balance: sum('balance'),
    estimated_earnings: sum('estimated_today_income')
  }

  const ps = last('/pool_stats')
  const poolStats = ps && ps.body && typeof ps.body === 'object'
    ? {
        poolType: 'foundry',
        active_workers_count: num(ps.body.activeWorkers),
        hashrate: hs(ps.body.hashrate5minAvg),
        hashrate_1h: hs(ps.body.hashrate1hrAvg),
        hashrate_24h: hs(ps.body.hashrate24hrAvg),
        hashrate_stale_1h: optionalHs(ps.body.stale1hrAvg),
        hashrate_reject_1h: optionalHs(ps.body.reject1hrAvg),
        last_share_time: optionalTime(ps.body.lastShareTime)
      }
    : null

  return {
    windows: w,
    metrics,
    stats: statsRows,
    workers: workerRows,
    transactions: txRows,
    hashrateHour: { interval: 'hour', accounts: hourAccounts },
    hashrateDay: { interval: 'day', accounts: dayAccounts },
    poolStats,
    checks
  }
}

module.exports = { expectedFor, windows }

'use strict'

const { PoolService } = require('./mdk')
const FoundryApi = require('./api/client')
const { DataError, FoundryApiError } = require('./errors')
const { parseAccounts } = require('./utils/accounts')
const { toNumber, toOptionalNumber, ghsToHs, optionalGhsToHs, btcToSats } = require('./utils/numbers')
const { toTimestamp, toOptionalTimestamp, dateString, monthKey, previousDay, getMonthlyDateRanges } = require('./utils/dates')
const { getWorkersStats } = require('./utils/workers')
const {
  POOL_TYPE, DEFAULT_API_URL, DAY_MS, HISTORY_TTL_MS, STATS_MAX_AGE_MS, REQUEST_INTERVAL_MS, EARNINGS_LOOKBACK_DAYS
} = require('./constants')

const DAILY_JOB = '1D'

const toSecondTs = time => Math.floor(time.getTime() / 1000) * 1000

/**
 * @typedef {Object} AccountStats
 * @property {string} username           sub-account name
 * @property {number} timestamp          ms when the snapshot was taken
 * @property {number|null} balance       BTC, unpaid credited balance; null without financial access
 * @property {null} unsettled            the API does not expose pending credits
 * @property {number|null} revenue_24h   BTC credited for the latest settled UTC day; null without financial access
 * @property {number|null} estimated_today_income  revenue_24h scaled by today's 24h hashrate; null without financial access
 * @property {number} hashrate           H/s, 5 minute average
 * @property {number} hashrate_15m       H/s
 * @property {number} hashrate_1h        H/s
 * @property {number} hashrate_24h       H/s
 * @property {number|null} hashrate_stale_1h   H/s
 * @property {null} hashrate_stale_24h   not published
 * @property {number|null} hashrate_reject_1h  H/s
 * @property {number|null} worker_count  workers known to the pool (last workers poll), null before the first
 * @property {number} active_workers_count     workers with a share in the last 15 minutes
 * @property {number|null} offline_workers_count  offline15MinWorkerCount + offline24HrWorkerCount; the API's
 *                                            24h figure already includes the week-plus buckets
 * @property {number|null} last_share_time     ms
 * @property {number|null} total_earned  BTC, lifetime; null without financial access
 * @property {number|null} total_withdrawn  BTC, lifetime; null without financial access
 * @property {number|null} total_pool_fees  BTC, lifetime; null without financial access
 * @property {MonthlyBalance[]} yearlyBalances  empty without financial access
 * @property {boolean} financial_access  false when the credential is refused on the balance,
 *                                       earnings or transaction endpoints (a technician key)
 */

/**
 * @typedef {Object} MonthlyBalance
 * @property {string} month   "M-YYYY"
 * @property {number} balance BTC credited in that month
 */

/**
 * @typedef {Object} Transaction
 * @property {string} username
 * @property {string|null} id            blockchain txId, null for credits
 * @property {string} type               Foundry's own type (FPPS, Auto-Withdraw, ...)
 * @property {number} changed_balance    BTC, negative for debits
 * @property {number} created_at         unix seconds; for a confirmed withdrawal, its creation, not its confirmation
 * @property {number} satoshis_net_earned  credits in satoshis, 0 for debits
 * @property {string|null} address       payout address for debits
 */

/**
 * Foundry USA Pool worker.
 *
 * Every request is spaced by the client's rate limiter, so a full stats cycle
 * for one sub-account takes about a second. Three mechanisms keep that from
 * piling up:
 *  - `FoundryApi` serializes all HTTP calls through one queue;
 *  - `_dedupe` makes overlapping scheduler ticks share one in-flight job;
 *  - `_history` caches the twelve-month earnings history per sub-account.
 *
 * A poll either completes for every configured sub-account or fails: a
 * rejected key or an unknown sub-account fails the poll, the failure names
 * the sub-account, and the metrics answer E_POOL_API until a clean poll.
 * A total summed over the sub-accounts that happened to work would be a
 * number nobody can act on.
 *
 * The one tolerated partial result is a credential without financial access
 * (a technician API key): the stats call succeeds, then /balance, /v2/earnings
 * and /transactions answer 403. The poll keeps the hashrate and worker
 * figures, reports the money fields as null, flags `financial_access: false`,
 * and logs the refusal once per sub-account. The balance and earnings
 * metrics answer E_POOL_API for that account; nothing is summed as zero.
 *
 * Blocks are not fetched: the Foundry /blocks endpoint needs an admin
 * credential, which a customer credential never has.
 */
class FoundryPool extends PoolService {
  constructor (conf, ctx) {
    super({ ...conf, wtype: conf?.wtype || POOL_TYPE }, ctx)
    this._inFlight = new Map()
    this._history = new Map()
    this._statsError = null
    this._financialDenied = new Set()
  }

  async init () {
    if (this._initialized) {
      return
    }

    try {
      await super.init(POOL_TYPE)
      this._scheduleDailyJobInUtc()
    } catch (err) {
      await new Promise(resolve => this.stop(resolve))
      throw err
    }
  }

  /**
   * PoolService schedules the daily job in local time. Foundry settles and
   * ledgers per UTC day, so the job must fire at UTC midnight.
   */
  _scheduleDailyJobInUtc () {
    this.scheduler_0.del(DAILY_JOB)
    this.scheduler_0.add(
      DAILY_JOB,
      time => this.fetchData(DAILY_JOB, time),
      { rule: '0 0 0 * * *', tz: 'Etc/UTC' }
    )
  }

  async _createFacilities (ctx) {
    const config = this.conf.foundry || {}

    this.accounts = parseAccounts(config)
    FoundryApi.validateConfig(config)

    await super._createFacilities(ctx)

    this.foundryApi = new FoundryApi(this.http_0, {
      apiUrl: this.getHttpUrl(),
      coin: config.coin,
      signal: this.abortSignal,
      requestIntervalMs: process.env.NODE_ENV === 'test' ? 0 : REQUEST_INTERVAL_MS
    })
  }

  /**
   * PoolService registers signal handlers it never removes. Keep a reference
   * so stop() can detach them and a test process does not leak listeners.
   */
  _bindProcessExit () {
    this._onProcessExit = () => this.stop(() => {})
    process.once('SIGINT', this._onProcessExit)
    process.once('SIGTERM', this._onProcessExit)
  }

  stop (cb) {
    if (this._onProcessExit) {
      process.removeListener('SIGINT', this._onProcessExit)
      process.removeListener('SIGTERM', this._onProcessExit)
    }
    super.stop(cb)
  }

  getHttpUrl () {
    return this.conf.foundry?.apiUrl || DEFAULT_API_URL
  }

  /**
   * The base class persists `data.statsData` on its 5-minute tick and serves
   * it through ext_data regardless of how the last poll went. Keep the
   * history honest: nothing is written while the snapshot is failed or empty.
   */
  async saveStats (time) {
    if (this._statsError || !this.data.statsData.stats?.length) {
      return
    }
    return super.saveStats(time)
  }

  /**
   * ext_data `stats` carries the last good snapshot plus `error`, the message
   * of the last failed poll, so a reader can tell a live snapshot from one
   * that is being held because the API stopped answering.
   */
  async getWrkExtData (req) {
    const data = await super.getWrkExtData(req)
    if (req?.query?.key === 'stats' && data && typeof data === 'object' && !Array.isArray(data)) {
      return { ...data, error: this._statsError ? this._statsError.message : null }
    }
    return data
  }

  fetchStats (time) {
    return this._dedupe('stats', async () => {
      try {
        const stats = []
        for (const { name, credential } of this.accounts) {
          stats.push(await this._forAccount(name, () => this._fetchAccountStats(name, credential, time)))
        }
        this.data.statsData = { ts: toSecondTs(time), stats }
        this._statsError = null
      } catch (err) {
        this._statsError = err
        throw err
      }
    })
  }

  fetchWorkers (time) {
    return this._dedupe('workers', async () => {
      const workers = []
      for (const { name, credential } of this.accounts) {
        workers.push(...await this._forAccount(name, () => this._fetchAccountWorkers(name, credential, time)))
      }

      const ts = toSecondTs(time)
      await this._saveToDb(this.workersCountDb, ts, { ts, count: workers.length })
      this.data.workersData = { ts, workers }
    })
  }

  /**
   * Fires at UTC midnight and stores the transactions of the day that just
   * ended, keyed by that day's UTC start.
   * @param {Date} [time] scheduler fire time; the previous UTC day is collected
   */
  fetchTransactions (time = new Date()) {
    return this._dedupe('transactions', async () => {
      const day = previousDay(time)

      const transactions = []
      for (const { name, credential } of this.accounts) {
        transactions.push(...await this._forAccount(name, () => this._fetchAccountTransactions(name, credential, day)))
      }

      await this._saveToDb(this.transactionsDb, day.start, { ts: day.start, transactions })
    })
  }

  async fetchBlocks () {
    // /blocks needs an admin credential a customer never has: nothing to fetch.
  }

  /**
   * Earnings credited per month for the last twelve months, newest first.
   * One ledger call per sub-account, cached for HISTORY_TTL_MS and
   * invalidated on month rollover.
   * @returns {Promise<MonthlyBalance[]>}
   */
  getYearlyBalances (username, credential, time = new Date()) {
    return this._dedupe(`history:${username}`, async () => {
      const ranges = getMonthlyDateRanges(time)
      const cached = this._history.get(username)
      if (isFreshHistory(cached, ranges[0].month)) {
        return cached.balances
      }

      const balances = await this._financial(username, () => this._fetchMonthlyEarnings(username, credential, ranges)) || []
      this._history.set(username, { month: ranges[0].month, ts: Date.now(), balances })
      return balances
    })
  }

  /**
   * Sum of one stats field across all sub-accounts. Throws E_POOL_API when
   * the last poll failed, is older than STATS_MAX_AGE_MS, or lacks the field.
   * @param {string} field key of an entry in `data.statsData.stats`
   * @returns {number}
   */
  getMetric (field) {
    const { ts, stats } = this.data.statsData

    const isStale = Date.now() - ts > STATS_MAX_AGE_MS
    if (this._statsError || !stats?.length || isStale) {
      throw new Error('E_POOL_API: Foundry statistics are unavailable or stale')
    }
    if (stats.some(account => !Number.isFinite(account[field]))) {
      throw new Error(`E_POOL_API: Foundry ${field} is unavailable`)
    }

    return stats.reduce((sum, account) => sum + account[field], 0)
  }

  /**
   * Extra ext_data keys on top of the base set (stats, stats-history,
   * workers, workers-count, transactions):
   *
   *   hashrate-history  { start, end, interval: 'hour' | 'day' } — pool-side
   *                     hashrate series per sub-account, live from the API
   *   pool-stats        pool-wide live figures, no sub-account scope
   */
  async _getWrkExtDataExtra (key, query) {
    if (key === 'hashrate-history') {
      return this._fetchHashrateHistory(query)
    }
    if (key === 'pool-stats') {
      return this._fetchPoolStats()
    }
    return undefined
  }

  /** @returns {Promise<AccountStats>} */
  async _fetchAccountStats (username, credential, time) {
    const acct = await this.foundryApi.getSubAccountStats(username, credential)
    // The stats call above succeeded with this credential, so a 403 from the
    // money endpoints below is a scope problem, not a bad key.
    const bal = await this._financial(username, () => this.foundryApi.getBalance(username, credential))
    const earnings = await this._financial(username, () => this._fetchLatestEarnings(username, credential, time))
    const yearlyBalances = await this.getYearlyBalances(username, credential, time)

    const hashrate24h = ghsToHs(acct.hashrate24hrAvg, 'stats.hashrate24hrAvg')
    // The worker list comes from its own poll; before the first one there is
    // no count to report, and null says so where a zero would lie.
    const hasWorkersPoll = this.data.workersData.ts > 0
    const workers = this.data.workersData.workers.filter(worker => worker.username === username)
    const offline15m = toOptionalNumber(acct.offline15MinWorkerCount, 'stats.offline15MinWorkerCount')
    const offline24h = toOptionalNumber(acct.offline24HrWorkerCount, 'stats.offline24HrWorkerCount')

    return {
      username,
      timestamp: Date.now(),
      balance: bal ? toNumber(bal.balance, 'balance.balance') : null,
      unsettled: null,
      revenue_24h: earnings ? earnings.revenue : null,
      estimated_today_income: earnings ? estimateTodayIncome(earnings, hashrate24h) : null,
      hashrate: ghsToHs(acct.hashrate5minAvg, 'stats.hashrate5minAvg'),
      hashrate_15m: ghsToHs(acct.hashrate15minAvg, 'stats.hashrate15minAvg'),
      hashrate_1h: ghsToHs(acct.hashrate1hrAvg, 'stats.hashrate1hrAvg'),
      hashrate_24h: hashrate24h,
      hashrate_stale_1h: optionalGhsToHs(acct.stale1hrAvg, 'stats.stale1hrAvg'),
      hashrate_stale_24h: null,
      hashrate_reject_1h: optionalGhsToHs(acct.reject1hrAvg, 'stats.reject1hrAvg'),
      worker_count: hasWorkersPoll ? workers.length : null,
      active_workers_count: toNumber(acct.activeWorkers, 'stats.activeWorkers'),
      offline_workers_count: offline15m === null && offline24h === null ? null : (offline15m || 0) + (offline24h || 0),
      last_share_time: toOptionalTimestamp(acct.lastShareTime, 'stats.lastShareTime'),
      total_earned: bal ? toNumber(bal.totalEarned, 'balance.totalEarned') : null,
      total_withdrawn: bal ? toNumber(bal.totalWithdrawn, 'balance.totalWithdrawn') : null,
      total_pool_fees: bal ? toNumber(bal.totalPoolFees, 'balance.totalPoolFees') : null,
      yearlyBalances,
      financial_access: !this._financialDenied.has(username)
    }
  }

  /**
   * Runs a call to a money endpoint (/balance, /v2/earnings, /transactions).
   * A 401/403 there means the credential authenticates but lacks financial
   * access, which is what a technician API key looks like: the call yields
   * null and the refusal is logged once per sub-account. Anything else is
   * rethrown and fails the poll as usual.
   * @template T
   * @param {string} username
   * @param {() => Promise<T>} job
   * @returns {Promise<T|null>}
   */
  async _financial (username, job) {
    try {
      const result = await job()
      this._financialDenied.delete(username)
      return result
    } catch (err) {
      if (!(err instanceof FoundryApiError) || err.code !== 'AUTH') {
        throw err
      }
      if (!this._financialDenied.has(username)) {
        this._financialDenied.add(username)
        this._logErr(`WARN_FOUNDRY_FINANCIAL ${username}`, `${err.message}: credential has no financial access, balance and earnings reported as null`)
      }
      return null
    }
  }

  async _fetchAccountWorkers (username, credential, time) {
    return getWorkersStats(await this.foundryApi.getWorkers(username, credential), username, time.getTime())
  }

  /**
   * Foundry settles FPPS once per UTC day, so there is no intraday figure.
   * The latest settled row is `revenue_24h`; its hashrate lets today's income
   * be projected from the current 24h hashrate.
   * @returns {Promise<{ revenue: number, hashrate: number|null }>}
   */
  async _fetchLatestEarnings (username, credential, time) {
    const end = time.getTime()
    const rows = await this.foundryApi.getEarnings(username, credential, end - EARNINGS_LOOKBACK_DAYS * DAY_MS, end)

    let latest = null
    for (const row of rows) {
      const startTime = toTimestamp(row?.startTime, 'earning.startTime')
      if (!latest || startTime > latest.startTime) {
        latest = { startTime, row }
      }
    }
    if (!latest) {
      return { revenue: 0, hashrate: null }
    }
    return {
      revenue: toNumber(latest.row.totalAmount, 'earning.totalAmount'),
      hashrate: optionalGhsToHs(latest.row.hashrate, 'earning.hashrate')
    }
  }

  /** @returns {Promise<Transaction[]>} */
  async _fetchAccountTransactions (username, credential, day) {
    const rows = await this._financial(username, () => this.foundryApi.getTransactions(username, credential, day.start, day.end)) || []

    const transactions = []
    for (const row of rows) {
      // The API selects rows by creation time. A confirmed withdrawal reports
      // its confirmation as `time` and its creation as `broadcastTime`, so a
      // withdrawal created before midnight and confirmed after it still
      // belongs to this day.
      const createdAt = toOptionalTimestamp(row?.broadcastTime, 'transaction.broadcastTime') ?? toTimestamp(row?.time, 'transaction.time')
      if (createdAt < day.start || createdAt >= day.end) {
        continue
      }
      const amount = toNumber(row.amount, 'transaction.amount')
      transactions.push({
        username,
        id: typeof row.txId === 'string' && row.txId ? row.txId : null,
        type: typeof row.type === 'string' ? row.type : 'unknown',
        changed_balance: amount,
        created_at: Math.floor(createdAt / 1000),
        // The base PoolService sums this for the hourly revenue aggregation;
        // debits (withdrawals, fees) must not count as earnings.
        satoshis_net_earned: amount > 0 ? btcToSats(amount) : 0,
        address: typeof row.address === 'string' ? row.address : null
      })
    }
    return transactions
  }

  async _fetchMonthlyEarnings (username, credential, ranges) {
    const oldest = ranges[ranges.length - 1]
    const newest = ranges[0]
    const rows = await this.foundryApi.getEarnings(username, credential, oldest.start, newest.end)

    const totals = new Map(ranges.map(range => [range.month, 0]))
    for (const row of rows) {
      const month = monthKey(toTimestamp(row?.startTime, 'earning.startTime'))
      if (!totals.has(month)) {
        continue
      }
      totals.set(month, totals.get(month) + toNumber(row.totalAmount, 'earning.totalAmount'))
    }

    return Array.from(totals, ([month, balance]) => ({ month, balance }))
  }

  async _fetchHashrateHistory (query) {
    const { start, end, interval = 'hour' } = query
    if (!Number.isFinite(+start) || +start <= 0) throw new Error('ERR_START_INVALID')
    if (!Number.isFinite(+end) || +end <= 0) throw new Error('ERR_END_INVALID')
    if (interval !== 'hour' && interval !== 'day') throw new Error('ERR_INTERVAL_INVALID')

    const accounts = []
    for (const { name, credential } of this.accounts) {
      const rows = await this._forAccount(name, () => interval === 'day'
        ? this.foundryApi.getHashrateDay(name, credential, dateString(+start), dateString(+end))
        : this.foundryApi.getHashrateHour(name, credential, +start, +end))
      accounts.push({ username: name, poolType: this.wtype, hashrates: rows.map(mapHashrateRow) })
    }
    return { ts: Date.now(), interval, accounts }
  }

  async _fetchPoolStats () {
    const ps = await this.foundryApi.getPoolStats()
    return {
      ts: Date.now(),
      poolType: this.wtype,
      active_workers_count: toNumber(ps.activeWorkers, 'pool.activeWorkers'),
      hashrate: ghsToHs(ps.hashrate5minAvg, 'pool.hashrate5minAvg'),
      hashrate_1h: ghsToHs(ps.hashrate1hrAvg, 'pool.hashrate1hrAvg'),
      hashrate_24h: ghsToHs(ps.hashrate24hrAvg, 'pool.hashrate24hrAvg'),
      hashrate_stale_1h: optionalGhsToHs(ps.stale1hrAvg, 'pool.stale1hrAvg'),
      hashrate_reject_1h: optionalGhsToHs(ps.reject1hrAvg, 'pool.reject1hrAvg'),
      last_share_time: toOptionalTimestamp(ps.lastShareTime, 'pool.lastShareTime')
    }
  }

  /**
   * Runs one sub-account's part of a poll. An API or data error is logged
   * and re-thrown with the sub-account name, so the poll fails as a whole and
   * the log says which account to look at. An abort passes through untouched.
   */
  async _forAccount (username, job) {
    try {
      return await job()
    } catch (err) {
      this.abortSignal.throwIfAborted()
      this._logErr(`ERR_FOUNDRY_ACCOUNT ${username}`, err.message)
      const wrapped = new Error(`ERR_FOUNDRY_ACCOUNT ${username}: ${err.message}`)
      wrapped.cause = err
      throw wrapped
    }
  }

  /**
   * Scheduler ticks can overlap when a poll is slow. Callers with the same
   * key share the job that is already running.
   * @param {string} key job identity, e.g. 'stats' or 'history:<account>'
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   * @template T
   */
  _dedupe (key, job) {
    if (this._inFlight.has(key)) {
      return this._inFlight.get(key)
    }

    const pending = Promise.resolve()
      .then(job)
      .finally(() => this._inFlight.delete(key))
    this._inFlight.set(key, pending)
    return pending
  }
}

/**
 * Project today's income from the latest settled day, scaled by the ratio of
 * the current 24h hashrate to the hashrate that day was paid on. Falls back
 * to the settled amount when either hashrate is unknown or zero.
 */
function estimateTodayIncome ({ revenue, hashrate }, currentHashrate) {
  if (!hashrate || !currentHashrate || hashrate <= 0 || currentHashrate <= 0) {
    return revenue
  }
  return revenue * (currentHashrate / hashrate)
}

function mapHashrateRow (row) {
  if (!row || typeof row !== 'object') {
    throw new DataError('hashrate.row')
  }
  return {
    // unixTime is ms as a number; the ISO `time` is the fallback.
    ts: toOptionalNumber(row.unixTime, 'hashrate.unixTime') ?? toTimestamp(row.time, 'hashrate.time'),
    hashrate: ghsToHs(row.hashrateAccepted, 'hashrate.hashrateAccepted'),
    hashrate_stale: optionalGhsToHs(row.hashrateStale, 'hashrate.hashrateStale'),
    hashrate_rejected: optionalGhsToHs(row.hashrateRejected, 'hashrate.hashrateRejected'),
    average_workers: toOptionalNumber(row.averageWorkers, 'hashrate.averageWorkers')
  }
}

function isFreshHistory (cached, currentMonth) {
  return Boolean(cached) &&
    cached.month === currentMonth &&
    Date.now() - cached.ts < HISTORY_TTL_MS
}

module.exports = FoundryPool
module.exports.estimateTodayIncome = estimateTodayIncome

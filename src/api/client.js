'use strict'

const { setTimeout: sleep } = require('node:timers/promises')
const { FoundryApiError } = require('../errors')
const { authHeaders } = require('../utils/accounts')
const {
  COIN, DEFAULT_API_URL, REQUEST_INTERVAL_MS, REQUEST_TIMEOUT_MS,
  RATE_LIMIT_MAX_WAIT_MS, RATE_LIMIT_RETRIES, RATE_LIMIT_FALLBACK_WAIT_MS
} = require('../constants')

/**
 * @typedef {Object} FoundryApiOptions
 * @property {string} [apiUrl]            base URL, no path
 * @property {'BTC'} [coin]
 * @property {AbortSignal} [signal]       aborts waits and in-flight requests
 * @property {number} [requestIntervalMs] minimum spacing between requests
 * @property {number} [rateLimitFallbackMs] wait before retrying a 429 that names no reset
 */

/**
 * Read-only client for the Foundry USA Pool customer REST API.
 *
 * Every sub-account endpoint takes the credential per call, because one
 * worker may poll several sub-accounts each with its own API key.
 *
 * Concurrency model:
 *  - every call goes through one promise chain (`_queue`), so requests from
 *    stats, workers and history polling never interleave;
 *  - `_waitForRateLimit` spaces consecutive requests by `requestIntervalMs`;
 *  - the API's rate limit is per credential (API key, or user for a PAT) and
 *    every response reports it in `x-ratelimit-remaining` / `x-ratelimit-reset`.
 *    When the budget hits zero, the next request on that credential waits for
 *    the reset; a 429 waits the same way and is retried. Because the queue is
 *    serial, that wait also holds requests on other credentials, which is
 *    acceptable: one worker alone stays well under the limit, so a spent budget
 *    means something else is using the same credential.
 */
class FoundryApi {
  /**
   * @param {{ get: Function }} http  HttpFacility
   * @param {FoundryApiOptions} options
   */
  constructor (http, options = {}) {
    const {
      apiUrl = DEFAULT_API_URL, coin = COIN, signal,
      requestIntervalMs = REQUEST_INTERVAL_MS, rateLimitFallbackMs = RATE_LIMIT_FALLBACK_WAIT_MS
    } = options
    FoundryApi.validateConfig({ apiUrl, coin })

    this._http = http
    this._baseUrl = apiUrl.replace(/\/+$/, '')
    this._coin = coin
    this._signal = signal
    this._requestIntervalMs = requestIntervalMs
    this._rateLimitFallbackMs = rateLimitFallbackMs

    this._nextRequestAt = 0
    this._queue = Promise.resolve()
    /** credential -> ms timestamp before which it must not be used */
    this._pausedUntil = new Map()
  }

  static validateConfig ({ apiUrl = DEFAULT_API_URL, coin = COIN }) {
    if (coin !== COIN) {
      throw new Error('ERR_FOUNDRY_COIN_UNSUPPORTED')
    }
    if (!isPlainHttpUrl(apiUrl)) {
      throw new Error('ERR_FOUNDRY_API_URL_INVALID')
    }
  }

  /** GET /subaccount_stats/{sub}: live figures, hashrate in GH/s. */
  async getSubAccountStats (account, credential) {
    const path = `/subaccount_stats/${encodeURIComponent(account)}`
    return expectObject(path, await this._request(path, credential))
  }

  /** GET /workers/{sub}: every worker (pageSize=-1 disables paging). */
  async getWorkers (account, credential) {
    const path = `/workers/${encodeURIComponent(account)}`
    const data = await this._request(path, credential, {
      sort: 'highestHashrate', status: 'all', pageNumber: 0, pageSize: -1, tag: 'all'
    })
    if (!Array.isArray(data?.workersList)) {
      throw FoundryApiError.payload(path, 'INVALID_WORKERS')
    }
    // pageSize=-1 asks for every worker; if the server ever caps a page, the
    // count would be silently low, so hold it to the total it reports.
    if (Number.isFinite(data.totalWorkerCount) && data.totalWorkerCount !== data.workersList.length) {
      throw FoundryApiError.payload(path, 'TRUNCATED_WORKERS')
    }
    return data.workersList
  }

  /** GET /balance/{sub}: balance, totalEarned, totalWithdrawn... in BTC. */
  async getBalance (account, credential) {
    const path = `/balance/${encodeURIComponent(account)}`
    return expectObject(path, await this._request(path, credential))
  }

  /** GET /v2/earnings/{sub}: one row per settled UTC day in [startMs, endMs). */
  async getEarnings (account, credential, startMs, endMs) {
    const path = `/v2/earnings/${encodeURIComponent(account)}`
    return expectArray(path, await this._request(path, credential, { startDateUnixMs: startMs, endDateUnixMs: endMs }))
  }

  /** GET /transactions/{sub}: credits and debits in [startMs, endMs). */
  async getTransactions (account, credential, startMs, endMs) {
    const path = `/transactions/${encodeURIComponent(account)}`
    return expectArray(path, await this._request(path, credential, { startDateUnixMs: startMs, endDateUnixMs: endMs }))
  }

  /** GET /subaccount_hashrate_hour/{sub} */
  async getHashrateHour (account, credential, startMs, endMs) {
    const path = `/subaccount_hashrate_hour/${encodeURIComponent(account)}`
    return expectArray(path, await this._request(path, credential, { startDateUnixMs: startMs, endDateUnixMs: endMs }))
  }

  /** GET /subaccount_hashrate_day/{sub}: takes YYYY-MM-DD bounds only. */
  async getHashrateDay (account, credential, startDay, endDay) {
    const path = `/subaccount_hashrate_day/${encodeURIComponent(account)}`
    return expectArray(path, await this._request(path, credential, { start: startDay, end: endDay }))
  }

  /** GET /pool_stats: pool-wide figures, no credential. */
  async getPoolStats () {
    const path = '/pool_stats'
    return expectObject(path, await this._request(path, null))
  }

  _request (path, credential, query = {}) {
    const result = this._queue.then(() => this._send(path, credential, query))
    // A failed request must not stall the queue for the next caller.
    this._queue = result.catch(() => {})
    return result
  }

  async _send (path, credential, query) {
    const url = this._buildUrl(path, query)
    const headers = { Accept: 'application/json', ...(credential ? authHeaders(credential) : {}) }

    for (let attempt = 0; ; attempt++) {
      this._signal?.throwIfAborted()
      await this._waitForBudget(credential)
      await this._waitForRateLimit()

      let response
      try {
        response = await this._http.get(url, {
          headers,
          encoding: 'json',
          timeout: REQUEST_TIMEOUT_MS,
          signal: this._signal,
          redirect: false
        })
      } catch (err) {
        this._signal?.throwIfAborted()
        if (err?.status === 429 && attempt < RATE_LIMIT_RETRIES) {
          this._pause(credential, resetFrom(err.headers) ?? Date.now() + this._rateLimitFallbackMs)
          continue
        }
        throw FoundryApiError.transport(path, err)
      }
      this._noteBudget(credential, response?.headers)
      return response?.body
    }
  }

  async _waitForRateLimit () {
    while (this._nextRequestAt > Date.now()) {
      await sleep(this._nextRequestAt - Date.now(), undefined, { signal: this._signal })
    }
    this._nextRequestAt = Date.now() + this._requestIntervalMs
  }

  /** A response that reports the budget spent pauses its credential until the reset. */
  _noteBudget (credential, headers) {
    if (headerNumber(headers, 'x-ratelimit-remaining') === 0) {
      const resetAt = resetFrom(headers)
      if (resetAt) this._pause(credential, resetAt)
    }
  }

  _pause (credential, until) {
    this._pausedUntil.set(credential || '', Math.min(until, Date.now() + RATE_LIMIT_MAX_WAIT_MS))
  }

  async _waitForBudget (credential) {
    const key = credential || ''
    const until = this._pausedUntil.get(key)
    if (until === undefined) return
    const wait = until - Date.now()
    if (wait > 0) {
      await sleep(wait, undefined, { signal: this._signal })
    }
    this._pausedUntil.delete(key)
  }

  _buildUrl (path, query) {
    const params = new URLSearchParams({ coin: this._coin })
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value))
      }
    }
    return `${this._baseUrl}${path}?${params}`
  }
}

function header (headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  const key = Object.keys(headers).find(k => k.toLowerCase() === name)
  const value = key === undefined ? undefined : headers[key]
  return Array.isArray(value) ? value[0] : value
}

function headerNumber (headers, name) {
  const value = header(headers, name)
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * The ms timestamp at which the credential's window resets, from
 * `x-ratelimit-reset` (unix seconds) or, failing that, `retry-after`
 * (seconds). Null when neither is usable or the reset is already past.
 */
function resetFrom (headers) {
  const now = Date.now()
  const reset = headerNumber(headers, 'x-ratelimit-reset')
  if (reset !== null && reset * 1000 > now) return reset * 1000
  const retryAfter = headerNumber(headers, 'retry-after')
  if (retryAfter !== null && retryAfter > 0) return now + retryAfter * 1000
  return null
}

function isPlainHttpUrl (value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:'
  const hasExtras = url.username || url.password || url.search || url.hash
  return isHttp && !hasExtras
}

function expectObject (path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw FoundryApiError.payload(path, 'INVALID_RESPONSE')
  }
  return body
}

function expectArray (path, body) {
  if (!Array.isArray(body)) {
    throw FoundryApiError.payload(path, 'INVALID_RESPONSE')
  }
  return body
}

module.exports = FoundryApi

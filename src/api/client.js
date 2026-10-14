'use strict'

const { setTimeout: sleep } = require('node:timers/promises')
const { FoundryApiError } = require('../errors')
const { authHeaders } = require('../utils/accounts')
const { COIN, DEFAULT_API_URL, REQUEST_INTERVAL_MS, REQUEST_TIMEOUT_MS } = require('../constants')

/**
 * @typedef {Object} FoundryApiOptions
 * @property {string} [apiUrl]            base URL, no path
 * @property {'BTC'} [coin]
 * @property {AbortSignal} [signal]       aborts waits and in-flight requests
 * @property {number} [requestIntervalMs] minimum spacing between requests
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
 *  - `_waitForRateLimit` spaces consecutive requests by `requestIntervalMs`.
 */
class FoundryApi {
  /**
   * @param {{ get: Function }} http  HttpFacility
   * @param {FoundryApiOptions} options
   */
  constructor (http, options = {}) {
    const { apiUrl = DEFAULT_API_URL, coin = COIN, signal, requestIntervalMs = REQUEST_INTERVAL_MS } = options
    FoundryApi.validateConfig({ apiUrl, coin })

    this._http = http
    this._baseUrl = apiUrl.replace(/\/+$/, '')
    this._coin = coin
    this._signal = signal
    this._requestIntervalMs = requestIntervalMs

    this._nextRequestAt = 0
    this._queue = Promise.resolve()
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
    this._signal?.throwIfAborted()
    await this._waitForRateLimit()

    const url = this._buildUrl(path, query)
    const headers = { Accept: 'application/json', ...(credential ? authHeaders(credential) : {}) }

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
      throw FoundryApiError.transport(path, err)
    }
    return response?.body
  }

  async _waitForRateLimit () {
    while (this._nextRequestAt > Date.now()) {
      await sleep(this._nextRequestAt - Date.now(), undefined, { signal: this._signal })
    }
    this._nextRequestAt = Date.now() + this._requestIntervalMs
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

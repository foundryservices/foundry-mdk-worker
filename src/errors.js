'use strict'

/**
 * The only error type the API client throws for transport and payload
 * problems. It deliberately does not wrap the original HTTP error: that
 * object may carry the request headers, credential included. `detail` is
 * the API's own short error message when its JSON envelope had one
 * ("Invalid API key", "Not authenticated", ...), or the transport error code
 * (ETIMEDOUT, ECONNREFUSED, ...) when no response arrived; never the full
 * response body and never a header.
 */
class FoundryApiError extends Error {
  constructor (path, status, code, detail = null) {
    super(`ERR_FOUNDRY_API ${path} ${status} ${code}${detail ? ` (${detail})` : ''}`)
    this.path = path
    this.status = status
    this.code = code
    this.detail = detail
  }

  static transport (path, err) {
    const status = err?.status || 0
    const detail = status ? envelopeMessage(err?.response) : transportDetail(err)
    return new FoundryApiError(path, status, codeForStatus(status), detail)
  }

  /** The server answered 2xx, but the payload does not fit the documented shape. */
  static payload (path, code) {
    return new FoundryApiError(path, 200, code)
  }
}

/** A field in an otherwise valid response is missing or malformed. */
class DataError extends Error {
  constructor (field) {
    super(`ERR_FOUNDRY_DATA ${field}`)
    this.field = field
  }
}

function codeForStatus (status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'SERVER'
  return 'REQUEST_FAILED'
}

const MAX_DETAIL = 120

// node-fetch surfaces the socket error code on err.code (ECONNREFUSED,
// ENOTFOUND, ...) and a timeout as type 'request-timeout'.
function transportDetail (err) {
  const code = err?.code || err?.type
  return typeof code === 'string' && code.length <= MAX_DETAIL ? code : null
}

function envelopeMessage (response) {
  let body = response
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { return null }
  }
  const message = body?.message
  return typeof message === 'string' && message.length <= MAX_DETAIL ? message : null
}

module.exports = { FoundryApiError, DataError }

'use strict'

const { DataError } = require('../errors')
const { DAY_MS, MONTHS_OF_HISTORY } = require('../constants')

/**
 * Foundry timestamps arrive in two shapes: ISO with offset
 * ("2024-06-28T14:49:05.000+00:00") on most endpoints and a JDBC-style
 * "2024-06-28 14:49:05.0" on pool_stats. Both are UTC.
 * @returns {number} ms
 */
function toTimestamp (value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    throw new DataError(field)
  }
  let str = value.trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) {
    str = str.replace(' ', 'T') + 'Z'
  }
  const ms = Date.parse(str)
  if (!Number.isFinite(ms)) {
    throw new DataError(field)
  }
  return ms
}

function toOptionalTimestamp (value, field) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  return toTimestamp(value, field)
}

/** "YYYY-MM-DD" in UTC, the only form the per-day hashrate endpoint accepts. */
function dateString (time) {
  return new Date(time).toISOString().slice(0, 10)
}

/** "M-YYYY", the key the base PoolService uses for yearly balances. */
function monthKey (time) {
  const date = new Date(time)
  return `${date.getUTCMonth() + 1}-${date.getUTCFullYear()}`
}

/**
 * The completed UTC day before `time`.
 * @returns {{ start: number, end: number, date: string }} [start, end) in ms and YYYY-MM-DD
 */
function previousDay (time) {
  const end = Date.parse(dateString(time))
  const start = end - DAY_MS
  return { start, end, date: dateString(start) }
}

/**
 * Twelve months ending with the month of `time`, newest first.
 * @returns {Array<{ month: string, start: number, end: number }>} [start, end) in ms
 */
function getMonthlyDateRanges (time) {
  const date = new Date(time)
  return Array.from({ length: MONTHS_OF_HISTORY }, (_, monthsAgo) => {
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthsAgo, 1)
    const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthsAgo + 1, 1)
    return { month: monthKey(start), start, end }
  })
}

module.exports = { toTimestamp, toOptionalTimestamp, dateString, monthKey, previousDay, getMonthlyDateRanges }

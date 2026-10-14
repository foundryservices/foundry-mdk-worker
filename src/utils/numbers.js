'use strict'

const { DataError } = require('../errors')
const { GHS, BTC_SATS } = require('../constants')

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/

function isNumericValue (value) {
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (typeof value === 'string') {
    return DECIMAL_STRING.test(value) && Number.isFinite(Number(value))
  }
  return false
}

/**
 * A missing or malformed reading must never become a valid zero.
 * @param {unknown} value number or decimal string
 * @param {string} field  reported in the error message
 * @returns {number}
 */
function toNumber (value, field) {
  if (!isNumericValue(value)) {
    throw new DataError(field)
  }
  return Number(value)
}

/** Like toNumber, but a field the API may omit yields null instead of an error. */
function toOptionalNumber (value, field) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  return toNumber(value, field)
}

/** GH/s (as the API reports) to H/s (as MDK wants). */
function ghsToHs (value, field) {
  return toNumber(value, field) * GHS
}

function optionalGhsToHs (value, field) {
  const n = toOptionalNumber(value, field)
  return n === null ? null : n * GHS
}

function btcToSats (btc) {
  return Math.round(btc * BTC_SATS)
}

module.exports = { toNumber, toOptionalNumber, ghsToHs, optionalGhsToHs, btcToSats }

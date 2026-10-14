'use strict'

const { PAT_PREFIX, API_KEY_HEADER, AUTH_HEADER } = require('../constants')

/**
 * @typedef {Object} Account
 * @property {string} name        sub-account name as it appears in the pool UI
 * @property {string} credential  sub-account API key or `fdpat_` personal access token
 */

function isNonEmptyString (value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Foundry has no master account: every request names a sub-account, so the
 * list is required. Entries are a name sharing `apiKey`, or `{ name, apiKey }`
 * with a per-sub-account key, which is how Foundry issues API keys. A single
 * personal access token in `apiKey` covers every sub-account its user can see.
 * @param {{ accounts?: Array<string|{name:string, apiKey?:string}>, apiKey?: string }} config
 * @returns {Account[]}
 */
function parseAccounts (config = {}) {
  const { accounts, apiKey: defaultCredential } = config
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('ERR_FOUNDRY_ACCOUNTS_REQUIRED')
  }

  const parsed = accounts.map(entry => {
    const name = typeof entry === 'string' ? entry : entry?.name
    const credential = typeof entry === 'string' ? defaultCredential : (entry?.apiKey || defaultCredential)
    if (!isNonEmptyString(name)) {
      throw new Error('ERR_FOUNDRY_ACCOUNTS_INVALID')
    }
    if (!isNonEmptyString(credential)) {
      throw new Error(`ERR_FOUNDRY_CREDENTIAL_REQUIRED ${name}`)
    }
    return { name: name.trim(), credential: credential.trim() }
  })

  if (new Set(parsed.map(a => a.name)).size !== parsed.length) {
    throw new Error('ERR_FOUNDRY_ACCOUNTS_INVALID')
  }
  return parsed
}

/** Picks the header the API expects for the credential type. */
function authHeaders (credential) {
  if (credential.startsWith(PAT_PREFIX)) {
    return { [AUTH_HEADER]: `Bearer ${credential}` }
  }
  return { [API_KEY_HEADER]: credential }
}

module.exports = { parseAccounts, authHeaders }

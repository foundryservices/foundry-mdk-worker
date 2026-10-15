'use strict'

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

module.exports = {
  COIN: 'BTC',
  POOL_TYPE: 'foundry',
  DEFAULT_API_URL: 'https://api.pool.foundrydigital.com',

  // The Foundry API reports every hashrate figure in GH/s; MDK wants H/s.
  GHS: 1e9,
  BTC_SATS: 100000000,

  // Credentials: a sub-account API key travels as X-API-KEY; a personal
  // access token (My Profile → Personal Access Token tab) carries this prefix and travels as a Bearer.
  API_KEY_HEADER: 'X-API-KEY',
  AUTH_HEADER: 'Authorization',
  PAT_PREFIX: 'fdpat_',

  // The API rate limit, where enabled, is 300 requests per minute per client.
  // 250 ms spacing caps one worker at 240 and leaves headroom.
  REQUEST_INTERVAL_MS: 250,
  REQUEST_TIMEOUT_MS: 30 * SECOND_MS,

  // Foundry counts a worker as active when its last share is within 15 minutes.
  WORKER_ONLINE_WINDOW_MS: 15 * MINUTE_MS,

  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  STATS_MAX_AGE_MS: 3 * MINUTE_MS,
  HISTORY_TTL_MS: HOUR_MS,
  MONTHS_OF_HISTORY: 12,
  // Earnings settle once per UTC day; three days back always contains the
  // latest settled row, even right after midnight when today has none yet.
  EARNINGS_LOOKBACK_DAYS: 3
}

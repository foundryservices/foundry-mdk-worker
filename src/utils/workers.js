'use strict'

const { DataError } = require('../errors')
const { ghsToHs, optionalGhsToHs, toOptionalNumber } = require('./numbers')
const { toOptionalTimestamp } = require('./dates')
const { WORKER_ONLINE_WINDOW_MS } = require('../constants')

/**
 * Raw worker row from GET /workers/{subAccountName}.
 * @typedef {Object} FoundryWorker
 * @property {string|number} workerId
 * @property {string|null} workerName   null for shares sent without a worker suffix
 * @property {number} hashrate_5m       GH/s
 * @property {number} hashrate_15m      GH/s
 * @property {number} hashrate_1h       GH/s
 * @property {number} [stale_1h]        GH/s
 * @property {number} [reject_1h]       GH/s
 * @property {string|null} lastShareTime
 * @property {string|null} updatedAt
 * @property {string} [tag]
 */

/**
 * Normalized worker shared with the other pool workers. Foundry publishes no
 * 24h figures per worker, so those stay null rather than a fabricated zero.
 * @typedef {Object} WorkerStats
 * @property {string} username
 * @property {string} id
 * @property {string} name
 * @property {0|1} online             last share within 15 minutes
 * @property {number|null} last_updated   ms
 * @property {number|null} last_share_time ms
 * @property {number} hashrate        H/s, 5 minute average
 * @property {number} hashrate_15m    H/s
 * @property {number} hashrate_1h     H/s
 * @property {null} hashrate_24h
 * @property {number|null} hashrate_stale_1h
 * @property {null} hashrate_stale_24h
 * @property {number|null} hashrate_reject_1h
 * @property {number|null} stale_15m_percent
 * @property {number|null} reject_15m_percent
 * @property {string} tag
 */

function isOnline (lastShareMs, now) {
  return lastShareMs !== null && now - lastShareMs <= WORKER_ONLINE_WINDOW_MS ? 1 : 0
}

/**
 * @param {FoundryWorker} worker
 * @returns {WorkerStats}
 */
function toWorkerStats (worker, username, now) {
  const id = worker?.workerId
  if ((typeof id !== 'string' && typeof id !== 'number') || id === '') {
    throw new DataError('worker.workerId')
  }
  const lastShareTime = toOptionalTimestamp(worker.lastShareTime, 'worker.lastShareTime')

  return {
    username,
    id: String(id),
    name: typeof worker.workerName === 'string' && worker.workerName ? worker.workerName : String(id),
    online: isOnline(lastShareTime, now),
    last_updated: toOptionalTimestamp(worker.updatedAt, 'worker.updatedAt') ?? lastShareTime,
    last_share_time: lastShareTime,
    hashrate: ghsToHs(worker.hashrate_5m, 'worker.hashrate_5m'),
    hashrate_15m: ghsToHs(worker.hashrate_15m, 'worker.hashrate_15m'),
    hashrate_1h: ghsToHs(worker.hashrate_1h, 'worker.hashrate_1h'),
    hashrate_24h: null,
    hashrate_stale_1h: optionalGhsToHs(worker.stale_1h, 'worker.stale_1h'),
    hashrate_stale_24h: null,
    hashrate_reject_1h: optionalGhsToHs(worker.reject_1h, 'worker.reject_1h'),
    stale_15m_percent: toOptionalNumber(worker.stale15mPercent, 'worker.stale15mPercent'),
    reject_15m_percent: toOptionalNumber(worker.reject15mPercent, 'worker.reject15mPercent'),
    tag: typeof worker.tag === 'string' ? worker.tag : ''
  }
}

/**
 * @param {FoundryWorker[]} workers
 * @returns {WorkerStats[]}
 */
function getWorkersStats (workers, username, now = Date.now()) {
  return workers.map(worker => toWorkerStats(worker, username, now))
}

module.exports = { getWorkersStats, isOnline }

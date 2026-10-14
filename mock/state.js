'use strict'

const { DAY_MS, generateMockWorkers, generateSubAccountStats, generateEarnings } = require('./generators')

/**
 * Canned state for one sub-account. Lifetime balance figures derive from a
 * year of settled earnings so /balance agrees with /v2/earnings.
 * @param {{ name?: string, workerCount?: number, now?: number }} [opts]
 */
module.exports = function createState ({ name = 'test', workerCount, now = Date.now() } = {}) {
  const workers = generateMockWorkers(workerCount, now)
  const stats = generateSubAccountStats(name, workers, now)
  const hashrateGhs = stats.hashrate1hrAvg

  const lifetime = generateEarnings(now - 365 * DAY_MS, now, hashrateGhs, now)
  const totalEarned = lifetime.reduce((s, r) => s + r.totalAmount, 0)
  const totalPoolFees = lifetime.reduce((s, r) => s + r.poolFeeAmount, 0)
  const totalWithdrawn = +(totalEarned * 0.9).toFixed(8)

  return {
    name,
    hashrateGhs,
    workers,
    stats,
    balance: {
      balance: +(totalEarned - totalWithdrawn).toFixed(8),
      totalEarned: +totalEarned.toFixed(8),
      totalFCMFees: 0,
      totalDebits: 0,
      totalPoolFees: +totalPoolFees.toFixed(8),
      totalWithdrawn,
      totalOptifleetFees: 0
    }
  }
}

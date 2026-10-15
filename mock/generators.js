'use strict'

// Adapted from Tether MDK v0.10.0, backend/workers/minerpools/ocean/mock/initial_states/utils.js
// (https://github.com/tetherto/mdk, Apache-2.0, Copyright Tether and contributors).
// Modified by Foundry Digital LLC. See NOTICE.

const crypto = require('crypto')

const DAY_MS = 24 * 60 * 60 * 1000

// ~100 TH/s per worker, expressed in GH/s like the real API.
const AVG_HASHRATE_PER_WORKER_GHS = 100000

function randomFloat () {
  return crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48
}

function randomNumber (min = 0, max = 1) {
  const number = randomFloat() * (max - min) + min
  return parseFloat(number.toFixed(2))
}

// "2024-06-28T14:49:05.000+00:00" — the timestamp format most endpoints emit.
function isoOffset (ms) {
  return new Date(ms).toISOString().replace('Z', '+00:00')
}

// "2024-06-28 14:49:05.0" — the JDBC format pool_stats emits.
function jdbcTs (ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '.0')
}

function generateMockWorkers (workerCount, now = Date.now()) {
  const count = workerCount != null ? workerCount : 5 + Math.floor(randomNumber() * 10)
  const workers = []
  for (let i = 0; i < count; i++) {
    const base = AVG_HASHRATE_PER_WORKER_GHS + randomNumber(-5000, 5000)
    workers.push({
      workerId: String(1000000000000000000 + i),
      workerName: `worker${i + 1}`,
      hashrate_5m: Math.round(base),
      hashrate_15m: Math.round(base + randomNumber(-2000, 2000)),
      stale_15m: Math.round(randomNumber(0, 500)),
      stale15mPercent: randomNumber(0, 1),
      reject_15m: 0,
      reject15mPercent: 0.0,
      rejectDetail_15m: '{}',
      hashrate_1h: Math.round(base + randomNumber(-2000, 2000)),
      stale_1h: Math.round(randomNumber(0, 500)),
      reject_1h: 0,
      rejectDetail_1h: '{}',
      lastShareTime: isoOffset(now - Math.floor(randomNumber(0, 60) * 1000)),
      updatedAt: isoOffset(now),
      tag: i % 2 === 0 ? 'Untagged' : 'datacenter1'
    })
  }
  return workers
}

function generateSubAccountStats (name, workers, now = Date.now()) {
  const sum = (field) => workers.reduce((s, w) => s + w[field], 0)
  return {
    name,
    activeWorkers: workers.length,
    offline15MinWorkerCount: 0,
    offline24HrWorkerCount: 0,
    offline24HrTo1WkWorkerCount: 0,
    offline1WkWorkerCount: 0,
    hashrate5minAvg: sum('hashrate_5m'),
    hashrate15minAvg: sum('hashrate_15m'),
    stale15minAvg: sum('stale_15m'),
    reject15minAvg: sum('reject_15m'),
    hashrate1hrAvg: sum('hashrate_1h'),
    hashrate24hrAvg: Math.round(sum('hashrate_1h') * randomNumber(0.95, 1.05)),
    stale1hrAvg: sum('stale_1h'),
    reject1hrAvg: sum('reject_1h'),
    lastShareTime: isoOffset(now - 5000),
    updatedAt: isoOffset(now),
    fcmOptIn: false
  }
}

/**
 * One settled FPPS row per UTC day in [startMs, endMs), newest first — the
 * shape of GET /v2/earnings. Amounts are deterministic per day so repeated
 * polls of the same window agree.
 */
function generateEarnings (startMs, endMs, hashrateGhs, now = Date.now()) {
  const rows = []
  const todayStart = new Date(now).setUTCHours(0, 0, 0, 0)
  let day = new Date(startMs).setUTCHours(0, 0, 0, 0)
  while (day < endMs && day < todayStart) {
    const dayEnd = day + DAY_MS
    const seed = (Math.floor(day / DAY_MS) % 17) / 17 // 0..1, stable per day
    const btcPerGhsDay = 4.5e-10 // ~0.045 BTC per 100 PH/s-day
    const gross = hashrateGhs * btcPerGhsDay * (0.9 + 0.2 * seed)
    const poolFee = gross * 0.02
    rows.push({
      startTime: isoOffset(day),
      endTime: isoOffset(dayEnd),
      totalAmount: +(gross - poolFee).toFixed(8),
      hashrate: Math.round(hashrateGhs * (0.95 + 0.1 * seed)),
      ppsBaseAmount: +(gross * 0.9).toFixed(8),
      txFeeRewardAmount: +(gross * 0.1).toFixed(8),
      fppsRatePercent: 2.0,
      poolFeeAmount: +poolFee.toFixed(8),
      feeRatePercent: 2.0,
      grossEarnings: +gross.toFixed(8),
      payoutSchema: 'FPPS'
    })
    day = dayEnd
  }
  return rows.reverse()
}

/**
 * Daily FPPS credits plus a withdrawal every 10 days — GET /transactions.
 */
function generateTransactions (startMs, endMs, hashrateGhs, now = Date.now()) {
  const txs = []
  const earnings = generateEarnings(startMs - DAY_MS, endMs, hashrateGhs, now)
  for (const e of earnings) {
    const creditTime = Date.parse(e.endTime) + 60 * 60 * 1000 // settled 01:00 UTC
    if (creditTime < startMs || creditTime > endMs) continue
    txs.push({
      time: isoOffset(creditTime),
      broadcastTime: null,
      amount: e.totalAmount,
      type: 'FPPS',
      description: e.startTime.slice(0, 10),
      txId: null,
      address: null
    })
    if (Math.floor(Date.parse(e.startTime) / DAY_MS) % 10 === 0) {
      txs.push({
        time: isoOffset(creditTime + 8 * 60 * 60 * 1000),
        broadcastTime: isoOffset(creditTime + 8 * 60 * 60 * 1000 + 30000),
        amount: -+(e.totalAmount * 9).toFixed(8),
        type: 'Auto-Withdraw',
        description: 'Auto-Withdraw',
        txId: crypto.randomBytes(32).toString('hex'),
        address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
      })
    }
  }
  return txs.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
}

function generateHashrateHour (startMs, endMs, hashrateGhs) {
  const rows = []
  let t = new Date(startMs).setUTCMinutes(0, 0, 0)
  while (t < endMs) {
    rows.push({
      time: isoOffset(t),
      endTime: null,
      unixTime: t,
      hashrateAccepted: Math.round(hashrateGhs * randomNumber(0.95, 1.05)),
      hashrateStale: Math.round(hashrateGhs * randomNumber(0, 0.03)),
      hashrateRejected: Math.round(hashrateGhs * randomNumber(0, 0.01)),
      averageWorkers: null
    })
    t += 60 * 60 * 1000
  }
  return rows
}

function generateHashrateDay (startMs, endMs, hashrateGhs, workerCount) {
  const rows = []
  let t = new Date(startMs).setUTCHours(0, 0, 0, 0)
  while (t < endMs) {
    rows.push({
      time: isoOffset(t),
      endTime: isoOffset(t + DAY_MS),
      unixTime: t,
      hashrateAccepted: Math.round(hashrateGhs * randomNumber(0.95, 1.05)),
      hashrateStale: Math.round(hashrateGhs * randomNumber(0, 0.03)),
      hashrateRejected: Math.round(hashrateGhs * randomNumber(0, 0.01)),
      averageWorkers: workerCount
    })
    t += DAY_MS
  }
  return rows.reverse()
}

function generatePoolStats (now = Date.now()) {
  const hashrate = 173236175398 // ~173 EH/s in GH/s
  return {
    activeWorkers: 1337523,
    hashrate5minAvg: hashrate,
    hashrate15minAvg: Math.round(hashrate * 1.007),
    stale15minAvg: 773618415,
    reject15minAvg: 131054906,
    hashrate1hrAvg: Math.round(hashrate * 1.018),
    hashrate24hrAvg: Math.round(hashrate * 0.996),
    stale1hrAvg: 449151771,
    reject1hrAvg: 188375486,
    lastShareTime: jdbcTs(now - 4000),
    updatedAt: jdbcTs(now)
  }
}

module.exports = {
  DAY_MS,
  AVG_HASHRATE_PER_WORKER_GHS,
  randomNumber,
  isoOffset,
  jdbcTs,
  generateMockWorkers,
  generateSubAccountStats,
  generateEarnings,
  generateTransactions,
  generateHashrateHour,
  generateHashrateDay,
  generatePoolStats
}

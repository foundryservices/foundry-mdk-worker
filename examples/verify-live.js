'use strict'

// Read-only check of a real credential against the Foundry API. Prints OK per
// metric and exits nonzero if any metric is unavailable.
//
//   FOUNDRY_SUBACCOUNT=<name> FOUNDRY_API_KEY=<key or fdpat_…> node examples/verify-live.js
//   FOUNDRY_API_URL overrides the base URL (e.g. the staging API).

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { FOUNDRY_POOL } = require('..')

const METRIC_FIELDS = ['hashrate', 'active_workers_count', 'balance', 'estimated_today_income']

function readConfig (env) {
  const { FOUNDRY_API_URL: apiUrl, FOUNDRY_SUBACCOUNT: name, FOUNDRY_API_KEY: apiKey } = env
  if (!name || !apiKey) {
    throw new Error('Set FOUNDRY_SUBACCOUNT and FOUNDRY_API_KEY before running live verification')
  }
  return { ...(apiUrl ? { apiUrl } : {}), accounts: [{ name, apiKey }] }
}

async function main () {
  const foundry = readConfig(process.env)
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdk-foundry-live-'))
  const pool = new FOUNDRY_POOL({ foundry }, { rack: 'verify', root: storeDir, storeDir })

  try {
    await pool.init()
    await pool.fetchWorkers(new Date())
    await pool.fetchStats(new Date())

    for (const field of METRIC_FIELDS) {
      if (!Number.isFinite(pool.getMetric(field))) {
        throw new Error(`Invalid ${field}`)
      }
      console.log(`${field}: OK`)
    }
    const [stats] = pool.data.statsData.stats
    console.log(`hashrate ${(stats.hashrate / 1e12).toFixed(2)} TH/s, workers ${stats.active_workers_count}/${stats.worker_count}, balance ${stats.balance} BTC`)
    console.log('Foundry live verification passed')
  } finally {
    await new Promise(resolve => pool.stop(resolve))
    fs.rmSync(storeDir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})

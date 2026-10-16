'use strict'

// Live validation: runs the worker against the real API through a recording
// proxy, polls once (workers, stats, transactions, hashrate history, pool
// stats), and compares its output field by field with values computed
// independently from the recorded responses.
//
//   node tools/validate/live.js --account <sub-account>=<key file> [--account ...]
//     [--api <base url>] [--label <name>] [--out <dir>]
//
// Each key file holds one API key or personal access token. The report and the
// recorded responses go to --out (default: a new folder in the OS temp dir).
// The recording is your account's real data: keep it out of the repository.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { FOUNDRY_POOL } = require('../..')
const { DEFAULT_API_URL } = require('../../src/constants')
const { startRecorder } = require('./proxy')
const { expectedFor, windows } = require('./expected')
const { compare, report } = require('./compare')

function parseArgs (argv) {
  const opts = { accounts: [], api: DEFAULT_API_URL, label: 'live', out: null }
  for (let i = 2; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (flag === '--api') opts.api = value
    else if (flag === '--label') opts.label = value
    else if (flag === '--out') opts.out = value
    else if (flag === '--account') {
      const [name, keyFile] = value.split('=')
      opts.accounts.push({ name, keyFile })
    } else throw new Error(`unknown flag ${flag}`)
  }
  if (!opts.accounts.length) throw new Error('at least one --account <sub-account>=<key file> is required')
  return opts
}

async function main () {
  const opts = parseArgs(process.argv)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = opts.out || path.join(os.tmpdir(), `foundry-validate-${opts.label}-${stamp}`)
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })

  const recorder = await startRecorder({ upstream: opts.api, file: path.join(outDir, 'api.jsonl') })
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-validate-store-'))
  const pool = new FOUNDRY_POOL({
    foundry: {
      apiUrl: recorder.url,
      accounts: opts.accounts.map(a => ({ name: a.name, apiKey: fs.readFileSync(a.keyFile, 'utf8').trim() }))
    }
  }, { rack: 'validate', root: storeDir, storeDir })
  pool._logErr = (tag, msg) => console.error(`  worker log: ${tag} ${msg}`)

  const errors = {}
  const attempt = async (name, fn) => { try { return await fn() } catch (err) { errors[name] = err.message; return null } }
  let failed = true

  try {
    await pool.init()
    // MDK's own schedule (1m stats, 5m workers, 1D transactions) would fire on a
    // minute boundary mid-run and the worker would merge our poll into it, so
    // the poll would run with the scheduler's time instead of ours.
    for (const key of ['1m', '5m', '1D']) pool.scheduler_0.del(key)
    const now = new Date()
    const t0 = now.getTime()
    const w = windows(t0)

    await attempt('workers', () => pool.fetchWorkers(now))
    await attempt('stats', () => pool.fetchStats(now))
    await attempt('transactions', () => pool.fetchTransactions(now))

    const metric = (field) => { try { return pool.getMetric(field) } catch (err) { return err.message.split(':')[0] } }
    const statsExt = await attempt('ext stats', () => pool.getWrkExtData({ query: { key: 'stats' } }))
    const txExt = await attempt('ext transactions', () => pool.getWrkExtData({ query: { key: 'transactions', start: w.previousDay.start, end: w.previousDay.end } }))
    const hour = await attempt('hashrate-history hour', () => pool.getWrkExtData({ query: { key: 'hashrate-history', start: w.hour.start, end: w.hour.end, interval: 'hour' } }))
    const day = await attempt('hashrate-history day', () => pool.getWrkExtData({ query: { key: 'hashrate-history', start: w.day.start, end: w.day.end, interval: 'day' } }))
    const poolStats = await attempt('pool-stats', () => pool.getWrkExtData({ query: { key: 'pool-stats' } }))

    const actual = {
      t0,
      errors,
      metrics: {
        hashrate: metric('hashrate'),
        workers_online: metric('active_workers_count'),
        balance: metric('balance'),
        estimated_earnings: metric('estimated_today_income')
      },
      stats: statsExt && statsExt.stats,
      workers: pool.data.workersData.workers,
      transactions: Array.isArray(txExt) && txExt[0] ? txExt[0].transactions : [],
      hashrateHour: hour,
      hashrateDay: day,
      poolStats
    }

    const names = opts.accounts.map(a => a.name)
    const expected = expectedFor({ records: recorder.records, accounts: names, t0 })
    const results = compare(expected, actual)
    const md = report({ label: opts.label, api: opts.api, accounts: names, t0, expected, actual, results, records: recorder.records })

    fs.writeFileSync(path.join(outDir, 'actual.json'), JSON.stringify(actual, null, 1), { mode: 0o600 })
    fs.writeFileSync(path.join(outDir, 'expected.json'), JSON.stringify(expected, null, 1), { mode: 0o600 })
    fs.writeFileSync(path.join(outDir, 'report.md'), md, { mode: 0o600 })

    const drift = results.filter(r => r.mismatches.length)
    const badChecks = expected.checks.filter(c => !c.ok)
    failed = drift.length > 0 || Object.keys(errors).length > 0
    console.log(`${opts.label}: ${results.length - drift.length}/${results.length} sections match, ${badChecks.length} check(s) not OK, ${Object.keys(errors).length} worker error(s)`)
    for (const r of drift) console.log(`  MISMATCH ${r.name}: ${r.mismatches.length} (first: ${r.mismatches[0].path} expected ${JSON.stringify(r.mismatches[0].expected)} actual ${JSON.stringify(r.mismatches[0].actual)})`)
    for (const c of badChecks) console.log(`  CHECK ${c.account}: ${c.check} -> ${JSON.stringify(c.detail)}`)
    for (const [k, v] of Object.entries(errors)) console.log(`  ERROR ${k}: ${v}`)
    console.log(`  report: ${path.join(outDir, 'report.md')}`)
  } finally {
    await new Promise(resolve => pool.stop(resolve))
    await recorder.close()
    fs.rmSync(storeDir, { recursive: true, force: true })
  }
  process.exitCode = failed ? 1 : 0
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

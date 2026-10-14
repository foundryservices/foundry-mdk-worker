'use strict'

const { WorkerRuntime } = require('./mdk')
const FoundryPool = require('./pool')
const plugin = require('./plugin')

/**
 * Boots a Foundry USA Pool worker on the WorkerRuntime.
 *
 * The pool is one logical device whose deviceId equals `workerId`. All
 * configured sub-accounts are aggregated behind that single device.
 *
 * @param {object} opts
 * @param {string} opts.workerId     one runtime process = one workerId
 * @param {string} opts.rack         rack identifier (pool store prefix)
 * @param {string} opts.storeDir     persistent store directory
 * @param {object} [opts.conf]       `{ foundry: { apiUrl, coin, apiKey, accounts } }`
 * @param {string} [opts.root]       directory whose config/foundry.json, if present, replaces conf.foundry
 * @param {string} [opts.kernelTopic] Kernel discovery topic (hex)
 * @param {Array}  [opts.bootstrap]  DHT bootstrap override for a private or test network
 */
async function startFoundryWorker (opts = {}) {
  assertBootOptions(opts)

  const pool = new FoundryPool(opts.conf, {
    rack: opts.rack,
    storeDir: opts.storeDir,
    root: opts.root
  })
  const services = { pool }

  let runtime
  const stop = async () => {
    try {
      await runtime?.stop()
    } finally {
      await new Promise(resolve => pool.stop(resolve))
    }
  }

  try {
    await pool.init()
    runtime = new WorkerRuntime(plugin, {
      workerId: opts.workerId,
      kernelTopic: opts.kernelTopic || null,
      bootstrap: opts.bootstrap || null,
      store: pool.store_s1,
      services,
      devices: [{ deviceId: opts.workerId, config: { pool } }]
    })
    await runtime.start()
  } catch (err) {
    await stop()
    throw err
  }

  return { runtime, pool, services, stop }
}

function assertBootOptions ({ workerId, rack, storeDir }) {
  if (!workerId) {
    throw new Error('ERR_WORKER_ID_REQUIRED')
  }
  if (!rack) {
    throw new Error('ERR_RACK_REQUIRED')
  }
  if (!storeDir) {
    throw new Error('ERR_STORE_DIR_REQUIRED')
  }
}

module.exports = { startFoundryWorker }

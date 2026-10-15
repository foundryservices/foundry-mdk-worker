'use strict'

// Adapted from Tether MDK v0.10.0, backend/workers/minerpools/ocean/plugin/index.js
// (https://github.com/tetherto/mdk, Apache-2.0, Copyright Tether and contributors).
// Modified by Foundry Digital LLC. See NOTICE.

const path = require('node:path')

// Contract handler paths are relative to the package root.
module.exports = {
  contract: require('../mdk-contract.json'),
  dir: path.join(__dirname, '..'),
  connect: async (config) => {
    if (!config.pool) {
      throw new Error('ERR_POOL_REQUIRED')
    }
    return config.pool
  }
}

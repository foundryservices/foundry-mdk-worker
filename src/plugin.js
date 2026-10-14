'use strict'

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

'use strict'

module.exports = {
  plugin: require('./src/plugin'),
  startFoundryWorker: require('./src/boot').startFoundryWorker,
  FOUNDRY_POOL: require('./src/pool')
}

'use strict'

// MDK is not on npm yet: the host installs the monorepo from git and its
// packages are reachable only by path. This is the one file that knows that
// layout. When @tetherto/mdk-core and @tetherto/mdk-worker are published,
// replace these requires with the package names.
const { PoolService } = require('@tetherto/mdk/backend/core/mdk')
const { WorkerRuntime } = require('@tetherto/mdk/backend/core/mdk-worker')
const actions = require('@tetherto/mdk/backend/core/kernel/lib/protocol/actions')
const envelope = require('@tetherto/mdk/backend/core/kernel/lib/protocol/envelope')

module.exports = {
  PoolService,
  WorkerRuntime,
  protocol: { ...actions, ...envelope }
}

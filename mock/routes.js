'use strict'

const {
  DAY_MS,
  generateEarnings,
  generateTransactions,
  generateHashrateHour,
  generateHashrateDay,
  generatePoolStats
} = require('./generators')

const PUBLIC_PATHS = ['/pool_stats', '/ping']

function envelope (status, error, message, path) {
  return { timestamp: new Date().toISOString(), status, error, message, path }
}

function unixRange (query, defaultSpanMs) {
  const now = Date.now()
  const end = +query.endDateUnixMs > 0 ? +query.endDateUnixMs : now
  const start = +query.startDateUnixMs > 0 ? +query.startDateUnixMs : end - defaultSpanMs
  return { start, end }
}

function dayRange (query, defaultSpanMs) {
  const now = Date.now()
  const end = query.end ? Date.parse(`${query.end}T00:00:00Z`) + DAY_MS : now
  const start = query.start ? Date.parse(`${query.start}T00:00:00Z`) : end - defaultSpanMs
  return { start, end }
}

/**
 * The subset of the Foundry API this worker uses, with its auth gate and
 * error envelopes.
 *
 * @param {object} opts
 * @param {Object<string, object>} opts.accounts   sub-account name -> state
 * @param {Object<string, string>} opts.apiKeys    sub-account name -> accepted X-API-KEY
 * @param {string[]} opts.pats                      accepted `fdpat_` bearer tokens (all accounts)
 * @param {number} [opts.delayMs]                   added latency per request
 * @param {boolean} [opts.error]                    answer 500 on every route
 */
module.exports = async function routes (fastify, { accounts, apiKeys, pats, delayMs = 0, error = false }) {
  fastify.addHook('onRequest', async (req, res) => {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    if (error) {
      return res.code(500).send(envelope(500, 'Internal Server Error', 'Internal server error', req.url))
    }
    const path = req.url.split('?')[0]
    if (PUBLIC_PATHS.includes(path)) return

    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
    if (bearer) {
      if (!pats.includes(bearer[1].trim())) {
        return res.code(401).send(envelope(401, 'Unauthorized', 'Invalid or expired personal access token', path))
      }
      req.principal = { pat: true }
      return
    }
    const key = req.headers['x-api-key']
    if (!key) {
      return res.code(403).send(envelope(403, '403 FORBIDDEN', 'Not authenticated', path))
    }
    const owner = Object.keys(apiKeys).find(name => apiKeys[name] === key)
    if (!owner) {
      return res.code(403).send(envelope(403, '403 FORBIDDEN', 'Invalid API key', path))
    }
    req.principal = { account: owner }
  })

  // Resolves the sub-account for a scoped route: unknown name -> 404, a key
  // issued for another sub-account -> 403, as the real API answers.
  const scoped = handler => (req, res) => {
    const name = req.params.subAccountName
    const state = accounts[name]
    if (!state) {
      return res.code(404).send(envelope(404, 'Not Found', `Sub-account ${name} not found`, req.url))
    }
    if (req.principal.account && req.principal.account !== name) {
      return res.code(403).send(envelope(403, '403 FORBIDDEN', 'Forbidden', req.url))
    }
    return handler(req, res, state)
  }

  fastify.get('/ping', async () => 'pong')
  fastify.get('/pool_stats', async () => generatePoolStats())

  fastify.get('/subaccount_stats/:subAccountName', scoped((req, res, state) => res.send(state.stats)))

  fastify.get('/workers/workerCounts/:subAccountName', scoped((req, res, state) => {
    const s = state.stats
    res.send({
      activeWorkers: s.activeWorkers,
      offline15MinWorkerCount: s.offline15MinWorkerCount,
      offline24HrWorkerCount: s.offline24HrWorkerCount,
      offline24HrTo1WkWorkerCount: s.offline24HrTo1WkWorkerCount,
      offline1WkWorkerCount: s.offline1WkWorkerCount
    })
  }))

  fastify.get('/workers/:subAccountName', scoped((req, res, state) => {
    let list = state.workers
    const { tag = 'all', pageNumber = 0, pageSize = -1, workerNameSearchStr = '' } = req.query
    if (tag !== 'all') list = list.filter(w => w.tag === tag)
    if (workerNameSearchStr) list = list.filter(w => (w.workerName || '').includes(workerNameSearchStr))
    const total = list.length
    if (+pageSize > 0) list = list.slice(+pageNumber * +pageSize, (+pageNumber + 1) * +pageSize)
    res.send({ workersList: list, totalWorkerCount: total })
  }))

  fastify.get('/balance/:subAccountName', scoped((req, res, state) => res.send(state.balance)))

  const earnings = scoped((req, res, state) => {
    const { start, end } = unixRange(req.query, 30 * DAY_MS)
    res.send(generateEarnings(start, end, state.hashrateGhs))
  })
  fastify.get('/earnings/:subAccountName', earnings)
  fastify.get('/v2/earnings/:subAccountName', earnings)

  fastify.get('/transactions/:subAccountName', scoped((req, res, state) => {
    const { start, end } = unixRange(req.query, 30 * DAY_MS)
    res.send(generateTransactions(start, end, state.hashrateGhs))
  }))

  fastify.get('/subaccount_hashrate_hour/:subAccountName', scoped((req, res, state) => {
    const { start, end } = unixRange(req.query, DAY_MS)
    res.send(generateHashrateHour(start, end, state.hashrateGhs))
  }))

  fastify.get('/subaccount_hashrate_day/:subAccountName', scoped((req, res, state) => {
    const { start, end } = dayRange(req.query, 30 * DAY_MS)
    res.send(generateHashrateDay(start, end, state.hashrateGhs, state.workers.length))
  }))
}

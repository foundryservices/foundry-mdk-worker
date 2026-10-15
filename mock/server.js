'use strict'

const fastify = require('fastify')
const { parseArgs } = require('node:util')
const createState = require('./state')
const keys = require('./keys')
const routes = require('./routes')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8010

/**
 * Mock of the Foundry USA Pool customer API.
 *
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]         0 picks a free port
 * @param {Object<string, object>} [options.accounts]  name -> state (default: one `test` sub-account)
 * @param {Object<string, string>} [options.apiKeys]   name -> accepted X-API-KEY with financial access
 * @param {Object<string, string>} [options.technicianKeys]  name -> accepted X-API-KEY without financial access
 * @param {string[]} [options.pats]       accepted personal access tokens
 * @param {number} [options.workerCount]  workers under the default sub-account
 * @param {number} [options.delayMs]
 * @param {boolean} [options.error]       answer 500 on every route
 * @param {number} [options.rateLimit]    requests per minute per credential, with the API's headers (default 300)
 * @returns {Promise<{ app: import('fastify').FastifyInstance, apiUrl: string, accounts: object }>}
 */
async function createServer (options = {}) {
  const {
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    workerCount,
    accounts = { [keys.subAccount]: createState({ name: keys.subAccount, workerCount }) },
    apiKeys = { [keys.subAccount]: keys.apiKey },
    technicianKeys = { [keys.subAccount]: keys.technicianKey },
    pats = [keys.pat],
    delayMs,
    error,
    rateLimit
  } = options

  const app = fastify({ logger: false })
  app.register(routes, { accounts, apiKeys, technicianKeys, pats, delayMs, error, rateLimit })

  try {
    const url = await app.listen({ host, port })
    return { app, apiUrl: url, accounts }
  } catch (err) {
    await app.close()
    throw err
  }
}

async function main () {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: DEFAULT_HOST },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      workerCount: { type: 'string' }
    }
  })

  const { apiUrl, app } = await createServer({
    host: values.host,
    port: Number(values.port),
    workerCount: values.workerCount ? Number(values.workerCount) : undefined
  })
  console.log(`Foundry mock listening at ${apiUrl} (sub-account "${keys.subAccount}", X-API-KEY ${keys.apiKey}, technician X-API-KEY ${keys.technicianKey}, PAT ${keys.pat})`)

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => app.close())
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message)
    process.exitCode = 1
  })
}

module.exports = { createServer }

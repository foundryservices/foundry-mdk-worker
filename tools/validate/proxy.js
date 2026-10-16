'use strict'

// Recording proxy: the worker's apiUrl points here, every request is forwarded
// to the real API and the exact response is kept, so expected values are
// computed from the same bytes the worker consumed (no timing skew).
// Credentials are forwarded but never written: records carry a short hash.

const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const fs = require('node:fs')

const PASS_HEADERS = ['content-type', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']

const pick = (headers, names) => Object.fromEntries(names.filter(n => headers[n] !== undefined).map(n => [n, headers[n]]))
const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)

/**
 * @param {object} opts
 * @param {string} opts.upstream  API base URL to forward to
 * @param {string} [opts.file]    JSONL file to append records to
 * @returns {Promise<{ url: string, records: object[], close: () => Promise<void> }>}
 */
function startRecorder ({ upstream, file }) {
  const base = new URL(upstream)
  const transport = base.protocol === 'http:' ? http : https
  const out = file ? fs.createWriteStream(file, { flags: 'a', mode: 0o600 }) : null
  const records = []

  const server = http.createServer((req, res) => {
    const started = Date.now()
    const key = req.headers['x-api-key']
    const bearer = req.headers.authorization
    const headers = { accept: 'application/json', ...(key ? { 'x-api-key': key } : {}), ...(bearer ? { authorization: bearer } : {}) }

    const upstreamReq = transport.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === 'http:' ? 80 : 443),
      method: req.method,
      path: req.url,
      headers
    }, (upstreamRes) => {
      const chunks = []
      upstreamRes.on('data', chunk => chunks.push(chunk))
      upstreamRes.on('end', () => {
        const buf = Buffer.concat(chunks)
        const url = new URL(req.url, 'http://recorder')
        let body
        try { body = JSON.parse(buf.toString('utf8')) } catch { body = buf.toString('utf8') }
        const record = {
          ts: started,
          ms: Date.now() - started,
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          status: upstreamRes.statusCode,
          bytes: buf.length,
          credential: key ? `key:${fingerprint(key)}` : bearer ? `bearer:${fingerprint(bearer)}` : null,
          headers: pick(upstreamRes.headers, PASS_HEADERS),
          body
        }
        records.push(record)
        if (out) out.write(JSON.stringify(record) + '\n')
        res.writeHead(upstreamRes.statusCode, { 'content-type': 'application/json', ...pick(upstreamRes.headers, PASS_HEADERS) })
        res.end(buf)
      })
    })
    upstreamReq.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: `recorder upstream error ${err.code}` }))
    })
    upstreamReq.end()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      records,
      close: () => new Promise(resolve => server.close(() => (out ? out.end(resolve) : resolve())))
    }))
  })
}

module.exports = { startRecorder }

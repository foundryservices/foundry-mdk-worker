'use strict'

// Field-by-field comparison of expected vs actual worker output, and the
// Markdown report. Only keys present on the expected side are compared, so
// MDK's own additions (timestamp, poolType on rows) don't count as drift.

const close = (a, b) => a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

function diff (expected, actual, path = '', out = []) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (!close(expected, actual)) out.push({ path, expected, actual })
    return out
  }
  if (expected === null || typeof expected !== 'object' || actual === null || typeof actual !== 'object') {
    if (expected !== actual) out.push({ path, expected, actual })
    return out
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return out.concat({ path, expected: `array(${expected.length})`, actual: typeof actual })
    if (expected.length !== actual.length) out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length })
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) diff(expected[i], actual[i], `${path}[${i}]`, out)
    return out
  }
  for (const key of Object.keys(expected)) diff(expected[key], actual[key], path ? `${path}.${key}` : key, out)
  return out
}

/** Sections of worker output compared against the expected values. */
function compare (expected, actual) {
  const sections = [
    ['metrics (the 4 MDK telemetry values)', expected.metrics, actual.metrics],
    ['stats rows (ext_data stats)', expected.stats, actual.stats],
    ['worker rows (workers)', expected.workers, actual.workers],
    ['transactions (previous UTC day)', expected.transactions, actual.transactions],
    ['hashrate-history hour', expected.hashrateHour, actual.hashrateHour],
    ['hashrate-history day', expected.hashrateDay, actual.hashrateDay],
    ['pool-stats', expected.poolStats, actual.poolStats]
  ]
  return sections.map(([name, e, a]) => ({ name, mismatches: e === null && a === null ? [] : diff(e, a) }))
}

const fmt = v => (typeof v === 'string' ? v : JSON.stringify(v))

function report ({ label, api, accounts, t0, expected, actual, results, records }) {
  const lines = []
  const failed = results.filter(r => r.mismatches.length)
  lines.push(`# Foundry MDK worker validation: ${label}`, '')
  lines.push(`- API: ${api}`, `- Sub-accounts: ${accounts.join(', ')}`, `- Poll time: ${new Date(t0).toISOString()}`)
  lines.push(`- Result: ${failed.length ? `**${failed.length} section(s) with mismatches**` : '**all sections match**'}`, '')

  lines.push('## Worker output vs expected', '', '| Section | Result |', '|---|---|')
  for (const r of results) lines.push(`| ${r.name} | ${r.mismatches.length ? `${r.mismatches.length} mismatch(es)` : 'match'} |`)
  for (const r of failed) {
    lines.push('', `### ${r.name}`, '', '| Field | Expected | Actual |', '|---|---|---|')
    for (const m of r.mismatches.slice(0, 25)) lines.push(`| \`${m.path}\` | ${fmt(m.expected)} | ${fmt(m.actual)} |`)
    if (r.mismatches.length > 25) lines.push(`| … | ${r.mismatches.length - 25} more | |`)
  }

  if (actual.errors && Object.keys(actual.errors).length) {
    lines.push('', '## Worker errors', '')
    for (const [k, v] of Object.entries(actual.errors)) lines.push(`- ${k}: ${v}`)
  }

  lines.push('', '## Checks', '', '| Sub-account | Check | OK | Detail |', '|---|---|---|---|')
  for (const c of expected.checks) lines.push(`| ${c.account} | ${c.check} | ${c.ok ? 'yes' : '**no**'} | ${fmt(c.detail)} |`)

  lines.push('', '## Requests the worker made', '', '| Path | Status | ms | Bytes | Rate limit remaining |', '|---|---|---|---|---|')
  for (const r of records) lines.push(`| ${r.path} | ${r.status} | ${r.ms} | ${r.bytes} | ${r.headers['x-ratelimit-remaining'] ?? '-'} |`)

  lines.push('', '## Headline values', '')
  for (const [k, v] of Object.entries(actual.metrics)) lines.push(`- ${k}: ${fmt(v)}`)
  return lines.join('\n') + '\n'
}

module.exports = { compare, diff, report }

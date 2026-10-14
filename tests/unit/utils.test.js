'use strict'

const test = require('brittle')
const { parseAccounts, authHeaders } = require('../../src/utils/accounts')
const { toNumber, toOptionalNumber, ghsToHs, optionalGhsToHs, btcToSats } = require('../../src/utils/numbers')
const { toTimestamp, toOptionalTimestamp, dateString, monthKey, previousDay, getMonthlyDateRanges } = require('../../src/utils/dates')
const { getWorkersStats } = require('../../src/utils/workers')
const { GHS } = require('../../src/constants')

test('parseAccounts accepts names with a shared credential and explicit objects', t => {
  const out = parseAccounts({ accounts: ['a', { name: 'b', apiKey: 'kb' }, { name: 'c' }], apiKey: 'shared' })
  t.alike(out, [
    { name: 'a', credential: 'shared' },
    { name: 'b', credential: 'kb' },
    { name: 'c', credential: 'shared' }
  ])
})

test('parseAccounts rejects empty, duplicate and credential-less entries', t => {
  t.exception(() => parseAccounts({}), /ERR_FOUNDRY_ACCOUNTS_REQUIRED/)
  t.exception(() => parseAccounts({ accounts: [] }), /ERR_FOUNDRY_ACCOUNTS_REQUIRED/)
  t.exception(() => parseAccounts({ accounts: [''], apiKey: 'k' }), /ERR_FOUNDRY_ACCOUNTS_INVALID/)
  t.exception(() => parseAccounts({ accounts: [{ apiKey: 'k' }] }), /ERR_FOUNDRY_ACCOUNTS_INVALID/)
  t.exception(() => parseAccounts({ accounts: ['a', 'a'], apiKey: 'k' }), /ERR_FOUNDRY_ACCOUNTS_INVALID/)
  t.exception(() => parseAccounts({ accounts: ['a'] }), /ERR_FOUNDRY_CREDENTIAL_REQUIRED a/)
  t.exception(() => parseAccounts({ accounts: [{ name: 'b', apiKey: ' ' }] }), /ERR_FOUNDRY_CREDENTIAL_REQUIRED b/)
})

test('authHeaders picks Bearer for a personal access token and X-API-KEY otherwise', t => {
  t.alike(authHeaders('fdpat_abc'), { Authorization: 'Bearer fdpat_abc' })
  t.alike(authHeaders('plain-key'), { 'X-API-KEY': 'plain-key' })
})

test('toNumber accepts numbers and decimal strings, rejects everything else', t => {
  t.is(toNumber(1.5, 'f'), 1.5)
  t.is(toNumber('0.00012', 'f'), 0.00012)
  t.is(toNumber('-3', 'f'), -3)
  for (const bad of [undefined, null, '', 'abc', NaN, Infinity, {}, '1e5', true]) {
    t.exception(() => toNumber(bad, 'field'), /ERR_FOUNDRY_DATA field/)
  }
  t.is(toOptionalNumber(undefined, 'f'), null)
  t.is(toOptionalNumber('', 'f'), null)
  t.is(toOptionalNumber('2', 'f'), 2)
  t.exception(() => toOptionalNumber('x', 'f'), /ERR_FOUNDRY_DATA f/)
})

test('ghsToHs converts GH/s to H/s and never fabricates a zero', t => {
  t.is(ghsToHs(100, 'f'), 100 * GHS)
  t.is(ghsToHs('2.5', 'f'), 2.5 * GHS)
  t.exception(() => ghsToHs(undefined, 'f'), /ERR_FOUNDRY_DATA f/)
  t.is(optionalGhsToHs(null, 'f'), null)
  t.is(optionalGhsToHs(1, 'f'), GHS)
})

test('btcToSats rounds to whole satoshis', t => {
  t.is(btcToSats(0.00013927), 13927)
  t.is(btcToSats(1), 100000000)
})

test('toTimestamp parses ISO-with-offset and JDBC timestamps as UTC', t => {
  t.is(toTimestamp('2024-06-28T14:49:05.000+00:00', 'f'), Date.UTC(2024, 5, 28, 14, 49, 5))
  t.is(toTimestamp('2024-06-28 14:49:05.0', 'f'), Date.UTC(2024, 5, 28, 14, 49, 5))
  t.is(toTimestamp(1700000000000, 'f'), 1700000000000)
  t.exception(() => toTimestamp('yesterday', 'f'), /ERR_FOUNDRY_DATA f/)
  t.exception(() => toTimestamp(undefined, 'f'), /ERR_FOUNDRY_DATA f/)
  t.is(toOptionalTimestamp(null, 'f'), null)
})

test('date helpers work in UTC and cross year boundaries', t => {
  const jan15 = Date.UTC(2025, 0, 15, 12)
  t.is(dateString(jan15), '2025-01-15')
  t.is(monthKey(jan15), '1-2025')
  t.alike(previousDay(new Date(jan15)), { start: Date.UTC(2025, 0, 14), end: Date.UTC(2025, 0, 15), date: '2025-01-14' })
  const ranges = getMonthlyDateRanges(jan15)
  t.is(ranges.length, 12)
  t.is(ranges[0].month, '1-2025')
  t.is(ranges[0].start, Date.UTC(2025, 0, 1))
  t.is(ranges[0].end, Date.UTC(2025, 1, 1))
  t.is(ranges[1].month, '12-2024')
  t.is(ranges[11].month, '2-2024')
})

test('getWorkersStats maps Foundry rows to common stats rows', t => {
  const now = Date.UTC(2024, 5, 28, 15, 0, 0)
  const rows = [{
    workerId: '100',
    workerName: '30x41',
    hashrate_5m: 300,
    hashrate_15m: 290,
    hashrate_1h: 280,
    stale_1h: 2,
    reject_1h: 1,
    stale15mPercent: 0.5,
    reject15mPercent: 0,
    lastShareTime: '2024-06-28T14:50:00.000+00:00',
    updatedAt: '2024-06-28T14:59:00.000+00:00',
    tag: 'dc1'
  }, {
    workerId: 101,
    workerName: null,
    hashrate_5m: 0,
    hashrate_15m: 0,
    hashrate_1h: 0,
    lastShareTime: '2024-06-01T00:00:00.000+00:00',
    updatedAt: null
  }]
  const [a, b] = getWorkersStats(rows, 'sub', now)
  t.is(a.username, 'sub')
  t.is(a.id, '100')
  t.is(a.name, '30x41')
  t.is(a.online, 1)
  t.is(a.hashrate, 300 * GHS)
  t.is(a.hashrate_1h, 280 * GHS)
  t.is(a.hashrate_24h, null)
  t.is(a.hashrate_stale_1h, 2 * GHS)
  t.is(a.last_updated, Date.UTC(2024, 5, 28, 14, 59))
  t.is(a.tag, 'dc1')
  t.is(b.id, '101')
  t.is(b.name, '101', 'nameless worker falls back to its id')
  t.is(b.online, 0)
  t.is(b.hashrate_stale_1h, null)
  t.is(b.last_updated, Date.UTC(2024, 5, 1))
  t.is(b.tag, '')
})

test('getWorkersStats rejects a row without an id or with a malformed hashrate', t => {
  t.exception(() => getWorkersStats([{ workerName: 'x', hashrate_5m: 1 }], 'sub'), /ERR_FOUNDRY_DATA worker.workerId/)
  t.exception(() => getWorkersStats([{ workerId: 1, hashrate_5m: 'n/a' }], 'sub'), /ERR_FOUNDRY_DATA worker.hashrate_5m/)
})

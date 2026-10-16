# foundry-mdk-worker

[Tether MDK](https://github.com/tetherto/mdk) worker for the Foundry USA Pool.
It reads hashrate, active workers, unpaid balance, daily earnings and
transaction history for one or more sub-accounts through the Foundry customer
REST API.

Built and tested against MDK v0.10.0.

## Install

MDK is not on the npm registry yet, so both MDK and this worker install from
git. Pin each one to a commit SHA, not a branch. In the project that runs
your MDK host:

```bash
npm install github:tetherto/mdk#<mdk-sha> github:<org>/foundry-mdk-worker#<worker-sha>
npm --prefix node_modules/@tetherto/mdk install --ignore-scripts
```

The second command installs MDK's own dependencies, which npm skips for a git
dependency. The worker declares `@tetherto/mdk` as a peer dependency and
uses the copy your project installs. The worker has no install scripts, so
`--ignore-scripts` is safe for both packages.

## Develop and test

Use Node.js 24 or later and npm 11:

```bash
npm ci --ignore-scripts
npm run setup:mdk
npm test
node examples/mock.js
```

`npm ci` installs the MDK commit this repository pins in `devDependencies`.
Working next to an MDK checkout? `npm run setup:local` replaces that copy with
a symlink to `../mdk` (or `$MDK_DIR`), whose own dependencies must already be
installed. The tests run against a local HTTP mock and a local DHT test
network, so they need no Foundry credentials and no internet access.
`examples/mock.js` starts the mock, polls it once and prints the four metrics
as JSON.

To check a real credential against the API, put it in `FOUNDRY_API_KEY`, name
the sub-account in `FOUNDRY_SUBACCOUNT` and run `node examples/verify-live.js`.
`FOUNDRY_API_URL` points it at another deployment, for example staging. The
script only reads, prints `OK` per metric and exits nonzero if any metric is
unavailable. To compare every field the worker reports with the API's own
responses, use `npm run validate:live`; see
[tools/validate](tools/validate/README.md).

## Usage

`startFoundryWorker` boots one pool device on `WorkerRuntime`. The device ID
is the `workerId`, and every configured sub-account reports through that one
device.

```js
const { startFoundryWorker } = require('foundry-mdk-worker')

async function main () {
  const worker = await startFoundryWorker({
    workerId: 'foundry-site-1',
    rack: 'site-1',
    storeDir: './store/foundry-site-1',
    conf: {
      foundry: {
        accounts: [
          { name: 'subaccount1', apiKey: process.env.FOUNDRY_API_KEY_SUBACCOUNT1 }
        ]
      }
    }
  })

  // Register this public key with your Kernel.
  console.log(worker.runtime.getPublicKey().toString('hex'))
  process.once('SIGINT', () => worker.stop())
  process.once('SIGTERM', () => worker.stop())
}

main().catch(console.error)
```

The package also exports `plugin` and the `FOUNDRY_POOL` manager class. All
imports from MDK go through `src/mdk.js`, the only file that knows the
monorepo layout.

| Boot option | Required | Meaning |
| --- | --- | --- |
| `workerId` | Yes | Unique runtime and device ID |
| `rack` | Yes | Rack identifier, used as the store prefix |
| `storeDir` | Yes | Directory for the persistent store |
| `conf.foundry` | Yes | API settings, see below |
| `root` | No | Directory whose `config/foundry.json`, if present, replaces `conf.foundry` wholesale. With no `root` the lookup is relative to the working directory |
| `kernelTopic` | No | Kernel discovery topic as hex |
| `bootstrap` | No | DHT bootstrap list for a private or test network |

| API setting | Default | Meaning |
| --- | --- | --- |
| `apiUrl` | `https://api.pool.foundrydigital.com` | Base URL, no path |
| `coin` | `BTC` | Only Bitcoin is supported. Any other value fails `init()` |
| `accounts` | Required | Sub-accounts to poll, see below. Foundry has no master account, so the list cannot be empty |
| `apiKey` | none | Default credential for accounts that do not carry their own |

`accounts` entries are a sub-account name sharing `apiKey`, or
`{ name, apiKey }` with their own credential. `init()` rejects duplicate or
empty names and an account with no credential. Keep credentials in an ignored
local config file or in environment variables.

### Credentials

The API accepts two credential types; the worker picks the header from the
value:

- **Sub-account API key** (Sub-account → Links & API tab in the pool UI), sent as
  `X-API-KEY`. Foundry issues these per sub-account and a key only ever sees
  the sub-account it was issued for, so each entry needs its own. Create the
  key with **financial** access: a technician key authenticates but is
  refused on the balance, earnings and transaction endpoints, see below.
- **Personal access token** (My Profile → Personal Access Token tab),
  recognised by its `fdpat_` prefix and sent as `Authorization: Bearer`. A
  token is user-scoped and read-only, so one token in `apiKey` can cover every
  sub-account its user can see.

A credential without financial access still works, with less data. The
worker notices when `/subaccount_stats` succeeds and `/balance`,
`/v2/earnings` or `/transactions` then answer 403 with the same credential.
It keeps polling, reports the hashrate and worker figures, sets `balance`,
`revenue_24h`, `estimated_today_income` and the lifetime totals to `null`,
leaves `yearlyBalances` empty, marks the account `financial_access: false`,
and logs `WARN_FOUNDRY_FINANCIAL <sub>` once. The `balance` and
`estimated_earnings` metrics answer `E_POOL_API` for as long as that lasts;
`hashrate` and `workers_online` are unaffected. Swap in a financial key and
the next poll fills the fields back in.

## Telemetry

| Metric | Unit | Source |
| --- | --- | --- |
| `hashrate` | H/s | `hashrate5minAvg` from `/subaccount_stats`, converted from GH/s |
| `workers_online` | Count | `activeWorkers` from `/subaccount_stats`: a share in the last 15 minutes |
| `balance` | BTC | `balance` from `/balance`, the unpaid credited balance |
| `estimated_earnings` | BTC | Latest settled FPPS day from `/v2/earnings`, scaled by hashrate (below) |

Foundry adds FPPS earnings to your balance once a day, shortly after 01:00
UTC, for the previous day. There is no earnings figure for today.

- `revenue_24h` is yesterday's earnings. Before 01:00 UTC, yesterday's
  earnings aren't in yet, so it shows the day before yesterday.
- `estimated_earnings` is `revenue_24h` adjusted for your hashrate now. If
  your hashrate is 10% higher than on that day, the estimate is 10% higher.
  Without a hashrate to compare, it equals `revenue_24h`.

Statistics refresh every minute and the list of online workers (a share in
the last 15 minutes) every five minutes. If a
poll is still running when the next tick fires, the tick joins the running
poll instead of starting another. Metric handlers answer `E_POOL_API` until
the first successful poll, after a failed poll, and whenever the snapshot is
older than three minutes.

A poll either completes for every configured sub-account or fails. A
rejected credential, an unknown sub-account or a malformed field fails the
poll, the error and the log name the sub-account, and the metrics answer
`E_POOL_API` until a clean poll. The worker never sums the sub-accounts that
happened to work and reports that as the total, and it never substitutes
zero for a reading it did not get. The exception is a credential without
financial access, described under Credentials: the poll completes with the
money fields `null`. The one place a zero can stand in for an
absence is the earnings ledger. `revenue_24h` and `estimated_today_income`
show `0` for a day with no earnings, such as a day with no mining. They also
show `0` if Foundry's daily earnings run is late, until it finishes.
The `stats` extension keeps the last good snapshot while polls fail
and carries `error`, the last failure message, or `null`; nothing is written
to the stats history while the snapshot is failed.

The `stats` extension carries the per-account values: the common fields
(`username`, `balance`, `unsettled`, `revenue_24h`, `estimated_today_income`,
`hashrate`, `hashrate_1h`, `hashrate_24h`, `hashrate_stale_1h`,
`worker_count`, `active_workers_count`, `yearlyBalances`) plus Foundry extras
(`hashrate_15m`, `hashrate_reject_1h`, `offline_workers_count`,
`last_share_time`, `total_earned`, `total_withdrawn`, `total_pool_fees`,
`financial_access`). Per-worker rows cover the online workers and
add `hashrate_15m`, `stale_15m_percent`, `reject_15m_percent` and `tag`.
`unsettled` and `hashrate_stale_24h` are `null` because the API does not
expose them. `worker_count` is every worker the pool knows for the
sub-account, online or offline: `active_workers_count` plus
`offline_workers_count`. `yearlyBalances` holds earnings per month for the
current month and the eleven before it, from one ledger call per sub-account,
cached for an hour and refreshed on month rollover. Each day counts toward
the month it was earned in, even though the last day of a month is credited
on the 1st. Every hashrate is in H/s; the API reports GH/s.

Amounts become JavaScript numbers at the MDK boundary. Treat them as
telemetry, not as figures for accounting or transaction signing.

### Extra `ext_data` keys

On top of the base set (`stats`, `stats-history`, `workers`, `workers-count`,
`transactions`):

| Key | Query | Returns |
| --- | --- | --- |
| `hashrate-history` | `start`, `end` (ms), `interval: 'hour' \| 'day'` | Pool-side hashrate series per sub-account, live from the API |
| `pool-stats` | none | Pool-wide live figures from `/pool_stats`, no sub-account scope |

## Transaction history

The daily job runs at midnight UTC and stores the transactions of the day
that just ended, keyed by that day's UTC start. Each record has the
sub-account, the Foundry transaction type (`FPPS`, `Auto-Withdraw`, ...), the
amount in BTC (negative for debits), the time it was created in Unix
seconds, the transaction ID and payout address when Foundry supplies them, and
`satoshis_net_earned` for credits. That last field is what the base service's
hourly revenue aggregation sums, so
`getWrkExtData({ query: { key: 'transactions', start, end, aggrHourly: true } })`
works. Debits contribute zero to it.

A day's `FPPS` credit is created early the next UTC day, so it lands in the
next day's record. A withdrawal belongs to the day it was created: one
created before midnight UTC and confirmed after it stays in the earlier day,
and its `created_at` is the creation, not the confirmation.

The F2Pool and Ocean workers key daily records by the host's local midnight.
This worker keys them by UTC midnight, because Foundry settles and ledgers
per UTC day. On a host that runs in UTC all three behave the same.

Blocks are not fetched. `GET /blocks` needs an admin credential that a
customer credential does not carry.

## Requests

Every call is a GET with `coin=BTC` and the credential header. All calls,
including history pages, go through one queue that spaces them 250 ms
apart, which keeps one worker under the API's limit of 300 requests per
minute. The limit is per API key, or per user for a personal access token,
not per IP. Several processes using the same credential share that budget,
and nothing in the worker coordinates them. Every response reports the
budget in `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset` (unix seconds). When `remaining` reaches zero the next
request on that credential waits for the reset, and a 429 waits for the
reset (or `retry-after`) and is retried twice before it fails the poll as
`RATE_LIMITED`. No wait exceeds 65 seconds. Because the request queue is
serial, a paused credential also holds the others; one worker on its own
never spends the budget, so a pause means something else is using the same
credential. Requests time
out after 30 seconds, abort when the worker stops, and do not follow
redirects. Error messages carry the API's short error message ("Invalid API
key", "Not authenticated"), or the socket error code when no response
arrived, but no response bodies and no request headers.

Endpoints used: `/subaccount_stats/{sub}`, `/workers/{sub}`, `/balance/{sub}`,
`/v2/earnings/{sub}`, `/transactions/{sub}`, `/subaccount_hashrate_hour/{sub}`,
`/subaccount_hashrate_day/{sub}`, `/pool_stats`.

## Health and troubleshooting

The contract declares `OK`, `DEGRADED` and `OFFLINE`, plus
`alert.pool_unreachable` and `alert.hashrate_low`, same as the other pool
workers. The runtime health ping only says whether the process is reachable.
It does not call the Foundry API, so watch the metric errors and the poll log
for API trouble.

| Message | Meaning |
| --- | --- |
| `ERR_FOUNDRY_ACCOUNTS_REQUIRED` | `conf.foundry.accounts` is missing or empty |
| `ERR_FOUNDRY_ACCOUNTS_INVALID` | An entry has no name, or two entries share one |
| `ERR_FOUNDRY_CREDENTIAL_REQUIRED <sub>` | That entry has no `apiKey` and no default |
| `ERR_FOUNDRY_API_URL_INVALID` | `apiUrl` is not a plain http(s) URL |
| `ERR_FOUNDRY_COIN_UNSUPPORTED` | `coin` is not `BTC` |
| `ERR_FOUNDRY_ACCOUNT <sub>: ...` | That sub-account's part of a poll failed; the rest of the message says why |
| `ERR_FOUNDRY_API <path> 401 AUTH (Invalid API key)` or `403 AUTH (Invalid API key)` | The credential is unknown to this deployment. Check it was issued on the same environment |
| `ERR_FOUNDRY_API <path> 401 AUTH (API key expired)` | The API key passed the expiry set when it was created. Create a new one or rotate it under Links & API |
| `ERR_FOUNDRY_API <path> 403 AUTH (Not authenticated)` | No credential reached the API |
| `ERR_FOUNDRY_API <path> 401 AUTH (...)` | Invalid or expired personal access token |
| `ERR_FOUNDRY_API <path> 404 NOT_FOUND` | Unknown sub-account |
| `ERR_FOUNDRY_API <path> 429 RATE_LIMITED` | Still rate limited after waiting for the window reset and retrying twice; another process is using the same credential's 300 requests per minute |
| `WARN_FOUNDRY_FINANCIAL <sub>: ... 403 AUTH (API key provided does not have permission to view payments.)` | A technician key: it authenticates but lacks financial access, so the money fields are `null` until a financial key is configured |
| `WARN_FOUNDRY_FINANCIAL <sub>: ... 403 AUTH (Insufficient privileges. Requires viewPayments ...)` | A personal access token whose user cannot view payments on that sub-account, so the money fields are `null` |
| `ERR_FOUNDRY_API <path> 0 REQUEST_FAILED (ECONNREFUSED)` | No response: DNS, connection or TLS failure, or the 30 s timeout (`request-timeout`). Check `apiUrl` and outbound HTTPS |
| `ERR_FOUNDRY_API <path> 200 INVALID_RESPONSE` | The server answered, but not in the documented shape |
| `ERR_FOUNDRY_API <path> 200 TRUNCATED_WORKERS` | The worker list came back shorter than the total the API reported |
| `ERR_FOUNDRY_DATA <field>` | A field in an otherwise valid response is missing or malformed |
| `E_POOL_API` | The last poll failed or the snapshot is stale; look at the poll log first |

Before escalating low hashrate, compare it with what the miners themselves
report.

## Mock

```bash
npm run mock
```

The mock listens on `127.0.0.1:8010` and serves the routes above with the
API's auth gate and error envelopes: 403 `Not authenticated` without a
credential, 403 `Invalid API key` for an unknown key, 401 for an unknown
personal access token, 403 for a key issued to another sub-account, 403
`API key provided does not have permission to view payments.` on the
balance, earnings and transaction routes for a technician key, 404 for an unknown sub-account, and 429 with the `x-ratelimit-*` headers
once a credential exceeds `rateLimit` requests in a minute (default 300). The fixtures in `mock/keys.js` are
public and do not work against Foundry. In tests, `createServer({ port: 0 })`
picks a free port and returns the server handle. The options `accounts`,
`apiKeys`, `technicianKeys`, `pats`, `workerCount`, `delayMs`, `error` and
`rateLimit` shape the mock's behaviour.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

Copyright 2026 Foundry Digital LLC. Licensed under the
[Apache License, Version 2.0](LICENSE). Portions are adapted from
[Tether MDK](https://github.com/tetherto/mdk); see [NOTICE](NOTICE).

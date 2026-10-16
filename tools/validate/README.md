# Validation tools

Checks that the worker reports exactly what the Foundry API says. Nothing here
ships in the npm package.

## Live comparison

```bash
node tools/validate/live.js --account <sub-account>=<key file> [--account ...] \
  [--api <base url>] [--label <name>] [--out <dir>]
```

Each key file holds one API key or personal access token. The script runs the
worker through a local recording proxy, polls once (workers, stats,
transactions, hashrate history, pool stats), and compares every field of the
output with values computed independently from the recorded responses. It
prints a summary, writes `report.md`, and exits nonzero on any mismatch.

`--out` defaults to a new folder in the OS temp directory. The recorded
responses (`api.jsonl`) are your account's real data, including payout
addresses: keep them out of the repository and delete them when done.
Credentials are never written; the recording keeps only a short hash of each.

- `proxy.js`: the recording proxy.
- `expected.js`: expected output derived from the recorded responses and the
  README. It shares no code with `src/`, so a bug copied into both sides
  cannot pass.
- `compare.js`: the field-by-field diff and the report.

The report also lists API-level checks (for example, balance totals adding up
and worker counts agreeing). A failure there points at the API, not the worker.

## Fake-clock scenarios

`scenarios.js` replays crafted API responses for edge cases at a fixed time:
before and after the daily earnings run, a late run, month rollover, a
withdrawal confirmed after midnight, truncated and malformed responses, 401,
and a 429 retry. `tests/integration/scenarios.test.js` runs them with
`npm test`.

'use strict'

// Fake-clock scenarios (tools/validate/scenarios.js): each one replays crafted
// API responses for an edge case and checks the worker's output against
// independently computed expected values and the README's promises.

const test = require('brittle')
const { FOUNDRY_POOL } = require('../..')
const { SCENARIOS, runScenario } = require('../../tools/validate/scenarios')

for (const scenario of SCENARIOS) {
  test(`${scenario.id}: ${scenario.title}`, { timeout: 30000 }, async (t) => {
    const { promises, drift } = await runScenario(FOUNDRY_POOL, scenario)
    for (const p of promises) {
      t.ok(p.ok, `${p.what} (got ${JSON.stringify(p.got)})`)
    }
    for (const section of drift) {
      const first = section.mismatches[0]
      t.fail(`${section.name}: ${section.mismatches.length} mismatch(es), first ${first.path} expected ${JSON.stringify(first.expected)} actual ${JSON.stringify(first.actual)}`)
    }
  })
}

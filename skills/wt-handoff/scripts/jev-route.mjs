#!/usr/bin/env node
// Should this handoff go to a planner instead of a worker? Asks Jev one Noul question over the prompt (stdin).
// Prints one JSON line: {"role":"planner","p":0.82} or {"role":"worker","p":0.12}; {"role":"worker","p":null}
// when WT_JEV_ROUTE is off or Jev gives nothing (no key, timeout, error). Always exits 0: routing never blocks.
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { judge, enabled, minFor } from '../../wt-shared/scripts/typesafe.mjs'

export const route = {
  questions: () => ({ plan: { type: 'noul', instructions: 'Does this request need an implementation plan before any code is written?',
    criteria: { true: 'It is a feature, multi-step change or open design question where the approach must be worked out first.',
      false: 'It is a clear, bounded task (a fix, a tweak, a check, or implementing an existing plan) a worker can just do.' } } }),
  decide: (a, min = 0.75) => ((a?.plan?.noul ?? 0) >= min ? 'planner' : 'worker'),
}

async function main() {
  const prompt = readFileSync(0, 'utf8').trim()
  if (!prompt || !enabled('route', true)) return console.log(JSON.stringify({ role: 'worker', p: null }))
  const min = minFor('route', 0.75)
  const a = await judge('route', { request: prompt.slice(0, 4000) }, route.questions(), { pick: (x) => route.decide(x, min) === 'planner' })
  console.log(JSON.stringify({ role: a ? route.decide(a, min) : 'worker', p: a ? Math.round((a.plan?.noul ?? 0) * 100) / 100 : null }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => { console.error(e); console.log('{"role":"worker","p":null}') })

#!/usr/bin/env node
// Accuracy and latency of one Jev feature on its labelled fixture:
//   node wt-shared/scripts/jev-eval.mjs <feature>
// Fixture: wt-shared/jev-fixtures/<feature, _ as ->.json = [{state, expect}]. The feature's evaluator module
// (EVALUATORS below) exports questions(state) + decide(answers) — the same pair production uses.
// Exit 3 without a key (same contract as the rest of typesafe.mjs).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { judge, keyFor, NO_KEY } from './typesafe.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pack = join(here, '..', '..')
// feature → 'module#export' relative to the pack root; the export is {questions(state), decide(answers)}.
// Each feature unit adds its line.
export const EVALUATORS = {
  room_resolve: 'wt-dashboard/rooms.mjs#roomResolve',
  needs_you: 'wt-dashboard/server.mjs#needsYouJudge',
  stall: 'wt-dashboard/server.mjs#stallJudge',
  route: 'wt-handoff/scripts/jev-route.mjs#route',
  memory_dup: 'wt-memory/scripts/jev-memory.mjs#memoryDup',
  memory_suggest: 'wt-memory/scripts/jev-memory.mjs#memorySuggest',
  triage: 'wt-shared/scripts/jev-triage.mjs#triageClass',
  inbox_rank: 'wt-dashboard/inbox.mjs#inboxRank',
  ticket_triage: 'wt-dashboard/ticketJev.mjs#ticketType',
}

const feature = process.argv[2]
if (!feature || !EVALUATORS[feature]) {
  console.error(`usage: jev-eval.mjs <${Object.keys(EVALUATORS).join('|') || 'feature'}>`)
  process.exit(2)
}
const key = keyFor()
if (!key) { console.error('no TYPESAFE_API_KEY'); process.exit(NO_KEY) }
const [mod, name] = EVALUATORS[feature].split('#')
const { questions, decide } = (await import(pathToFileURL(join(pack, mod)).href))[name]
const cases = JSON.parse(readFileSync(join(here, '..', 'jev-fixtures', `${feature.replaceAll('_', '-')}.json`), 'utf8'))
const ms = [], wrong = []
let right = 0, failed = 0
for (const [i, c] of cases.entries()) {
  const t0 = Date.now()
  const a = await judge(`eval:${feature}`, c.state, questions(c.state), { key, timeoutMs: 10000 })
  ms.push(Date.now() - t0)
  if (a == null) { failed++; continue }
  const got = decide(a)
  if (JSON.stringify(got) === JSON.stringify(c.expect)) right++
  else wrong.push({ i, expect: c.expect, got })
}
ms.sort((a, b) => a - b)
const q = (f) => ms[Math.min(ms.length - 1, Math.floor(f * ms.length))]
console.log(JSON.stringify({ feature, n: cases.length, accuracy: +(right / Math.max(1, cases.length - failed)).toFixed(2), failed, p50ms: q(0.5), p95ms: q(0.95), wrong }))
process.exit(0) // an evaluator module may hold timers (server.mjs)

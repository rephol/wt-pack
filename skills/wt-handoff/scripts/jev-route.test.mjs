// node --test: the route decision, and handoff.sh --dry-run routing with a fake herdr (no Jev call is made:
// the switch is off, the prompt is wt-plan's own, or --role forces it).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { route } from './jev-route.mjs'

const here = dirname(fileURLToPath(import.meta.url))
test('route: planner at or above 0.75, worker below or with no answer', () => {
  assert.equal(route.decide({ plan: { noul: 0.82 } }), 'planner')
  assert.equal(route.decide({ plan: { noul: 0.74 } }), 'worker')
  assert.equal(route.decide(null), 'worker')
})

// WP-162: this file's "wt-plan's own prompt" test runs handoff.sh with a deliberately fake TYPESAFE_API_KEY,
// which still hits model-route.mjs's real network Jev call (shadow mode logs but doesn't apply); with no
// WT_JEV_LOG override that 401 landed in the real ~/.local/share/wt-dashboard/jev-calls.jsonl production log.
const jevLog = join(mkdtempSync(join(tmpdir(), 'jev-route-test-')), 'jev.jsonl')
const bin = mkdtempSync(join(tmpdir(), 'fake-herdr-'))
writeFileSync(join(bin, 'herdr'), `#!/bin/sh
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "agent list") echo '{"result":{"agents":[]}}' ;;
  *) echo '{}' ;;
esac
`)
chmodSync(join(bin, 'herdr'), 0o755)
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'route-repo-')))
execFileSync('git', ['init', '-q', repo])
const wt = join(repo, 'sub'); execFileSync('mkdir', ['-p', wt])
const run = (args, prompt, env = {}) => execFileSync('sh', [join(here, 'handoff.sh'), '--dry-run', ...args, wt], {
  input: prompt, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HERDR_PANE_ID: '', WT_AGENTS_MCP: 'full', WT_JEV_LOG: jevLog, ...env } })

test('handoff --dry-run: switch off → a worker in cwd, no route line (unchanged behaviour)', () => {
  const out = run([], 'build the thing', { WT_JEV_ROUTE: 'off' })
  assert.match(out, new RegExp(`^dry-run: would spawn a worker in ${wt}$`, 'm'))
  assert.doesNotMatch(out, /route:/)
})
test("handoff --dry-run: wt-plan's own prompt is never re-routed", () => {
  const out = run([], 'Use wt-work to implement docs/plans/x.md to its Definition of Done.', { WT_JEV_ROUTE: 'on', TYPESAFE_API_KEY: 'x' })
  assert.match(out, /would spawn a worker in /)
  assert.doesNotMatch(out, /route:/)
  // WP-162: the fake key still reaches model-route.mjs's own (unrelated) Jev call in shadow mode, which must
  // log to the isolated tmp path above, never the real dashboard log.
  assert.match(readFileSync(jevLog, 'utf8'), /"outcome":"auth_error"/)
})
test('handoff --dry-run: --role planner targets a planner in the main checkout', () => {
  assert.match(run(['--role', 'planner'], 'anything'), new RegExp(`^dry-run: would spawn a planner in ${repo}$`, 'm'))
})

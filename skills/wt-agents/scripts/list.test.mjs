// Run: node --test skills/wt-agents/scripts/list.test.mjs — WP-173: `list`/`list --json` surface dnd (+until) and pair.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
const tmp = mkdtempSync(join(tmpdir(), 'wt-list-'))
const bin = join(tmp, 'bin')
mkdirSync(bin)
writeFileSync(join(bin, 'herdr'), `#!/bin/sh
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"label":"demo-workers","workspace_id":"w1"}]}}' ;;
  "agent list") echo '{"result":{"agents":[
    {"name":"demo-worker-01","pane_id":"w1:p1","agent_status":"idle","cwd":"/repo","workspace_id":"w1"},
    {"name":"demo-worker-02","pane_id":"w1:p2","agent_status":"idle","cwd":"/repo","workspace_id":"w1"},
    {"name":"demo-worker-03","pane_id":"w1:p3","agent_status":"idle","cwd":"/repo","workspace_id":"w1"}
  ]}}' ;;
  "pane list") echo '{"result":{"panes":[
    {"pane_id":"w1:p2","tokens":{"dnd":"1"}},
    {"pane_id":"w1:p3","tokens":{"dnd":"2099-01-01T00:00:00.000Z","pair":"WP-9"}}
  ]}}' ;;
  *) echo '{"result":{}}' ;;
esac
`)
chmodSync(join(bin, 'herdr'), 0o755)

const run = (args) => spawnSync(join(here, 'agents.sh'), args, { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, WT_AGENTS_WORKSPACE: 'demo-workers' } })

test('list: plain output marks dnd (with expiry) and pair, off agents unmarked', () => {
  const r = run(['list', 'worker'])
  assert.equal(r.status, 0, r.stderr)
  const rows = Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const c = l.split('\t'); return [c[0], c] }))
  assert.deepEqual(rows['demo-worker-01'].slice(4), ['-', '-'])
  assert.deepEqual(rows['demo-worker-02'].slice(4), ['dnd', '-'])
  assert.deepEqual(rows['demo-worker-03'].slice(4), ['dnd until 2099-01-01T00:00:00.000Z', 'WP-9'])
})

test('list --json: exposes structured dnd:{on,until} and pair alongside raw tokens', () => {
  const r = run(['list', 'worker', '--json'])
  assert.equal(r.status, 0, r.stderr)
  const rows = Object.fromEntries(r.stdout.trim().split('\n').map((l) => { const o = JSON.parse(l); return [o.name, o] }))
  assert.deepEqual(rows['demo-worker-01'].dnd, { on: false, until: null })
  assert.equal(rows['demo-worker-01'].pair, null)
  assert.deepEqual(rows['demo-worker-02'].dnd, { on: true, until: null })
  assert.deepEqual(rows['demo-worker-03'].dnd, { on: true, until: '2099-01-01T00:00:00.000Z' })
  assert.equal(rows['demo-worker-03'].pair, 'WP-9')
  // raw tokens map is untouched, for backward compat
  assert.equal(rows['demo-worker-03'].tokens.dnd, '2099-01-01T00:00:00.000Z')
})

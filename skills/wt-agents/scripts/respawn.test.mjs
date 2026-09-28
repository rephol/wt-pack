// Run: node --test skills/wt-agents/scripts/respawn.test.mjs — WP-125: respawn keeps name/role/cwd/session/tokens
// in a NEW tab (the kill shims are tab-create env), refuses a working agent without --force; --stale picks only
// agents whose claude lacks the shim.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
const tmp = mkdtempSync(join(tmpdir(), 'wt-respawn-'))
const bin = join(tmp, 'bin'), log = join(tmp, 'calls.log'), repo = join(tmp, 'demo'), agents = join(tmp, 'agents.json')
mkdirSync(bin); mkdirSync(repo); mkdirSync(join(tmp, '.claude', 'projects', 'x'), { recursive: true })
writeFileSync(join(tmp, '.claude', 'projects', 'x', 's-old.jsonl'), '{}\n')
writeFileSync(join(tmp, '.claude', 'projects', 'x', 's-ok.jsonl'), '{}\n')
const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${log}\n${body}\n`); chmodSync(join(bin, name), 0o755) }
stub('herdr', `case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"label":"demo-workers","workspace_id":"w1"},{"label":"other-workers","workspace_id":"w2"}]}}' ;;
  "agent list") printf '{"result":{"agents":%s}}' "$(cat ${agents})" ;;
  "agent get") jq -c --arg p "$3" '{result:{agent:(.[] | select(.pane_id == $p))}}' ${agents} ;;
  "tab create") echo '{"result":{"root_pane":{"pane_id":"w1:p9"}}}' ;;
esac`)
// Fake process table: old agent has no shim env, ok agent has it.
stub('ps', `case "$*" in
  "-axo pid=,command=") printf '101 /usr/bin/claude --name demo-worker-01\\n102 claude --name demo-worker-02 --resume x\\n' ;;
  *"-p 101"*) echo "claude --name demo-worker-01 PATH=/usr/bin" ;;
  *"-p 102"*) echo "claude --name demo-worker-02 WT_KILL_SHIM_DIR=/x/wt-agents/bin" ;;
esac`)
execFileSync('git', ['-C', repo, 'init', '-q'])
const row = (n, status, session, extra = {}) => ({ name: `demo-worker-0${n}`, pane_id: `w1:p${n}`, tab_id: `w1:t${n}`, workspace_id: 'w1',
  agent_status: status, cwd: repo, agent_session: { kind: 'id', value: session }, tokens: { role: 'worker', project: 'demo', created: '2026-01-01', ...extra } })
const setAgents = (a) => writeFileSync(agents, JSON.stringify(a))

const run = (args) => {
  rmSync(log, { force: true })
  const r = spawnSync(join(here, 'agents.sh'), args, { cwd: repo, encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, XDG_CACHE_HOME: tmp, WT_DASHBOARD_DATA: tmp, WT_DASHBOARD_ENV: join(tmp, 'env') } })
  return { ...r, calls: (() => { try { return readFileSync(log, 'utf8').split('\n') } catch { return [] } })() }
}
const idx = (calls, re) => calls.findIndex((l) => re.test(l))

test('respawn <name>: closes the old tab first, new tab has the shims, resumes under the same name, carries tokens', () => {
  setAgents([row(1, 'idle', 's-old', { task: 'WP-9 fix', ticket: 'WP-9' })])
  const r = run(['respawn', 'demo-worker-01'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'demo-worker-01 w1:p9')
  const close = idx(r.calls, /^herdr tab close w1:t1/), create = idx(r.calls, /^herdr tab create/), start = idx(r.calls, /^herdr agent start/)
  assert.ok(close >= 0 && close < create && create < start)
  assert.match(r.calls[create], /--env WT_KILL_SHIM_DIR=\S+\/bin/)
  assert.match(r.calls[start], /agent start demo-worker-01 .*--name demo-worker-01 --resume s-old/)
  assert.ok(r.calls.some((l) => /report-metadata w1:p9 .*--token task=WP-9 fix/.test(l)))
  assert.ok(r.calls.some((l) => /report-metadata w1:p9 .*--token ticket=WP-9/.test(l)))
  assert.ok(!r.calls.some((l) => /--token created=2026-01-01/.test(l)))
})

test('respawn refuses a working agent without --force; no transcript → fresh start', () => {
  setAgents([row(1, 'working', 's-old')])
  let r = run(['respawn', 'w1:p1'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /is working; re-run with --force/)
  assert.ok(!r.calls.some((l) => l.startsWith('herdr tab close')))
  setAgents([row(1, 'working', 's-none')])
  r = run(['respawn', 'w1:p1', '--force'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /no transcript/)
  assert.doesNotMatch(r.calls[idx(r.calls, /^herdr agent start/)], /--resume/)
})

test('respawn --stale: only the agent whose claude lacks the shim', () => {
  setAgents([row(1, 'idle', 's-old'), row(2, 'idle', 's-ok')])
  const r = run(['respawn', '--stale'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^respawned demo-worker-01 w1:p9 \(no kill shim\)$/m)
  assert.doesNotMatch(r.stdout, /demo-worker-02/)
  assert.ok(!r.calls.some((l) => /pgrep|pkill/.test(l)))
})

test('WP-143: respawn passes --model/--effort from the old tokens, and does not carry them as plain tokens too', () => {
  setAgents([row(1, 'idle', 's-old', { model: 'opus', effort: 'high' })])
  const r = run(['respawn', 'demo-worker-01'])
  assert.equal(r.status, 0, r.stderr)
  const start = r.calls[idx(r.calls, /^herdr agent start/)]
  assert.match(start, /--model claude-opus-5-5/) // WP-158: the old tier's explicit id, not the bare alias
  assert.match(start, /--effort high/)
  assert.ok(!r.calls.some((l) => /report-metadata w1:p9 .*--token model=/.test(l) && !l.includes('--token model=opus')))
  assert.ok(!r.calls.some((l) => /report-metadata w1:p9 .*--token effort=/.test(l) && !l.includes('--token effort=high')))
})

test('respawn --stale: nothing stale; working agent is skipped and reported', () => {
  setAgents([row(2, 'idle', 's-ok')])
  assert.equal(run(['respawn', '--stale']).stdout.trim(), 'no stale agents')
  setAgents([row(1, 'working', 's-old')])
  assert.match(run(['respawn', '--stale']).stdout, /^skipped demo-worker-01: .*is working/m)
})

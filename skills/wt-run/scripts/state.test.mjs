// Run: node --test skills/wt-run/scripts/state.test.mjs — WP-368 run-state. No dashboard, no panes: a temp dir only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const script = join(import.meta.dirname, 'state.mjs')
const dir = mkdtempSync(join(tmpdir(), 'wt-run-'))
// HERDR_DASH_URL on a closed port: nothing here may reach a live dashboard.
const env = { ...process.env, WT_LEAD_DIR: dir, HERDR_DASH_URL: 'http://127.0.0.1:9' }
const run = async (...args) => {
  try { const r = await exec('node', [script, '--repo', 'demo', ...args], { env }); return { code: 0, out: r.stdout.trim(), err: r.stderr } }
  catch (e) { return { code: e.code, out: (e.stdout || '').trim(), err: e.stderr || '' } }
}
const file = join(dir, 'demo', 'WP-1.json')

test('init creates the file once and next starts at plan', async () => {
  const r = await run('init', 'WP-1')
  assert.equal(r.out, file)
  await run('set', 'WP-1', 'branch', 'wp-1-x')
  await run('init', 'WP-1')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).branch, 'wp-1-x', 'init does not reset')
  assert.equal((await run('next', 'WP-1')).out, 'run plan')
})

test('get, set parse JSON, dotted keys, strings', async () => {
  await run('set', 'WP-1', 'units', '[{"id":"U1","owner":"wt-engineer"}]')
  await run('set', 'WP-1', 'plan', 'docs/plans/WP-1.md')
  assert.equal((await run('get', 'WP-1', 'units.0.owner')).out, 'wt-engineer')
  assert.equal((await run('get', 'WP-1', 'plan')).out, 'docs/plans/WP-1.md')
  assert.equal((await run('get', 'WP-1', 'nope')).out, 'null')
})

test('phases run in order and stop at each gate', async () => {
  await run('start', 'WP-1', 'plan')
  assert.equal((await run('get', 'WP-1', 'phase')).out, 'plan')
  await run('done', 'WP-1', 'plan')
  assert.equal((await run('next', 'WP-1')).out, 'open gate A')
  await run('gate', 'WP-1', 'A', 'open', '--packet', 'docs/plans/WP-1.md')
  assert.equal((await run('next', 'WP-1')).out, 'wait gate A')
  assert.equal((await run('gate', 'WP-1', 'A')).out, 'open')
  assert.equal((await run('gate', 'WP-1', 'A', 'approve')).out, 'approved')
  assert.equal((await run('next', 'WP-1')).out, 'run work')
  for (const p of ['work', 'review', 'qa']) await run('done', 'WP-1', p)
  assert.equal((await run('next', 'WP-1')).out, 'open gate B')
})

test('a gate that is not open cannot be approved or rejected', async () => {
  const r = await run('gate', 'WP-1', 'C', 'approve')
  assert.equal(r.code, 1)
  assert.match(r.err, /not open/)
})

test('rejecting gate B reruns work, review and qa', async () => {
  await run('gate', 'WP-1', 'B', 'open')
  await run('gate', 'WP-1', 'B', 'reject', 'copy is wrong')
  const st = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(st.gates.B.rejected, 'copy is wrong')
  assert.deepEqual(['work', 'review', 'qa'].map((p) => st.phases[p].status), ['pending', 'pending', 'pending'])
  assert.equal(st.phases.plan.status, 'done', 'earlier phases are kept')
  assert.equal((await run('next', 'WP-1')).out, 'run work')
})

test('a full run ends finished', async () => {
  for (const p of ['work', 'review', 'qa']) await run('done', 'WP-1', p)
  for (const g of ['B']) { await run('gate', 'WP-1', g, 'open'); await run('gate', 'WP-1', g, 'approve') }
  for (const p of ['ship', 'babysit']) await run('done', 'WP-1', p)
  await run('gate', 'WP-1', 'C', 'open'); await run('gate', 'WP-1', 'C', 'approve')
  assert.equal((await run('next', 'WP-1')).out, 'finished')
})

test('writes are atomic (no tmp left) and a missing state errors', async () => {
  assert.deepEqual(readdirSync(join(dir, 'demo')), ['WP-1.json'])
  const r = await run('get', 'WP-9')
  assert.equal(r.code, 1)
  assert.match(r.err, /no run-state/)
})

test('bad ticket ids, repos, keys and phases are refused', async () => {
  assert.equal((await run('init', '../x')).code, 2)
  assert.equal((await run('init', 'wp')).code, 2)
  assert.equal((await run('set', 'WP-1', '__proto__.x', '1')).code, 2)
  assert.equal((await run('start', 'WP-1', 'gateA')).code, 2)
  const r = await exec('node', [script, '--repo', '../evil', 'init', 'WP-2'], { env }).catch((e) => e)
  assert.equal(r.code, 2)
  assert.ok(!existsSync(join(dir, '..', 'evil')))
})

test('repo defaults to the main checkout dir name from a worktree-less cwd', async () => {
  const { stdout } = await exec('node', [script, 'path', 'WP-3'], { env, cwd: dir })
  assert.equal(stdout.trim(), join(dir, dir.split('/').at(-1), 'WP-3.json'))
})

test('an approved gate cannot be reopened (a restarted lead must not re-block itself)', async () => {
  const r = await run('gate', 'WP-1', 'A', 'open')
  assert.equal(r.code, 1)
  assert.match(r.err, /already approved/)
  assert.equal((await run('gate', 'WP-1', 'A')).out, 'approved')
})

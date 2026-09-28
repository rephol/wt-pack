// Run: node --test skills/wt-shared/scripts/model-route.test.mjs — WP-128 routing core. A temp HOME keeps the real
// judge log, cache and config untouched; a stub fetch stands in for Jev.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const tmp = mkdtempSync(join(tmpdir(), 'wt-route-'))
process.env.HOME = tmp
process.env.TYPESAFE_API_KEY = 'test-key'
process.env.WT_DASHBOARD_DATA = join(tmp, 'dash')
process.env.WT_DASHBOARD_ENV = join(tmp, 'none.env')
process.env.WT_JEV_LOG = join(tmp, 'jev.jsonl')
delete process.env.WT_MODEL_ROUTING
const { buildState, localDecide, applyFloors, loadConfig, route, outcome, DEFAULTS, paths } = await import('./model-route.mjs')
const repo = join(tmp, 'repo'); mkdirSync(repo); execFileSync('git', ['-C', repo, 'init', '-q'])
const cli = join(import.meta.dirname, 'model-route.mjs')

let calls = 0
const jev = (choice, confidence) => async () => { calls++; return { ok: true, status: 200, json: async () => ({ answers: { tier: { choice, confidence } } }) } }
const TASK = 'Implement the plan unit U2: add a column to the tickets table and update the handlers and tests accordingly.'

test('state stays small and the question text is constant', () => {
  const s = buildState({ skill: 'wt-work', task: 'x'.repeat(5000), description: 'd'.repeat(500) })
  assert.ok(JSON.stringify(s).length <= 1200, JSON.stringify(s).length)
  assert.equal(s.task.length, 600)
  assert.equal(buildState({ task: 'fix the bug' }).signals.edits, true)
})

test('local decisions and floors: floors only raise', () => {
  assert.equal(localDecide(buildState({ skill: 'Explore', task: TASK })), 'haiku')
  assert.equal(localDecide(buildState({ task: 'list the open PRs' })), 'haiku')
  assert.equal(localDecide(buildState({ task: TASK })), null)
  const cfg = DEFAULTS
  assert.equal(applyFloors('haiku', buildState({ lens: 'security', task: 'x' }), cfg), 'sonnet')
  assert.equal(applyFloors('opus', buildState({ lens: 'security', task: 'x' }), cfg), 'opus') // never lowers
  assert.equal(applyFloors('haiku', buildState({ role: 'planner', task: 'x' }), cfg), 'opus')
  assert.equal(applyFloors('haiku', buildState({ task: 'run the data backfill' }), cfg), 'sonnet')
})

test('explicit model wins; pin beats Jev but not a floor; kill switch', async () => {
  const env = { WT_MODEL_ROUTING: 'live' }
  assert.equal((await route({ model: 'opus', task: TASK, env, cwd: repo })).apply, null)
  assert.equal((await route({ model: 'opus', task: TASK, env, cwd: repo })).source, 'explicit')
  mkdirSync(join(repo, '.wt-pack'), { recursive: true })
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ skills: { 'wt-work': { pin: 'haiku' } } }))
  calls = 0
  let d = await route({ skill: 'wt-work', task: TASK, env, cwd: repo, fetchImpl: jev('opus', 0.99) })
  assert.equal(d.apply, 'haiku'); assert.equal(d.source, 'pin'); assert.equal(calls, 0)
  d = await route({ skill: 'wt-work', lens: 'security', task: TASK, env, cwd: repo, fetchImpl: jev('opus', 0.99) })
  assert.equal(d.apply, 'sonnet') // the security floor raises the pin
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), '{}')
  assert.equal((await route({ task: TASK, env: { WT_MODEL_ROUTING: 'off' }, cwd: repo })).apply, null)
})

test('Jev thresholds, durable cache (no second fetch), shadow applies nothing', async () => {
  const env = { WT_MODEL_ROUTING: 'live' }
  calls = 0
  let d = await route({ skill: 'wt-plan-x', task: TASK + ' opus', env, cwd: repo, fetchImpl: jev('opus', 0.7) })
  assert.equal(d.apply, 'opus'); assert.equal(calls, 1)
  d = await route({ skill: 'wt-plan-x', task: TASK + ' opus', env, cwd: repo, fetchImpl: jev('haiku', 0.99) })
  assert.equal(d.apply, 'opus'); assert.equal(calls, 1) // cached on disk
  assert.equal((await route({ skill: 'a', task: TASK + ' h1', env, cwd: repo, fetchImpl: jev('haiku', 0.7) })).apply, 'sonnet') // below 0.8
  assert.equal((await route({ skill: 'a', task: TASK + ' h2', env, cwd: repo, fetchImpl: jev('haiku', 0.9) })).apply, 'haiku')
  const s = await route({ skill: 'a', task: TASK + ' s', env: {}, cwd: repo, fetchImpl: jev('haiku', 0.9) })
  assert.equal(s.mode, 'shadow'); assert.equal(s.apply, null); assert.equal(s.tier, 'haiku')
  const log = readFileSync(paths().log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(log.every((e) => e.cmd === 'routing')); assert.ok(log.some((e) => e.item.mode === 'shadow'))
})

test('a timeout falls back to sonnet within 1.5 s', async () => {
  const hang = (url, { signal }) => new Promise((_, rej) => {
    const keep = setTimeout(() => {}, 5000) // AbortSignal.timeout does not hold the event loop open
    signal.addEventListener('abort', () => { clearTimeout(keep); rej(Object.assign(new Error('t'), { name: 'TimeoutError' })) })
  })
  const t0 = Date.now()
  const d = await route({ skill: 'a', task: TASK + ' slow', env: { WT_MODEL_ROUTING: 'live' }, cwd: repo, fetchImpl: hang, timeoutMs: 1500 })
  assert.equal(d.apply, 'sonnet'); assert.equal(d.source, 'jev-failopen')
  assert.ok(Date.now() - t0 < 1700, `${Date.now() - t0}ms`)
})

test('config precedence: env › repo › project setting › user › default', () => {
  assert.equal(loadConfig({ cwd: repo, env: {} }).mode, 'shadow')
  mkdirSync(join(tmp, '.config', 'wt-pack'), { recursive: true })
  writeFileSync(paths().user, JSON.stringify({ mode: 'off', thresholds: { haiku: 0.9 } }))
  let c = loadConfig({ cwd: repo, env: {} }); assert.equal(c.mode, 'off'); assert.equal(c.from, 'user'); assert.equal(c.thresholds.opus, 0.6)
  mkdirSync(join(tmp, 'dash', 'data'), { recursive: true })
  const db = new DatabaseSync(join(tmp, 'dash', 'data', 'wt.db'))
  db.exec("CREATE TABLE project_settings (project TEXT, key TEXT, value TEXT); INSERT INTO project_settings VALUES ('repo', 'WT_MODEL_ROUTING', 'live')"); db.close()
  c = loadConfig({ cwd: repo, env: {} }); assert.equal(c.mode, 'live'); assert.equal(c.from, 'project')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ mode: 'shadow' }))
  c = loadConfig({ cwd: repo, env: {} }); assert.equal(c.mode, 'shadow'); assert.equal(c.from, 'repo'); assert.equal(c.thresholds.haiku, 0.9)
  c = loadConfig({ cwd: repo, env: { WT_MODEL_ROUTING: 'off' } }); assert.equal(c.mode, 'off'); assert.equal(c.from, 'env')
})

test('CLI: pick prints a tier only in live; explain is JSON; outcome writes the log', () => {
  const run = (args, env) => execFileSync(process.execPath, [cli, ...args], { input: 'list the files', encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(run(['pick', '--skill', 'x', '--cwd', repo], { WT_MODEL_ROUTING: 'live' }).trim(), 'haiku')
  assert.equal(run(['pick', '--skill', 'x', '--cwd', repo], { WT_MODEL_ROUTING: 'shadow' }).trim(), '')
  assert.equal(run(['pick', '--skill', 'x', '--cwd', repo], { WT_MODEL_ROUTING: 'off' }).trim(), '')
  const e = JSON.parse(run(['explain', '--skill', 'x', '--cwd', repo], { WT_MODEL_ROUTING: 'shadow' }))
  assert.equal(e.mode, 'shadow'); assert.equal(e.tier, 'haiku')
  const j = JSON.parse(run(['pick', '--json', '--skill', 'x', '--cwd', repo], { WT_MODEL_ROUTING: 'live' }))
  assert.match(j.ref, /^[a-z0-9]+#0$/)
  outcome(j.ref, 'send-back', 'review found a P1')
  assert.match(readFileSync(paths().outcomes, 'utf8'), /"outcome":"send-back","why":"review found a P1"/)
  assert.throws(() => outcome('bad', 'ok'))
  assert.ok(existsSync(paths().cache))
})

test('global off beats a per-skill live mode (kill switch)', async () => {
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ skills: { 'wt-work': { mode: 'live' } } }))
  assert.equal((await route({ skill: 'wt-work', task: 'list files', env: { WT_MODEL_ROUTING: 'off' }, cwd: repo })).mode, 'off')
  assert.equal((await route({ skill: 'wt-work', task: 'list files', env: {}, cwd: repo })).mode, 'live')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), '{}')
})

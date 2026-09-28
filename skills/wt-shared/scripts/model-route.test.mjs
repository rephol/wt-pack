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

// WP-129: six fixtures from live-round misses. Expected tiers: haiku, haiku, sonnet, opus, opus, haiku.
test('WP-129: sharper local signals — read verbs, security keywords, docs-lens haiku', () => {
  const s1 = buildState({ lens: 'docs', task: 'check the README wording against the CLI help text' })
  assert.equal(localDecide(s1), 'haiku') // 1: docs lens, no Jev call

  const s2 = buildState({ task: 'list the open PRs and report which ones are stale' })
  assert.equal(s2.signals.reads, true); assert.equal(s2.signals.edits, false)
  assert.equal(localDecide(s2), 'haiku') // 2: read-only, no security keyword

  const s3 = buildState({ task: TASK })
  assert.equal(localDecide(s3), null) // 3: normal edit work falls through to Jev (sonnet)

  const s4 = buildState({ role: 'planner', task: 'plan the migration' })
  assert.equal(applyFloors('haiku', s4, DEFAULTS), 'opus') // 4: role floor

  const s5 = buildState({ task: 'impact sweep of the session cookie format across the auth handlers' })
  assert.equal(s5.signals.reads, true) // 'sweep' now counts as a read
  assert.deepEqual(s5.signals.keywords.sort(), ['auth', 'cookie', 'session'].sort())
  assert.equal(localDecide(s5), null) // security keyword present: no shortcut, goes to Jev
  assert.equal(applyFloors('haiku', s5, DEFAULTS), 'sonnet') // 5: the security floor applies (docs: floors only raise to sonnet)

  const s6 = buildState({ lens: 'naming', task: 'rename the variable to match the convention' })
  assert.equal(localDecide(s6), 'haiku') // 6: naming lens, no Jev call

  // verify/compare/csrf/cookie/permission all now recognized
  assert.equal(buildState({ task: 'verify the output' }).signals.reads, true)
  assert.equal(buildState({ task: 'compare the two configs' }).signals.reads, true)
  assert.deepEqual(buildState({ task: 'add csrf and permission checks' }).signals.keywords.sort(), ['csrf', 'permission'].sort())

  // a security keyword blocks the docs/naming/formatting-lens shortcut too, not just the read-only one
  const s7 = buildState({ lens: 'docs', task: 'check the docs against the session cookie handling' })
  assert.equal(localDecide(s7), null)
})

test('WP-133: Jev gets a plain-language notes sentence, not raw booleans, security first', async () => {
  const s = buildState({ task: 'impact sweep of the session cookie format across the auth handlers' })
  assert.equal(s.signals.notes, 'security-sensitive: auth, session, cookie; read-only; lens: none')

  let sent
  const capture = async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ answers: { tier: { choice: 'opus', confidence: 0.9 } } }) } }
  await route({ skill: 'b', task: 'impact sweep of the session cookie format across the auth handlers', env: { WT_MODEL_ROUTING: 'live' }, cwd: repo, fetchImpl: capture })
  assert.equal(sent.state.notes, 'security-sensitive: auth, session, cookie; read-only; lens: none')
  assert.equal(sent.state.edits, undefined); assert.equal(sent.state.reads, undefined); assert.equal(sent.state.keywords, undefined)
})

test('CLI: usage prints tokens/cost by model, split session vs subagent, over --days', () => {
  const proj = join(tmp, '.claude', 'projects', 'proj')
  mkdirSync(join(proj, 's1', 'subagents'), { recursive: true })
  const now = new Date().toISOString()
  const line = (id, model, sessionId) => JSON.stringify({ type: 'assistant', sessionId, timestamp: now, message: { id, model, usage: { input_tokens: 100, output_tokens: 0 } } }) + '\n'
  writeFileSync(join(proj, 's1.jsonl'), line('m1', 'claude-sonnet-5', 's1'))
  writeFileSync(join(proj, 's1', 'subagents', 'agent-x.jsonl'), line('m2', 'claude-haiku-4-5', 's1'))
  const out = execFileSync(process.execPath, [cli, 'usage', '--days', '7'], { encoding: 'utf8' })
  assert.match(out, /^usage, last 7d: 200 tokens/)
  assert.match(out, /claude-sonnet-5 · session\t100\t/)
  assert.match(out, /claude-haiku-4-5 · subagent\t100\t/)
  // invalid --days (0, negative, non-numeric) falls back to 7, not a zero/negative keep window
  for (const bad of ['0', '-3', 'nope']) assert.match(execFileSync(process.execPath, [cli, 'usage', '--days', bad], { encoding: 'utf8' }), /^usage, last 7d: 200 tokens/)
})

test('global off beats a per-skill live mode (kill switch)', async () => {
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ skills: { 'wt-work': { mode: 'live' } } }))
  assert.equal((await route({ skill: 'wt-work', task: 'list files', env: { WT_MODEL_ROUTING: 'off' }, cwd: repo })).mode, 'off')
  assert.equal((await route({ skill: 'wt-work', task: 'list files', env: {}, cwd: repo })).mode, 'live')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), '{}')
})

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
const { buildState, localDecide, applyFloors, computeEffort, loadConfig, route, outcome, DEFAULTS, paths, modelIdFor } = await import('./model-route.mjs')
const repo = join(tmp, 'repo'); mkdirSync(repo); execFileSync('git', ['-C', repo, 'init', '-q'])
const cli = join(import.meta.dirname, 'model-route.mjs')

let calls = 0
const jev = (choice, confidence, effort, effortP = 0.9) => async () => {
  calls++
  return { ok: true, status: 200, json: async () => ({ answers: { tier: { choice, confidence }, ...(effort ? { effort: { choice: effort, confidence: effortP } } : {}) } }) }
}
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
  // WP-137: an explicit model still gets its own computed effort (an escalation overrides the tier, not E).
  const exp = await route({ model: 'haiku', task: TASK, env, cwd: repo })
  assert.equal(exp.effort, 'high'); assert.equal(exp.applyEffort, 'high') // downgrade from sonnet, capped
  const shadowExp = await route({ model: 'haiku', task: TASK, env: { WT_MODEL_ROUTING: 'shadow' }, cwd: repo })
  assert.equal(shadowExp.effort, 'high'); assert.equal(shadowExp.applyEffort, null)
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

// WP-168: a dispatch to an already-running worker (handoff.sh's mode=pane) has a known tier and nothing to
// apply — reuse logs it anyway (no Jev) so eval has a decision and `outcome` has a ref to mark.
test('WP-168: --reuse logs the known tier with no Jev call; plain --model stays unlogged', async () => {
  calls = 0
  const before = existsSync(paths().log) ? readFileSync(paths().log, 'utf8') : ''
  const d = await route({ model: 'opus', reuse: true, task: TASK, env: { WT_MODEL_ROUTING: 'shadow' }, cwd: repo, fetchImpl: jev('haiku', 0.99) })
  assert.equal(d.tier, 'opus'); assert.equal(d.apply, null); assert.equal(d.source, 'reuse'); assert.equal(calls, 0)
  assert.match(d.run, /^[a-z0-9]+$/)
  const after = readFileSync(paths().log, 'utf8')
  assert.ok(after.length > before.length)
  const last = JSON.parse(after.trim().split('\n').pop())
  assert.equal(last.item.source, 'reuse'); assert.equal(last.item.tier, 'opus')
  // outcome() accepts the ref this produced (throws on a malformed one — this is the round trip WP-168 fixes).
  outcome(`${d.run}#0`, 'ok', 'reused worker finished the ticket')
  assert.match(readFileSync(paths().outcomes, 'utf8'), /reused worker finished the ticket/)
  // a plain --model (escalation) is unaffected: still no run/log entry, same as before WP-168.
  const before2 = readFileSync(paths().log, 'utf8')
  const plain = await route({ model: 'opus', task: TASK, env: { WT_MODEL_ROUTING: 'shadow' }, cwd: repo })
  assert.equal(plain.run, undefined)
  assert.equal(readFileSync(paths().log, 'utf8'), before2)
  // off is still the kill switch for reuse too.
  assert.equal((await route({ model: 'opus', reuse: true, task: TASK, env: { WT_MODEL_ROUTING: 'off' }, cwd: repo })).source, 'off')
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

// WP-137: effort is computed from the FLOORED tier, not Jev's pre-floor pick — a security floor raising
// haiku to sonnet must not also carry haiku's downgrade-compensation raise.
test('WP-137: effort follows the floor-raised tier, not the pre-floor pick', async () => {
  const env = { WT_MODEL_ROUTING: 'live' }
  const secTask = 'edit the session cookie auth token handling in the backend'
  const d = await route({ skill: 'c', task: secTask, env, cwd: repo, fetchImpl: jev('haiku', 0.99) })
  assert.equal(d.tier, 'sonnet'); assert.equal(d.source, 'jev+floor')
  assert.equal(d.effort, 'medium') // sonnet's own base, no downgrade-raise from the pre-floor haiku pick
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

// WP-137: E = min(base [+2 if downgraded below sonnet, capped 'high'], G). Clamp table.
test('WP-137: effort clamp table — downgrade raise, no raise on upgrade/unchanged, always ≤ G', () => {
  const rw = buildState({ task: 'read the files' }) // reads, not edits: base drops one step
  const edit = buildState({ task: TASK }) // edits
  assert.equal(computeEffort('haiku', edit, 'max'), 'high') // downgrade from sonnet: low +2 = high
  assert.equal(computeEffort('sonnet', edit, 'max'), 'medium') // unchanged: base, no raise
  assert.equal(computeEffort('opus', edit, 'max'), 'high') // upgrade: base, no raise
  assert.equal(computeEffort('haiku', edit, 'medium'), 'medium') // downgrade raise clamped to G
  assert.equal(computeEffort('opus', edit, 'low'), 'low') // base itself clamped to G
  assert.equal(computeEffort('haiku', rw, 'max'), 'high') // read-only lowers base (low → nothing lower), then +2
  assert.equal(computeEffort('sonnet', rw, 'max'), 'low') // read-only lowers sonnet's base a step
  assert.equal(computeEffort('sonnet', edit, undefined), 'medium') // no G override: falls back to the default ceiling
})

// WP-139: Jev's own effort pick (the second question in the same call) drives E, clamped by the same rules —
// not the tier-derived base the local-rule path still uses.
test('WP-139: Jev\'s effort pick is used and clamped (≤ G; downgrade capped at base+2/high)', async () => {
  const env = { WT_MODEL_ROUTING: 'live' }
  // distinct task text per case: the durable cache keys on state, so identical tasks would hit an earlier case's cache
  // haiku pick (downgrade from sonnet, base 'low'): Jev asks for 'max', capped to base+2='high'
  const d1 = await route({ skill: 'a', task: `${TASK} (case 1)`, env, cwd: repo, fetchImpl: jev('haiku', 0.99, 'max') })
  assert.equal(d1.tier, 'haiku'); assert.equal(d1.effort, 'high')
  // opus pick (upgrade, base 'high'): Jev's 'low' pick is honoured, not forced back up to base
  const d2 = await route({ skill: 'a', task: `${TASK} (case 2)`, env, cwd: repo, fetchImpl: jev('opus', 0.99, 'low') })
  assert.equal(d2.tier, 'opus'); assert.equal(d2.effort, 'low')
  // sonnet pick (unchanged), Jev asks 'xhigh': still clamped to G ('high' here, the default ceiling)
  const d3 = await route({ skill: 'a', task: `${TASK} (case 3)`, env, cwd: repo, fetchImpl: jev('sonnet', 0.99, 'xhigh') })
  assert.equal(d3.tier, 'sonnet'); assert.equal(d3.effort, 'high')
  // and the whole thing still respects a lower G, e.g. the orchestrator's WP-139 report (G='medium')
  const d4 = await route({ skill: 'a', task: `${TASK} (case 4)`, env: { ...env, WT_EFFORT: 'medium' }, cwd: repo, fetchImpl: jev('haiku', 0.99, 'max') })
  assert.equal(d4.effort, 'medium')
})

// WP-139: G defaults to Claude Code's own effective effort setting (settings.json effortLevel, project over
// user) instead of the hardcoded 'high' — wt-pack's own overrides (WT_EFFORT) still win.
test('WP-139: G reads Claude Code settings.json when wt-pack has no override', () => {
  writeFileSync(paths().user, '{}')
  mkdirSync(join(tmp, '.claude'), { recursive: true })
  writeFileSync(join(tmp, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'medium' }))
  assert.equal(loadConfig({ cwd: repo, env: {} }).effort, 'medium')
  assert.equal(loadConfig({ cwd: repo, env: {} }).effortFrom, 'claude')
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'low' }))
  assert.equal(loadConfig({ cwd: repo, env: {} }).effort, 'low') // project over user
  // WP-142: CLAUDE_EFFORT is the CALLING session's own effort, exported into every child process — not a
  // setting for the routed target, so it must not move G at all.
  assert.equal(loadConfig({ cwd: repo, env: { CLAUDE_EFFORT: 'xhigh' } }).effort, 'low')
  assert.equal(loadConfig({ cwd: repo, env: { CLAUDE_EFFORT: 'xhigh' } }).effortFrom, 'claude')
  // wt-pack's own WT_EFFORT override still wins over a Claude Code effortLevel present at the same time
  assert.equal(loadConfig({ cwd: repo, env: { WT_EFFORT: 'max' } }).effort, 'max')
  assert.equal(loadConfig({ cwd: repo, env: { WT_EFFORT: 'max' } }).effortFrom, 'env')
  writeFileSync(join(repo, '.claude', 'settings.json'), '{}')
  writeFileSync(join(tmp, '.claude', 'settings.json'), '{}')
})

// WP-141: a `modelSettings[<model id>].effortLevel` scopes to the model whose id it names — it must not leak
// into every tier's G the way a flat read of "some nested effortLevel" would.
test('WP-141: modelSettings effortLevel is per-model, top-level effortLevel is the fallback for the rest', async () => {
  const { effortCeiling } = await import('./model-route.mjs')
  writeFileSync(paths().user, '{}')
  mkdirSync(join(tmp, '.claude'), { recursive: true })
  writeFileSync(join(tmp, '.claude', 'settings.json'), JSON.stringify({
    effortLevel: 'medium',
    modelSettings: { 'claude-opus-5': { effortLevel: 'low' }, 'claude-opus-4-8': { effortLevel: 'low' }, 'claude-opus-5-5': { effortLevel: 'low' } },
  }))
  const cfg = loadConfig({ cwd: repo, env: {} })
  assert.equal(cfg.effortFrom, 'claude') // loadConfig() has no tier yet: top-level effortLevel only
  assert.equal(cfg.effort, 'medium')
  assert.equal(effortCeiling(cfg, 'opus').effort, 'low') // opus has its own modelSettings entry
  assert.equal(effortCeiling(cfg, 'opus').effortFrom, 'claude')
  assert.equal(effortCeiling(cfg, 'sonnet').effort, 'medium') // no modelSettings entry: falls back to top-level
  assert.equal(effortCeiling(cfg, 'haiku').effort, 'medium')
  // project settings.json's modelSettings wins over the user one, same as its top-level effortLevel already does
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } }))
  const cfg2 = loadConfig({ cwd: repo, env: {} })
  assert.equal(effortCeiling(cfg2, 'opus').effort, 'low')
  assert.equal(effortCeiling(cfg2, 'sonnet').effort, 'medium') // project has no top-level effortLevel: user's still applies
  // route() actually applies the per-tier ceiling to a routed decision, not just loadConfig() — Jev's own 'max'
  // pick for an opus (upgrade) tier is clamped all the way down to G='low' from the project's opus modelSettings
  const d = await route({ skill: 'a', task: `${TASK} (wp-141)`, env: { WT_MODEL_ROUTING: 'live' }, cwd: repo, fetchImpl: jev('opus', 0.99, 'max') })
  assert.equal(d.tier, 'opus'); assert.equal(d.effort, 'low'); assert.equal(d.effortFrom, 'claude')
  writeFileSync(join(repo, '.claude', 'settings.json'), '{}')
  writeFileSync(join(tmp, '.claude', 'settings.json'), '{}')
})

// WP-142: CLAUDE_EFFORT is Claude Code's export of the CALLING session's own effort into every child process,
// not a setting for the routed target — a low-effort orchestrator dispatching a task must not drag the
// target's own G down to 'low' just because the orchestrator itself is running at 'low'.
test('WP-142: CLAUDE_EFFORT does not move the ceiling; the target\'s own settings.json still does', async () => {
  const { effortCeiling } = await import('./model-route.mjs')
  writeFileSync(paths().user, '{}')
  mkdirSync(join(tmp, '.claude'), { recursive: true })
  writeFileSync(join(tmp, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'medium' }))
  const cfg = loadConfig({ cwd: repo, env: { CLAUDE_EFFORT: 'low' } })
  assert.equal(cfg.effort, 'medium')
  assert.equal(effortCeiling(cfg, 'sonnet').effort, 'medium')
  const d = await route({ skill: 'a', task: `${TASK} (wp-142)`, env: { WT_MODEL_ROUTING: 'live', CLAUDE_EFFORT: 'low' }, cwd: repo, fetchImpl: jev('sonnet', 0.99, 'xhigh') })
  assert.equal(d.tier, 'sonnet'); assert.equal(d.effort, 'medium')
  // the old code let CLAUDE_EFFORT beat a tier's own modelSettings entry too, not just the top-level fallback
  writeFileSync(join(tmp, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }))
  assert.equal(effortCeiling(loadConfig({ cwd: repo, env: { CLAUDE_EFFORT: 'low' } }), 'opus').effort, 'high')
  writeFileSync(join(tmp, '.claude', 'settings.json'), '{}')
})

test('WT_EFFORT config precedence and route() carries effort/applyEffort', async () => {
  assert.equal(loadConfig({ cwd: repo, env: {} }).effort, 'high') // default G
  writeFileSync(paths().user, JSON.stringify({ mode: 'off', effort: 'low' }))
  let c = loadConfig({ cwd: repo, env: {} }); assert.equal(c.effort, 'low'); assert.equal(c.effortFrom, 'user')
  mkdirSync(join(tmp, 'dash', 'data'), { recursive: true })
  const db2 = new DatabaseSync(join(tmp, 'dash', 'data', 'wt.db'))
  try { db2.exec("INSERT INTO project_settings VALUES ('repo', 'WT_EFFORT', 'xhigh')") } catch { db2.exec("CREATE TABLE project_settings (project TEXT, key TEXT, value TEXT); INSERT INTO project_settings VALUES ('repo', 'WT_EFFORT', 'xhigh')") }
  db2.close()
  c = loadConfig({ cwd: repo, env: {} }); assert.equal(c.effort, 'xhigh'); assert.equal(c.effortFrom, 'project')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ effort: 'medium' }))
  c = loadConfig({ cwd: repo, env: {} }); assert.equal(c.effort, 'medium'); assert.equal(c.effortFrom, 'repo')
  c = loadConfig({ cwd: repo, env: { WT_EFFORT: 'low' } }); assert.equal(c.effort, 'low'); assert.equal(c.effortFrom, 'env')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), '{}')
  writeFileSync(paths().user, JSON.stringify({ mode: 'shadow' }))

  const d = await route({ skill: 'a', task: TASK, env: { WT_MODEL_ROUTING: 'live' }, cwd: repo, fetchImpl: jev('opus', 0.99) })
  assert.equal(d.effort, 'high'); assert.equal(d.applyEffort, 'high')
  const shadow = await route({ skill: 'a', task: TASK, env: { WT_MODEL_ROUTING: 'shadow' }, cwd: repo, fetchImpl: jev('opus', 0.99) })
  assert.equal(shadow.effort, 'high'); assert.equal(shadow.applyEffort, null) // computed but not applied outside live
})

test('CLI: pick --json and floor --json carry effort', () => {
  const run = (args, env) => execFileSync(process.execPath, [cli, ...args], { input: 'list the files', encoding: 'utf8', env: { ...process.env, ...env } })
  const j = JSON.parse(run(['pick', '--json', '--skill', 'x', '--cwd', repo], { WT_MODEL_ROUTING: 'live' }))
  assert.equal(j.tier, 'haiku'); assert.equal(j.effort, 'high'); assert.equal(j.applyEffort, 'high') // downgrade from sonnet raises to the 'high' cap
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ roleFloors: { planner: 'opus' } }))
  const f = JSON.parse(run(['floor', '--role', 'planner', '--cwd', repo, '--json'], { WT_MODEL_ROUTING: 'live' }))
  assert.equal(f.tier, 'opus'); assert.equal(f.effort, 'high'); assert.equal(f.model, 'claude-opus-5-5') // WP-158
  // plain-text (no --json): unchanged from pre-WP-137 — just the bare floor tier. WP-160: applies in every
  // mode, not just live — a spawn has no task text to route, so shadow has no reason to withhold it.
  assert.equal(run(['floor', '--role', 'planner', '--cwd', repo], { WT_MODEL_ROUTING: 'live' }).trim(), 'opus')
  assert.equal(run(['floor', '--role', 'planner', '--cwd', repo], { WT_MODEL_ROUTING: 'shadow' }).trim(), 'opus')
  // --model: effort/id for the caller's actual tier, not the role's own floor tier when they diverge; the
  // printed/`tier` floor itself is unaffected. The id is independent of live/shadow (an explicit tier resolves
  // to its id regardless of routing mode).
  const div = JSON.parse(run(['floor', '--role', 'planner', '--model', 'sonnet', '--cwd', repo, '--json'], { WT_MODEL_ROUTING: 'live' }))
  assert.equal(div.tier, 'opus'); assert.equal(div.effort, 'medium'); assert.equal(div.model, 'claude-sonnet-5') // sonnet's own base, not opus's
  const shadowDiv = JSON.parse(run(['floor', '--role', 'planner', '--model', 'sonnet', '--cwd', repo, '--json'], { WT_MODEL_ROUTING: 'shadow' }))
  assert.equal(shadowDiv.tier, 'opus'); assert.equal(shadowDiv.effort, 'medium'); assert.equal(shadowDiv.model, 'claude-sonnet-5')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), '{}')
})

test('WP-157/160: floor never spawns a role on haiku, in any mode — every role gets at least sonnet, a role floor only raises further', () => {
  const run = (args, env) => execFileSync(process.execPath, [cli, ...args], { input: 'list the files', encoding: 'utf8', env: { ...process.env, ...env } })
  // A role with no roleFloors entry (everything but planner, today) used to print nothing live — now sonnet.
  const worker = JSON.parse(run(['floor', '--role', 'worker', '--cwd', repo, '--json'], { WT_MODEL_ROUTING: 'live' }))
  assert.equal(worker.tier, 'sonnet'); assert.equal(worker.source, 'session-floor'); assert.equal(worker.effort, 'medium')
  // WP-160: shadow (default) and off both apply the same floor — a spawn has no task text to route, so this
  // floor never touches Jev and has no shadow-mode reason to withhold (unlike a task-routed `pick`).
  const shadow = JSON.parse(run(['floor', '--role', 'worker', '--cwd', repo, '--json'], { WT_MODEL_ROUTING: 'shadow' }))
  assert.equal(shadow.tier, 'sonnet'); assert.equal(shadow.source, 'session-floor')
  const off = JSON.parse(run(['floor', '--role', 'worker', '--cwd', repo, '--json'], { WT_MODEL_ROUTING: 'off' }))
  assert.equal(off.tier, 'sonnet'); assert.equal(off.source, 'session-floor')
  // A role floor above sonnet (planner -> opus) still wins and reports as role-floor, not session-floor.
  const planner = JSON.parse(run(['floor', '--role', 'planner', '--cwd', repo, '--json'], { WT_MODEL_ROUTING: 'live' }))
  assert.equal(planner.tier, 'opus'); assert.equal(planner.source, 'role-floor')
  // A misconfigured role floor BELOW sonnet (e.g. haiku) is still raised to the session floor, not honored.
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ roleFloors: { worker: 'haiku' } }))
  const misfloored = JSON.parse(run(['floor', '--role', 'worker', '--cwd', repo, '--json'], { WT_MODEL_ROUTING: 'live' }))
  assert.equal(misfloored.tier, 'sonnet'); assert.equal(misfloored.source, 'session-floor')
  // A role floor set EQUAL to the session floor attributes to the role's own config, not the session default.
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ roleFloors: { worker: 'sonnet' } }))
  const tied = JSON.parse(run(['floor', '--role', 'worker', '--cwd', repo, '--json'], { WT_MODEL_ROUTING: 'live' }))
  assert.equal(tied.tier, 'sonnet'); assert.equal(tied.source, 'role-floor')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), '{}')
})

test('WP-157: subagent routing (pick/explain) is unaffected — it may still choose haiku for any role', async () => {
  const d = await route({ skill: 'x', role: 'worker', task: TASK, env: { WT_MODEL_ROUTING: 'live' }, cwd: repo, fetchImpl: jev('haiku', 0.99) })
  assert.equal(d.tier, 'haiku'); assert.equal(d.apply, 'haiku')
})

test('WP-157: session: true (wt-handoff spawning a fresh agent) floors a Jev haiku pick to sonnet', async () => {
  // Without --session, a mechanical task genuinely picks haiku live (this is the bug wt-handoff hit: it used
  // plain `pick`, which is shaped for subagent routing, to decide its OWN session's tier).
  const plain = await route({ skill: 'wt-handoff', role: 'worker', task: 'rename a variable', env: { WT_MODEL_ROUTING: 'live' }, cwd: repo, fetchImpl: jev('haiku', 0.99, 'low') })
  assert.equal(plain.tier, 'haiku'); assert.equal(plain.apply, 'haiku')
  // With session: true, the same Jev haiku pick is raised to sonnet, source records both steps, and effort
  // is Jev's own task-effort answer (unaffected by the tier bump, WP-139) clamped to sonnet's own ceiling.
  const s = await route({ skill: 'wt-handoff', role: 'worker', task: 'rename a variable', env: { WT_MODEL_ROUTING: 'live' }, cwd: repo, fetchImpl: jev('haiku', 0.99, 'low'), session: true })
  assert.equal(s.tier, 'sonnet'); assert.equal(s.apply, 'sonnet'); assert.equal(s.source, 'jev+session-floor')
  // An explicit --model (e.g. a dispatch escalation) passed with session: true is floored too, never left at haiku.
  const explicit = await route({ skill: 'wt-handoff', role: 'worker', model: 'haiku', env: { WT_MODEL_ROUTING: 'live' }, cwd: repo, session: true })
  assert.equal(explicit.tier, 'sonnet'); assert.equal(explicit.source, 'explicit+session-floor')
  // session: true never lowers an already-adequate pick (distinct state so it doesn't hit an earlier test's cache).
  const already = await route({ skill: 'wt-handoff', role: 'worker', task: 'design a new auth flow', env: { WT_MODEL_ROUTING: 'live' }, cwd: repo, fetchImpl: jev('opus', 0.99), session: true })
  assert.equal(already.tier, 'opus')
})

test('CLI: pick --session floors a haiku pick to sonnet; plain pick (subagent shape) is unaffected', () => {
  const run = (args, env) => execFileSync(process.execPath, [cli, ...args], { input: 'rename a variable', encoding: 'utf8', env: { ...process.env, ...env } })
  const plain = JSON.parse(run(['pick', '--json', '--skill', 'wt-handoff', '--role', 'worker', '--cwd', repo], { WT_MODEL_ROUTING: 'live' }))
  assert.equal(plain.tier, 'haiku')
  const session = JSON.parse(run(['pick', '--json', '--skill', 'wt-handoff', '--role', 'worker', '--session', '--cwd', repo], { WT_MODEL_ROUTING: 'live' }))
  assert.equal(session.tier, 'sonnet'); assert.equal(session.apply, 'sonnet')
})

test('global off beats a per-skill live mode (kill switch)', async () => {
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ skills: { 'wt-work': { mode: 'live' } } }))
  assert.equal((await route({ skill: 'wt-work', task: 'list files', env: { WT_MODEL_ROUTING: 'off' }, cwd: repo })).mode, 'off')
  assert.equal((await route({ skill: 'wt-work', task: 'list files', env: {}, cwd: repo })).mode, 'live')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), '{}')
})

// WP-158: each tier spawns pinned to an explicit model id, not the bare alias Claude Code would otherwise
// resolve on its own — configurable, same layers as everything else, falling back to the tier name if unmapped.
test('modelIdFor: default map, a partial config override, and an unknown tier falls back to itself', () => {
  assert.equal(modelIdFor('opus', DEFAULTS), 'claude-opus-5-5')
  assert.equal(modelIdFor('sonnet', DEFAULTS), 'claude-sonnet-5')
  assert.equal(modelIdFor('haiku', DEFAULTS), 'claude-haiku-4-5-20251001')
  assert.equal(modelIdFor('opus', { modelIds: { opus: 'claude-opus-6' } }), 'claude-opus-6')
  assert.equal(modelIdFor('sonnet', {}), 'sonnet') // no map at all: the pre-WP-158 alias behaviour
  assert.equal(modelIdFor('nope', DEFAULTS), 'nope')
})

test('CLI: model-id prints the configured id, a repo override wins over the default, bad tier exits 2', () => {
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  assert.equal(run(['model-id', 'opus', '--cwd', repo]).trim(), 'claude-opus-5-5')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), JSON.stringify({ modelIds: { opus: 'claude-opus-6' } }))
  assert.equal(run(['model-id', 'opus', '--cwd', repo]).trim(), 'claude-opus-6')
  writeFileSync(join(repo, '.wt-pack', 'model-routing.json'), '{}')
  assert.throws(() => execFileSync(process.execPath, [cli, 'model-id', 'nope'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
})

#!/usr/bin/env node
// WP-128: pick the model tier (haiku | sonnet | opus) for a session or subagent from its task.
// WP-137: also pick its effort level (low < medium < high < xhigh < max), gated by the global ceiling G. Local rules
// (tier, lens, read-only) set the base; a tier picked BELOW the default tier (sonnet) may raise effort up to 2
// levels to compensate, capped at 'high'; an unchanged or upgraded tier never raises. Either way E is clamped to G.
//   model-route.mjs pick --skill S [--role R] [--lens L] [--model M] [--reuse] [--desc D] [--cwd DIR] [--session] [--json] < task
//       live: prints the tier; off/shadow: prints nothing (--json: always the decision incl. effort, plus "run#i").
//       Exit 0 always. --session (WP-157): this pick decides a fresh SESSION's own tier (e.g. wt-handoff
//       spawning an agent), not a subagent's — never lands below the session floor (see `floor` below),
//       whatever picked it. wt-review/wt-research's lens/shard picks never pass this, so they may still land
//       on haiku. --reuse (WP-168, with --model set to the already-running worker's tier): logs that tier as
//       source 'reuse' with no Jev call (nothing will be applied — the worker is already on it), so the
//       ticket handed to it gets a ref `outcome` can later mark. A plain --model (escalation) stays unlogged.
//       WP-298: --effort low|medium|high is the unit effort the caller declares (the tech-lead, per unit): it is
//       the effort of the pick (clamped to G), and `high` lifts cfg.roleCeilings (default worker → sonnet) so opus
//       is allowed; otherwise the ceiling caps the TIER of that role (Jev may still raise effort). An explicit
//       --model is never capped. Deterministic: `capTier` and the unit effort are reported (applyEffort) in
//       shadow and off too, only Jev's tier stays live-gated. `low` (with --session, no --model) is the one exception
//       to the session floor: the session runs haiku/low (`unitTier`, no Jev call; security etc. floors still raise it).
//   model-route.mjs explain …same flags… < task   the whole decision as JSON
//   model-route.mjs floor --role R [--model M] [--persona-model M] [--cwd DIR] [--json]   the role's floor tier (planner → opus,
//       every other role → sonnet, WP-157: a session never spawns on haiku with no explicit tier) and its
//       effort (spawn has no task text to route, so this is all it applies without an explicit tier). WP-160:
//       applies in every mode, not just live — this floor never uses Jev, so there's no shadow-mode reason to
//       withhold it; only a task-routed `pick` stays live-gated. --model computes the printed effort for that
//       tier instead of the role's floor tier (e.g. the caller already picked one some other way) without
//       changing the printed/`tier` floor itself. --json adds `source` (role-floor | session-floor).
//   model-route.mjs outcome <run#i> ok|send-back|returned|escalated ["why"]   record what happened (tuning input);
//       shadow-ok|shadow-returned: the turn's result on the model that ran under a shadow pick (reported, not tuned)
//   model-route.mjs usage [--days N]   tokens/notional cost by model, split session vs subagent (WP-130; dashboard-
//       free equivalent of Settings › Usage; N defaults to 7)
//   model-route.mjs model-id <haiku|sonnet|opus> [--cwd DIR]   the explicit model id `claude --model` should get
//       for that tier (WP-158; `claude --model opus` lets Claude Code resolve the alias to whatever it currently
//       treats as opus — a session-level spawn wants the pinned id). Configurable: DEFAULTS.modelIds, same layers
//       as everything else below.
// Order: kill switch / mode off → explicit model → skill pin → local obvious case → Jev choice → floors (only raise).
// Config layers, first wins: env WT_MODEL_ROUTING (mode) / WT_EFFORT (G) › <repo>/.wt-pack/model-routing.json ›
// dashboard project setting WT_MODEL_ROUTING / WT_EFFORT › ~/.config/wt-pack/model-routing.json › defaults (mode
// shadow, effort high).
// Every decision past the explicit check is logged to the judge log as cmd 'routing' (wt-judge calibrate skips it;
// routing-eval.mjs tunes it). Nothing here may throw into a caller: failures pick sonnet or nothing.
// A subagent (the Agent tool) has no effort parameter to pass through — E applies to the spawned session only.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { judge, choice, runId } from './typesafe.mjs'
import { settingsRoot } from './roles.mjs'

export const TIERS = ['haiku', 'sonnet', 'opus']
const rank = (t) => TIERS.indexOf(t)
const max = (a, b) => (rank(b) > rank(a) ? b : a)
const isTier = (t) => TIERS.includes(t)
const MODES = ['off', 'shadow', 'live']
// WP-137: E, gated by the global effort G. base tier is 'sonnet' (model-route's own assumed default for normal
// work); a pick below it is a downgrade that may raise effort to compensate, at most 2 levels, never past 'high'.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const erank = (e) => EFFORTS.indexOf(e)
const isEffort = (e) => EFFORTS.includes(e)
const emin = (a, b) => (erank(b) < erank(a) ? b : a)
const DEFAULT_TIER = 'sonnet'
const TIER_BASE_EFFORT = { haiku: 'low', sonnet: 'medium', opus: 'high' }
export const DEFAULTS = {
  mode: 'shadow', skills: {},
  floors: { correctness: 'sonnet', security: 'sonnet', data: 'sonnet', migration: 'sonnet' },
  roleFloors: { planner: 'opus' },
  // WP-298: a per-role CEILING on the routed tier — Jev may raise effort for the role, not its tier — unless the
  // request carries `effort: 'high'` (the tech-lead's per-unit effort) or an explicit model. Deterministic, so
  // like `floor` it holds in every mode. A role without an entry is unchanged.
  roleCeilings: { worker: 'sonnet' },
  // WP-157: a hard floor on the `floor` command only (spawn/session picks) — never haiku for a main agent,
  // whatever role or explicit tier was asked for it. Subagent routing (pick/explain) never reads this, so
  // wt-review/wt-research lens and shard picks may still choose haiku.
  sessionFloor: 'sonnet',
  thresholds: { haiku: 0.8, opus: 0.6 },
  effort: 'high', // the global ceiling G, same config layering as `mode`
  // WP-158: the explicit model id `claude --model` gets for each tier, so a session-level spawn pins the
  // actual model instead of handing Claude Code a bare alias to resolve on its own.
  modelIds: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }, // WP-178
}
// Falls back to the bare tier name (today's alias behaviour) when a tier has no configured id.
export const modelIdFor = (tier, cfg) => (isTier(tier) && cfg?.modelIds?.[tier]) || tier
const home = () => process.env.HOME || homedir()
export const paths = () => ({
  user: join(home(), '.config', 'wt-pack', 'model-routing.json'),
  cache: join(home(), '.cache', 'wt-pack', 'model-route.json'),
  log: join(home(), '.claude', 'wt-judge-log.jsonl'),
  outcomes: join(home(), '.local', 'share', 'wt-pack', 'routing-outcomes.jsonl'),
})
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const merge = (a, b) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return a
  const o = { ...a }
  for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a?.[k] ?? {}, v) : v
  return o
}
const repoRoot = (cwd) => { try { return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
const projectSetting = (cwd, key) => {
  try {
    return execFileSync(process.execPath, [fileURLToPath(new URL('./project-setting.mjs', import.meta.url)), 'get', key, '--cwd', cwd],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim().split('\n').pop()
  } catch { return '' }
}
// WP-139: G's real default is Claude Code's own effective effort setting, not the hardcoded 'high' — wt-pack's
// own WT_EFFORT/model-routing.json layers below still win when a caller explicitly sets one. Source: the
// target's own settings.json `effortLevel` (project over user) — never a live session env var: WP-142 found
// Claude Code exports CLAUDE_EFFORT into every child process as the CALLING session's own effort, not a
// setting for the routed target, so reading it here silently imported the caller's effort as the target's
// ceiling. An explicit override still goes through wt-pack's own WT_EFFORT (loadConfig()), tier-agnostic and
// already final by the time claudeCodeEffort() runs.
// WP-141: within each settings.json, a `modelSettings[<model id>].effortLevel` for the routed tier's own model
// (matched by id prefix, e.g. "claude-opus-5-5" for tier 'opus') wins over that file's top-level `effortLevel` —
// it's the more specific setting. `tier` is optional: omitted, this reads only the top-level effortLevel (used
// by loadConfig(), which resolves before a tier is chosen); effortCeiling() re-resolves per tier once one is.
function modelSettingsEffort(settings, tier) {
  if (!isTier(tier)) return null
  const re = new RegExp(`^claude-${tier}(-|$)`)
  for (const [id, v] of Object.entries(settings?.modelSettings ?? {})) if (re.test(id) && isEffort(v?.effortLevel)) return v.effortLevel
  return null
}
function claudeCodeEffort(root, tier) {
  const proj = root && readJson(join(root, '.claude', 'settings.json'))
  const pm = modelSettingsEffort(proj, tier)
  if (isEffort(pm)) return pm
  if (isEffort(proj?.effortLevel)) return proj.effortLevel
  const user = readJson(join(home(), '.claude', 'settings.json'))
  const um = modelSettingsEffort(user, tier)
  if (isEffort(um)) return um
  if (isEffort(user?.effortLevel)) return user.effortLevel
  return null
}
// Re-resolves G for the actual routed tier once one is known, when nothing more specific than Claude Code's own
// settings (or nothing at all) claimed G yet — a wt-pack-level override (user/project/repo/env) is tier-agnostic
// and already final by then.
export function effortCeiling(cfg, tier) {
  if (cfg.effortFrom !== 'claude' && cfg.effortFrom !== 'default') return cfg
  const ce = claudeCodeEffort(cfg.root, tier)
  return isEffort(ce) ? { ...cfg, effort: ce, effortFrom: 'claude' } : cfg
}

// The merged config; `from`/`effortFrom` name where the mode/effort came from (for explain).
export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  let cfg = merge(DEFAULTS, readJson(paths().user))
  let from = readJson(paths().user)?.mode ? 'user' : 'default'
  let effortFrom = readJson(paths().user)?.effort ? 'user' : 'default'
  const root = repoRoot(cwd) // one shell-out, shared with the repo config-file read below
  if (effortFrom === 'default') {
    const ce = claudeCodeEffort(root)
    if (isEffort(ce)) { cfg = { ...cfg, effort: ce }; effortFrom = 'claude' }
  }
  const pm = projectSetting(cwd, 'WT_MODEL_ROUTING')
  if (MODES.includes(pm)) { cfg = { ...cfg, mode: pm }; from = 'project' }
  const pe = projectSetting(cwd, 'WT_EFFORT')
  if (isEffort(pe)) { cfg = { ...cfg, effort: pe }; effortFrom = 'project' }
  const repo = root && readJson(join(settingsRoot(root), 'model-routing.json'))
  if (repo) { cfg = merge(cfg, repo); if (repo.mode) from = 'repo'; if (repo.effort) effortFrom = 'repo' }
  const e = env.WT_MODEL_ROUTING
  if (MODES.includes(e)) { cfg = { ...cfg, mode: e }; from = 'env' }
  const ee = env.WT_EFFORT
  if (isEffort(ee)) { cfg = { ...cfg, effort: ee }; effortFrom = 'env' }
  if (!MODES.includes(cfg.mode)) cfg.mode = 'shadow'
  if (!isEffort(cfg.effort)) cfg.effort = DEFAULTS.effort
  return { ...cfg, from, effortFrom, root }
}

const EDIT = /\b(implement|fix|edit|write|add|change|refactor|rename|delete|remove|migrate|update|commit|merge|build)\b/i
const READ = /\b(read|find|search|grep|list|look|explore|locate|check|compare|verify|sweep|report)\b/i
const KEYWORDS = ['security', 'auth', 'secret', 'token', 'session', 'cookie', 'permission', 'csrf', 'migration', 'schema', 'data', 'backfill', 'refactor', 'architecture', 'plan', 'review', 'test']
// A security-sensitive subset of KEYWORDS: floors the tier (applyFloors) and blocks the read-only local haiku rule.
const SECURITY = ['security', 'auth', 'secret', 'token', 'session', 'cookie', 'permission', 'csrf', 'migration', 'schema']
const LOCAL_HAIKU_LENS = /^(docs|naming|formatting)$/i
// A plain-language summary of the signals, for Jev: raw booleans/keyword arrays read as "easy" to it (WP-133) —
// a security risk stated first in words outweighs "reads:true" pulling it toward haiku.
function buildNotes(s) {
  const sec = s.keywords.filter((k) => SECURITY.includes(k))
  const rest = s.keywords.filter((k) => !SECURITY.includes(k))
  const parts = []
  if (sec.length) parts.push(`security-sensitive: ${sec.join(', ')}`)
  parts.push(s.edits ? 'edits code' : s.reads ? 'read-only' : 'unclear scope')
  parts.push(`lens: ${s.lens || 'none'}`)
  if (rest.length) parts.push(`keywords: ${rest.join(', ')}`)
  return parts.join('; ')
}
// ≤ ~300 tokens: skill, description, the first 600 chars of the task, and cheap signals.
export function buildState({ skill = '', role = '', lens = '', description = '', task = '' } = {}) {
  const t = String(task)
  const edits = EDIT.test(t), reads = READ.test(t), l = String(lens).slice(0, 30)
  const keywords = KEYWORDS.filter((k) => new RegExp(`\\b${k}`, 'i').test(t))
  return {
    skill: String(skill).slice(0, 60), role: String(role).slice(0, 30), agent_description: String(description).slice(0, 120),
    task: t.slice(0, 600),
    signals: { edits, reads, lens: l, keywords, len: t.length, notes: buildNotes({ edits, reads, lens: l, keywords }) },
  }
}

// A cheap, certain answer with no Jev call, or null.
export function localDecide(state) {
  if (/^explore$/i.test(state.skill)) return 'haiku'
  const secure = state.signals.keywords.some((k) => SECURITY.includes(k))
  if (secure) return null // a security-sensitive task always goes to Jev (and the floor), never a local shortcut
  if (LOCAL_HAIKU_LENS.test(state.signals.lens)) return 'haiku'
  if (state.signals.len > 0 && state.signals.len < 80 && !state.signals.edits) return 'haiku'
  if (state.signals.reads && !state.signals.edits) return 'haiku'
  return null
}

// Floors only ever raise the tier.
// WP-298: the tier a role is capped at for this request, or null (no entry, an explicit model, or unit effort high).
export function ceilingTier(cfg, role, { model = '', effort = '' } = {}) {
  const c = cfg.roleCeilings?.[role]
  return isTier(c) && !model && effort !== 'high' ? c : null
}
// A unit effort (low|medium|high) is the caller's own pick: it replaces the computed effort, still clamped to G.
const unitEffort = (e, g) => (isEffort(e) ? emin(e, isEffort(g) ? g : DEFAULTS.effort) : null)

export function applyFloors(tier, state, cfg) {
  let t = tier
  const s = state.signals
  for (const k of [s.lens, ...s.keywords]) if (k && isTier(cfg.floors?.[k])) t = max(t, cfg.floors[k])
  if (s.keywords.some((k) => SECURITY.includes(k)) && isTier(cfg.floors?.security)) t = max(t, cfg.floors.security)
  if (isTier(cfg.roleFloors?.[state.role])) t = max(t, cfg.roleFloors[state.role])
  if (isTier(cfg.skills?.[state.skill]?.floor)) t = max(t, cfg.skills[state.skill].floor)
  return t
}

// Local rules: tier, lens and read-only decide the base effort, before the downgrade-compensation and G clamps.
function baseEffort(tier, state) {
  let e = TIER_BASE_EFFORT[tier] ?? 'medium'
  if (state?.signals?.reads && !state?.signals?.edits) e = EFFORTS[Math.max(0, erank(e) - 1)]
  return e
}

// E = Jev's own effort pick when it made one (the local-rule path has none), else the tier's base effort — then,
// when `tier` is a downgrade below the default tier (sonnet), capped at base +2 levels (never past 'high'); an
// unchanged or upgraded tier keeps the pick uncapped by base, only by 'high'. Either way, clamped to G last.
export function computeEffort(tier, state, ceiling, jevEffort) {
  const base = baseEffort(tier, state)
  const downgrade = rank(tier) < rank(DEFAULT_TIER)
  const cap = downgrade ? emin(EFFORTS[erank(base) + 2], 'high') : 'high'
  const pick = isEffort(jevEffort) ? jevEffort : downgrade ? cap : base
  return emin(emin(pick, cap), isEffort(ceiling) ? ceiling : DEFAULTS.effort)
}

const QUESTION = choice('Which Claude model tier does this agent task need? haiku: mechanical and bounded (look something up, run a known command, format, small obvious edit). sonnet: normal software work. opus: judgement-heavy or risky (design, planning, security, data migration, subtle bugs, reviewing others\' code).',
  { haiku: 'Mechanical, bounded, low-risk work', sonnet: 'Normal implementation or analysis work', opus: 'Judgement-heavy, ambiguous or high-risk work' })
// WP-139: Jev's own effort pick, asked in the SAME call as the tier question (independent questions run in one
// request, no extra latency, only input tokens). computeEffort() still clamps it (≤ G; a downgraded model gets
// at most +2 above base, never past 'high').
const EFFORT_QUESTION = choice('How much reasoning effort does this task need? low: trivial or mechanical, the answer is obvious. medium: normal work needing some judgement. high: complex, ambiguous or risky work needing careful reasoning. xhigh: deep multi-step reasoning over a lot of context. max: the hardest, highest-stakes reasoning the model can do.',
  { low: 'Trivial or mechanical, the answer is obvious', medium: 'Normal work needing some judgement', high: 'Complex, ambiguous or risky work needing careful reasoning', xhigh: 'Deep multi-step reasoning over a lot of context', max: 'The hardest, highest-stakes reasoning the model can do' })

// Durable cache: every hook call is a new process, so judge()'s in-memory cache never hits there.
const CACHE_TTL = 7 * 24 * 3600 * 1000, CACHE_MAX = 2000
const hashOf = (state) => createHash('sha1').update(JSON.stringify(state)).digest('hex').slice(0, 16)
function cacheGet(h) {
  const c = readJson(paths().cache)?.[h]
  return c && Date.now() - c.ts < CACHE_TTL ? c : null
}
function cachePut(h, v) {
  try {
    const p = paths().cache, c = readJson(p) ?? {}
    c[h] = { ...v, ts: Date.now() }
    const keys = Object.keys(c)
    if (keys.length > CACHE_MAX) for (const k of keys.sort((a, b) => c[a].ts - c[b].ts).slice(0, keys.length - CACHE_MAX)) delete c[k]
    mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(c))
  } catch {}
}

// Jev's pick: haiku/opus only when that choice clears its threshold; anything else (incl. failure) → sonnet.
// Its effort pick (WP-139) rides the same call, unclamped here — computeEffort() applies the G/downgrade rules.
export async function jevDecide(state, cfg, { fetchImpl, timeoutMs = 1500 } = {}) {
  const h = hashOf(state)
  let a = cacheGet(h), cached = !!a
  if (!a) {
    // Jev sees the notes sentence, not the raw booleans/keyword array — those read as "easy" to it (WP-133).
    const jevState = { skill: state.skill, role: state.role, agent_description: state.agent_description, task: state.task,
      lens: state.signals.lens, notes: state.signals.notes }
    const ans = await judge('model_route', jevState, { tier: QUESTION, effort: EFFORT_QUESTION }, { timeoutMs, fetchImpl })
    const t = ans?.tier, e = ans?.effort
    if (t && isTier(t.choice)) {
      a = { choice: t.choice, confidence: t.confidence ?? 0 }
      if (e && isEffort(e.choice)) { a.effort = e.choice; a.effortP = e.confidence ?? 0 }
      cachePut(h, a)
    }
  }
  if (!a) return { tier: 'sonnet', source: 'jev-failopen', p: null, cached }
  const th = cfg.thresholds ?? DEFAULTS.thresholds
  // `p` (here and in the log/tuning) is always this same confidence — the one number gated against thresholds,
  // never a separate "probability" (WP-133): keep any future metric change to this one line.
  const tier = a.choice === 'haiku' && a.confidence >= th.haiku ? 'haiku' : a.choice === 'opus' && a.confidence >= th.opus ? 'opus' : 'sonnet'
  return { tier, source: 'jev', p: a.confidence, choice: a.choice, jevEffort: a.effort, effortP: a.effortP, cached }
}

// jev-eval's evaluator pair (EVALUATORS.routing): the same question(s) production asks, in the same call shape
// (WP-139: jevDecide asks tier+effort together, so tuning must judge the tier answer under that same shape).
export const modelRoute = { questions: () => ({ tier: QUESTION, effort: EFFORT_QUESTION }), decide: (a) => a?.tier?.choice ?? null }

function logDecision(d) {
  try {
    const p = paths().log
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify({ run: d.run, i: 0, ts: new Date().toISOString(), cmd: 'routing', p: d.p, t: d.t,
      decided: d.tier !== 'sonnet', item: { skill: d.state.skill, role: d.state.role, tier: d.tier, effort: d.effort, mode: d.mode, source: d.source, choice: d.choice ?? null, jevEffort: d.jevEffort ?? null, effortP: d.effortP ?? null }, state: d.state }) + '\n') // state (≤1.2 KB) lets routing-eval seed fixtures
  } catch {}
}

// The decision. `apply` is the tier to use (live only) or null.
// `session`: WP-157 — this call decides a SESSION's own tier (a fresh agent spawn, e.g. wt-handoff), not a
// subagent's. Never lands below cfg.sessionFloor regardless of what picked it — explicit, pinned, local or
// Jev. Subagent routing (wt-review/wt-research's lens/shard picks) never passes this, so it stays unaffected.
export async function route({ skill = '', role = '', lens = '', model = '', reuse = false, description = '', task = '', cwd = process.cwd(), env = process.env, fetchImpl, timeoutMs, log = true, session = false, effort: reqEffort = '' } = {}) {
  let cfg
  try { cfg = loadConfig({ cwd, env }) } catch { cfg = { ...DEFAULTS, from: 'default' } }
  // Global off is the kill switch: a per-skill mode never overrides it.
  const mode = cfg.mode !== 'off' && MODES.includes(cfg.skills?.[skill]?.mode) ? cfg.skills[skill].mode : cfg.mode
  // WP-298: the ceiling and the unit effort are deterministic, so they are reported even when routing is off.
  const cap = ceilingTier(cfg, role, { model, effort: reqEffort })
  const ue = unitEffort(reqEffort, effortCeiling(cfg, cap ?? 'sonnet').effort)
  const state = buildState({ skill, role, lens, description, task })
  // WP-298: the one exception to the session floor — a SESSION handed a unit of declared effort `low` may run on
  // haiku (floors such as security still raise it). Opt-in only: --session AND effort low AND no explicit model.
  const unitTier = session && reqEffort === 'low' && !model ? applyFloors('haiku', state, cfg) : null
  if (mode === 'off') return { mode, apply: null, source: 'off', from: cfg.from, capTier: cap, unitTier, ...(ue ? { effort: ue, applyEffort: ue } : {}) }
  const sessionFloor = !unitTier && session && isTier(cfg.sessionFloor) ? cfg.sessionFloor : null
  if (model) {
    const tier = sessionFloor ? max(sessionFloor, model) : model
    const effort = unitEffort(reqEffort, effortCeiling(cfg, tier).effort) ?? computeEffort(tier, state, effortCeiling(cfg, tier).effort)
    const out = { mode, apply: null, tier, effort, capTier: cap, source: reuse ? 'reuse' : tier === model ? 'explicit' : 'explicit+session-floor', from: cfg.from, applyEffort: mode === 'live' || ue ? effort : null }
    // WP-168: a hand-off reused an already-running worker, so its tier is already known and nothing new will be
    // applied — no Jev call needed. Still log it (with a `run` ref, same shape as a Jev/local/pin decision) so
    // the ticket that rode it has something `outcome` can mark; a plain explicit/escalated pick stays unlogged,
    // unchanged from before.
    if (reuse) { out.run = runId(); out.state = state; if (log) logDecision(out) }
    return out
  }
  let d
  const pin = cfg.skills?.[skill]?.pin
  if (unitTier) d = { tier: unitTier, source: 'unit-effort' } // no Jev call: the caller declared the effort
  else if (isTier(pin)) d = { tier: pin, source: 'pin' }
  else {
    const local = localDecide(state)
    d = local ? { tier: local, source: 'local' } : await jevDecide(state, cfg, { fetchImpl, timeoutMs })
  }
  const floored = applyFloors(d.tier, state, cfg)
  if (floored !== d.tier) d = { ...d, tier: floored, source: `${d.source}+floor` }
  // WP-298: the ceiling caps the tier (Jev's pick stays in `choice`); the session floor below still wins over it.
  if (cap && rank(d.tier) > rank(cap)) d = { ...d, tier: cap, source: `${d.source}+ceiling` }
  if (sessionFloor && rank(sessionFloor) > rank(d.tier)) d = { ...d, tier: sessionFloor, source: `${d.source}+session-floor` }
  const ceiling = effortCeiling(cfg, d.tier)
  const effort = unitEffort(reqEffort, ceiling.effort) ?? computeEffort(d.tier, state, ceiling.effort, d.jevEffort)
  const out = { ...d, effort, capTier: cap, unitTier, mode, from: cfg.from, effortFrom: ceiling.effortFrom, run: runId(), t: d.choice === 'opus' ? cfg.thresholds?.opus : cfg.thresholds?.haiku, state }
  if (log) logDecision(out)
  return { ...out, apply: mode === 'live' ? out.tier : null, applyEffort: mode === 'live' || ue ? out.effort : null }
}

// shadow-*: what the turn did on the model that ran while a shadow pick applied nothing (WP-215) — kept apart by
// routing-eval and never marked in wt-judge (it says nothing about whether the pick was right).
const MARK = { ok: 'yes', 'send-back': 'no', returned: 'no', escalated: 'no', 'shadow-ok': null, 'shadow-returned': null }
// Outcome for a logged decision: the reason goes to routing-outcomes.jsonl; the label to wt-judge mark.
export function outcome(runi, what, why = '') {
  if (!/^[a-z0-9]+#\d+$/.test(runi) || !(what in MARK)) throw new Error('usage: outcome <run#i> ok|send-back|returned|escalated|shadow-ok|shadow-returned ["why"]')
  const [run, i] = runi.split('#')
  const p = paths().outcomes
  mkdirSync(dirname(p), { recursive: true })
  appendFileSync(p, JSON.stringify({ run, i: Number(i), ts: new Date().toISOString(), outcome: what, why: String(why).slice(0, 200) }) + '\n')
  if (MARK[what]) try { execFileSync(process.execPath, [fileURLToPath(new URL('./wt-judge.mjs', import.meta.url)), 'mark', runi, MARK[what]], { stdio: 'ignore', timeout: 5000 }) } catch {}
}

// Tokens/notional cost by model, split session vs subagent — the dashboard-free equivalent of Settings › Usage.
// Dynamic import: wt-shared must keep working (pick/explain/floor/outcome) even where wt-dashboard isn't checked out.
async function usageReport(days) {
  const { UsageAgg } = await import('../../wt-dashboard/usage.mjs')
  const agg = new UsageAgg({ keepMs: days * 86400_000 })
  await agg.refresh(join(home(), '.claude', 'projects'))
  const s = agg.summary(Date.now() - days * 86400_000, (r) => `${r.model} · ${r.kind}`)
  console.log(`usage, last ${days}d: ${s.tokens} tokens${s.priced ? `, $${s.cost.toFixed(2)} notional` : ''}`)
  console.log('model · kind\ttokens\tcost')
  for (const g of s.groups) console.log([g.key, g.tokens, g.cost.toFixed(2)].join('\t'))
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2)
  const opt = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] ?? '' : '' }
  if (cmd === 'outcome') { outcome(a[0], a[1], a[2]); return }
  if (cmd === 'usage') { const days = Number(opt('days')); await usageReport(Number.isFinite(days) && days > 0 ? days : 7); return }
  if (cmd === 'model-id') {
    if (!isTier(a[0])) { console.error('usage: model-route.mjs model-id <haiku|sonnet|opus> [--cwd DIR]'); process.exitCode = 2; return }
    console.log(modelIdFor(a[0], loadConfig({ cwd: opt('cwd') || process.cwd() })))
    return
  }
  if (cmd === 'floor') {
    const cfg = loadConfig({ cwd: opt('cwd') || process.cwd() })
    // WP-157: sessionFloor is the hard minimum for every role (a session never spawns on haiku); a role's own
    // floor (e.g. planner → opus) only ever raises further, same as everywhere else floors are applied.
    const sessionFloor = isTier(cfg.sessionFloor) ? cfg.sessionFloor : 'sonnet'
    const roleFloor = cfg.roleFloors?.[opt('role')]
    let t = isTier(roleFloor) ? max(sessionFloor, roleFloor) : sessionFloor
    // WP-298: a persona's own model (its role file) may raise its base role's floor, never lower it.
    if (isTier(opt('persona-model'))) t = max(t, opt('persona-model'))
    // WP-298: a role ceiling caps the default tier too (never below the session floor); an explicit --model or persona model skips it.
    const cap = ceilingTier(cfg, opt('role'), { model: opt('model') || opt('persona-model') })
    if (cap && rank(t) > rank(cap)) t = max(sessionFloor, cap)
    const source = isTier(roleFloor) && rank(roleFloor) >= rank(sessionFloor) ? 'role-floor' : 'session-floor'
    // WP-160: unlike `pick`'s Jev-routed choice, this floor never uses Jev — it's a fixed computation from
    // cfg.sessionFloor/roleFloors, so (t and effortTier below are always a tier) it applies in every mode
    // (including off), not just live. A spawn has no task text to route in the first place; gating this on
    // live only ever meant a haiku-default spawn in shadow/off, the opposite of "never runs on haiku".
    // --model: the caller's actual tier (an explicit override away from the role's floor), effort only —
    // never changes the printed/`tier` floor itself. The session floor applies to the default (no --model)
    // case via `t` above; an explicit --model is the caller's own choice and keeps its own effort, same as
    // before WP-157 — the floor guards what gets spawned with no explicit tier, not an explicit override.
    const effortTier = isTier(opt('model')) ? opt('model') : t
    // WP-158: the explicit model id for whichever tier ends up spawned (the caller's own --model, or else the
    // role/session floor tier) — independent of routing mode, since a caller-given tier gets its id regardless.
    // Folded into this same call (rather than a separate `model-id` one) so a spawn/respawn that
    // already needs floor's tier/effort doesn't pay for loadConfig()'s git/project-setting shell-outs twice.
    const model = modelIdFor(effortTier, cfg)
    const effort = computeEffort(effortTier, buildState({ role: opt('role') }), effortCeiling(cfg, effortTier).effort)
    if (a.includes('--json')) console.log(JSON.stringify({ tier: t, source, effort, model }))
    else console.log(t)
    return
  }
  if (cmd !== 'pick' && cmd !== 'explain') { console.error('usage: model-route.mjs pick|explain [--skill S] [--role R] [--lens L] [--model M] [--reuse] [--desc D] [--cwd DIR] [--session] [--effort low|medium|high] [--json] < task | outcome <run#i> <what> ["why"] | usage [--days N] | floor --role R [--model M] [--persona-model M] [--cwd DIR] [--json] | model-id <haiku|sonnet|opus> [--cwd DIR]'); process.exitCode = 2; return }
  let task = ''
  if (!process.stdin.isTTY) try { task = readFileSync(0, 'utf8') } catch {}
  const d = await route({ skill: opt('skill'), role: opt('role'), lens: opt('lens'), model: opt('model'), reuse: a.includes('--reuse'), description: opt('desc'), task, cwd: opt('cwd') || process.cwd(), log: !a.includes('--no-log'), session: a.includes('--session'), effort: opt('effort') })
  if (cmd === 'explain') { const { state, ...rest } = d; console.log(JSON.stringify({ ...rest, state })); return }
  if (a.includes('--json')) console.log(JSON.stringify({ tier: d.tier ?? null, apply: d.apply, capTier: d.capTier ?? null, unitTier: d.unitTier ?? null, effort: d.effort ?? null, applyEffort: d.applyEffort ?? null, mode: d.mode, source: d.source, ref: d.run ? `${d.run}#0` : null }))
  else if (d.apply) console.log(d.apply)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(() => { process.exitCode = 0 })

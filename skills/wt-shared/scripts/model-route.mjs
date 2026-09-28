#!/usr/bin/env node
// WP-128: pick the model tier (haiku | sonnet | opus) for a session or subagent from its task.
// WP-137: also pick its effort level (low < medium < high < xhigh < max), gated by the global ceiling G. Local rules
// (tier, lens, read-only) set the base; a tier picked BELOW the default tier (sonnet) may raise effort up to 2
// levels to compensate, capped at 'high'; an unchanged or upgraded tier never raises. Either way E is clamped to G.
//   model-route.mjs pick --skill S [--role R] [--lens L] [--model M] [--desc D] [--cwd DIR] [--json] < task
//       live: prints the tier; off/shadow: prints nothing (--json: always the decision incl. effort, plus "run#i").
//       Exit 0 always.
//   model-route.mjs explain …same flags… < task   the whole decision as JSON
//   model-route.mjs floor --role R [--model M] [--cwd DIR] [--json]   live: the role's floor tier (planner →
//       opus) and its effort, else nothing (spawn has no task text to route, so this is all it applies without
//       an explicit tier). --model computes the printed effort for that tier instead of the role's floor tier
//       (e.g. the caller already picked one some other way) without changing the printed/`tier` floor itself.
//   model-route.mjs outcome <run#i> ok|send-back|returned|escalated ["why"]   record what happened (tuning input)
//   model-route.mjs usage [--days N]   tokens/notional cost by model, split session vs subagent (WP-130; dashboard-
//       free equivalent of Settings › Usage; N defaults to 7)
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
  thresholds: { haiku: 0.8, opus: 0.6 },
  effort: 'high', // the global ceiling G, same config layering as `mode`
}
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
// own WT_EFFORT/model-routing.json layers below still win when a caller explicitly sets one. Same source order
// Claude Code itself uses: its live session env var, else its settings.json `effortLevel` (project over user).
function claudeCodeEffort(root, env) {
  if (isEffort(env.CLAUDE_EFFORT)) return env.CLAUDE_EFFORT
  const proj = root && readJson(join(root, '.claude', 'settings.json'))
  if (isEffort(proj?.effortLevel)) return proj.effortLevel
  const user = readJson(join(home(), '.claude', 'settings.json'))
  if (isEffort(user?.effortLevel)) return user.effortLevel
  return null
}

// The merged config; `from`/`effortFrom` name where the mode/effort came from (for explain).
export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  let cfg = merge(DEFAULTS, readJson(paths().user))
  let from = readJson(paths().user)?.mode ? 'user' : 'default'
  let effortFrom = readJson(paths().user)?.effort ? 'user' : 'default'
  const root = repoRoot(cwd) // one shell-out, shared with the repo config-file read below
  if (effortFrom === 'default') {
    const ce = claudeCodeEffort(root, env)
    if (isEffort(ce)) { cfg = { ...cfg, effort: ce }; effortFrom = 'claude' }
  }
  const pm = projectSetting(cwd, 'WT_MODEL_ROUTING')
  if (MODES.includes(pm)) { cfg = { ...cfg, mode: pm }; from = 'project' }
  const pe = projectSetting(cwd, 'WT_EFFORT')
  if (isEffort(pe)) { cfg = { ...cfg, effort: pe }; effortFrom = 'project' }
  const repo = root && readJson(join(root, '.wt-pack', 'model-routing.json'))
  if (repo) { cfg = merge(cfg, repo); if (repo.mode) from = 'repo'; if (repo.effort) effortFrom = 'repo' }
  const e = env.WT_MODEL_ROUTING
  if (MODES.includes(e)) { cfg = { ...cfg, mode: e }; from = 'env' }
  const ee = env.WT_EFFORT
  if (isEffort(ee)) { cfg = { ...cfg, effort: ee }; effortFrom = 'env' }
  if (!MODES.includes(cfg.mode)) cfg.mode = 'shadow'
  if (!isEffort(cfg.effort)) cfg.effort = DEFAULTS.effort
  return { ...cfg, from, effortFrom }
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
export async function route({ skill = '', role = '', lens = '', model = '', description = '', task = '', cwd = process.cwd(), env = process.env, fetchImpl, timeoutMs, log = true } = {}) {
  let cfg
  try { cfg = loadConfig({ cwd, env }) } catch { cfg = { ...DEFAULTS, from: 'default' } }
  // Global off is the kill switch: a per-skill mode never overrides it.
  const mode = cfg.mode !== 'off' && MODES.includes(cfg.skills?.[skill]?.mode) ? cfg.skills[skill].mode : cfg.mode
  if (mode === 'off') return { mode, apply: null, source: 'off', from: cfg.from }
  const state = buildState({ skill, role, lens, description, task })
  if (model) {
    const effort = computeEffort(model, state, cfg.effort)
    return { mode, apply: null, tier: model, effort, source: 'explicit', from: cfg.from, applyEffort: mode === 'live' ? effort : null }
  }
  let d
  const pin = cfg.skills?.[skill]?.pin
  if (isTier(pin)) d = { tier: pin, source: 'pin' }
  else {
    const local = localDecide(state)
    d = local ? { tier: local, source: 'local' } : await jevDecide(state, cfg, { fetchImpl, timeoutMs })
  }
  const floored = applyFloors(d.tier, state, cfg)
  if (floored !== d.tier) d = { ...d, tier: floored, source: `${d.source}+floor` }
  const effort = computeEffort(d.tier, state, cfg.effort, d.jevEffort)
  const out = { ...d, effort, mode, from: cfg.from, effortFrom: cfg.effortFrom, run: runId(), t: d.choice === 'opus' ? cfg.thresholds?.opus : cfg.thresholds?.haiku, state }
  if (log) logDecision(out)
  return { ...out, apply: mode === 'live' ? out.tier : null, applyEffort: mode === 'live' ? out.effort : null }
}

const MARK = { ok: 'yes', 'send-back': 'no', returned: 'no', escalated: 'no' }
// Outcome for a logged decision: the reason goes to routing-outcomes.jsonl; the label to wt-judge mark.
export function outcome(runi, what, why = '') {
  if (!/^[a-z0-9]+#\d+$/.test(runi) || !MARK[what]) throw new Error('usage: outcome <run#i> ok|send-back|returned|escalated ["why"]')
  const [run, i] = runi.split('#')
  const p = paths().outcomes
  mkdirSync(dirname(p), { recursive: true })
  appendFileSync(p, JSON.stringify({ run, i: Number(i), ts: new Date().toISOString(), outcome: what, why: String(why).slice(0, 200) }) + '\n')
  try { execFileSync(process.execPath, [fileURLToPath(new URL('./wt-judge.mjs', import.meta.url)), 'mark', runi, MARK[what]], { stdio: 'ignore', timeout: 5000 }) } catch {}
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
  if (cmd === 'floor') {
    const cfg = loadConfig({ cwd: opt('cwd') || process.cwd() })
    const t = cfg.roleFloors?.[opt('role')]
    const live = cfg.mode === 'live' && isTier(t)
    // --model: the caller's actual tier (an explicit override away from the role's floor), effort only —
    // never changes the printed/`tier` floor itself.
    const effortTier = isTier(opt('model')) ? opt('model') : t
    const effortLive = cfg.mode === 'live' && isTier(effortTier)
    if (a.includes('--json')) console.log(JSON.stringify({ tier: live ? t : null, effort: effortLive ? computeEffort(effortTier, buildState({ role: opt('role') }), cfg.effort) : null }))
    else if (live) console.log(t)
    return
  }
  if (cmd !== 'pick' && cmd !== 'explain') { console.error('usage: model-route.mjs pick|explain [--skill S] [--role R] [--lens L] [--model M] [--desc D] [--cwd DIR] [--json] < task | outcome <run#i> <what> ["why"] | usage [--days N] | floor --role R [--cwd DIR] [--json]'); process.exitCode = 2; return }
  let task = ''
  if (!process.stdin.isTTY) try { task = readFileSync(0, 'utf8') } catch {}
  const d = await route({ skill: opt('skill'), role: opt('role'), lens: opt('lens'), model: opt('model'), description: opt('desc'), task, cwd: opt('cwd') || process.cwd(), log: !a.includes('--no-log') })
  if (cmd === 'explain') { const { state, ...rest } = d; console.log(JSON.stringify({ ...rest, state })); return }
  if (a.includes('--json')) console.log(JSON.stringify({ tier: d.tier ?? null, apply: d.apply, effort: d.effort ?? null, applyEffort: d.applyEffort ?? null, mode: d.mode, source: d.source, ref: d.run ? `${d.run}#0` : null }))
  else if (d.apply) console.log(d.apply)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(() => { process.exitCode = 0 })

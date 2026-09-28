#!/usr/bin/env node
// WP-128: pick the model tier (haiku | sonnet | opus) for a session or subagent from its task.
//   model-route.mjs pick --skill S [--role R] [--lens L] [--model M] [--desc D] [--cwd DIR] [--json] < task
//       live: prints the tier; off/shadow: prints nothing (--json: always the decision, plus "run#i"). Exit 0 always.
//   model-route.mjs explain …same flags… < task   the whole decision as JSON
//   model-route.mjs floor --role R [--cwd DIR]   live: the role's floor tier (planner → opus), else nothing (spawn
//       has no task text to route, so this is all it applies without a --model)
//   model-route.mjs outcome <run#i> ok|send-back|returned|escalated ["why"]   record what happened (tuning input)
// Order: kill switch / mode off → explicit model → skill pin → local obvious case → Jev choice → floors (only raise).
// Config layers, first wins: env WT_MODEL_ROUTING (mode) › <repo>/.wt-pack/model-routing.json › dashboard project
// setting WT_MODEL_ROUTING (mode) › ~/.config/wt-pack/model-routing.json › defaults (mode shadow).
// Every decision past the explicit check is logged to the judge log as cmd 'routing' (wt-judge calibrate skips it;
// routing-eval.mjs tunes it). Nothing here may throw into a caller: failures pick sonnet or nothing.
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
export const DEFAULTS = {
  mode: 'shadow', skills: {},
  floors: { correctness: 'sonnet', security: 'sonnet', data: 'sonnet', migration: 'sonnet' },
  roleFloors: { planner: 'opus' },
  thresholds: { haiku: 0.8, opus: 0.6 },
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
const projectMode = (cwd) => {
  try {
    return execFileSync(process.execPath, [fileURLToPath(new URL('./project-setting.mjs', import.meta.url)), 'get', 'WT_MODEL_ROUTING', '--cwd', cwd],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim().split('\n').pop()
  } catch { return '' }
}

// The merged config; `layers` names where the mode came from (for explain).
export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  let cfg = merge(DEFAULTS, readJson(paths().user))
  let from = readJson(paths().user)?.mode ? 'user' : 'default'
  const pm = projectMode(cwd)
  if (MODES.includes(pm)) { cfg = { ...cfg, mode: pm }; from = 'project' }
  const root = repoRoot(cwd)
  const repo = root && readJson(join(root, '.wt-pack', 'model-routing.json'))
  if (repo) { cfg = merge(cfg, repo); if (repo.mode) from = 'repo' }
  const e = env.WT_MODEL_ROUTING
  if (MODES.includes(e)) { cfg = { ...cfg, mode: e }; from = 'env' }
  if (!MODES.includes(cfg.mode)) cfg.mode = 'shadow'
  return { ...cfg, from }
}

const EDIT = /\b(implement|fix|edit|write|add|change|refactor|rename|delete|remove|migrate|update|commit|merge|build)\b/i
const READ = /\b(read|find|search|grep|list|look|explore|locate|check|compare|verify|sweep|report)\b/i
const KEYWORDS = ['security', 'auth', 'secret', 'token', 'session', 'cookie', 'permission', 'csrf', 'migration', 'schema', 'data', 'backfill', 'refactor', 'architecture', 'plan', 'review', 'test']
// A security-sensitive subset of KEYWORDS: floors the tier (applyFloors) and blocks the read-only local haiku rule.
const SECURITY = ['security', 'auth', 'secret', 'token', 'session', 'cookie', 'permission', 'csrf', 'migration', 'schema']
const LOCAL_HAIKU_LENS = /^(docs|naming|formatting)$/i
// ≤ ~300 tokens: skill, description, the first 600 chars of the task, and cheap signals.
export function buildState({ skill = '', role = '', lens = '', description = '', task = '' } = {}) {
  const t = String(task)
  return {
    skill: String(skill).slice(0, 60), role: String(role).slice(0, 30), agent_description: String(description).slice(0, 120),
    task: t.slice(0, 600),
    signals: { edits: EDIT.test(t), reads: READ.test(t), lens: String(lens).slice(0, 30),
      keywords: KEYWORDS.filter((k) => new RegExp(`\\b${k}`, 'i').test(t)), len: t.length },
  }
}

// A cheap, certain answer with no Jev call, or null.
export function localDecide(state) {
  if (/^explore$/i.test(state.skill)) return 'haiku'
  if (LOCAL_HAIKU_LENS.test(state.signals.lens)) return 'haiku'
  const secure = state.signals.keywords.some((k) => SECURITY.includes(k))
  if (secure) return null // a security-sensitive task always goes to Jev (and the floor), never a local shortcut
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

const QUESTION = choice('Which Claude model tier does this agent task need? haiku: mechanical and bounded (look something up, run a known command, format, small obvious edit). sonnet: normal software work. opus: judgement-heavy or risky (design, planning, security, data migration, subtle bugs, reviewing others\' code).',
  { haiku: 'Mechanical, bounded, low-risk work', sonnet: 'Normal implementation or analysis work', opus: 'Judgement-heavy, ambiguous or high-risk work' })

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
export async function jevDecide(state, cfg, { fetchImpl, timeoutMs = 1500 } = {}) {
  const h = hashOf(state)
  let a = cacheGet(h), cached = !!a
  if (!a) {
    const ans = await judge('model_route', state, { tier: QUESTION }, { timeoutMs, fetchImpl })
    const t = ans?.tier
    if (t && isTier(t.choice)) { a = { choice: t.choice, confidence: t.confidence ?? 0 }; cachePut(h, a) }
  }
  if (!a) return { tier: 'sonnet', source: 'jev-failopen', p: null, cached }
  const th = cfg.thresholds ?? DEFAULTS.thresholds
  const tier = a.choice === 'haiku' && a.confidence >= th.haiku ? 'haiku' : a.choice === 'opus' && a.confidence >= th.opus ? 'opus' : 'sonnet'
  return { tier, source: 'jev', p: a.confidence, choice: a.choice, cached }
}

// jev-eval's evaluator pair (EVALUATORS.routing): the same question production asks.
export const modelRoute = { questions: () => ({ tier: QUESTION }), decide: (a) => a?.tier?.choice ?? null }

function logDecision(d) {
  try {
    const p = paths().log
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify({ run: d.run, i: 0, ts: new Date().toISOString(), cmd: 'routing', p: d.p, t: d.t,
      decided: d.tier !== 'sonnet', item: { skill: d.state.skill, role: d.state.role, tier: d.tier, mode: d.mode, source: d.source, choice: d.choice ?? null }, state: d.state }) + '\n') // state (≤1.2 KB) lets routing-eval seed fixtures
  } catch {}
}

// The decision. `apply` is the tier to use (live only) or null.
export async function route({ skill = '', role = '', lens = '', model = '', description = '', task = '', cwd = process.cwd(), env = process.env, fetchImpl, timeoutMs, log = true } = {}) {
  let cfg
  try { cfg = loadConfig({ cwd, env }) } catch { cfg = { ...DEFAULTS, from: 'default' } }
  // Global off is the kill switch: a per-skill mode never overrides it.
  const mode = cfg.mode !== 'off' && MODES.includes(cfg.skills?.[skill]?.mode) ? cfg.skills[skill].mode : cfg.mode
  if (mode === 'off') return { mode, apply: null, source: 'off', from: cfg.from }
  if (model) return { mode, apply: null, tier: model, source: 'explicit', from: cfg.from }
  const state = buildState({ skill, role, lens, description, task })
  let d
  const pin = cfg.skills?.[skill]?.pin
  if (isTier(pin)) d = { tier: pin, source: 'pin' }
  else {
    const local = localDecide(state)
    d = local ? { tier: local, source: 'local' } : await jevDecide(state, cfg, { fetchImpl, timeoutMs })
  }
  const floored = applyFloors(d.tier, state, cfg)
  if (floored !== d.tier) d = { ...d, tier: floored, source: `${d.source}+floor` }
  const out = { ...d, mode, from: cfg.from, run: runId(), t: d.choice === 'opus' ? cfg.thresholds?.opus : cfg.thresholds?.haiku, state }
  if (log) logDecision(out)
  return { ...out, apply: mode === 'live' ? out.tier : null }
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

async function main() {
  const [cmd, ...a] = process.argv.slice(2)
  const opt = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] ?? '' : '' }
  if (cmd === 'outcome') { outcome(a[0], a[1], a[2]); return }
  if (cmd === 'floor') {
    const cfg = loadConfig({ cwd: opt('cwd') || process.cwd() })
    const t = cfg.roleFloors?.[opt('role')]
    if (cfg.mode === 'live' && isTier(t)) console.log(t)
    return
  }
  if (cmd !== 'pick' && cmd !== 'explain') { console.error('usage: model-route.mjs pick|explain [--skill S] [--role R] [--lens L] [--model M] [--desc D] [--cwd DIR] [--json] < task | outcome <run#i> <what> ["why"]'); process.exitCode = 2; return }
  let task = ''
  if (!process.stdin.isTTY) try { task = readFileSync(0, 'utf8') } catch {}
  const d = await route({ skill: opt('skill'), role: opt('role'), lens: opt('lens'), model: opt('model'), description: opt('desc'), task, cwd: opt('cwd') || process.cwd(), log: !a.includes('--no-log') })
  if (cmd === 'explain') { const { state, ...rest } = d; console.log(JSON.stringify({ ...rest, state })); return }
  if (a.includes('--json')) console.log(JSON.stringify({ tier: d.tier ?? null, apply: d.apply, mode: d.mode, source: d.source, ref: d.run ? `${d.run}#0` : null }))
  else if (d.apply) console.log(d.apply)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(() => { process.exitCode = 0 })

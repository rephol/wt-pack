#!/usr/bin/env node
// WP-128 model routing: report and self-tuning from local logs (no API key needed).
//   node skills/wt-shared/scripts/jev-eval.mjs routing --report [--since 7d] [--apply]
// Reads the judge log (cmd 'routing') joined to routing-outcomes.jsonl by run id. --apply moves each Jev threshold by
// at most ±0.05, ignores pinned skills, never touches floors, writes the user config and seeds jev-fixtures/routing.json
// from escalations and send-backs.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, TIERS, loadConfig, paths } from './model-route.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const STEP = 0.05, MIN_N = 10, BAD_HIGH = 0.2
const BAD = new Set(['send-back', 'returned', 'escalated'])
const jsonl = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const days = (s) => Number(/^(\d+)d$/.exec(s ?? '')?.[1] ?? 7)

// Decisions since `since`, each with the outcomes recorded for it.
export function load({ sinceDays = 7, now = Date.now() } = {}) {
  const from = now - sinceDays * 864e5
  const outs = new Map()
  for (const o of jsonl(paths().outcomes)) outs.set(o.run, [...(outs.get(o.run) ?? []), o.outcome])
  return jsonl(paths().log).filter((e) => e.cmd === 'routing' && Date.parse(e.ts) >= from)
    .map((e) => ({ ...e.item, p: e.p, run: e.run, state: e.state, outcomes: outs.get(e.run) ?? [] }))
}

// Per skill×tier: picks, applied (live), send-backs, returns, escalations, ok. `effort` (WP-137) is the most
// recent E seen for that skill×tier — deterministic given tier and signals, so it rarely varies within a group.
export function report(ds) {
  const rows = new Map()
  for (const d of ds) {
    const k = `${d.skill || d.role || '-'}|${d.tier}`
    const r = rows.get(k) ?? { skill: d.skill || d.role || '-', tier: d.tier, effort: null, picks: 0, applied: 0, sendBack: 0, returned: 0, escalated: 0, ok: 0 }
    r.picks++; if (d.mode === 'live') r.applied++
    if (d.effort) r.effort = d.effort
    for (const o of d.outcomes) if (o === 'send-back') r.sendBack++; else if (o === 'returned') r.returned++; else if (o === 'escalated') r.escalated++; else if (o === 'ok') r.ok++
    rows.set(k, r)
  }
  return [...rows.values()].sort((a, b) => a.skill.localeCompare(b.skill) || TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier))
}

// New thresholds, each moved at most one STEP per run. Only Jev decisions with an outcome count; pinned skills are
// ignored; floors are never read or written.
export function tune(ds, cfg) {
  const th = { ...DEFAULTS.thresholds, ...cfg.thresholds }
  const changes = []
  // Haiku picks: failures tighten, a clean record loosens. (Bad opus outcomes don't argue for less opus.)
  const xs = ds.filter((d) => d.source === 'jev' && d.choice === 'haiku' && d.outcomes.length && !cfg.skills?.[d.skill]?.pin)
  if (xs.length >= MIN_N) {
    const bad = xs.filter((d) => d.outcomes.some((o) => BAD.has(o))).length / xs.length
    const next = Math.min(0.99, Math.max(0.5, +(th.haiku + (bad > BAD_HIGH ? STEP : bad === 0 ? -STEP : 0)).toFixed(2)))
    if (next !== th.haiku) { changes.push({ tier: 'haiku', from: th.haiku, to: next, n: xs.length, bad: +bad.toFixed(2) }); th.haiku = next }
  }
  // Escalations of non-opus picks say opus was needed: loosen the opus threshold one step.
  const esc = ds.filter((d) => d.source === 'jev' && d.tier !== 'opus' && d.outcomes.includes('escalated') && !cfg.skills?.[d.skill]?.pin)
  const jevN = ds.filter((d) => d.source === 'jev' && d.outcomes.length).length
  if (jevN >= MIN_N && esc.length / jevN > BAD_HIGH / 2) {
    const next = Math.max(0.5, +(th.opus - STEP).toFixed(2))
    if (next !== th.opus) { changes.push({ tier: 'opus', from: th.opus, to: next, n: jevN, bad: +(esc.length / jevN).toFixed(2) }); th.opus = next }
  }
  return { thresholds: th, changes }
}

// Estimated tokens/cost saved vs running every decided pick at the default tier (sonnet), using each tier's
// actual average cost-per-message from real usage in the same window (avgByTier: {tier: {tokens, cost}}, from
// wt-dashboard/usage.mjs — WP-130; no per-decision usage is recorded, so this compares averages, not exact spend).
export function estimateSavings(ds, avgByTier) {
  const base = avgByTier.sonnet
  if (!base) return { tokens: 0, cost: 0, priced: false, n: 0 }
  let tokens = 0, cost = 0, priced = true, n = 0
  for (const d of ds) {
    if (d.mode !== 'live' || d.tier === 'sonnet') continue
    const t = avgByTier[d.tier]
    if (!t) { priced = false; continue }
    tokens += base.tokens - t.tokens; cost += base.cost - t.cost; n++
  }
  return { tokens: Math.round(tokens), cost, priced, n }
}

const up = (t) => TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(t) + 1)]
const hash = (s) => createHash('sha1').update(JSON.stringify(s)).digest('hex').slice(0, 16)
// Escalated or sent-back decisions become fixtures expecting one tier up; deduped by state hash.
export function seedFixtures(ds, file = join(here, '..', 'jev-fixtures', 'routing.json')) {
  const cur = readJson(file) ?? []
  const seen = new Set(cur.map((c) => hash(c.state)))
  let added = 0
  for (const d of ds) {
    if (!d.state || !d.outcomes.some((o) => o === 'escalated' || o === 'send-back')) continue
    const h = hash(d.state)
    if (seen.has(h)) continue
    seen.add(h); cur.push({ state: d.state, expect: up(d.tier) }); added++
  }
  if (added) writeFileSync(file, JSON.stringify(cur, null, 1) + '\n')
  return added
}

export function writeUser(thresholds) {
  const p = paths().user, c = readJson(p) ?? {}
  c.thresholds = { ...c.thresholds, ...thresholds }
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(c, null, 2) + '\n')
}

export async function main(argv) {
  const at = argv.indexOf('--since'), sinceDays = days(at >= 0 ? argv[at + 1] : '7d')
  const ds = load({ sinceDays })
  const rows = report(ds)
  console.log(`model routing, last ${sinceDays}d: ${ds.length} decisions (tokens-saved column skipped: no per-session usage source)`)
  // WP-136: tune() already excludes these (only source === 'jev' feeds thresholds), but a spike is worth a
  // line in the report — it means routing silently defaulted to sonnet for the whole window.
  const failOpen = ds.filter((d) => d.source === 'jev-failopen').length
  if (failOpen) console.log(`${failOpen} decision(s) fell back to sonnet (Jev unavailable) — excluded from tuning`)
  console.log('skill\ttier\teffort\tpicks\tapplied\tsend-back\treturned\tescalated\tok')
  for (const r of rows) console.log([r.skill, r.tier, r.effort ?? '-', r.picks, r.applied, r.sendBack, r.returned, r.escalated, r.ok].join('\t'))
  const cfg = loadConfig({ cwd: process.cwd() })
  const { thresholds, changes } = tune(ds, cfg)
  for (const c of changes) console.log(`threshold ${c.tier}: ${c.from} → ${c.to} (n=${c.n}, bad=${c.bad})`)
  if (!changes.length) console.log(`thresholds unchanged (need ≥${MIN_N} Jev decisions with outcomes per tier)`)
  if (!argv.includes('--apply')) return
  const added = seedFixtures(ds)
  console.log(`fixtures: +${added}`)
  if (!changes.length) return
  writeUser(thresholds)
  console.log(`wrote ${paths().user}`)
  const room = join(here, '..', '..', 'wt-room', 'scripts', 'room')
  if (existsSync(room)) try {
    execFileSync(room, ['post', 'wt-pack', `model routing tuned: ${changes.map((c) => `${c.tier} ${c.from}→${c.to}`).join(', ')}`], { stdio: 'ignore', timeout: 10000 })
  } catch {}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((err) => { console.error(err); process.exitCode = 1 })

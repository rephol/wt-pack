// Shared TypeSafe call path for the wt-* pack.
//
// Exit-code contract for every caller, because these tools are OPTIONAL:
//   0  judged      1  run failed      2  usage      3  no key — SKIP SILENTLY
//
// Nothing here decides anything. Callers map answers to behaviour, and every
// caller must have a no-key fallback that is the pack's existing behaviour.
import { readFileSync, appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
export const NO_KEY = 3;

// The key normally lives in ~/.claude/.env rather than the shell. Minimal parse:
// KEY=value lines, optional export, a matched quote pair stripped — anything
// fancier belongs in a dotenv dependency this does not need.
export function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    for (const line of readFileSync(join(homedir(), '.claude', '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/);
      if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return null;
}

export function requireKey() {
  const key = apiKey();
  if (!key) {
    console.error('TYPESAFE_API_KEY is not set, and no TYPESAFE_API_KEY line in ~/.claude/.env');
    process.exit(NO_KEY);
  }
  return key;
}

// One call, many questions: independent questions over the same state run in
// parallel server-side, so batching is free latency-wise and costs only input
// tokens once. Callers should batch rather than loop.
export async function ask(state, questions, key = requireKey()) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: MODEL, questions }),
  });
  if (!res.ok) {
    console.error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 400)}`);
    process.exit(1);
  }
  return res.json();
}

export const noul = (instructions, criteria) => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) });
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
// Score criteria is the LIST of level descriptions, not {levels:[...]} — the
// object shape is rejected with 422 "Input should be a valid list".
export const score = (instructions, levels) => ({ type: 'score', instructions, criteria: levels });

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'));
  } catch (e) {
    console.error(`cannot read JSON from ${path}: ${e.message}`);
    process.exit(2);
  }
}

export const readText = (path) => readFileSync(path === '-' ? 0 : path, 'utf8');
export const pct = (n) => `${Math.round(n * 100)}%`;

// ── judgment log ─────────────────────────────────────────────────────────────
// Every judgment is appended here with a stable id so an outcome can be attached
// later. This is the only way the thresholds improve: a model re-scoring its own
// answers just repeats its own bias, so calibration needs outcomes from outside.
export const LOG = join(homedir(), '.claude', 'wt-judge-log.jsonl');
export const THRESHOLDS = join(homedir(), '.claude', 'wt-judge-thresholds.json');

export const runId = () => Math.random().toString(36).slice(2, 8);

// Entries: {run, i, ts, cmd, p, t, decided, label?, item}
export function logJudgments(run, cmd, t, rows) {
  const ts = new Date().toISOString();
  const lines = rows.map((r, i) =>
    JSON.stringify({ run, i, ts, cmd, p: r.p, t, decided: r.p >= t, item: r.item }));
  try {
    appendFileSync(LOG, lines.join('\n') + '\n');
  } catch (e) {
    // Never fail a judgment because the log could not be written.
    console.error(`(judgment log not written: ${e.message})`);
  }
}

export function readLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// Learned thresholds override the shipped defaults; absent file means defaults.
export function learnedThresholds() {
  try { return JSON.parse(readFileSync(THRESHOLDS, 'utf8')); } catch { return {}; }
}

// ── fail-open judgments ──────────────────────────────────────────────────────
// judge() is for callers that must keep working without Jev: it never throws and
// never exits — any failure (no key, timeout, HTTP error, bad JSON) returns null
// and the caller falls back to its existing heuristic. Every call, cache hits
// included, appends one line to jev-calls.jsonl; the key is never written.
export const JEV_DIR = join(homedir(), '.local', 'share', 'wt-dashboard');
// WT_JEV_LOG overrides the path (tests).
export const jevLog = () => process.env.WT_JEV_LOG || join(JEV_DIR, 'jev-calls.jsonl');
const ROTATE_BYTES = 5 * 1024 * 1024;
const DASH_ENV = () => process.env.WT_DASHBOARD_ENV || join(homedir(), '.config', 'wt-dashboard', 'env');

// Same lookup as mcp-mode.sh: env wins, else the dashboard env file's last KEY= line.
export function envSetting(name) {
  if (process.env[name] != null && process.env[name] !== '') return process.env[name];
  try {
    let v = null;
    for (const line of readFileSync(DASH_ENV(), 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`));
      if (m) v = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    return v;
  } catch { return null; }
}

// CLI switch lookup. The server must use cfg.get('WT_JEV_*') instead (the app copies the env file into
// the server env at launch, so env-first would ignore Settings toggles there).
export const enabled = (feature, dflt = false) => {
  const v = envSetting(`WT_JEV_${feature.toUpperCase()}`);
  return v == null ? dflt : v === 'on';
};

export function keyFor() {
  const k = apiKey();
  if (k) return k;
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'wt-dashboard', '-a', 'TYPESAFE_API_KEY', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).trim() || null;
  } catch { return null; }
}

function logCall(rec) {
  try {
    const log = jevLog();
    mkdirSync(dirname(log), { recursive: true });
    try { if (statSync(log).size > ROTATE_BYTES) renameSync(log, log + '.1'); } catch {} // ponytail: one rename, not a rotation library
    appendFileSync(log, JSON.stringify(rec) + '\n');
  } catch {}
}

// ponytail: per-process cache; the server is the long-lived caller that benefits.
const cache = new Map();
const CACHE_MAX = 128, CACHE_TTL = 10 * 60 * 1000;

// Best-effort headline probability for the log: first answer's noul, choice confidence, or null.
function headline(answers) {
  const a = Object.values(answers ?? {})[0];
  const p = a?.noul ?? a?.confidence ?? null;
  return typeof p === 'number' ? Math.round(p * 100) / 100 : null;
}

// Returns the answers object or null. `pick(answers)` (optional) tells the log whether the caller's
// judgment was positive; without it outcome is 'picked' for any answer.
export async function judge(feature, state, questions, { timeoutMs = 2000, key, fetchImpl = globalThis.fetch, pick } = {}) {
  const t0 = Date.now();
  const input = JSON.stringify([state, questions]);
  const h = createHash('sha1').update(input).digest('hex');
  const ck = `${feature}:${h}`;
  const rec = (answers, err, cached) => {
    const outcome = answers == null ? 'failopen' : (pick ? (pick(answers) ? 'picked' : 'not') : 'picked');
    logCall({ ts: new Date().toISOString(), feature, outcome, p: headline(answers), ms: Date.now() - t0, cache: cached, err,
      in: h.slice(0, 12), ...(envSetting('WT_JEV_LOG_SNIPPETS') === 'on' ? { snippet: JSON.stringify(state).slice(0, 120) } : {}) });
    return answers;
  };
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.t < CACHE_TTL) return rec(hit.a, null, true);
  const k = key ?? keyFor();
  if (!k) return rec(null, 'nokey', false);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return rec(null, `http_${res.status}`, false);
    let j;
    try { j = await res.json(); } catch { return rec(null, 'parse', false); }
    if (!j?.answers || typeof j.answers !== 'object') return rec(null, 'parse', false);
    cache.set(ck, { t: Date.now(), a: j.answers });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return rec(j.answers, null, false);
  } catch (e) {
    return rec(null, e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'http_0', false);
  }
}

// Numeric threshold override: WT_JEV_<FEATURE>_MIN, else dflt.
export const minFor = (feature, dflt = 0.7) => {
  const v = Number(envSetting(`WT_JEV_${feature.toUpperCase()}_MIN`));
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

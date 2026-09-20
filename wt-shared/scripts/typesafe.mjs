// Shared TypeSafe call path for the wt-* pack.
//
// Exit-code contract for every caller, because these tools are OPTIONAL:
//   0  judged      1  run failed      2  usage      3  no key — SKIP SILENTLY
//
// Nothing here decides anything. Callers map answers to behaviour, and every
// caller must have a no-key fallback that is the pack's existing behaviour.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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

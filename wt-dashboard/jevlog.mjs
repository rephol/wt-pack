// Reads the Jev call log that wt-shared/scripts/typesafe.mjs judge() appends (CLIs and server alike):
// one {ts, feature, outcome, p, ms, cache, err, in} per line, plus the rotated `.1` file.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const JEV_LOG = process.env.WT_JEV_LOG || join(homedir(), '.local', 'share', 'wt-dashboard', 'jev-calls.jsonl')

export async function readCalls(file = JEV_LOG) {
  const texts = await Promise.all([file + '.1', file].map((f) => readFile(f, 'utf8').catch(() => '')))
  const out = []
  for (const l of texts.join('\n').split('\n')) {
    if (!l) continue
    try { const r = JSON.parse(l); if (r?.ts && r.feature) out.push(r) } catch {}
  }
  return out
}

// /api/health: a summary only; the full stats are in Settings › Observability.
export function healthSummary(calls, now = Date.now()) {
  const day = calls.filter((c) => now - Date.parse(c.ts) < 86_400_000)
  return { today: day.length, errors: day.filter((c) => c.err).length }
}

#!/usr/bin/env node
// Which catalog MCP servers does a task prompt need? Asks Jev (TypeSafe) one Noul (yes/no probability)
// question per server, so several can apply at once. Prompt on stdin; prints one JSON line:
//   {"picks":["figma"],"p":{"figma":0.93,"railway":0.02,...},"ms":640}
// Only picks at or above WT_HANDOFF_JEV_MIN (default 0.7). Any failure — no key, timeout (2s), HTTP
// error, bad JSON — prints {"picks":[],"error":"…"} and exits 0: a handoff never blocks on this.
// The key comes from $TYPESAFE_API_KEY, else the Keychain entry wt-dashboard keeps (never printed).
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// What each catalog server is FOR, in the words Jev judges against. A catalog name without an
// entry here is never picked.
export const SERVERS = {
  figma: 'reading or matching a Figma design: frames, components, design tokens, screenshots from Figma',
  railway: 'deploying to Railway or operating Railway services: deploys, service logs, variables, environments',
  context7: 'looking up current documentation or API reference for a third-party library, framework or SDK',
}

export function questions(names) {
  return Object.fromEntries(names.filter((n) => SERVERS[n]).map((n) => [n, {
    type: 'noul',
    instructions: `Does carrying out this task need a tool for ${SERVERS[n]}?`,
    criteria: { true: `The task clearly involves ${SERVERS[n]}.`, false: 'The task can be done without it.' },
  }]))
}

export function picksFrom(answers, min) {
  const p = Object.fromEntries(Object.entries(answers ?? {}).map(([k, a]) => [k, Math.round((a?.noul ?? 0) * 100) / 100]))
  return { picks: Object.keys(p).filter((k) => p[k] >= min), p }
}

function key() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'wt-dashboard', '-a', 'TYPESAFE_API_KEY', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return '' }
}

async function main() {
  const t0 = Date.now()
  const out = (o) => console.log(JSON.stringify({ ...o, ms: Date.now() - t0 }))
  try {
    const prompt = readFileSync(0, 'utf8').trim()
    const catalog = process.env.WT_AGENTS_CATALOG ?? join(homedir(), '.claude/skills/wt-agents/mcp/catalog.json')
    const names = Object.keys(JSON.parse(readFileSync(catalog, 'utf8')).mcpServers ?? {})
    const qs = questions(names)
    const k = key()
    if (!prompt || !Object.keys(qs).length) return out({ picks: [], error: 'nothing to ask' })
    if (!k) return out({ picks: [], error: 'no TYPESAFE_API_KEY' })
    const r = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
      body: JSON.stringify({ model: 'jev-latest', state: { task: prompt.slice(0, 4000) }, questions: qs }),
      signal: AbortSignal.timeout(Number(process.env.WT_HANDOFF_JEV_TIMEOUT_MS ?? 2000)),
    })
    if (!r.ok) return out({ picks: [], error: `HTTP ${r.status}` })
    const j = await r.json()
    out(picksFrom(j.answers, Number(process.env.WT_HANDOFF_JEV_MIN ?? 0.7)))
  } catch (e) {
    out({ picks: [], error: e?.name === 'TimeoutError' ? 'timeout' : String(e?.message ?? e).slice(0, 80) })
  }
}

// Run as a script (also through the ~/.claude/skills symlink), not when imported by the test.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()

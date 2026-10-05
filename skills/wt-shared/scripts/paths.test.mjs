// Run: node --test skills/wt-shared/scripts/paths.test.mjs — WP-122 path guard. A plugin install has no
// ~/.claude/skills links, so scripts, strings sent to agents and SKILL.md prose name sibling paths instead. Only the
// allowlisted lines may mention the link: deliberate fallbacks and text about the ./setup install itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '..')
const RE = /~\/\.claude\/skills|\$HOME\/\.claude\/skills|'\.claude', 'skills'|\.claude\/skills\//
// file (repo-relative) → substrings a matching line must contain to be allowed
const ALLOW = {
  'setup': ['SKILLS="$HOME/.claude/skills"', 'change it to ~/.claude/skills/wt-shared/hooks/'],
  'skills/wt-memory/claude-plugin/hooks/paths.mjs': ['falls back to the ./setup link', "join(homedir(), '.claude', 'skills', rel)"],
  'skills/wt-memory/claude-plugin/hooks/inject.mjs': ["join(homedir(), '.claude', 'skills', 'wt-memory'"],
  'skills/wt-memory/claude-plugin/.mcp.json': ['WT_MEMORY_MCP:-'],
  'skills/wt-memory/scripts/jev-memory.mjs': ['the linked pack under ~/.claude/skills', "join(homedir(), '.claude', 'skills'"],
  'skills/wt-dashboard/server.mjs': ["join(homedir(), '.claude', 'skills', 'wt-memory'"],
  'skills/wt-handoff/scripts/jev-mcp.mjs': ['through the ~/.claude/skills symlink'],
  'skills/wt-agents/mcp/worker.json': ['WT_MEMORY_MCP:-'], 'skills/wt-agents/mcp/planner.json': ['WT_MEMORY_MCP:-'],
  'skills/wt-agents/mcp/reviewer.json': ['WT_MEMORY_MCP:-'], 'skills/wt-agents/mcp/auditor.json': ['WT_MEMORY_MCP:-'],
  'skills/wt-dashboard/app/src-tauri/src/main.rs': ['~/.claude/skills/wt-dashboard', '{home}/.claude/skills/wt-dashboard'],
  'skills/wt-agents/scripts/agents.sh': ['a plugin-only install has no such link'],
  'skills/wt-dashboard/dispatch.mjs': ['that a plugin install lacks'],
  'skills/wt-mods/hooks/guards.ts': ['never write ~/.claude/skills/… in sent strings'], // the guard's own message
  // prose about the ./setup install itself (the Codex hookup, wt-setup's link, the desktop app's launcher)
  'skills/wt-memory/SKILL.md': ['codex mcp add', '"command":"node ~/.claude/skills/wt-memory', 'node $HOME/.claude/skills/wt-memory/', '/Users/<you>/.claude/skills/wt-memory/'],
  'skills/wt-setup/SKILL.md': ['the directory `~/.claude/skills/wt-setup` links into'],
  'skills/wt-dashboard/README.md': ['$WT_DASHBOARD_HOME'], // the app needs ./setup (dashboard)
}
const SKIP = /node_modules|\/dist\/|\/target\/|\.test\.|\/gen\//
function* files(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (SKIP.test(p) || n.startsWith('.') && n !== '.mcp.json') continue
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(sh|mjs|js|ts|tsx|json|rs|md)$|\/scripts\/[^./]+$|\/bin\/[^./]+$/.test(p)) yield p
  }
}

export function offenders(md = true) {
  const out = []
  for (const p of [join(root, 'setup'), ...files(join(root, 'skills'))]) {
    const rel = relative(root, p)
    if (!md && rel.endsWith('.md')) continue
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (RE.test(line) && !(ALLOW[rel] ?? []).some((s) => line.includes(s))) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return out
}

test('no ~/.claude/skills in scripts, sent strings or SKILL.md / references prose, outside the allowlist', () => {
  assert.deepEqual(offenders(), [])
})

#!/usr/bin/env node
// WP-213: ./setup loads this checkout as THE wt-pack plugin through CLAUDE_CODE_PLUGIN_DIRS in the `env` block of
// ~/.claude/settings.json (the plugin dirs a session loads, ':'-separated, each exactly as `--plugin-dir`).
//   plugin-env.mjs list   [settings]        one entry per line
//   plugin-env.mjs add    [settings] <dir>  append <dir> unless present (other entries and settings are kept)
//   plugin-env.mjs remove [settings] <dir>  drop <dir>; an emptied variable is removed from env
// settings defaults to ~/.claude/settings.json. Exit 0 ok, 2 usage, 1 an unreadable (not JSON) settings file —
// never overwritten.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const KEY = 'CLAUDE_CODE_PLUGIN_DIRS'
export const entries = (settings) => String(settings?.env?.[KEY] ?? '').split(':').map((s) => s.trim()).filter(Boolean)

export function edit(settings, op, dir) {
  const cur = entries(settings)
  const next = op === 'add' ? (cur.includes(dir) ? cur : [...cur, dir]) : cur.filter((d) => d !== dir)
  const out = { ...settings, env: { ...(settings.env ?? {}) } }
  if (next.length) out.env[KEY] = next.join(':')
  else delete out.env[KEY]
  if (!Object.keys(out.env).length) delete out.env
  return out
}

export function read(path) {
  if (!existsSync(path)) return {}
  const j = JSON.parse(readFileSync(path, 'utf8') || '{}') // throws on a non-JSON file: caller exits 1, file untouched
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('settings.json is not an object')
  return j
}

function main(argv) {
  const [op, ...rest] = argv
  const path = rest.length > (op === 'list' ? 0 : 1) ? rest[0] : join(homedir(), '.claude', 'settings.json')
  const dir = rest[rest.length - 1]
  if (!['list', 'add', 'remove'].includes(op) || (op !== 'list' && !dir)) { console.error('usage: plugin-env.mjs list|add|remove [settings.json] [dir]'); return 2 }
  let s
  try { s = read(path) } catch (e) { console.error(`plugin-env: ${path}: ${e.message}`); return 1 }
  if (op === 'list') { for (const d of entries(s)) console.log(d); return 0 }
  const next = edit(s, op, dir)
  if (JSON.stringify(next) !== JSON.stringify(s)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(next, null, 2) + '\n') }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2))

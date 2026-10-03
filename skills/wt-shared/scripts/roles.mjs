#!/usr/bin/env node
// Project roles (WP-204): per-repo role files `<main checkout>/.wt-pack/roles/<name>.md`.
//   roles.mjs list    [--cwd D]            JSON: every role file (name, base, meta, bytes)
//   roles.mjs resolve <name> [--cwd D]     JSON {name, base, model, effort, mcp, skills, labels}, or exit 1 (no such file)
//   roles.mjs check   [--cwd D]            JSON [{name, level: warn|error, msg}]; exit 1 on any error
// A file is an OVERRIDE when its name is a base role (worker.md) and a PERSONA otherwise (frontend-worker.md,
// which needs `base:` in its frontmatter). Frontmatter is flat `key: value` lines plus `[a, b]` lists, no YAML.
// Pure and synchronous: wt-memory's hook imports it (dynamically) under a 2 s timeout.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BASES = ['orchestrator', 'planner', 'worker', 'auditor', 'reviewer']
export const NAME = /^[a-z][a-z0-9-]{0,23}$/
export const CAP = 6 * 1024
const KEYS = { base: 'str', model: ['haiku', 'sonnet', 'opus'], effort: ['low', 'medium', 'high'], mcp: 'list', skills: 'list', labels: 'list' }

// The repo's MAIN checkout (a worktree resolves to its main repo), or null outside a repo.
export function mainCheckout(cwd = process.cwd()) {
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return basename(common) === '.git' ? dirname(common) : common.replace(/\.git$/, '')
  } catch { return null }
}
export const rolesDir = (checkout) => join(checkout, '.wt-pack', 'roles')

const val = (s) => {
  s = s.trim()
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean)
  return s.replace(/^(["'])(.*)\1$/, '$2')
}
// {meta, body}: a leading `---` block of `key: value` lines, then the free-form body.
export function parse(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { meta: {}, body: text.trim() }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = val(kv[2])
  }
  return { meta, body: text.slice(m[0].length).trim() }
}

function load(checkout, name) {
  const file = join(rolesDir(checkout), `${name}.md`)
  let text
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const { meta, body } = parse(text)
  const override = BASES.includes(name)
  return { name, file, override, base: override ? name : meta.base, meta, body, bytes: Buffer.byteLength(body) }
}

export function list(checkout) {
  let names = []
  try { names = readdirSync(rolesDir(checkout)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() } catch {}
  return names.map((n) => load(checkout, n)).filter(Boolean)
}

// {name, base, model?, effort?, mcp[], skills[], labels[]} for a role file, or null when there is none.
export function resolve(checkout, name) {
  if (!checkout || !NAME.test(name ?? '')) return null
  const r = load(checkout, name)
  if (!r || !BASES.includes(r.base)) return null
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : [])
  return { name, base: r.base, model: r.meta.model, effort: r.meta.effort, mcp: arr(r.meta.mcp), skills: arr(r.meta.skills), labels: arr(r.meta.labels) }
}

// Dispatch's view of the personas: [{name, base, labels}] in filename order (invalid ones left out).
export function personas(checkout) {
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : [])
  return list(checkout).filter((r) => !r.override && NAME.test(r.name) && BASES.includes(r.base))
    .map((r) => ({ name: r.name, base: r.base, labels: arr(r.meta.labels) }))
}

// Prompt sections for an agent with role token `role` and optional `persona`: [[heading, text]]. Base override
// first, then the persona. A body beyond CAP is cut at a line boundary and says so.
export function sections(checkout, role, persona) {
  if (!checkout) return []
  const out = []
  for (const name of [BASES.includes(role) ? role : null, persona].filter((n) => n && NAME.test(n))) {
    const r = load(checkout, name)
    if (!r) continue
    let text = r.body.replace(/ *<!--[\s\S]*?-->/g, '').trim()
    if (Buffer.byteLength(text) > CAP) {
      let cut = Buffer.from(text).subarray(0, CAP).toString('utf8')
      cut = cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0))
      text = `${cut}\n… truncated (${Buffer.byteLength(text) - Buffer.byteLength(cut)} bytes over the 6 KB cap; see the file)`
    }
    const skills = [].concat(r.meta.skills ?? [])
    if (skills.length) text += `\n\nSuggested skills: ${skills.join(', ')}`
    if (text) out.push([`Project role (${name}, .wt-pack/roles/${name}.md)`, text])
  }
  return out
}

// Findings for every role file. `catalog` = the MCP server names the pack knows (omit to skip that check);
// `settingsRoles` = the dashboard's Settings role ids (omit to skip the collision check).
export function check(checkout, { catalog, settingsRoles } = {}) {
  const f = []
  const warn = (name, msg, level = 'warn') => f.push({ name, level, msg })
  for (const r of list(checkout)) {
    if (!NAME.test(r.name)) warn(r.name, `name must match ${NAME}`, 'error')
    if (!r.override && !BASES.includes(r.base)) warn(r.name, `a persona needs \`base:\` one of ${BASES.join(', ')} (got ${r.base ?? 'none'})`, 'error')
    if (r.override && r.meta.base && r.meta.base !== r.name) warn(r.name, `\`base:\` is ignored on an override file`)
    if (settingsRoles?.includes(r.name) && !r.override) warn(r.name, 'collides with a Settings role id')
    for (const [k, v] of Object.entries(r.meta)) {
      const spec = KEYS[k]
      if (!spec) warn(r.name, `unknown key \`${k}\``)
      else if (Array.isArray(spec) && !spec.includes(v)) warn(r.name, `\`${k}\` must be one of ${spec.join('|')} (got ${v})`, 'error')
      else if (spec === 'list' && !Array.isArray(v)) warn(r.name, `\`${k}\` must be a list: [a, b]`, 'error')
    }
    if (catalog) for (const m of [].concat(r.meta.mcp ?? [])) if (!catalog.includes(m)) warn(r.name, `unknown MCP server \`${m}\``, 'error')
    if (r.bytes > CAP) warn(r.name, `body is ${r.bytes} bytes; only the first 6 KB is injected`)
    if (!r.body) warn(r.name, 'empty body')
  }
  return f
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  const i = rest.indexOf('--cwd')
  const cwd = i >= 0 ? rest.splice(i, 2)[1] : process.cwd()
  const checkout = mainCheckout(cwd)
  const out = (x) => console.log(JSON.stringify(x))
  if (!checkout) { console.error('not in a git repo'); process.exit(2) }
  if (cmd === 'list') out(list(checkout).map(({ name, base, meta, bytes }) => ({ name, base, meta, bytes })))
  else if (cmd === 'resolve') {
    const r = resolve(checkout, rest[0])
    if (!r) process.exit(1)
    out(r)
  } else if (cmd === 'check') {
    let catalog
    const cat = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wt-agents', 'mcp', 'catalog.json')
    if (existsSync(cat)) try { const c = JSON.parse(readFileSync(cat, 'utf8')); catalog = Object.keys(c.mcpServers ?? {}) } catch {}
    const f = check(checkout, { catalog })
    out(f)
    if (f.some((x) => x.level === 'error')) process.exit(1)
  } else { console.error('usage: roles.mjs list|resolve <name>|check [--cwd D]'); process.exit(2) }
}

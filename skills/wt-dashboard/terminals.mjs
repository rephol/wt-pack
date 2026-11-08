// Terminals: plain shells the dashboard mirrors and types into. herdr owns every terminal (no pty here): a shell is
// a pane with no agent in a "<project>-shells" workspace; the screen is `pane read --format ansi`, input is
// `pane send-text` / `pane send-keys`. Off by default, and only a request from this machine's own 127.0.0.1 page
// can turn it on or let the tailnet use it. Everything typed is appended to an audit log.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Our key names → herdr's. Nothing outside this map is ever sent.
export const KEYS = {
  Enter: 'enter', Tab: 'tab', Esc: 'esc', Up: 'up', Down: 'down', Left: 'left', Right: 'right', Backspace: 'backspace',
  'C-c': 'ctrl+c', 'C-d': 'ctrl+d', 'C-z': 'ctrl+z', 'C-l': 'ctrl+l', PageUp: 'pageup', PageDown: 'pagedown', Home: 'home', End: 'end',
}
export function herdrKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 32) throw Object.assign(new Error('keys: 1–32 names'), { status: 400 })
  return keys.map((k) => {
    if (!Object.hasOwn(KEYS, k)) throw Object.assign(new Error(`key not allowed: ${String(k).slice(0, 20)}`), { status: 400 })
    return KEYS[k]
  })
}
export const shellsLabel = (project) => `${project}-shells`
export const isShellPane = (p, shellWorkspaceIds) => Boolean(p && !p.agent && shellWorkspaceIds.has(p.workspace_id))

// A shell may start only in a known place: a project root, one of its worktrees, $HOME, or the temp dir.
export function allowedCwd(cwd, { roots, worktrees, home, tmp }) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return false
  const c = cwd.replace(/\/+$/, '') || '/'
  return [...roots, ...worktrees, home, ...tmp].some((d) => d && d.replace(/\/+$/, '') === c)
}

export class TerminalSettings {
  constructor(dir) { this.file = join(dir, 'terminals.json'); this.audit = join(dir, 'terminal-audit.jsonl'); this.s = { enabled: false, tailnet: false } }
  async load() { try { this.s = { ...this.s, ...JSON.parse(await readFile(this.file, 'utf8')) } } catch { /* defaults: off */ } return this }
  async set(patch) {
    for (const k of ['enabled', 'tailnet']) if (typeof patch[k] === 'boolean') this.s[k] = patch[k]
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.s))
    return this.s
  }
  // null = allowed; else [status, message].
  gate({ loopback, session }) {
    if (!session) return [403, 'session required — reload the dashboard']
    if (!this.s.enabled) return [403, 'terminals are disabled (Settings › Terminals, from http://127.0.0.1 on this machine)']
    if (!loopback && !this.s.tailnet) return [403, 'terminals are not allowed over the tailnet (Settings › Terminals)']
    return null
  }
  async log(entry) {
    await mkdir(dirname(this.audit), { recursive: true })
    await appendFile(this.audit, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  }
  async tail(n = 100) {
    const text = await readFile(this.audit, 'utf8').catch(() => '')
    return text.trim().split('\n').filter(Boolean).slice(-n).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
  }
}

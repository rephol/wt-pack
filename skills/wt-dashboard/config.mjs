// Integrations & environment: the settings that used to live only in ~/.config/wt-dashboard/env, editable from
// Settings. Precedence per key: process env var > Keychain (secrets only) > env file > default.
// The desktop app injects the env file into the server's env at launch, so a process env var that EQUALS the
// file's value at boot is treated as coming from the file, not as an override.
// Secrets never leave this module except to the caller that uses them (the Linear client): publicState() carries
// only "set" and the last four characters.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { writeFile, rename, mkdir, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'

export const KEYS = {
  LINEAR_API_KEY: { secret: true, label: 'Linear API key' },
  TYPESAFE_API_KEY: { secret: true, label: 'TypeSafe (Jev) API key' },
  WT_DASHBOARD_PROJECTS: { list: ':', legacy: 'HERDR_DASH_PROJECTS', label: 'Extra projects' },
  WT_DASHBOARD_HIDDEN_PROJECTS: { list: ':', label: 'Hidden projects' }, // project names (WP-223)
  WT_DASHBOARD_ALLOWED_HOSTS: { list: ',', legacy: 'HERDR_DASH_ALLOWED_HOSTS', label: 'Allowed hosts', loopbackOnly: true },
  WT_DASHBOARD_REPO: { legacy: 'UMKMALL_REPO', label: 'Default repo', restart: true },
  // Linear teams whose tickets the dashboard shows and recognises: KEY=project (project defaults to the key, lower-cased).
  WT_LINEAR_TEAMS: { list: ',', label: 'Linear teams', restart: true },
  // Read by the shell scripts too (wt-shared/scripts/mcp-mode.sh): lean | full (default).
  WT_NUDGE: { oneOf: ['on', 'off'], label: 'Nudge handed-off agents whose card is not in review' }, // WP-272: off = no "continue" line
  WT_MESSAGE_RESEND: { oneOf: ['on', 'off'], label: 'Resend unacknowledged messages' }, // WP-263: off = the sweep only flags, never re-types
  WT_AGENTS_MCP: { oneOf: ['full', 'lean'], label: 'Lean agent MCP' },
  // Jev integrations (read by the server via cfg.get, by the CLIs via typesafe.mjs enabled()). ON where calls are
  // rare and event-driven, OFF where they scale with poll ticks or every prompt.
  ...Object.fromEntries([
    ['ROOM_RESOLVE', 'Room needs-you resolve', 'on'], ['MEMORY_DUP', 'Memory near-duplicate check', 'on'],
    ['BABYSIT_TRIAGE', 'Babysit comment triage', 'on'], ['ROUTE', 'Handoff routing', 'on'],
    ['TICKET_TRIAGE', 'Ticket triage', 'on'],
    ['NEEDS_YOU', 'Pane needs-you', 'off'], ['STALL', 'Stalled vs thinking', 'off'],
    ['INBOX_RANK', 'Inbox urgency', 'off'], ['MEMORY_SUGGEST', 'Memory suggestions', 'off'],
    ['LOG_SNIPPETS', 'Log input snippets', 'off'],
  ].map(([k, label, d]) => [`WT_JEV_${k}`, { oneOf: ['on', 'off'], label, default: d, jev: true }])),
}
const SERVICE = 'wt-dashboard'
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/
const SECRET = /^[\w-]{8,200}$/ // Linear keys are lin_api_…; also keeps the value safe inside `security -i` quoting

// WT_LINEAR_TEAMS entries → { KEY: project }. Malformed entries are skipped.
export function parseTeams(list) {
  const out = {}
  for (const e of list) {
    const [k, p] = e.split('=').map((x) => x.trim())
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(k ?? '') && (!p || /^[\w.-]+$/.test(p))) out[k.toUpperCase()] = p || k.toLowerCase()
  }
  return out
}

export function parseEnvFile(text) {
  const out = {}
  for (const l of text.split('\n')) {
    if (l.trim().startsWith('#')) continue
    const i = l.indexOf('=')
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^"|"$/g, '')
  }
  return out
}
// Replace or drop one KEY= line, keeping every other line (comments included) as written.
export function setEnvLine(text, key, value) {
  const lines = text.split('\n').filter((l) => !(l.includes('=') && l.slice(0, l.indexOf('=')).trim() === key))
  while (lines.length && lines.at(-1) === '') lines.pop()
  if (value != null && value !== '') lines.push(`${key}=${value}`)
  return lines.length ? lines.join('\n') + '\n' : ''
}

// macOS login Keychain via `security`. The secret goes in on STDIN (`security -i` reads commands from it), never
// argv, so it never shows up in `ps`. Reads use `-w`, which prints only the password to our pipe.
export function keychain(run = defaultRun) {
  return {
    get: (acct) => run('security', ['find-generic-password', '-s', SERVICE, '-a', acct, '-w']).then((o) => o.replace(/\n$/, '') || null, () => null),
    set: (acct, v) => {
      if (!SECRET.test(v) || !/^\w+$/.test(acct)) return Promise.reject(new Error('refusing an unexpected character'))
      return run('security', ['-i'], `add-generic-password -s ${SERVICE} -a ${acct} -w "${v}" -U\n`).then(() => undefined)
    },
    del: (acct) => run('security', ['delete-generic-password', '-s', SERVICE, '-a', acct]).then(() => undefined, () => undefined),
  }
}
export function defaultRun(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { timeout: 10_000 }, (err, out) => (err ? reject(new Error(`${cmd} ${args[0]} failed (${err.code ?? 'error'})`)) : resolve(out)))
    // A child that exits without reading stdin (a fast `security find-generic-password`) makes this write EPIPE;
    // unhandled, that crashed the server at startup under load (WP-40). The result still comes from the callback.
    p.stdin.on('error', () => {})
    p.stdin.end(input ?? '')
  })
}

export class Config {
  constructor({ file, env = process.env, kc = keychain(), platform = process.platform }) {
    this.file = file
    this.env = env
    this.kc = platform === 'darwin' ? kc : null
    this.fileVals = this.readFile()
    this.boot = { ...this.fileVals } // what the app injected at launch
    this.secrets = {} // key -> value from the Keychain
    this.bootValues = {} // resolved at start, for keys that need a restart
  }
  readFile() { try { return parseEnvFile(readFileSync(this.file, 'utf8')) } catch { return {} } }
  async load() {
    if (this.kc) for (const k of Object.keys(KEYS)) if (KEYS[k].secret) this.secrets[k] = await this.kc.get(k)
    for (const k of Object.keys(KEYS)) this.bootValues[k] = this.get(k)
    return this
  }
  // A real process override: set in the env and not merely the file's own value injected at launch.
  override(k) {
    const v = this.env[k] ?? (KEYS[k].legacy ? this.env[KEYS[k].legacy] : undefined)
    return v != null && v !== '' && v !== this.boot[k] ? v : null
  }
  source(k) {
    if (this.override(k) != null) return 'env'
    if (KEYS[k].secret && this.secrets[k]) return 'keychain'
    if (this.fileVals[k] || (KEYS[k].legacy && this.fileVals[KEYS[k].legacy])) return 'file'
    return 'default'
  }
  get(k) {
    return this.override(k) ?? (KEYS[k].secret ? this.secrets[k] : null) ?? this.fileVals[k] ?? (KEYS[k].legacy ? this.fileVals[KEYS[k].legacy] : null) ?? KEYS[k].default ?? null
  }
  list(k) { return (this.get(k) ?? '').split(KEYS[k].list).map((s) => s.trim()).filter(Boolean) }

  async writeFileKey(k, v) {
    const text = (() => { try { return readFileSync(this.file, 'utf8') } catch { return '' } })()
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, setEnvLine(text, k, v), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.file)
    this.fileVals = this.readFile()
  }
  // Returns where it went. Keychain first; on failure the 0600 env file.
  async setSecret(k, v) {
    if (!SECRET.test(v)) throw Object.assign(new Error('that does not look like an API key'), { status: 400 })
    if (this.kc) {
      try {
        await this.kc.set(k, v)
        this.secrets[k] = v
        if (this.fileVals[k]) await this.writeFileKey(k, null) // no plaintext copy left behind
        return 'keychain'
      } catch { /* fall through to the file */ }
    }
    await this.writeFileKey(k, v)
    return 'file'
  }
  async removeSecret(k) {
    if (this.kc) await this.kc.del(k)
    this.secrets[k] = null
    await this.writeFileKey(k, null)
  }
  // Validates and writes a non-secret key. Lists arrive as arrays.
  async setValue(k, v) {
    const d = KEYS[k]
    let s
    if (d.list) {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw Object.assign(new Error('expected a list'), { status: 400 })
      const items = [...new Set(v.map((x) => x.trim()).filter(Boolean))]
      if (k === 'WT_DASHBOARD_ALLOWED_HOSTS') {
        const bad = items.map((h) => h.toLowerCase()).filter((h) => !HOST.test(h))
        if (bad.length) throw Object.assign(new Error(`exact hostnames only (no scheme, port or wildcard): ${bad.join(', ')}`), { status: 400 })
        s = items.map((h) => h.toLowerCase()).join(',')
      } else if (k === 'WT_LINEAR_TEAMS') {
        const bad = items.filter((t) => !/^[A-Za-z][A-Za-z0-9]*(=[\w.-]+)?$/.test(t.replace(/\s*=\s*/, '=')))
        if (bad.length) throw Object.assign(new Error(`KEY or KEY=project (letters/digits; project: letters, digits, . _ -): ${bad.join(', ')}`), { status: 400 })
        s = items.map((t) => t.replace(/\s*=\s*/, '=')).join(',')
      } else if (k === 'WT_DASHBOARD_HIDDEN_PROJECTS') {
        if (items.some((n) => !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(n))) throw Object.assign(new Error('project names only'), { status: 400 })
        s = items.join(':')
      } else {
        if (items.some((p) => !p.startsWith('/') || p.includes(':') || /[\n"]/.test(p))) throw Object.assign(new Error('absolute paths only'), { status: 400 })
        s = items.join(':')
      }
    } else if (d.oneOf) {
      if (v !== '' && !d.oneOf.includes(v)) throw Object.assign(new Error(`one of: ${d.oneOf.join(', ')}`), { status: 400 })
      s = v
    } else {
      if (typeof v !== 'string' || (v && (!v.startsWith('/') || /[\n"]/.test(v)))) throw Object.assign(new Error('an absolute path'), { status: 400 })
      s = v.trim()
    }
    await this.writeFileKey(k, s)
  }
  publicState() {
    return Object.entries(KEYS).map(([k, d]) => {
      const o = { key: k, label: d.label, source: this.source(k), overridden: this.override(k) != null }
      if (d.secret) {
        const v = this.get(k)
        return { ...o, secret: true, set: Boolean(v), last4: v ? v.slice(-4) : null }
      }
      const value = d.list ? this.list(k) : this.get(k)
      return { ...o, value, restartNeeded: Boolean(d.restart && this.get(k) !== this.bootValues[k]), loopbackOnly: Boolean(d.loopbackOnly) }
    })
  }
}

// Only a request made on this machine to 127.0.0.1/localhost itself — not one `tailscale serve` proxied in
// (that also arrives from loopback, but with the tailnet Host and forwarding headers).
// Host names that mean "this machine": the Mac app loads wt-dashboard.localhost (WebKit resolves *.localhost to loopback)
// so Activity Monitor names its web process after the app, not "http://127.0.0.1:7777".
// WP-80: the server binds loopback unless WT_DASHBOARD_HOST says otherwise, and a non-loopback bind needs
// WT_ALLOW_REMOTE=1. Anything that reaches the port can drive agents running with bypassed permissions.
export const LOOPBACK_BIND = /^(127\.0\.0\.1|::1|localhost)$/
export function bindCheck(host, allowRemote) {
  if (LOOPBACK_BIND.test(host)) return { ok: true, remote: false }
  if (allowRemote) return { ok: true, remote: true }
  return { ok: false, message: [
    `wt-dashboard: refusing to listen on ${host} (WT_DASHBOARD_HOST) — it is not loopback.`,
    'Anyone who reaches that address can type into your agents, which run with bypassed permissions.',
    'Reach a remote machine with Tailscale (tailscale serve) or an SSH tunnel (ssh -L 7777:127.0.0.1:7777 <vm>)',
    'and keep the default bind (127.0.0.1). See docs/vm.md.',
    'If you really mean it (e.g. a private interface only you can reach): WT_ALLOW_REMOTE=1.',
  ].join('\n') }
}
// A remote bind's own host:port is added to the Host/Origin allowlist; brackets for IPv6.
export const bindHostHeader = (host, port) => `${host.includes(':') ? `[${host}]` : host}:${port}`.toLowerCase()
export const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|wt-dashboard\.localhost)(:\d+)?$/
export function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress ?? ''
  const h = req.headers ?? {}
  return /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(addr)
    && LOOPBACK_HOST.test(h.host ?? '')
    && !h['x-forwarded-for'] && !h['x-forwarded-host'] && !h['tailscale-user-login'] && !h.forwarded
}

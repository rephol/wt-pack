// Agent control room: herdr panes + git worktrees + PRs + Linear, joined into tasks.
// ponytail: no deps, polling instead of websockets; switch to SSE if refresh feels laggy.
import http from 'node:http'
import { execFile } from 'node:child_process'
import { readFile, readdir, open as fopen, stat, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, watch, realpathSync, statSync, readFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join, extname, normalize, basename, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Rooms, ticketSuggestions } from './rooms.mjs'
import { Inbox, itemFromTransition, toResolve } from './inbox.mjs'
import { UsageAgg, readLimits, PRICES, costOf } from './usage.mjs'
import { safeFetch, parseHtml, classifyUrl } from './unfurl.mjs'
import { RoleStore, resolveRole, inferTags, tokenDiff, adoptHandoff, clean as cleanTags, TAG_KEYS } from './roles.mjs'
import { Config, KEYS, LOOPBACK_HOST, isLoopbackRequest, parseEnvFile } from './config.mjs'
import { TerminalSettings, herdrKeys, shellsLabel, isShellPane, allowedCwd } from './terminals.mjs'

// ~/.config/wt-dashboard/env (legacy ~/.config/herdr-dash/env), read by the server itself: under launchd nothing
// else passes it in. A variable already in the environment wins.
for (const f of [join(homedir(), '.config', 'wt-dashboard', 'env'), join(homedir(), '.config', 'herdr-dash', 'env')]) {
  let text
  try { text = readFileSync(f, 'utf8') } catch { continue }
  for (const [k, v] of Object.entries(parseEnvFile(text))) if (process.env[k] === undefined) process.env[k] = v
  break
}

const PORT = Number(process.env.PORT ?? 7777)
// Activity Monitor and ps show this instead of "node".
process.title = 'wt-dashboard server'
// Integrations & environment (config.mjs): env var > Keychain > ~/.config/wt-dashboard/env > default.
const cfg = new Config({ file: join(homedir(), '.config', 'wt-dashboard', 'env') })
// ponytail: the default repo is read once; changing it asks for a restart (it is threaded through many paths).
const REPO = cfg.get('UMKMALL_REPO') ?? join(homedir(), 'Work', 'projects', 'umkmall')
// WT_DASHBOARD_* env names; the old HERDR_DASH_* names are still read as a fallback.
const envOf = (k) => process.env[`WT_DASHBOARD_${k}`] ?? process.env[`HERDR_DASH_${k}`]
// Everything the dashboard writes lives outside the source tree: <root>/data and <root>/uploads.
const DATA_ROOT = process.env.WT_DASHBOARD_DATA ?? join(homedir(), '.local', 'share', 'wt-dashboard')
const DATA = join(DATA_ROOT, 'data')
// WT_DASHBOARD_DIST: set by the desktop app (bundled resources); else the sibling web/dist.
const DIST = envOf('DIST') ? join(envOf('DIST'), '/') : new URL('./web/dist/', import.meta.url).pathname
const STALL_MS = 20 * 60_000
// Linear team key → project name (project = basename of the repo root).
const PROJECT_BY_TEAM = { UMK: 'umkmall' }
const REPO_PROJECT = basename(REPO)

// execFile, never a shell: prompt text goes through as one argv entry.
const run = (cmd, args, cwd, timeout = 20_000, extraEnv) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, maxBuffer: 32 << 20, timeout, ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}) }, (err, out, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(out)),
  )
const herdr = (...args) => run('herdr', args)
const git = (dir, ...args) => run('git', ['-C', dir, ...args])

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '')

// ---- tiny TTL cache (keeps the last good value if a refresh fails) ----
const store = new Map()
function cached(key, ttl, fn) {
  const hit = store.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.p
  const p = fn().catch((e) => {
    if (hit?.ok !== undefined) return hit.ok // stale but useful
    throw e
  })
  const entry = { at: Date.now(), p, ok: hit?.ok }
  store.set(key, entry)
  p.then((v) => (entry.ok = v), () => {})
  return p
}

// ---- pane parsing ----
const RULE = /^\s*─{10,}/
// Claude Code's live spinner line, just above the input box: "✻ Synthesizing… (10s · ↓ 391 tokens)",
// "✻ Calling PostHog…", "✻ Waiting for 1 background agent to finish". A finished turn leaves "✻ Cooked for 1m 2s"
// there too, which is not activity. Only the last few lines above the box count, so an old line never does.
export function parseActivity(text) {
  const lines = stripAnsi(text).split('\n')
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0)
  const cut = rules.length >= 2 ? rules[rules.length - 2] : rules.length ? rules[0] : lines.length
  const near = lines.slice(0, cut).filter((l) => l.trim()).slice(-3)
  for (const l of near.reverse()) {
    const m = l.match(/^\s*[✻✢✳✶✽✺·*]\s+(\S.*?)\s*$/)
    if (!m || /^\w+ for (\d+[hms]\s*)+$/.test(m[1])) continue // "Cooked for 1m 2s": a finished turn
    const d = m[1].match(/^(.*?)\s*\(([^()]*)\)\s*$/)
    return { text: (d ? d[1] : m[1]).trim(), detail: d ? d[2].trim() : null }
  }
  return null
}

export function parsePane(text, raw = '') {
  const lines = text.split('\n')
  // Footer = from the rule opening the input box downward. Two rules wrap the ❯ input box.
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0)
  const cut = rules.length >= 2 ? rules[rules.length - 2] : rules.length ? rules[0] : lines.length
  const body = lines.slice(0, cut)
  const footer = lines.slice(cut).join('\n')

  const ctx = footer.match(/Context:.*?(\d+(?:\.\d+)?[kM]?)\/(\d+[kM]?)\s*\((\d+)%\)/)
  const cwd = footer.match(/^\s*cwd:\s*(\S.*?)\s*$/m)?.[1]

  // Turns: ❯ = user, ⏺ = assistant; continuation lines belong to the current turn.
  const turns = []
  let cur = null
  for (const l of body) {
    const m = l.match(/^(❯|⏺)\s?(.*)$/)
    if (m) {
      cur = { role: m[1] === '❯' ? 'user' : 'assistant', lines: [m[2]] }
      turns.push(cur)
    } else if (cur && !/^[✻※]/.test(l.trim())) cur.lines.push(l.replace(/^  /, ''))
    else if (/^[✻※]/.test(l.trim())) cur = null // "✻ Cooked for…" / recap end a turn
  }
  const out = turns
    .map((t) => ({ role: t.role, text: t.lines.join('\n').trim() }))
    .filter((t) => t.text)

  // Last recap paragraph (continuation lines are indented).
  let recap = null
  const ri = body.findLastIndex((l) => l.includes('※ recap:'))
  if (ri >= 0) {
    const parts = [body[ri].split('※ recap:')[1]]
    for (let i = ri + 1; i < body.length && /^\s{2,}\S/.test(body[i]); i++) parts.push(body[i])
    recap = parts.map((s) => s.trim()).join(' ').trim()
  }

  const lastAssistant = out.findLast((t) => t.role === 'assistant')
  const lastUser = out.findLast((t) => t.role === 'user')
  const tail = body.slice(-25).join('\n')
  const choicePrompt = /❯\s*1\.|Do you want to|\(y\/n\)|\[Y\/n\]/i.test(tail)
  // ponytail: only a prompt on screen blocks the agent. A reply ending in "?" is just `done` — treating it as
  // needs-you left a red dot nothing could clear except sending another message.
  const question = choicePrompt ? tail.split('\n').filter((l) => l.trim()).slice(-6).join('\n').trim() : null

  // Background work Claude Code reports after a turn ("· 1 shell still running", "· 2 background tasks"):
  // the footer first, else the most recent turn-status line. Stop (Esc) does not end these.
  const BG = /·\s*(\d+)\s+(?:shells?|background tasks?|bash(?:es)?|monitors?|(?:local |sub)?agents?)\b[^·\n]*/g
  const statusLine = footer.match(BG) ? footer : body.findLast((l) => /^\s*[✻✳✶✽✢*]\s/.test(l)) ?? ''
  const background = [...statusLine.matchAll(BG)].reduce((n, m) => n + Number(m[1]), 0)

  return {
    picker: parsePicker(text, raw),
    background,
    recap,
    context: ctx ? { used: ctx[1], total: ctx[2], pct: Number(ctx[3]) } : null,
    cwd,
    asks: Boolean(question),
    question,
    lastPrompt: lastUser?.text.split('\n')[0] ?? null,
    turns: out,
  }
}

// ---- machines ----
const LOCAL_LABEL = hostname()
const REMOTE_TIMEOUT_MS = Number(process.env.REMOTE_TIMEOUT_MS ?? 8000)
async function machines() {
  return cached('machines', 60_000, async () => {
    const out = await herdr('machine', 'list').catch(() => '')
    const remotes = out.split('\n').map((l) => l.split('\t')).filter((f) => f.length >= 5 && f[1])
      .map(([id, label, host, session, state]) => ({ id, label, host, session, enabled: state.trim() === 'enabled', local: false }))
    return [{ id: 'local', label: LOCAL_LABEL, host: 'localhost', session: 'default', enabled: true, local: true }, ...remotes]
  })
}
// Label → machine, only from the list: user input never becomes an argv flag.
const machineBy = async (label) => (await machines()).find((m) => m.label === label && m.enabled) ?? null
// herdr on a machine. Remote = `herdr --machine <label>` over SSH, hard timeout.
const herdrOn = (m, ...args) => (m.local ? herdr(...args) : run('herdr', ['--machine', m.label, ...args], undefined, REMOTE_TIMEOUT_MS))

// ---- projects ----
// Project = the repo a cwd belongs to; worktrees resolve to their main repo via --git-common-dir.
const projectCache = new Map() // cwd → { name, at }
async function projectOf(cwd) {
  if (!cwd) return null
  const hit = projectCache.get(cwd)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name
  const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').catch(() => null)
  const name = common ? basename(dirname(common.trim())) : basename(cwd)
  projectCache.set(cwd, { name, at: Date.now() })
  return name
}

// ---- AskUserQuestion picker, read off the pane ----
// Claude Code writes the AskUserQuestion tool_use to the transcript only once it is answered, so a
// PENDING question can only be seen on screen. Shape (stripped):
//   ←  ☐ Color  ☒ Pets  ✔ Submit  →      (tab bar; absent for a single question)
//   Which color?
//   ❯ 1. Red            / 1. [✔] Cat      (multiSelect rows carry [ ] / [✔])
//        warm           (description lines, indented)
//     4. Type something.  ── 5. Chat about this
//   Enter to select · Tab/Arrow keys to navigate · Esc to cancel
// or the review step: "Review your answers" … "Ready to submit your answers?" ❯ 1. Submit answers  2. Cancel
// The focused tab is only visible as a background colour (SGR 48) in the ANSI tab row.
function focusedTab(raw, tabs) {
  const row = raw.replace(/\r/g, '').split('\n').findLast((l) => l.includes('←') && l.includes('→') && /\x1b\[[0-9;]*48;/.test(l))
  const seg = row?.match(/\x1b\[[0-9;]*48;[0-9;]*m([^\x1b]*)/)?.[1]?.replace(/[☐☒✔]/g, '').trim()
  if (!seg) return null
  if (seg === 'Submit') return tabs.length
  const i = tabs.findIndex((t) => t.header === seg)
  return i >= 0 ? i : null
}
export function parsePicker(text, raw = '') {
  const pk = parsePickerText(text)
  const f = pk && pk.tabs.length && raw ? focusedTab(raw, pk.tabs) : null
  if (pk && !pk.review && f != null) pk.current = f
  return pk
}
function parsePickerText(text) {
  const lines = text.split('\n')
  const foot = lines.findLastIndex((l) => /Enter to select\s*·/.test(l)) // hint line; may be truncated
  const reviewAt = lines.findLastIndex((l) => /Ready to submit your answers\?/.test(l))
  const tabLine = lines.findLastIndex((l) => /^\s*←\s+.*\s+→\s*$/.test(l))
  const tabs = tabLine >= 0
    ? [...lines[tabLine].matchAll(/([☐☒✔])\s+([^☐☒✔→]+?)(?=\s{2,}|\s*→)/g)].filter((m) => m[2].trim() !== 'Submit')
        .map((m) => ({ header: m[2].trim(), done: m[1] === '☒' }))
    : []
  if (reviewAt >= 0 && reviewAt > foot && reviewAt > tabLine) {
    const answers = []
    for (let i = tabLine + 1; i < reviewAt; i++) {
      const q = lines[i].match(/^\s*●\s+(.*)$/)
      const a = lines[i + 1]?.match(/^\s*→\s+(.*)$/)
      if (q && a) answers.push({ question: q[1].trim(), answer: a[1].trim() })
    }
    return { review: true, tabs, answers }
  }
  if (foot < 0 || (tabLine >= 0 && foot < tabLine)) return null
  const OPT = /^\s*(?:❯\s*)?(\d+)\.\s+(?:\[([ ✔])\]\s+)?(.*)$/
  let first = -1
  for (let i = foot; i > Math.max(tabLine, foot - 80); i--) {
    const m = lines[i].match(OPT)
    if (m && m[1] === '1') { first = i; break }
  }
  if (first < 0) return null
  let qStart = tabLine >= 0 ? tabLine + 1 : lines.slice(0, first).findLastIndex((l) => /^\s*─{10,}/.test(l)) + 1
  // A single question shows its header alone (" ☐ Color"), without the ← … → tab bar.
  const solo = tabLine < 0 && lines[qStart]?.match(/^\s*([☐☒])\s+(\S.*)$/)
  if (solo) { tabs.push({ header: solo[2].trim(), done: solo[1] === '☒' }); qStart++ }
  const question = lines.slice(qStart, first).map((l) => l.trim()).filter(Boolean).join('\n')
  // Preview layout (options carry `preview`): options sit in a narrow left column, a box-drawn preview of the
  // FOCUSED option on the right, "Notes: press n…" under it, no descriptions, labels wrap onto indented lines.
  let end = foot
  for (let i = first; i < foot; i++) if (/^\s*─{10,}/.test(lines[i])) { end = i; break }
  const boxX = Math.min(...lines.slice(first, end).map((l) => l.search(/[┌│└]/)).filter((x) => x > 0))
  if (Number.isFinite(boxX)) {
    const options = []
    let cursor = 1
    for (let i = first; i < end; i++) {
      const left = lines[i].slice(0, boxX).trimEnd()
      const m = left.match(OPT)
      if (m) {
        if (/^\s*❯/.test(left)) cursor = Number(m[1])
        const chosen = /\s✔\s*$/.test(m[3]) // revisited question: the earlier answer carries a ✔
        options.push({ label: m[3].replace(/\s*✔\s*$/, '').trim(), description: '', checked: chosen })
      } else if (options.length && left.trim()) options.at(-1).label += ' ' + left.trim() // wrapped label
    }
    const preview = lines.slice(first, end).map((l) => l.slice(boxX))
      .filter((r) => /^\s*│/.test(r)).map((r) => r.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '')).join('\n')
    return question && options.length
      ? { review: false, layout: 'preview', tabs, current: tabs.findIndex((t) => !t.done), question, multiSelect: false, options, other: null, cursor, preview }
      : null
  }
  const options = []
  let multiSelect = false, cursor = 1, other = null
  for (let i = first; i < foot; i++) {
    const m = lines[i].match(OPT)
    if (m) {
      if (/^\s*❯/.test(lines[i])) cursor = Number(m[1])
      const label = m[3].trim()
      if (/^(Type something\.?|Chat about this)$/.test(label)) break
      if (m[2] !== undefined) multiSelect = true
      const chosen = m[2] === '✔' || /\s✔\s*$/.test(label)
      options.push({ label: label.replace(/\s*✔\s*$/, ''), description: '', checked: chosen })
    } else if (/^\s*Submit\s*$/.test(lines[i])) {
      // multiSelect: the row right above "Submit" is "Type something" holding custom text, not an option.
      if (multiSelect && options.length) other = options.pop().label
      break
    } else if (/^\s*─{10,}/.test(lines[i])) {
      break
    } else if (options.length && lines[i].trim()) {
      const o = options.at(-1)
      o.description = (o.description ? o.description + ' ' : '') + lines[i].trim()
    }
  }
  return question && options.length ? { review: false, tabs, current: tabs.findIndex((t) => !t.done), question, multiSelect, options, other, cursor } : null
}

// A blocked agent's scrollback can't be read by --lines (alternate screen); fall back to the visible screen.
const readPane = (m, pane, lines) =>
  herdrOn(m, 'agent', 'read', pane, '--lines', String(lines), '--ansi').catch(() => herdrOn(m, 'agent', 'read', pane, '--source', 'visible', '--ansi'))

// ---- agents ----
const since = new Map() // machine|pane → { status, at }
const parsed = new Map() // machine|pane → { p, seq, at }: last parse, reused until the pane changes
const roleStore = new RoleStore(DATA)
await roleStore.load()
// Workspace labels and pane tokens: one `workspace list` + one `pane list` per refresh (local machine only).
async function paneMeta(m) {
  if (!m.local) return { ws: new Map(), tokens: new Map() }
  return cached('paneMeta', 3000, async () => {
    const [w, p] = await Promise.all([herdr('workspace', 'list'), herdr('pane', 'list')])
    return {
      ws: new Map(JSON.parse(w).result.workspaces.map((x) => [x.workspace_id, x.label])),
      tokens: new Map(JSON.parse(p).result.panes.map((x) => [x.pane_id, x.tokens ?? {}])),
    }
  })
}
// Keep each local agent's pane tokens equal to data/agent-tags.json (backfilling an agent seen for the first
// time from inference). Only when they differ, so a herdr restart re-applies them and a steady state costs nothing.
const syncing = new Set()
async function syncTokens(agents) {
  let backfilled = false
  for (const a of agents) {
    if (!a.local || syncing.has(a.id)) continue
    if (!roleStore.tags[a.name]) {
      roleStore.tags[a.name] = inferTags({ name: a.name, role: a.pool === 'other' ? undefined : a.pool, project: a.project ?? undefined, ticket: ticketOf(a.cwd) ?? undefined })
      backfilled = true
    }
    const adopted = adoptHandoff(roleStore.tags[a.name], a.paneTokens)
    if (adopted) { roleStore.tags[a.name] = adopted; backfilled = true }
    const { set, clear } = tokenDiff(a.paneTokens, roleStore.tags[a.name])
    if (!set.length && !clear.length) continue
    syncing.add(a.id)
    herdr('pane', 'report-metadata', a.id, '--source', 'wt-dashboard', ...set.flatMap(([k, v]) => ['--token', `${k}=${v}`]), ...clear.flatMap((k) => ['--clear-token', k]))
      .then(() => store.delete('paneMeta'), (e) => console.error('tokens:', a.name, e.message)).finally(() => syncing.delete(a.id))
  }
  if (backfilled) await roleStore.saveTags().catch((e) => console.error('agent-tags:', e.message))
}
const GENERIC = /^(claude code|claude)?$/i

// ponytail: sequential + change-driven reads. Parallel reads every 3s flooded herdr's socket.
async function listAgents(m) {
  const { result } = JSON.parse(await herdrOn(m, 'agent', 'list'))
  const meta = await paneMeta(m).catch(() => ({ ws: new Map(), tokens: new Map() }))
  const readEvery = m.local ? 15_000 : 30_000
  const out = []
  for (const a of result.agents) {
    const k = `${m.label}|${a.pane_id}`
    let name = a.name ?? a.terminal_title_stripped ?? a.pane_id
    if (!m.local && (GENERIC.test(name.trim()) || name === a.pane_id)) name = `${m.label}/${a.pane_id}`
    const prev = since.get(k)
    if (!prev || prev.status !== a.agent_status) since.set(k, { status: a.agent_status, at: Date.now() })
    const seen = parsed.get(k)
    const stale = !seen || seen.seq !== a.state_change_seq || (a.agent_status === 'working' && Date.now() - seen.at > readEvery) || Boolean(seen.p?.picker) // a picker advances without a status change
    if (stale) {
      try {
        const raw = await readPane(m, a.pane_id, '120')
            const p = parsePane(stripAnsi(raw), raw)
        parsed.set(k, { p, seq: a.state_change_seq, at: Date.now() })
      } catch {}
    }
    const p = parsed.get(k)?.p ?? {}
    const cwd = p.cwd ?? a.foreground_cwd ?? a.cwd
    const session = m.local && a.agent_session?.kind === 'id' ? a.agent_session.value : null
    // An AskUserQuestion picker on screen beats the reply-ends-with-? heuristic (kept for permission prompts).
    const pk = p.picker ?? null
    out.push({
      key: `${m.label}/${a.pane_id}`,
      id: a.pane_id,
      machine: m.label,
      local: m.local,
      name,
      ...(() => {
        const toks = meta.tokens.get(a.pane_id) ?? {}
        const own = Object.fromEntries(Object.entries(toks).filter(([k]) => TAG_KEYS.includes(k)))
        const tags = { ...own, ...(m.local ? roleStore.tags[name] : {}) }
        const role = resolveRole(roleStore.roles, { token: tags.role, workspace: meta.ws.get(a.workspace_id), name })
        return { pool: role.id, roleBy: role.by, tags, paneTokens: own, workspace: meta.ws.get(a.workspace_id) ?? null }
      })(),
      status: a.agent_status,
      statusSince: since.get(k).at,
      // The transcript's last write (local sessions); else when the status last changed.
      lastActivity: (await transcriptMtime(session)) || since.get(k).at, // statusSince resets on a server restart
      cwd,
      // Remote: no git over SSH, so the cwd's basename stands in.
      project: m.local ? await projectOf(cwd) : cwd ? basename(cwd) : null,
      recap: p.recap ?? null,
      context: p.context ?? null,
      background: p.background ?? 0,
      asks: Boolean(pk) || (p.asks ?? false),
      question: pk ? (pk.review ? 'Review and submit your answers' : `${pk.tabs[pk.current]?.header ? pk.tabs[pk.current].header + ': ' : ''}${pk.question}`) : p.question ?? null,
      picker: pk,
      lastPrompt: p.lastPrompt ?? null,
      session,
    })
  }
  if (m.local) syncTokens(out).catch((e) => console.error('tokens:', e.message))
  return out
}

// Remote machines refresh in the background and never block the local refresh.
const remote = new Map() // label → { agents, lastSeen, lastTry, ok, error, inflight }
function refreshRemote(m) {
  const r = remote.get(m.label) ?? { agents: [], lastSeen: null, lastTry: 0, ok: false }
  remote.set(m.label, r)
  if (r.inflight || Date.now() - r.lastTry < 10_000) return
  r.lastTry = Date.now()
  r.inflight = listAgents(m)
    .then((a) => Object.assign(r, { agents: a, lastSeen: Date.now(), ok: true, error: null }))
    .catch((e) => Object.assign(r, { ok: false, error: String(e.message).slice(0, 200) }))
    .finally(() => (r.inflight = null))
}
const machineStatus = (r) =>
  !r?.lastSeen ? (r?.inflight && !r.error ? 'connecting' : 'offline')
    : r.ok && Date.now() - r.lastSeen < 60_000 ? 'online'
    : Date.now() - r.lastSeen < 5 * 60_000 ? 'stale' : 'offline'

async function agents() {
  const ms = await machines()
  ms.filter((m) => !m.local && m.enabled).forEach(refreshRemote)
  const local = await cached('agents:local', 3000, () => listAgents(ms[0]))
  return [...local, ...ms.filter((m) => !m.local && m.enabled).flatMap((m) => remote.get(m.label)?.agents ?? [])]
}

async function machineSummaries(ag) {
  return (await machines()).map((m) => {
    const r = remote.get(m.label)
    const mine = ag.filter((a) => a.machine === m.label)
    return {
      label: m.label, host: m.host, local: m.local, enabled: m.enabled,
      status: !m.enabled ? 'disabled' : m.local ? 'online' : machineStatus(r),
      lastSeen: m.local ? Date.now() : r?.lastSeen ?? null,
      error: m.local ? null : r?.error ?? null,
      working: mine.filter((a) => a.status === 'working').length,
      idle: mine.filter((a) => a.status === 'idle').length,
      total: mine.length,
    }
  })
}

// ---- transcript stream (Claude Code's own JSONL) ----
const PROJECTS = join(homedir(), '.claude', 'projects')
const transcriptPath = new Map() // session id → path
async function findTranscript(id) {
  if (transcriptPath.has(id)) return transcriptPath.get(id)
  for (const d of await readdir(PROJECTS)) {
    const f = join(PROJECTS, d, `${id}.jsonl`)
    if (existsSync(f)) return transcriptPath.set(id, f), f
  }
  return null
}

async function transcriptMtime(id) {
  const f = id && (await findTranscript(id).catch(() => null))
  return (f && statSync(f, { throwIfNoEntry: false })?.mtimeMs) || 0
}

const NOISE = /^\s*<(local-command-caveat|local-command-stdout|task-notification|system-reminder|command-message)/
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
function toolSummary(input = {}) {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.description ?? input.url ?? input.prompt
    ?? Object.values(input).find((x) => typeof x === 'string') ?? ''
  return clip(String(v).replace(/\s+/g, ' '), 160)
}
// JSONL entry → renderable messages. Skips meta/sidechain/system/hook noise and thinking.
// AskUserQuestion = Claude Code's human-in-the-loop picker. `asks` (Set of its tool_use ids) links
// the later tool_result back to the question, which becomes {answered, answers | cancelled}.
export function normalizeEntry(e, asks = new Set()) {
  if (!e || e.isMeta || e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) return []
  const ts = e.timestamp, base = e.uuid
  const c = e.message?.content
  if (typeof c === 'string') {
    if (e.type !== 'user' || NOISE.test(c)) return []
    const cmd = c.match(/<command-name>(.*?)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/)
    const text = cmd ? `${cmd[1]} ${cmd[2]}`.trim() : c
    return text.trim() ? [{ id: base, role: 'user', text, ts, src: sourceOf(c) }] : []
  }
  if (!Array.isArray(c)) return []
  const meta = e.type === 'assistant' ? assistantMeta(e) : undefined
  const src = e.type === 'user' ? sourceOf(c.filter((b) => b.type === 'text').map((b) => b.text).join('\n')) : undefined
  return c.flatMap((b, i) => rowsOf(b, i)).map((m) => (m.role === 'tool' ? m : Object.assign(m, meta ? { meta } : {}, src && m.role === 'user' ? { src } : {})))
  function rowsOf(b, i) {
    const id = `${base}:${i}`
    if (b.type === 'text' && b.text?.trim() && !NOISE.test(b.text)) return [{ id, role: e.type, text: b.text, ts }]
    if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
      asks.add(b.id)
      return [{ id: `q:${b.id}`, role: 'question', text: '', toolUseId: b.id, questions: b.input?.questions ?? [], answered: false, ts }]
    }
    if (b.type === 'tool_result' && asks.has(b.tool_use_id)) {
      const r = e.toolUseResult
      return [{ id: `q:${b.tool_use_id}`, role: 'question', text: '', toolUseId: b.tool_use_id, answered: true,
        answers: r && typeof r === 'object' ? r.answers ?? {} : {}, cancelled: Boolean(b.is_error), ts, update: true }]
    }
    if (b.type === 'tool_use' && b.name === 'Read' && IMG_EXT.test(b.input?.file_path ?? '')) allowFile(b.input.file_path)
    if (b.type === 'tool_use' && b.name === 'SendUserFile' && Array.isArray(b.input?.files)) {
      // A file the agent delivered to the user: an attachment card per file, outside the tool group.
      const files = b.input.files.filter((f) => typeof f === 'string').map((f) => ({ path: f, name: basename(f), size: allowFile(f) }))
      return [{ id: `f:${b.id}`, role: 'assistant', text: '', files, caption: b.input.caption ?? null, ts }]
    }
    if (b.type === 'tool_use') return [{ id, role: 'tool', text: '', tool: { name: b.name, summary: toolSummary(b.input) }, ts, toolUseId: b.id, meta }]
    if (b.type === 'tool_result') {
      const t = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n')
      const row = { id, role: 'tool', text: clip(t, 600), tool: { name: 'result', summary: clip(t.replace(/\s+/g, ' '), 120) }, ts, toolUseId: b.tool_use_id, isError: Boolean(b.is_error) || undefined }
      // Images a tool returned (e.g. Read of a PNG) surface as their own assistant row, not inside the collapsed group.
      const imgs = Array.isArray(b.content) ? b.content.filter((x) => x.type === 'image' && x.source?.type === 'base64') : []
      return imgs.length ? [row, ...imgs.map((x, k) => imageMsg(x, `${id}:img${k}`, 'assistant', ts))] : [row]
    }
    if (b.type === 'image' && b.source?.type === 'base64') return [imageMsg(b, id, e.type, ts)]
    return [] // thinking, etc.
  }
}
// Per assistant API message (one `mid` spans several JSONL entries, each repeating its usage; the client keeps the
// last per mid). Tokens and a NOTIONAL cost (usage.mjs's list-price table; null for an unpriced model).
function assistantMeta(e) {
  const m = e.message ?? {}, u = m.usage ?? {}
  const t = { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0, cr: u.cache_read_input_tokens ?? 0 }
  return { mid: m.id ?? e.uuid, model: m.model, ...t, cost: m.model ? costOf({ model: m.model, ...t }) : null,
    stop: e.isApiErrorMessage ? 'error' : m.stop_reason === 'max_tokens' ? 'max_tokens' : m.stop_reason ?? null }
}
// Who typed a user turn: a room delivery, the dashboard (its sends are recorded by hash, never by text), else the
// terminal. Sends from before the hash log existed read as "terminal".
const SENT_FILE = join(DATA, 'sent-hashes.log')
const sentHashes = new Set((() => { try { return readFileSync(SENT_FILE, 'utf8').split('\n').slice(-5000).filter(Boolean) } catch { return [] } })())
const hashOf = (t) => createHash('sha256').update(String(t).trim()).digest('hex').slice(0, 24)
export function recordSent(text) {
  const h = hashOf(text)
  if (sentHashes.has(h)) return
  sentHashes.add(h)
  appendFile(SENT_FILE, h + '\n').catch((e) => console.error('sent-hashes:', e.message))
}
function sourceOf(text) {
  const room = String(text).match(/^\[room #([\w-]+)\]/)
  return room ? `room #${room[1]}` : sentHashes.has(hashOf(text)) ? 'dashboard' : 'terminal'
}
// ponytail: inline data URL, capped at ~1.5MB base64; bigger ones become a placeholder.
function imageMsg(b, id, role, ts) {
  const ok = b.source.data.length <= 1_500_000 && IMG[b.source.media_type]
  return { id, role, text: ok ? '' : '[image too large to preview]', images: ok ? [`data:${b.source.media_type};base64,${b.source.data}`] : [], ts }
}
// /api/files serves ONLY files a streamed transcript named (SendUserFile inputs, Read of an image),
// keyed by realpath so symlinks/traversal can't widen it. Returns the size (null if missing).
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i
const FILE_ALLOW = new Set()
function allowFile(f) {
  try {
    if (!isAbsolute(f)) return null
    const r = realpathSync(f)
    FILE_ALLOW.add(r)
    return statSync(r).size
  } catch { return null }
}
const FILE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json', pdf: 'application/pdf', svg: 'image/svg+xml', csv: 'text/csv; charset=utf-8' }
async function serveFile(res, url) {
  let r
  try { r = realpathSync(url.searchParams.get('path') ?? '') } catch { return send(res, 404, { error: 'not found' }) }
  if (!FILE_ALLOW.has(r)) return send(res, 403, { error: 'not a file an agent shared' })
  const type = FILE_MIME[extname(r).slice(1).toLowerCase()] ?? 'application/octet-stream'
  const h = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox allow-scripts' }
  if (url.searchParams.get('download')) h['content-disposition'] = `attachment; filename="${basename(r).replace(/"/g, '')}"`
  res.writeHead(200, h)
  res.end(await readFile(r))
}
const parseLines = (chunk, asks) => chunk.split('\n').filter(Boolean).flatMap((l) => {
  try { return normalizeEntry(JSON.parse(l), asks) } catch { return [] }
})
// Fold question `update`s (the answer) into the question message itself.
function foldQuestions(msgs) {
  const byId = new Map()
  const out = []
  for (const m of msgs) {
    const prev = m.role === 'question' && byId.get(m.id)
    if (prev) { Object.assign(prev, m, { update: undefined, questions: prev.questions }); continue }
    if (m.role === 'question') byId.set(m.id, m)
    out.push(m)
  }
  return out
}
export async function streamTranscript(req, res, session, url, fileOverride) {
  const file = fileOverride ?? (session && (await findTranscript(session)))
  if (!file) return send(res, 404, { error: 'no transcript for this agent' })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  // Every data event carries `id: <byte offset read so far>`. A client that has messages up to an offset resumes
  // with Last-Event-ID (EventSource's own reconnect) or ?since=<offset>, and gets only what came after it.
  const emit = (msgs, off) => { if (msgs.length) res.write(`id: ${off}\ndata: ${JSON.stringify(msgs)}\n\n`) }
  res.write(`event: session\ndata: ${JSON.stringify(session)}\n\n`)
  // ponytail: backlog reads the whole file once; tail-read from the end if transcripts get huge.
  const all = await readFile(file, 'utf8')
  const nl = all.lastIndexOf('\n')
  let offset = Buffer.byteLength(all.slice(0, nl + 1)) // an unfinished last line is re-read on the next pull
  let partial = ''
  const asks = new Set()
  const since = Number(req.headers['last-event-id'] ?? url?.searchParams.get('since'))
  if (Number.isFinite(since) && since > 0 && since <= offset) {
    // Resume: parse everything (question ids must be known), emit only lines that end past `since`.
    let at = 0
    const fresh = []
    for (const line of all.slice(0, nl + 1).split('\n')) {
      at += Buffer.byteLength(line) + 1
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      const msgs = normalizeEntry(e, asks)
      if (at > since) fresh.push(...msgs)
    }
    if (fresh.length) emit(fresh, offset); else res.write(`id: ${offset}\n: resumed\n\n`)
  } else {
    // Last 200 user/assistant turns; tool rows between them ride along uncounted.
    const backlog = foldQuestions(parseLines(all.slice(0, nl + 1), asks))
    let start = backlog.length
    for (let n = 0; start > 0 && n < 200; ) if (backlog[--start].role !== 'tool') n++
    const first = backlog.slice(start)
    if (first.length) emit(first, offset); else res.write(`id: ${offset}\n: empty\n\n`)
  }

  let busy = false
  const pull = async () => {
    if (busy) return
    busy = true
    try {
      const { size } = await stat(file)
      if (size < offset) offset = size // truncated/rewritten
      if (size > offset) {
        const fh = await fopen(file, 'r')
        const buf = Buffer.alloc(size - offset)
        await fh.read(buf, 0, buf.length, offset)
        await fh.close()
        offset = size
        const text = partial + buf.toString('utf8')
        const cut = text.lastIndexOf('\n')
        partial = text.slice(cut + 1) // incomplete trailing line waits for the next append
        emit(parseLines(text.slice(0, cut + 1), asks), offset - Buffer.byteLength(partial))
      }
    } catch {} finally { busy = false }
  }
  const w = watch(file, pull)
  const poll = setInterval(pull, 1000) // fs.watch on macOS can miss appends
  const beat = setInterval(() => res.write(': hb\n\n'), 15_000)
  req.on('close', () => (w.close(), clearInterval(poll), clearInterval(beat)))
}

// ---- roles (Settings › Roles) ----
async function rolesApi(req, res) {
  const inUse = {}
  for (const a of (await agents().catch(() => []))) inUse[a.pool] = (inUse[a.pool] ?? 0) + 1
  if (req.method === 'GET') return send(res, 200, { roles: roleStore.roles, inUse })
  if (req.method !== 'PUT') return send(res, 405, { error: 'GET or PUT' })
  const b = JSON.parse((await body(req)) || '{}')
  const next = new Set((b.roles ?? []).map((r) => r?.id))
  // A role agents use cannot vanish silently: the caller names where its agents go (reassign: {old: new}).
  const reassign = b.reassign ?? {}
  const orphaned = roleStore.roles.filter((r) => !next.has(r.id) && inUse[r.id] && !reassign[r.id])
  if (orphaned.length) return send(res, 409, { error: `in use: ${orphaned.map((r) => `${r.name} (${inUse[r.id]})`).join(', ')}`, needs: 'reassign', roles: orphaned.map((r) => r.id) })
  await roleStore.saveRoles(b.roles)
  for (const [from, to] of Object.entries(reassign)) {
    if (!next.has(to) && to !== 'other') continue
    for (const [name, t] of Object.entries(roleStore.tags)) if (t.role === from) roleStore.tags[name] = cleanTags({ ...t, role: to })
  }
  await roleStore.saveTags()
  store.delete('agents:local'); store.delete('overview')
  return send(res, 200, { roles: roleStore.roles })
}

// ---- memory (Settings › Memory): the wt-memory preference files, see wt-memory/SKILL.md ----
// Names match wt-memory's own rule, so nothing here can address a path outside the store.
const MEMORY = process.env.WT_MEMORY_HOME || join(homedir(), '.config', 'wt-memory')
const MEMORY_BIN = [new URL('../wt-memory/scripts/wt-memory', import.meta.url).pathname, join(homedir(), '.claude', 'skills', 'wt-memory', 'scripts', 'wt-memory')].find((p) => existsSync(p))
export const MEMORY_NAME = /^[A-Za-z0-9][\w.-]{0,99}$/
export function memoryFile(scope, name) {
  if (scope === 'global' && !name) return join(MEMORY, 'global.md')
  if ((scope === 'roles' || scope === 'projects') && MEMORY_NAME.test(name ?? '')) return join(MEMORY, scope, `${name}.md`)
  return null
}
const MEMORY_KEY = 'wt-memory@wt-pack'
// Agent-written entries and pending global proposals, via the CLI (the one parser of the trailer format).
const memoryEntries = async () => (MEMORY_BIN ? JSON.parse(await run(process.execPath, [MEMORY_BIN, 'list', '--json'], undefined, 5000)) : [])
// Seen ids; null until the first scan, which is a baseline (no notices for what already existed).
let memorySeen = null
async function memoryNotices() {
  const all = await memoryEntries()
  if (memorySeen) for (const e of all) if (!memorySeen.has(e.id)) {
    const where = e.name ? `${e.scope} ${e.name}` : e.scope
    await inbox.add(e.pending
      ? { kind: 'memory-proposal', key: `memory-proposal|${e.id}`, title: `${e.by} proposes a global preference`, body: e.text, target: { memory: e.id } }
      : { kind: 'memory', key: `memory|${e.id}`, title: `${e.by} remembered (${where})`, body: e.text, target: { memory: e.id } })
  }
  memorySeen = new Set(all.map((e) => e.id))
  return new Set(all.filter((e) => e.pending).map((e) => e.id))
}
async function memoryApi(req, res, url, parts) {
  if (!hasSession(req.headers.cookie)) return send(res, 403, { error: 'session required' })
  // POST /api/memory/entries/<id>/(forget|accept|reject)
  if (req.method === 'POST' && parts[2] === 'entries' && /^[0-9a-f]{6}$/.test(parts[3] ?? '') && ['forget', 'accept', 'reject'].includes(parts[4])) {
    if (!MEMORY_BIN) return send(res, 500, { error: 'wt-memory not found' })
    try { await run(process.execPath, [MEMORY_BIN, parts[4], parts[3]], undefined, 5000) } catch (e) { return send(res, 404, { error: String(e.message).trim() }) }
    await inbox.load()
    await inbox.resolve(inbox.items.filter((it) => it.target?.memory === parts[3] && !it.resolvedAt).map((it) => it.id))
    broadcastEvent('inbox', { changed: true })
    return send(res, 200, { ok: true })
  }
  if (parts[2] === 'preview' && req.method === 'GET') {
    const args = ['context']
    for (const k of ['role', 'project']) { const v = url.searchParams.get(k); if (v && MEMORY_NAME.test(v)) args.push(`--${k}`, v) }
    if (!MEMORY_BIN) return send(res, 200, { text: '', error: 'wt-memory not found' })
    // --cwd / so an unset project is not guessed from the SERVER's directory.
    return send(res, 200, { text: (await run(process.execPath, [MEMORY_BIN, ...args, '--cwd', '/'], undefined, 5000, { HERDR_PANE_ID: '' }).catch(() => '')).trim() })
  }
  if (req.method === 'GET' && !parts[2]) {
    const list = async (d) => (await readdir(join(MEMORY, d)).catch(() => [])).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    const roles = [...new Set([...roleStore.roles.map((r) => r.id), ...(await list('roles'))])]
    const projects = [...new Set([...(await projectRoots()).keys(), ...(await list('projects'))])]
    const texts = async (scope, names) => Object.fromEntries(await Promise.all(names.map(async (n) => [n, (await readSafe(memoryFile(scope, n))) ?? ''])))
    const installed = JSON.parse((await readSafe(join(CLAUDE, 'plugins', 'installed_plugins.json'))) ?? '{}').plugins?.[MEMORY_KEY]
    const enabled = JSON.parse((await readSafe(join(CLAUDE, 'settings.json'))) ?? '{}').enabledPlugins?.[MEMORY_KEY]
    return send(res, 200, {
      dir: MEMORY, cli: MEMORY_BIN ?? null,
      plugin: { installed: !!installed, enabled: !!installed && enabled !== false, version: installed?.[0]?.version ?? null },
      global: (await readSafe(memoryFile('global'))) ?? '', roles: await texts('roles', roles), projects: await texts('projects', projects),
      entries: await memoryEntries().catch(() => []),
    })
  }
  if (req.method === 'PUT') {
    const f = memoryFile(parts[2], parts[3] && decodeURIComponent(parts[3]))
    if (!f || parts.length > 4) return send(res, 400, { error: 'global, roles/<id> or projects/<name>' })
    const { text } = JSON.parse((await body(req)) || '{}')
    if (typeof text !== 'string' || text.length > 32_000) return send(res, 400, { error: 'text: a string up to 32 000 chars' })
    await mkdir(dirname(f), { recursive: true })
    await writeFile(f, text.trim() ? text.trimEnd() + '\n' : '')
    return send(res, 200, { ok: true })
  }
  send(res, 405, { error: 'method' })
}

// ---- link previews (unfurl.mjs has the SSRF guards) ----
// 24h cache in memory and on disk (data/unfurl-cache.json, 500 entries). Images are proxied only for URLs an
// unfurl produced, never an arbitrary URL the client names.
const UNFURL_FILE = join(DATA, 'unfurl-cache.json')
const unfurlCache = new Map((() => { try { return Object.entries(JSON.parse(readFileSync(UNFURL_FILE, 'utf8'))) } catch { return [] } })())
const unfurlImages = new Set([...unfurlCache.values()].flatMap((v) => [v.card?.image, v.card?.icon].filter(Boolean)))
let unfurlSave = null
const DAY = 86_400_000
async function unfurlApi(res, url) {
  const target = url.searchParams.get('url') ?? ''
  const hit = unfurlCache.get(target)
  if (hit && Date.now() - hit.at < (hit.card?.kind === 'pr' || hit.card?.kind === 'linear' ? 60_000 : DAY)) return send(res, 200, hit.card)
  const card = await richCard(target) ?? await pageCard(target)
  unfurlCache.set(target, { at: Date.now(), card })
  for (const k of [...unfurlCache.keys()].slice(0, Math.max(0, unfurlCache.size - 500))) unfurlCache.delete(k)
  clearTimeout(unfurlSave)
  unfurlSave = setTimeout(() => writeFile(UNFURL_FILE, JSON.stringify(Object.fromEntries(unfurlCache))).catch(() => {}), 2000)
  return send(res, 200, card)
}
async function pageCard(target) {
  const r = await safeFetch(target, 'text/html,application/xhtml+xml')
  if (r.status >= 400) return { kind: 'page', url: target, error: `HTTP ${r.status}` }
  if (!/^text\/html|application\/xhtml/i.test(r.headers['content-type'] ?? '')) return { kind: 'page', url: target, title: null, siteName: new URL(r.url).hostname }
  const c = parseHtml(r.body.toString('utf8'), r.url)
  for (const i of [c.image, c.icon]) if (i) unfurlImages.add(i)
  return { kind: 'page', url: target, ...c }
}
const repoName = () => cached('repoName', 3_600_000, async () => JSON.parse(await run('gh', ['repo', 'view', '--json', 'nameWithOwner'], REPO)).nameWithOwner).catch(() => null)
async function richCard(target) {
  const c = classifyUrl(target, await repoName())
  if (!c) return null
  if (c.kind === 'artifact') return { kind: 'artifact', url: target, title: 'Claude artifact', siteName: 'claude.ai' }
  if (c.kind === 'pr') {
    const p = JSON.parse(await run('gh', ['pr', 'view', String(c.number), '--json', 'number,title,state,isDraft,reviewDecision,statusCheckRollup'], REPO))
    return { kind: 'pr', url: target, number: p.number, title: p.title, state: p.isDraft && p.state === 'OPEN' ? 'DRAFT' : p.state, review: p.reviewDecision || null, ci: ciOf(p.statusCheckRollup ?? []), siteName: 'GitHub' }
  }
  if (c.kind === 'issue') {
    const p = JSON.parse(await run('gh', ['issue', 'view', String(c.number), '--json', 'number,title,state'], REPO))
    return { kind: 'issue', url: target, number: p.number, title: p.title, state: p.state, siteName: 'GitHub' }
  }
  const key = cfg.get('LINEAR_API_KEY')
  if (!key) return null // falls back to the page (a login wall, usually just the title)
  const r = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: key },
    body: JSON.stringify({ query: 'query($id: String!) { issue(id: $id) { identifier title priorityLabel state { name } assignee { name } } }', variables: { id: c.identifier } }) })
  const i = (await r.json()).data?.issue
  return i ? { kind: 'linear', url: target, identifier: i.identifier, title: i.title, state: i.state?.name, priority: i.priorityLabel, assignee: i.assignee?.name ?? null, siteName: 'Linear' } : null
}
async function unfurlImage(res, url) {
  const target = url.searchParams.get('url') ?? ''
  if (!unfurlImages.has(target)) return send(res, 403, { error: 'not an unfurled image' })
  const r = await safeFetch(target, 'image/*')
  const type = r.headers['content-type'] ?? ''
  if (r.status >= 400 || !/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|avif)/i.test(type)) return send(res, 415, { error: 'not an image' })
  res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" })
  res.end(r.body)
}

// ---- git / gh / linear ----
const ticketOf = (s) => (s?.match(/umk-(\d+)/i) ? `UMK-${s.match(/umk-(\d+)/i)[1]}` : null)

// ---- spawn / remove agents: always through the wt-agents skill's script (naming, pools, trust seed) ----
const AGENTS_SH = join(homedir(), '.claude', 'skills', 'wt-agents', 'scripts', 'agents.sh')
// Project name → main checkout: the configured repo, $WT_DASHBOARD_PROJECTS (colon-separated repo paths),
// and every repo a local agent is working in.
async function projectRoots() {
  return cached('projectRoots', 30_000, async () => {
    const dirs = [REPO, ...cfg.list('WT_DASHBOARD_PROJECTS'), ...(await agents()).filter((a) => a.local && a.cwd).map((a) => a.cwd)]
    const map = new Map()
    for (const d of new Set(dirs)) {
      const c = await git(d, 'rev-parse', '--path-format=absolute', '--git-common-dir').catch(() => null)
      if (c) { const root = dirname(c.trim()); map.set(basename(root), root) }
    }
    return map
  })
}
// Linked worktrees of a repo (the main checkout excluded: workers start inside a worktree).
async function linkedWorktrees(root) {
  const out = await git(root, 'worktree', 'list', '--porcelain')
  return out.split('\n\n').map((b) => ({ path: b.match(/^worktree (.+)$/m)?.[1], branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null }))
    .filter((w) => w.path && w.path !== root)
}
async function projectsApi() {
  const ag = (await agents()).filter((a) => a.local)
  const inside = (dir) => ag.filter((a) => a.cwd === dir || a.cwd?.startsWith(dir + '/')).map((a) => a.name)
  return Promise.all([...(await projectRoots())].map(async ([name, root]) => ({
    name, root,
    worktrees: (await linkedWorktrees(root).catch(() => [])).map((w) => ({ ...w, ticket: ticketOf(w.branch) ?? ticketOf(w.path), agents: inside(w.path) })),
  })))
}
async function spawnAgent(b) {
  const role = roleStore.roles.find((r) => r.id === b.kind && r.spawn)
  if (!role) throw Object.assign(new Error('unknown role, or it cannot be spawned (Settings › Roles)'), { status: 400 })
  const root = (await projectRoots()).get(b.project)
  if (!root) throw Object.assign(new Error('unknown project'), { status: 400 })
  if (role.spawn.projects.length && !role.spawn.projects.includes(b.project)) throw Object.assign(new Error(`${role.name} is not allowed in ${b.project}`), { status: 400 })
  const args = ['spawn', role.id]
  // Never a free path: the main checkout, or one of this project's own worktrees.
  const wts = role.spawn.start === 'main' ? [] : await linkedWorktrees(root)
  if (role.spawn.start === 'worktree' || (role.spawn.start === 'choose' && b.cwd && b.cwd !== root)) {
    const wt = wts.find((w) => w.path === b.cwd)
    if (!wt) throw Object.assign(new Error('cwd must be one of the project\'s worktrees'), { status: 400 })
    args.push(wt.path)
  } else args.push(root)
  const label = role.spawn.workspace.replace(/<repo>/g, basename(root)).replace(/<role>/g, role.id)
  const out = await run(AGENTS_SH, args, root, 120_000, { WT_AGENTS_WORKSPACE: label, WT_AGENTS_SPAWNED_BY: 'dashboard' })
  const [name, pane] = out.trim().split('\n').pop().split(' ')
  if (!name || !PANE.test(pane ?? '')) throw new Error(`unexpected agents.sh output: ${out.trim().slice(0, 200)}`)
  await roleStore.setTags(name, { role: role.id, project: b.project, ticket: ticketOf(b.cwd ?? '') ?? undefined, spawned_by: 'dashboard', created: new Date().toISOString().slice(0, 10) })
  store.delete('agents:local'); store.delete('overview'); store.delete('projectRoots')
  const machine = (await machines()).find((m) => m.local)?.label
  let prompted = false
  if (typeof b.prompt === 'string' && b.prompt.trim()) {
    await herdr('agent', 'wait', pane, '--until', 'idle', '--timeout', '60000').catch(() => {})
    await herdr('agent', 'prompt', pane, b.prompt.trim())
    prompted = true
  }
  return { name, pane, machine, key: `${machine}/${pane}`, prompted }
}

async function worktrees() {
  return cached('worktrees', 10_000, async () => {
    const out = await git(REPO, 'worktree', 'list', '--porcelain')
    const wts = out
      .split('\n\n')
      .map((b) => ({
        path: b.match(/^worktree (.+)$/m)?.[1],
        branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null,
      }))
      .filter((w) => w.path)
    return Promise.all(
      wts.map(async (w) => {
        const ticket = ticketOf(w.branch) ?? ticketOf(w.path)
        let plan = null
        if (ticket && w.path !== REPO) {
          const n = ticket.split('-')[1]
          const files = await git(w.path, 'ls-files', 'docs/plans').catch(() => '')
          plan = files.split('\n').find((f) => new RegExp(`umk-${n}(?!\\d)`, 'i').test(f)) ?? null
        }
        return { ...w, ticket, plan }
      }),
    )
  })
}

const shippedShas = new Set()
async function prs() {
  // ponytail: 30s TTL, not 3s — gh hits the GitHub API rate limit.
  return cached('prs', 30_000, async () => {
    const list = JSON.parse(
      await run(
        'gh',
        ['pr', 'list', '--state', 'all', '--limit', '50', '--json',
          'number,title,headRefName,state,isDraft,baseRefName,mergedAt,updatedAt,url,reviewDecision,statusCheckRollup,mergeCommit,mergeStateStatus,author'],
        REPO,
      ),
    )
    await git(REPO, 'fetch', '--quiet', 'origin', 'main').catch(() => {})
    const me = await ghUser()
    const threads = await unresolvedThreads(list.filter((p) => p.state === 'OPEN').map((p) => p.number))
    return Promise.all(
      list.map(async (p) => {
        const sha = p.mergeCommit?.oid
        let shipped = false
        if (p.state === 'MERGED' && sha) {
          if (!shippedShas.has(sha))
            await git(REPO, 'merge-base', '--is-ancestor', sha, 'origin/main').then(() => shippedShas.add(sha), () => {})
          shipped = shippedShas.has(sha)
        }
        return {
          number: p.number,
          title: p.title,
          branch: p.headRefName,
          base: p.baseRefName,
          state: p.state,
          isDraft: p.isDraft,
          url: p.url,
          review: p.reviewDecision || null,
          ci: ciOf(p.statusCheckRollup ?? []),
          behind: p.mergeStateStatus === 'BEHIND',
          unresolved: p.state === 'OPEN' ? threads?.[p.number] ?? null : null,
          mergedAt: p.mergedAt,
          updatedAt: p.updatedAt,
          shipped,
          ticket: ticketOf(p.headRefName),
          mine: Boolean(me) && p.author?.login === me,
        }
      }),
    )
  })
}

// Unresolved review threads per open PR, one batched query; gh has no field for it. null on failure.
async function unresolvedThreads(numbers) {
  if (!numbers.length) return {}
  return cached('prThreads', 60_000, async () => {
    const q = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){${numbers.map((n) => `p${n}:pullRequest(number:${n}){reviewThreads(first:100){nodes{isResolved}}}`).join(' ')}}}`
    const j = JSON.parse(await run('gh', ['api', 'graphql', '-f', `query=${q}`, '-F', 'owner={owner}', '-F', 'repo={repo}'], REPO))
    return Object.fromEntries(numbers.map((n) => [n, j.data.repository[`p${n}`]?.reviewThreads.nodes.filter((t) => !t.isResolved).length ?? null]))
  }).catch((e) => (console.error('threads:', e.message), null))
}

// The gh active user, for PR authorship. Cached for the process; null if gh can't say.
let ghLogin
const ghUser = async () => (ghLogin ??= await run('gh', ['api', 'user', '--jq', '.login'], REPO).then((s) => s.trim() || null, () => null))

function ciOf(checks) {
  if (!checks.length) return null
  const st = checks.map((c) => (c.__typename === 'StatusContext' ? c.state : c.status === 'COMPLETED' ? c.conclusion : 'PENDING'))
  if (st.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(s))) return 'fail'
  if (st.some((s) => ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', null].includes(s))) return 'pending'
  return 'pass'
}

const LINEAR_Q = `query {
  issues(first: 50, orderBy: updatedAt, filter: {
    state: { type: { nin: ["completed", "canceled"] } },
    or: [{ assignee: { isMe: { eq: true } } }, { team: { key: { eq: "UMK" } } }]
  }) { nodes { identifier title priority url updatedAt assignee { isMe } state { name type } } }
}`
async function linear() {
  const key = cfg.get('LINEAR_API_KEY')
  if (!key) return null
  return cached('linear', 60_000, async () => {
    const r = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: key },
      body: JSON.stringify({ query: LINEAR_Q }),
    })
    const j = await r.json()
    if (!r.ok || j.errors) throw new Error(`linear: ${JSON.stringify(j.errors ?? r.status)}`)
    return j.data.issues.nodes.map(({ assignee, ...i }) => ({ ...i, state: i.state?.name, stateType: i.state?.type, mine: Boolean(assignee?.isMe) }))
  })
}

// ---- task model ----
const inside = (cwd, dir) => cwd && (cwd === dir || cwd.startsWith(dir + '/'))

// The ticket an agent's tokens name: `ticket`, else the UMK id a handoff's `task` label starts with.
const tagTicket = (a) => (a.local && (a.tags?.ticket || a.tags?.task?.match(/^[A-Z]+-\d+/i)?.[0])?.toUpperCase()) || null
export function deriveTasks({ agents, worktrees, prs, issues }) {
  const now = Date.now()
  const ids = new Set([
    ...(issues ?? []).map((i) => i.identifier),
    ...worktrees.map((w) => w.ticket).filter(Boolean),
    ...prs.map((p) => p.ticket).filter(Boolean),
    ...agents.map(tagTicket).filter(Boolean),
  ])
  const linked = new Set()
  const tasks = []
  for (const id of ids) {
    const issue = issues?.find((i) => i.identifier === id)
    const wt = worktrees.find((w) => w.ticket === id && w.path !== REPO)
    const pr = prs.filter((p) => p.ticket === id).sort((a, b) => (a.state === 'OPEN' ? -1 : b.state === 'OPEN' ? 1 : 0))[0]
    // In the ticket's worktree, or tagged with the ticket by wt-agents/wt-handoff (a worker can sit in the
    // main checkout: its cwd alone made it an ad-hoc task that contradicted its own ticket).
    const ag = agents.filter((a) => a.local && ((wt && inside(a.cwd, wt.path)) || (tagTicket(a) === id && !worktrees.some((w) => w.path !== REPO && inside(a.cwd, w.path)))))
    ag.forEach((a) => linked.add(a.key))
    const asker = ag.find((a) => (a.status === 'idle' || a.status === 'blocked') && a.asks)
    const idleLong = ag.find((a) => a.status === 'idle' && now - a.statusSince > STALL_MS)
    const worker = ag.find((a) => a.pool === 'worker')
    const planner = ag.find((a) => a.pool === 'planner')
    const state = asker ? 'needs_you'
      : idleLong && !pr ? 'stalled'
      : pr?.state === 'MERGED' ? (pr.shipped ? 'shipped' : 'merged')
      : pr?.state === 'OPEN' ? 'in_review'
      : worker?.status === 'working' ? 'building'
      : wt?.plan && !worker ? 'plan_ready'
      : planner?.status === 'working' || (wt && !wt.plan) ? 'planning'
      : issue?.mine && ['unstarted', 'started'].includes(issue.stateType) && !wt && !pr && !ag.length ? 'up_next'
      : 'queued'
    // Old closed-unmerged PR with no live signal: skip, it's noise.
    if (!issue && !wt && pr?.state === 'CLOSED') continue
    const agent = asker ?? worker ?? planner ?? ag[0]
    tasks.push({
      id,
      title: issue?.title ?? pr?.title ?? wt?.branch ?? id,
      url: issue?.url ?? null,
      priority: issue?.priority ?? null,
      linearState: issue?.state ?? null,
      state,
      agent: agent ? { key: agent.key, id: agent.id, name: agent.name, machine: agent.machine } : null,
      // Who answers the ticket's room: the worker, else the planner.
      responder: (worker ?? planner) ? { key: (worker ?? planner).key, name: (worker ?? planner).name, taskState: (worker ?? planner).tags?.task_state ?? null } : null,
      project: agent?.project ?? (issue ? PROJECT_BY_TEAM[id.split('-')[0]] ?? id.split('-')[0].toLowerCase() : REPO_PROJECT),
      question: asker?.question ?? null,
      branch: wt?.branch ?? pr?.branch ?? null,
      worktree: wt?.path ?? null,
      plan: wt?.plan ?? null,
      pr: pr ?? null,
      updatedAt: [issue?.updatedAt, pr?.updatedAt, agent && new Date(agent.statusSince).toISOString()]
        .filter(Boolean).sort().at(-1) ?? null,
      // The user's own: Linear-assigned to the API key's user (assignee.isMe is the viewer), a PR they
      // authored, or work on this machine (a worktree, or one of their local agents).
      mine: Boolean(issue?.mine || pr?.mine || wt || ag.length),
      adHoc: false,
    })
  }
  for (const a of agents) {
    if (linked.has(a.key)) continue
    // Only an agent asking something is a task; the rest are visible in Agents.
    if (!a.asks || a.status === 'working') continue
    const title = (a.recap ?? a.lastPrompt ?? a.name).slice(0, 120)
    tasks.push({
      id: `agent:${a.key}`,
      title,
      url: null,
      priority: null,
      linearState: null,
      state: 'needs_you',
      agent: { key: a.key, id: a.id, name: a.name, machine: a.machine },
      project: a.project,
      question: a.question,
      branch: null, worktree: null, plan: null, pr: null,
      updatedAt: new Date(a.statusSince).toISOString(),
      mine: true,
      adHoc: true,
    })
  }
  return tasks
}

// The wt-plan handoff for a task, built only from server-derived fields. mode: 'worker' | 'reassign'.
export function handoffArgs(t, mode) {
  const err = (status, m) => Object.assign(new Error(m), { status })
  if (mode !== 'worker' && mode !== 'reassign') throw err(400, 'mode must be worker or reassign')
  if (t.state !== (mode === 'worker' ? 'plan_ready' : 'stalled')) throw err(409, `task is ${t.state}`)
  if (!t.plan || !t.worktree) throw err(400, 'task has no plan or worktree')
  const prompt = `Use wt-work to implement ${t.plan} to its Definition of Done.\n\nWork in ${t.worktree} on ${t.branch}. Do not cd to the main checkout.\n\nThen wt-ship.\n`
  return { args: [...(mode === 'reassign' ? ['--new'] : []), '--task', `${t.id} ${t.title}`.slice(0, 80), t.worktree], prompt }
}
const HANDOFF_SH = join(homedir(), '.claude', 'skills', 'wt-handoff', 'scripts', 'handoff.sh')
async function handoffTask(id, mode) {
  const t = (await overview()).tasks.find((x) => x.id === id)
  if (!t) throw Object.assign(new Error('unknown task'), { status: 404 })
  const { args, prompt } = handoffArgs(t, mode)
  const out = await new Promise((resolve, reject) => {
    const child = execFile(HANDOFF_SH, args, { cwd: t.worktree, maxBuffer: 1 << 20, timeout: 120_000 }, (err, o, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(o))
    child.stdin.end(prompt)
  })
  store.delete('overview'); store.delete('agents:local')
  const [kind, a, b] = out.trim().split('\n')[0].split(' ')
  return kind === 'created' ? { target: a, pane: b } : { target: null, pane: a }
}

// Per-source health for /api/health: last success, last error. Filled by every overview.
const STARTED_AT = new Date().toISOString()
// launchd: the LaunchAgent from `npm run service:install` sets WT_DASHBOARD_MANAGED=launchd.
const MANAGED_BY = envOf('MANAGED') === 'launchd' ? 'launchd' : envOf('APP') === '1' ? 'app' : 'external'
// The desktop app restarts a dead server at most 3 times in 5 minutes, then leaves it down. A restart can't see
// its own history, so each start is recorded and a burst becomes a visible inbox item instead of a silent outage.
export const RESTART_WINDOW_MS = 5 * 60_000
export function restartBurst(starts, now = Date.now()) {
  const recent = starts.filter((t) => now - t < RESTART_WINDOW_MS)
  return { recent, warn: recent.length >= 3 ? recent.length : 0 }
}
const SOURCES = Object.fromEntries(['herdr', 'git', 'gh', 'linear', 'machines'].map((k) => [k, { ok: null, lastOkAt: null, lastError: null }]))
const track = (name, p) => p.then(
  (v) => (Object.assign(SOURCES[name], { ok: true, lastOkAt: new Date().toISOString() }), v),
  (e) => { Object.assign(SOURCES[name], { ok: false, lastError: { at: new Date().toISOString(), message: String(e.message ?? e).slice(0, 300) } }); throw e })
// Jev (TypeSafe) status. The API exposes no credits/balance/usage endpoint: only a public GET /health and,
// with a key, GET /v1/models (the models on the account — which doubles as a key check).
export function jevState({ health, models, hasKey }) {
  const up = health?.status === 200 && health.body?.status === 'ok'
  const out = { state: health ? (up ? 'up' : 'down') : 'unreachable', key: hasKey ? 'unknown' : 'none', models: [] }
  if (hasKey && models) {
    if (models.status === 401 || models.status === 403) out.key = 'invalid'
    else if (models.status === 200) {
      out.key = 'ok'
      const list = Array.isArray(models.body?.models) ? models.body.models : Array.isArray(models.body?.data) ? models.body.data : []
      out.models = list.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean)
    }
  }
  return out
}
const jevGet = (path, key) => fetch(`https://api.typesafe.ai${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }), () => null)
const jev = () => cached('jev', 60_000, async () => {
  const key = cfg.get('TYPESAFE_API_KEY')
  const [h, m] = await Promise.all([jevGet('/health'), key ? jevGet('/v1/models', key) : null])
  return { ...jevState({ health: h, models: m, hasKey: Boolean(key) }), at: new Date().toISOString() }
})

async function health() {
  const dist = await stat(join(DIST, 'index.html')).catch(() => null)
  return {
    ok: true, app: 'wt-dashboard', runtime: RUNTIME, pid: process.pid, startedAt: STARTED_AT,
    managedBy: MANAGED_BY,
    webBuiltAt: dist?.mtime.toISOString() ?? null,
    sources: { ...SOURCES, linear: { ...SOURCES.linear, enabled: Boolean(cfg.get('LINEAR_API_KEY')) } },
    jev: await jev(), // outside `sources`: Jev being down doesn't degrade this server
  }
}

async function overview() {
  return cached('overview', 3000, async () => {
    const [ag, wt, pr, issues] = await Promise.all([
      track('herdr', agents()),
      track('git', worktrees()),
      track('gh', prs()).catch((e) => (console.error(e.message), [])),
      (cfg.get('LINEAR_API_KEY') ? track('linear', linear()) : linear()).catch((e) => (console.error(e.message), [])),
    ])
    const tasks = [...deriveTasks({ agents: ag, worktrees: wt, prs: pr, issues }), ...(await rooms.needsTasks())]
    const taskOf = new Map(tasks.filter((t) => t.agent).map((t) => [t.agent.key, t.id]))
    const n = (s) => tasks.filter((t) => t.state === s).length
    return {
      at: new Date().toISOString(),
      linearEnabled: Boolean(cfg.get('LINEAR_API_KEY')),
      roles: roleStore.roles,
      agents: ag.map((a) => ({ ...a, task: taskOf.get(a.key) ?? null })),
      machines: await track('machines', machineSummaries(ag).then((ms) => {
        SOURCES.machines.online = ms.filter((m) => m.status === 'online').length
        SOURCES.machines.total = ms.length
        return ms
      })),
      tasks,
      prs: pr,
      worktrees: wt,
      counts: {
        needsYou: n('needs_you'),
        stalled: n('stalled'),
        building: n('building'),
        inReview: n('in_review'),
        idleAgents: ag.filter((a) => a.status === 'idle').length,
      },
    }
  })
}

// ---- transition events (desktop notifications + tray) ----
// Per-agent state + per-PR CI, so successive overviews can be diffed. Pure: tested in parse.test.mjs.
export function snapshot(o) {
  const stalled = new Set(o.tasks.filter((t) => t.state === 'stalled' && t.agent).map((t) => t.agent.key))
  const agents = new Map(o.agents.map((a) => [a.key, {
    key: a.key, name: a.name, project: a.project, machine: a.machine, id: a.id,
    state: a.asks && a.status !== 'working' ? 'needs_you' : stalled.has(a.key) ? 'stalled' : a.status === 'done' ? 'done' : a.status,
    question: a.question ?? null, recap: a.recap ?? null,
  }]))
  // An agent that @mentioned the user in a room needs you until you reply there.
  for (const t of o.tasks.filter((t) => t.roomNeed)) agents.set(t.id, { key: t.agent.key, name: `${t.agent.name} in #${t.roomNeed}`, project: t.project, machine: 'room', id: t.id, state: 'needs_you', question: t.question, recap: null })
  const prs = new Map((o.prs ?? []).filter((p) => p.state === 'OPEN').map((p) => [p.number, p]))
  return { agents, prs }
}
// Only transitions INTO a notable state; the first snapshot is the baseline (no events for pre-existing states).
export function transitions(prev, next) {
  if (!prev) return []
  const out = []
  for (const a of next.agents.values()) {
    const b = prev.agents.get(a.key)
    const changed = !b || b.state !== a.state || (a.state === 'needs_you' && b.question !== a.question)
    if (changed && ['needs_you', 'done', 'stalled'].includes(a.state))
      out.push({ type: a.state, key: a.key, name: a.name, project: a.project, text: a.state === 'needs_you' ? a.question : a.recap, dedupe: `${a.machine}|${a.id}|${a.state}|${a.question ?? ''}` })
  }
  for (const p of next.prs.values()) {
    if (p.ci === 'fail' && prev.prs.get(p.number)?.ci !== 'fail')
      out.push({ type: 'ci_failed', key: null, name: `PR #${p.number}`, project: null, text: p.title, url: p.url, dedupe: `pr|${p.number}|fail` })
  }
  return out
}
// One always-on loop feeds the inbox (data/notifications.jsonl) from successive overviews; /api/events
// relays new items (native notifications) and the tray list (unresolved actionable items) to the app.
const inbox = new Inbox(join(DATA, 'notifications.jsonl'))
const subs = new Set()
let lastSnap = null
const trayOfInbox = () => ({
  needs: inbox.open().filter((it) => it.kind !== 'room-suggestion').map((it) => ({ key: it.target.agent ?? (it.target.room ? `room:${it.target.room}` : `memory:${it.target.memory}`), name: it.title, question: it.body })),
  working: lastSnap ? [...lastSnap.agents.values()].filter((a) => a.state === 'working').map((a) => ({ key: a.key, name: a.name })) : [],
})
const broadcastEvent = (event, data) => { for (const res of subs) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
inbox.subs.add((it) => broadcastEvent('notification', it))
// ---- Claude usage (Overview) ----
const USAGE_FILE = join(homedir(), '.cache', 'ccstatusline', 'usage.json')
const usageAgg = new UsageAgg()
let usageScan = null, usageScannedAt = 0
// Transcripts are re-read at most every 20s, appended bytes only; the first pass covers the last 8 days.
const scanUsage = () => {
  if (!usageScan && Date.now() - usageScannedAt > 20_000)
    usageScan = usageAgg.refresh(PROJECTS).catch((e) => console.error('usage:', e.message)).finally(() => { usageScan = null; usageScannedAt = Date.now() })
  return usageScan
}
async function usageApi() {
  await (usageScannedAt ? null : scanUsage()) // the first request waits for the first scan
  scanUsage()
  const ag = (await agents()).filter((a) => a.local && a.session)
  const agentOf = new Map(ag.map((a) => [a.session, a.name]))
  const proj = new Map()
  for (const r of usageAgg.recs.values()) if (r.cwd && !proj.has(r.cwd)) proj.set(r.cwd, await projectOf(r.cwd))
  const by = {
    agent: (r) => agentOf.get(r.session) ?? `other (${proj.get(r.cwd) ?? '?'})`,
    project: (r) => proj.get(r.cwd) ?? 'unknown',
    model: (r) => r.model,
  }
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
  const range = (from) => Object.fromEntries(Object.entries(by).map(([k, f]) => [k, usageAgg.summary(from, f)]))
  return {
    limits: await readLimits(USAGE_FILE),
    today: range(midnight.getTime()),
    week: range(Date.now() - 7 * 86400_000),
    priced: Object.keys(PRICES),
    scannedAt: usageScannedAt ? new Date(usageScannedAt).toISOString() : null,
  }
}
// Once per window per threshold: 80% and 95% of the 5-hour and weekly limits.
async function usageAlerts() {
  const l = await readLimits(USAGE_FILE)
  if (!l || l.stale) return
  for (const [name, pct, reset] of [['5-hour', l.session, l.sessionResetAt], ['Weekly', l.weekly, l.weeklyResetAt]]) {
    for (const th of [95, 80]) {
      if (pct == null || pct < th) continue
      const key = `usage|${name}|${th}|${reset ?? ''}`
      if (!inbox.items.some((it) => it.key === key))
        await inbox.add({ kind: 'usage', key, title: `Claude ${name} usage at ${pct}%`, body: `Crossed ${th}%${reset ? ` · resets ${new Date(reset).toLocaleString()}` : ''}`, target: {} })
      break // the higher threshold covers the lower one
    }
  }
}

async function tick() {
  try {
    await usageAlerts().catch((e) => console.error('usage alerts:', e.message))
    const o = await overview()
    const snap = snapshot(o)
    const first = !lastSnap
    const evs = transitions(lastSnap, snap)
    lastSnap = snap
    for (const e of evs) await inbox.add(itemFromTransition(e))
    // Baseline: what needs you right now is in the inbox too, quietly (no native pop for pre-existing states).
    if (first) for (const a of snap.agents.values()) if (a.state === 'needs_you')
      await inbox.add({ ...itemFromTransition({ type: 'needs_you', key: a.key, name: a.name, project: a.project, text: a.question, dedupe: `${a.machine}|${a.id}|needs_you|${a.question ?? ''}` }), quiet: true })
    await rooms.load()
    const sugg = rooms.settings.ticketRooms === 'suggest' ? ticketSuggestions(o.tasks, rooms.index.map((r) => r.slug), rooms.settings) : []
    for (const x of sugg) await inbox.add({ kind: 'room-suggestion', key: `suggest|${x.ticket}`, title: `Room suggested: #${x.slug}`, body: `${x.title} — ${x.reason}`, target: { task: x.ticket, room: x.slug }, quiet: true })
    const needs = new Set([...snap.agents.values()].filter((a) => a.state === 'needs_you').map((a) => a.key))
    const proposals = await memoryNotices().catch((e) => { console.error('memory:', e.message); return null })
    const resolved = await inbox.resolve(toResolve(inbox.items, needs, new Set(sugg.map((x) => x.ticket)), proposals))
    if (resolved) broadcastEvent('inbox', { changed: true })
    broadcastEvent('tray', trayOfInbox())
  } catch (e) { console.error('inbox:', e.message) }
}
function streamEvents(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  subs.add(res)
  if (inbox.items) res.write(`event: tray\ndata: ${JSON.stringify(trayOfInbox())}\n\n`)
  // The page reloads itself when web/dist was rebuilt after it loaded (a long-lived app window never goes stale).
  stat(join(DIST, 'index.html')).then((st) => res.write(`event: build\ndata: ${JSON.stringify(st.mtimeMs)}\n\n`), () => {})
  const beat = setInterval(() => res.write(': hb\n\n'), 15_000)
  req.on('close', () => { subs.delete(res); clearInterval(beat) })
}
async function inboxApi(req, res, url) {
  await inbox.load()
  if (req.method === 'GET') {
    const items = inbox.list()
    return send(res, 200, { items, unread: items.filter((it) => !it.read).length, open: inbox.open().length })
  }
  if (req.method === 'POST' && url.pathname === '/api/notifications/read') {
    const b = JSON.parse((await body(req)) || '{}')
    const ids = b.all ? inbox.items.filter((it) => !it.read).map((it) => it.id) : Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string') : []
    const n = await inbox.patch(ids, { read: true })
    broadcastEvent('inbox', { changed: true })
    return send(res, 200, { ok: true, marked: n })
  }
  if (req.method === 'POST' && url.pathname === '/api/notifications/clear') {
    const b = JSON.parse((await body(req)) || '{}')
    const n = await inbox.clear({ ids: Array.isArray(b.ids) ? b.ids : [], all: b.all === true, allRead: b.allRead === true })
    broadcastEvent('inbox', { changed: true })
    broadcastEvent('tray', trayOfInbox())
    return send(res, 200, { ok: true, cleared: n })
  }
  send(res, 404, { error: 'not found' })
}
// Which server build is serving: the SEA sidecar, or node on a live server.mjs.
const RUNTIME = basename(process.execPath).startsWith('wt-dashboard-server') ? { kind: 'bundled', path: process.execPath } : { kind: 'live', path: fileURLToPath(import.meta.url) }

// ---- slash commands / skills for the composer ----
const CLAUDE = join(homedir(), '.claude')
const BUILTINS = [
  ['clear', 'Clear conversation history'], ['compact', 'Compact the conversation to free context'],
  ['context', 'Show context window usage'], ['cost', 'Show token usage and cost'], ['model', 'Switch model'],
  ['resume', 'Resume a previous conversation'], ['review', 'Review a pull request'], ['init', 'Create a CLAUDE.md for this repo'],
  ['memory', 'Edit memory files'], ['config', 'Open settings'], ['help', 'Show help'], ['agents', 'Manage subagents'],
  ['mcp', 'Manage MCP servers'], ['permissions', 'View or change tool permissions'], ['status', 'Show session status'],
  ['export', 'Export the conversation'], ['rewind', 'Rewind the conversation or code'], ['loop', 'Run a prompt on an interval'],
  ['schedule', 'Schedule a recurring agent'], ['goal', 'Set a goal for this session'],
].map(([name, description]) => ({ name, description, source: 'Built-in' }))

// Tiny frontmatter reader: `key: value` lines between the first two `---`.
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const fm = {}
  let block = null // key of a `>` / `|` block scalar being collected
  if (m) for (const l of m[1].split('\n')) {
    const kv = l.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kv) {
      block = /^[>|][-+]?$/.test(kv[2].trim()) ? kv[1] : null
      fm[kv[1]] = block ? '' : kv[2].replace(/^["']|["']$/g, '').trim()
    } else if (block && /^\s/.test(l)) fm[block] += ' ' + l.trim()
  }
  const body = m ? text.slice(m[0].length) : text
  return { fm, firstLine: body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '' }
}
const desc = (s) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), 160)
const readSafe = (f) => readFile(f, 'utf8').catch(() => null)

async function skillsIn(dir, source, prefix = '') {
  const out = []
  for (const d of await readdir(join(dir, 'skills')).catch(() => [])) {
    const t = await readSafe(join(dir, 'skills', d, 'SKILL.md'))
    if (!t) continue
    const { fm, firstLine } = frontmatter(t)
    out.push({ name: prefix + (fm.name || d), description: desc(fm.description || firstLine), source })
  }
  return out
}
async function commandsIn(dir, source, prefix = '') {
  const root = join(dir, 'commands')
  const files = await readdir(root, { recursive: true }).catch(() => [])
  const out = []
  for (const rel of files.filter((f) => f.endsWith('.md'))) {
    const t = await readSafe(join(root, rel))
    if (!t) continue
    const { fm, firstLine } = frontmatter(t)
    out.push({ name: prefix + rel.slice(0, -3).split('/').join(':'), description: desc(fm.description || firstLine), source })
  }
  return out
}
async function pluginCommands() {
  const settings = JSON.parse((await readSafe(join(CLAUDE, 'settings.json'))) ?? '{}')
  const installed = JSON.parse((await readSafe(join(CLAUDE, 'plugins', 'installed_plugins.json'))) ?? '{}').plugins ?? {}
  const out = []
  for (const [key, on] of Object.entries(settings.enabledPlugins ?? {})) {
    const path = on && installed[key]?.[0]?.installPath
    if (!path) continue
    const name = key.split('@')[0]
    out.push(...(await skillsIn(path, 'Plugins', `${name}:`)), ...(await commandsIn(path, 'Plugins', `${name}:`)))
  }
  return out
}
async function commandsFor(a) {
  if (!a?.local) return BUILTINS // remote: no filesystem access
  const top = (await git(a.cwd, 'rev-parse', '--show-toplevel').catch(() => '')).trim()
  return cached(`commands:${top}`, 60_000, async () => {
    const seen = new Set()
    const all = [
      ...(top ? [...(await skillsIn(join(top, '.claude'), 'Project')), ...(await commandsIn(join(top, '.claude'), 'Project'))] : []),
      ...(await skillsIn(CLAUDE, 'Personal')), ...(await commandsIn(CLAUDE, 'Personal')),
      ...(await pluginCommands()),
      ...BUILTINS,
    ]
    return all.filter((c) => !seen.has(c.name) && seen.add(c.name)) // first (most specific) wins
  })
}

// ---- answering AskUserQuestion by driving Claude Code's picker ----
// Verified key semantics (Claude Code picker), one question per call:
//  single-select: digit k selects option k AND advances; "Type something" = digit N+1, then text, then Enter.
//  multiSelect:   digit k toggles [ ] without moving the cursor. Row N+1 is "Type something" (digit toggles it; the
//                 cursor must be on it to type), row N+2 is "Submit", Enter there advances. Tab is NOT safe: inside
//                 the text field it only moves the cursor.
//  Preview layout (options with previews): digit only moves focus, Enter selects+advances, no "Type something".
//  Review step ("Ready to submit your answers?"): digit 1 submits, 2 cancels.
//  Esc anywhere cancels the picker (rejected tool_result; the agent returns to its prompt).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const move = (from, to) => Array(Math.abs(to - from)).fill(to > from ? 'down' : 'up')
// "Chat about this" (declines the question, then the agent asks what to clarify; recorded as a rejected tool_result):
// numbered row N+2 in the normal/multiSelect layouts; unnumbered below the last option in the preview layout.
export function chatPlan(pk) {
  const n = pk.options.length
  return pk.layout === 'preview' ? [{ keys: [String(n)] }, { keys: ['down'] }, { keys: ['enter'] }] : [{ keys: [String(n + 2)] }]
}
export function answerPlan(pk, { selected = [], other = null }) {
  const n = pk.options.length
  const idx = selected.map((label) => pk.options.findIndex((o) => o.label === label) + 1)
  if (idx.some((k) => k < 1)) throw Object.assign(new Error('unknown option'), { status: 400 })
  other = typeof other === 'string' && other.trim() ? other.trim().replace(/[\r\n]+/g, ' ') : null
  if (pk.layout === 'preview') {
    if (other) throw Object.assign(new Error('this question has no free-text option'), { status: 400 })
    if (idx.length !== 1) throw Object.assign(new Error('pick exactly one option'), { status: 400 })
    return [{ keys: [String(idx[0])] }, { keys: ['enter'] }] // digit = focus only in this layout
  }
  if (!pk.multiSelect) {
    if (other) return [{ keys: [String(n + 1)] }, { text: other }, { keys: ['enter'] }]
    if (idx.length !== 1) throw Object.assign(new Error('pick exactly one option'), { status: 400 })
    return [{ keys: [String(idx[0])] }]
  }
  if (!idx.length && !other) throw Object.assign(new Error('pick at least one option'), { status: 400 })
  const steps = []
  pk.options.forEach((o, i) => { if (o.checked !== idx.includes(i + 1)) steps.push({ keys: [String(i + 1)] }) }) // toggle the difference
  if (other) {
    if (pk.other) throw Object.assign(new Error('custom text already typed in the terminal; edit it there'), { status: 409 })
    steps.push({ keys: [String(n + 1)] }, { keys: move(pk.cursor, n + 1) }, { text: other }, { keys: ['down', 'enter'] })
  } else {
    if (pk.other) steps.push({ keys: [String(n + 1)] }) // untick custom text typed earlier
    steps.push({ keys: [...move(pk.cursor, n + 2), 'enter'] })
  }
  return steps.filter((st) => st.text || st.keys.length)
}
async function answerQuestion(a, req) {
  const m = await machineBy(a.machine)
  const raw = await readPane(m, a.id, '80')
  const pk = parsePicker(stripAnsi(raw), raw)
  if (!pk) return [409, { error: 'no question is waiting on screen' }]
  let steps
  if (req.action === 'goto') {
    // ←/→ switch questions (verified); only from the screen the user saw.
    if (pk.review ? req.question !== 'review' : pk.question !== req.question) return [409, { error: 'that question is no longer on screen' }]
    const from = pk.review ? pk.tabs.length : pk.current
    const to = Number(req.tab)
    if (!Number.isInteger(to) || to < 0 || to > pk.tabs.length) return [400, { error: 'bad tab' }]
    steps = [{ keys: Array(Math.abs(to - from)).fill(to > from ? 'right' : 'left') }].filter((s) => s.keys.length)
  } else if (req.action === 'chat' || req.action === 'skip') {
    // Stale check: only act on the question (or review step) the user saw.
    if (pk.review ? req.question !== 'review' : pk.question !== req.question) return [409, { error: 'that question is no longer on screen' }]
    if (req.action === 'skip') steps = [{ keys: ['esc'] }]
    else if (pk.review) return [409, { error: 'not available at the review step' }]
    else steps = chatPlan(pk)
  } else if (req.action === 'submit' || req.action === 'cancel') {
    if (!pk.review) return [409, { error: 'not at the review step' }]
    steps = [{ keys: [req.action === 'submit' ? '1' : '2'] }]
  } else {
    // Only answer the question the user actually saw.
    if (pk.review || pk.question !== req.question) return [409, { error: 'that question is no longer on screen' }]
    steps = answerPlan(pk, req)
  }
  for (const st of steps) {
    if (st.text) await herdrOn(m, 'pane', 'send-text', a.id, st.text)
    else await herdrOn(m, 'agent', 'send-keys', a.id, ...st.keys)
    await sleep(150)
  }
  parsed.delete(`${m.label}|${a.id}`) // force a fresh pane read
  return [200, { ok: true }]
}

// ---- image uploads (Claude Code reads an image when the prompt holds its absolute path) ----
const UPLOADS = join(DATA_ROOT, 'uploads')
const MAX_UPLOAD = 10 << 20
const IMG = {
  'image/png': { ext: 'png', ok: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', ok: (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')) },
  'image/webp': { ext: 'webp', ok: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
}
const EXT_MIME = Object.fromEntries(Object.entries(IMG).map(([m, v]) => [v.ext, m]))
const rawBody = (req, max) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
async function saveUpload(req) {
  const type = IMG[(req.headers['content-type'] ?? '').split(';')[0].trim()]
  if (!type) return [415, { error: 'png, jpeg, webp or gif only' }]
  const buf = await rawBody(req, MAX_UPLOAD)
  if (!buf.length || !type.ok(buf)) return [400, { error: 'file content does not match its type' }]
  const day = new Date().toISOString().slice(0, 10)
  const dir = join(UPLOADS, day)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const name = `${randomUUID()}.${type.ext}` // never the client filename
  await writeFile(join(dir, name), buf, { mode: 0o600 })
  return [200, { path: join(dir, name), url: `/api/uploads/${day}/${name}` }]
}
// Only <yyyy-mm-dd>/<uuid>.<ext> — nothing else under (or outside) the uploads dir is reachable.
const UP_DAY = /^\d{4}-\d{2}-\d{2}$/
const UP_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/

// ---- http ----
const body = (req) =>
  new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 100_000) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(b))
  })

const send = (res, code, data, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(type === 'application/json' ? JSON.stringify(data) : data)
}

// Extra exact hostnames allowed through the Host/Origin guard, e.g. the tailnet name that
// `tailscale serve` proxies from. Comma-separated; exact match only, never a wildcard.
const LOCAL = {
  test: (h) =>
    LOOPBACK_HOST.test(h) || cfg.list('WT_DASHBOARD_ALLOWED_HOSTS').map((x) => x.toLowerCase()).includes(h.toLowerCase().replace(/:443$/, '')),
}
const PANE = /^[\w.:-]+$/
const KEY = /^[\w+-]{1,20}$/
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }

// ---- user session: only the dashboard page may act as the user ----
// A random token per server start, handed to the page as an HttpOnly SameSite=Strict cookie when it loads
// index.html. Every state-changing /api call needs it, except an agent's own room post (x-herdr-pane).
// ponytail: this stops cross-site requests and agents that simply curl the API; a local process that fetches
// index.html itself can still read the cookie — real isolation would need a per-user OS boundary.
const SESSION = randomUUID()
const SESSION_COOKIE = `hd_session=${SESSION}; HttpOnly; SameSite=Strict; Path=/`
export const hasSession = (cookieHeader, token = SESSION) =>
  (cookieHeader ?? '').split(';').some((c) => c.trim() === `hd_session=${token}`)
export function needsSession(method, path, headers) {
  if (method === 'GET' || method === 'HEAD' || !path.startsWith('/api/')) return false
  if (headers['x-herdr-pane'] && method === 'POST' && /^\/api\/rooms\/[^/]+\/messages$/.test(path)) return false // agent post
  if (headers['x-herdr-pane'] && method === 'POST' && path === '/api/rooms') return false // agent `room create` (gated by a setting)
  return true
}

// ---- rooms ----
const rooms = new Rooms({
  dir: DATA,
  agents: () => agents(),
  prompt: async (a, text) => {
    const m = await machineBy(a.machine)
    if (!m) throw new Error(`machine ${a.machine} unavailable`)
    await herdrOn(m, 'agent', 'prompt', a.id, text)
    store.delete('agents:local')
  },
})
let ticketTick = 0
const roomsLoop = async () => {
  try {
    await rooms.flush()
    await rooms.load()
    if (rooms.settings.ticketRooms !== 'off' && ++ticketTick % 3 === 0) await rooms.syncTickets((await overview()).tasks)
  } catch (e) { console.error('rooms:', e.message) }
}
// Who is posting: an agent names its pane (x-herdr-pane, set by the wt-room CLI from $HERDR_PANE_ID) and must be a
// live local agent reached on 127.0.0.1 itself; anything else must be the dashboard page (Origin present).
// $HERDR_PANE_ID is herdr's STABLE pane id (e.g. "w4:pM"), while `agent list` reports the current display
// id ("wM:p6"), which moves when workspaces are renumbered. `herdr pane get` resolves either form.
const paneIds = new Map() // any id form -> { id: display pane id, at }
// ponytail: 30s TTL, so a renumbered workspace is picked up quickly; `get` is injectable for the test.
export async function canonicalPane(id, get = (x) => herdr('pane', 'get', x), cache = paneIds, now = Date.now()) {
  if (!/^[\w-]+:[\w-]+$/.test(id)) return null
  const hit = cache.get(id)
  if (hit && now - hit.at < 30_000) return hit.id
  try {
    const got = JSON.parse(await get(id)).result?.pane?.pane_id ?? null
    if (got) cache.set(id, { id: got, at: now })
    return got
  } catch { return null }
}
async function roomAuthor(req) {
  if (hasSession(req.headers.cookie)) {
    const p = rooms.settings.profile
    return { kind: 'user', name: p.name, handle: p.handle, avatar: p.avatar ?? null }
  }
  const pane = req.headers['x-herdr-pane']
  if (pane) {
    const addr = req.socket.remoteAddress ?? ''
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(addr) || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? ''))
      throw Object.assign(new Error('agents post via 127.0.0.1 only'), { status: 403 })
    const id = await canonicalPane(pane)
    const a = (await agents()).find((x) => x.local && x.id === id)
    if (!a) throw Object.assign(new Error(`unknown pane ${pane}`), { status: 403 })
    return { kind: 'agent', name: a.name, machine: a.machine, pane: a.id, key: a.key }
  }
  throw Object.assign(new Error('post from the dashboard, or from an agent pane with bin/room'), { status: 403 })
}
// Room attachments: the user attaches files already uploaded (paths inside UPLOADS); an agent attaches
// images from its own cwd or /tmp, which are validated by content and COPIED into uploads.
const MAX_ROOM_ATTS = 5
async function roomAttachments(author, b) {
  const list = author.kind === 'user' ? b.attachments : b.attach
  if (list === undefined) return []
  if (!Array.isArray(list) || list.length > MAX_ROOM_ATTS || !list.every((p) => typeof p === 'string'))
    throw Object.assign(new Error(`at most ${MAX_ROOM_ATTS} attachments, as paths`), { status: 400 })
  const out = []
  for (const p of list) {
    let real
    try { real = realpathSync(p) } catch { throw Object.assign(new Error(`no such file: ${p}`), { status: 400 }) }
    if (!statSync(real).isFile() || statSync(real).size > MAX_UPLOAD) throw Object.assign(new Error(`${p}: not a file up to 10MB`), { status: 400 })
    const buf = await readFile(real)
    const type = Object.entries(IMG).find(([, v]) => v.ok(buf))
    if (!type || buf.length > MAX_UPLOAD) throw Object.assign(new Error(`${p}: png, jpeg, webp or gif up to 10MB only`), { status: 400 })
    if (author.kind === 'user') {
      if (!real.startsWith(realpathSync(UPLOADS) + '/')) throw Object.assign(new Error('attach uploaded files only'), { status: 400 })
      out.push({ path: real, type: type[0], size: buf.length })
      continue
    }
    const a = (await agents()).find((x) => x.key === author.key)
    const roots = [a?.cwd, '/tmp', '/private/tmp'].filter(Boolean).map((d) => { try { return realpathSync(d) } catch { return d } })
    if (!roots.some((d) => real.startsWith(d + '/'))) throw Object.assign(new Error(`${p}: only images under your cwd or /tmp`), { status: 400 })
    const day = new Date().toISOString().slice(0, 10)
    await mkdir(join(UPLOADS, day), { recursive: true, mode: 0o700 })
    const dest = join(UPLOADS, day, `${randomUUID()}.${type[1].ext}`)
    await writeFile(dest, buf, { mode: 0o600 })
    out.push({ path: dest, type: type[0], size: buf.length })
  }
  return out
}
const roomText = (msgs) => msgs.map((m, i) => `${i + 1}. [${m.ts.slice(11, 16)}] ${m.author.name}: ${m.text}${(m.attachments ?? []).map((a) => `\n   ${a.path}`).join('')}`).join('\n') + '\n'
async function roomsApi(req, res, url, parts) {
  const json = async () => JSON.parse((await body(req)) || '{}')
  const userOnly = async () => { if ((await roomAuthor(req)).kind !== 'user') throw Object.assign(new Error('dashboard only'), { status: 403 }) }
  await rooms.load()
  if (parts[1] === 'settings') {
    if (req.method === 'GET') return send(res, 200, rooms.settings)
    if (req.method === 'PATCH') { await userOnly(); return send(res, 200, await rooms.setSettings(await json())) }
  }
  if (parts.length === 2) {
    if (req.method === 'GET') {
      if (url.searchParams.get('format') === 'text') return send(res, 200, rooms.index.filter((r) => !r.archived).map((r) => `${r.slug}\t${r.title}${r.paused ? ' (paused)' : ''}`).join('\n') + '\n', 'text/plain')
      const tasks = rooms.settings.ticketRooms === 'suggest' ? (await overview()).tasks : []
      return send(res, 200, { rooms: rooms.index, settings: rooms.settings, pending: rooms.pending(),
        suggestions: ticketSuggestions(tasks, rooms.index.map((r) => r.slug), rooms.settings) })
    }
    if (req.method === 'POST') {
      const author = await roomAuthor(req)
      if (author.kind === 'agent') {
        const b = await json()
        const list = await agents()
        const me = list.find((a) => a.key === author.key)
        const out = await rooms.createByAgent({ author, slug: b.slug, title: b.title, invite: Array.isArray(b.invite) ? b.invite : [], project: me?.tags?.project ?? me?.project ?? null, agentList: list.filter((a) => a.local) })
        if (!out.existing) await inbox.add({ kind: 'room-created', key: `room-created|${out.room.slug}`, title: `${author.name} created #${out.room.slug}`, body: out.room.title, target: { room: out.room.slug, agent: author.key } })
        return send(res, 200, out)
      }
      if (author.kind !== 'user') throw Object.assign(new Error('dashboard only'), { status: 403 })
      const b = await json()
      if (b.ticket) {
        const t = (await overview()).tasks.find((x) => x.id === b.ticket)
        if (!t) return send(res, 404, { error: 'unknown ticket' })
        return send(res, 200, await rooms.createForTicket(t))
      }
      if (typeof b.title !== 'string' || !b.title.trim()) return send(res, 400, { error: 'title required' })
      return send(res, 200, await rooms.create({ title: b.title.trim(), project: b.project ?? null, responder: typeof b.responder === 'string' ? b.responder : null }))
    }
  }
  if (parts[2] === 'dismiss' && req.method === 'POST') {
    await userOnly()
    const { ticket } = await json()
    return send(res, 200, await rooms.setSettings({ dismissedTickets: [...new Set([...rooms.settings.dismissedTickets, String(ticket)])] }))
  }
  const slug = parts[2]
  if (!rooms.room(slug)) return send(res, 404, { error: 'unknown room' })
  if (!parts[3] && req.method === 'PATCH') { await userOnly(); return send(res, 200, await rooms.update(slug, await json())) }
  if (!parts[3] && req.method === 'DELETE') { await userOnly(); await rooms.remove(slug); return send(res, 200, { ok: true }) }
  if (parts[3] === 'stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    // Resume: ?since=<message count the client holds> (or Last-Event-ID) sends the tail from there, re-sending
    // the 50 before it so their delivery state catches up; `id:` is the room's message count.
    const all = await rooms.messages(slug)
    const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since'))
    const from = Number.isFinite(since) && since > 0 && since <= all.length ? Math.max(0, since - 50) : 0
    res.write(`event: backlog\nid: ${all.length}\ndata: ${JSON.stringify({ from, messages: all.slice(from) })}\n\n`)
    const set = rooms.subs.get(slug) ?? new Set()
    rooms.subs.set(slug, set.add(res))
    const beat = setInterval(() => res.write(': hb\n\n'), 15_000)
    return req.on('close', () => { set.delete(res); clearInterval(beat) })
  }
  if (parts[3] === 'messages' && req.method === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0)
    const msgs = (await rooms.messages(slug)).slice(since)
    return url.searchParams.get('format') === 'text' ? send(res, 200, roomText(msgs).replace(/^(\d+)\./gm, (_, n) => `${+n + since}.`), 'text/plain') : send(res, 200, msgs)
  }
  if (parts[3] === 'messages' && req.method === 'POST') {
    const author = await roomAuthor(req)
    const b = await json()
    return send(res, 200, await rooms.post(slug, { author, text: b.text, confirmAll: author.kind === 'user' && b.confirmAll === true, attachments: await roomAttachments(author, b), replyTo: b.replyTo }))
  }
  send(res, 404, { error: 'not found' })
}

// ---- Settings → Integrations & environment ----
// GET lists every key with its source; a secret is only ever "set · …last4". Writes are session-gated (needsSession)
// and allowed hosts additionally need a request from this machine's own 127.0.0.1 page.
async function linearViewer(key) {
  const r = await fetch('https://api.linear.app/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: key },
    body: JSON.stringify({ query: '{ viewer { name email organization { name } } }' }),
    signal: AbortSignal.timeout(10_000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.errors) throw new Error(j.errors?.[0]?.message ?? `Linear answered ${r.status}`)
  return { user: j.data.viewer.name ?? j.data.viewer.email, workspace: j.data.viewer.organization?.name ?? null }
}
async function repoRoot(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw Object.assign(new Error('an absolute path'), { status: 400 })
  const c = await git(p, 'rev-parse', '--path-format=absolute', '--git-common-dir').catch(() => null)
  if (!c) throw Object.assign(new Error(`not a git repository: ${p}`), { status: 400 })
  return dirname(c.trim())
}
async function configApi(req, res, parts) {
  const state = () => ({ items: cfg.publicState(), loopback: isLoopbackRequest(req), app: process.env.WT_DASHBOARD_APP === '1' })
  if (req.method === 'GET' && parts.length === 2) return send(res, 200, state())
  const b = JSON.parse((await body(req)) || '{}')
  if (req.method === 'POST' && parts[2] === 'linear-test') {
    const key = cfg.get('LINEAR_API_KEY')
    if (!key) return send(res, 400, { error: 'no Linear API key set' })
    return send(res, 200, await linearViewer(key).then((v) => ({ ok: true, ...v }), (e) => ({ ok: false, error: e.message })))
  }
  if (req.method === 'POST' && parts[2] === 'check-repo') return send(res, 200, await repoRoot(b.path).then((root) => ({ ok: true, root }), (e) => ({ ok: false, error: e.message })))
  const k = parts[2]
  const d = KEYS[k]
  if (!d || !(req.method === 'PUT' || req.method === 'DELETE')) return send(res, 404, { error: 'not found' })
  if (cfg.override(k) != null) return send(res, 409, { error: `${k} is set in the server's environment; change it there` })
  if (d.loopbackOnly && !isLoopbackRequest(req)) return send(res, 403, { error: 'allowed hosts can be changed only from http://127.0.0.1 on this machine' })
  if (d.secret) {
    if (req.method === 'DELETE') await cfg.removeSecret(k)
    else await cfg.setSecret(k, typeof b.value === 'string' ? b.value.trim() : '')
    store.delete('linear')
  } else {
    const v = req.method === 'DELETE' ? (d.list ? [] : '') : b.value
    if (k === 'WT_DASHBOARD_PROJECTS') for (const p of v ?? []) await repoRoot(p)
    if (k === 'UMKMALL_REPO' && v) await repoRoot(v)
    await cfg.setValue(k, v)
    store.delete('projectRoots')
  }
  send(res, 200, state())
}

// ---- Terminals (terminals.mjs): shells owned by herdr, mirrored and typed into from the dashboard ----
const terms = new TerminalSettings(DATA)
const hj = async (...a) => JSON.parse(await herdr(...a))
async function shellWorkspaces() {
  const ws = (await hj('workspace', 'list')).result.workspaces
  return new Map(ws.filter((w) => w.label?.endsWith('-shells')).map((w) => [w.workspace_id, w.label]))
}
async function shellPane(id) {
  const ws = await shellWorkspaces()
  const p = await hj('pane', 'get', id).then((j) => j.result.pane, () => null)
  if (!isShellPane(p, new Set(ws.keys()))) throw Object.assign(new Error('not a dashboard shell (agents keep their own controls)'), { status: 404 })
  return p
}
async function listShells() {
  const ws = await shellWorkspaces()
  const panes = (await hj('pane', 'list')).result.panes.filter((p) => isShellPane(p, new Set(ws.keys())))
  return Promise.all(panes.map(async (p) => {
    const tab = await hj('tab', 'get', p.tab_id).then((j) => j.result.tab, () => null)
    const tail = await herdr('pane', 'read', p.pane_id, '--source', 'recent-unwrapped', '--lines', '20').catch(() => '')
    return {
      pane: p.pane_id, name: tab?.label || basename(p.cwd ?? '') || p.pane_id, cwd: p.foreground_cwd ?? p.cwd, workspace: ws.get(p.workspace_id),
      title: p.terminal_title_stripped || null, rows: p.scroll?.viewport_rows ?? null,
      lastLine: stripAnsi(tail).split('\n').map((l) => l.trimEnd()).filter(Boolean).at(-1) ?? '',
    }
  }))
}
async function knownPlaces() {
  const roots = [...(await projectRoots())]
  const worktrees = (await Promise.all(roots.map(([, root]) => linkedWorktrees(root).catch(() => [])))).flat().map((w) => w.path)
  return { roots: roots.map(([, r]) => r), worktrees, home: homedir(), tmp: ['/private/tmp', '/tmp', realpathSync(tmpdir())], byRoot: roots }
}
async function createShell(b) {
  const places = await knownPlaces()
  const cwd = typeof b.cwd === 'string' ? b.cwd : places.byRoot.find(([n]) => n === b.project)?.[1]
  if (!allowedCwd(cwd, places)) throw Object.assign(new Error('cwd must be a project, one of its worktrees, $HOME or /private/tmp'), { status: 400 })
  const project = places.byRoot.find(([, root]) => cwd === root || cwd.startsWith(root + '/') || places.worktrees.includes(cwd))?.[0] ?? REPO_PROJECT
  const label = shellsLabel(project)
  const name = typeof b.name === 'string' && /^[\w .:@+-]{1,40}$/.test(b.name) ? b.name : basename(cwd) || 'shell'
  const ws = [...(await shellWorkspaces())].find(([, l]) => l === label)?.[0]
  // A new workspace comes with a tab and a shell pane: that is the first terminal. Otherwise, a new tab.
  const res = ws ? await hj('tab', 'create', '--workspace', ws, '--cwd', cwd, '--label', name, '--no-focus')
    : await hj('workspace', 'create', '--label', label, '--cwd', cwd, '--no-focus')
  const pane = res.result.root_pane?.pane_id
  if (!ws && res.result.tab?.tab_id) await herdr('tab', 'rename', res.result.tab.tab_id, name).catch(() => {})
  return { pane, name, cwd }
}
// One poller per pane, only while someone is watching; unchanged screens are not re-sent.
const screenSubs = new Map() // pane -> { clients:Set<res>, timer, last }
function watchScreen(pane, res) {
  let w = screenSubs.get(pane)
  if (!w) {
    w = { clients: new Set(), last: null, busy: false }
    w.timer = setInterval(async () => {
      if (w.busy) return
      w.busy = true
      try {
        const screen = await herdr('pane', 'read', pane, '--source', 'visible', '--format', 'ansi')
        if (screen !== w.last) { w.last = screen; for (const c of w.clients) c.write(`event: screen\ndata: ${JSON.stringify(screen)}\n\n`) }
      } catch (e) { for (const c of w.clients) c.write(`event: gone\ndata: ${JSON.stringify(e.message)}\n\n`) } finally { w.busy = false }
    }, 300)
    screenSubs.set(pane, w)
  }
  w.clients.add(res)
  if (w.last != null) res.write(`event: screen\ndata: ${JSON.stringify(w.last)}\n\n`)
  return () => { w.clients.delete(res); if (!w.clients.size) { clearInterval(w.timer); screenSubs.delete(pane) } }
}
const who = (req) => ({ remoteAddr: req.socket.remoteAddress ?? null, host: req.headers.host ?? null })
async function terminalSettingsApi(req, res) {
  const loopback = isLoopbackRequest(req)
  if (req.method === 'GET') return send(res, 200, { ...terms.s, loopback, audit: hasSession(req.headers.cookie) ? await terms.tail(100) : [] })
  if (!loopback) return send(res, 403, { error: 'terminal settings can be changed only from http://127.0.0.1 on this machine' })
  const b = JSON.parse((await body(req)) || '{}')
  await terms.set(b)
  await terms.log({ action: 'settings', text: JSON.stringify(terms.s), ...who(req) })
  send(res, 200, { ...terms.s, loopback })
}
async function terminalsApi(req, res, url, parts) {
  const denied = terms.gate({ loopback: isLoopbackRequest(req), session: hasSession(req.headers.cookie) })
  if (denied) return send(res, denied[0], { error: denied[1] })
  const pane = parts[2] ? decodeURIComponent(parts[2]) : null
  if (!pane) {
    if (req.method === 'GET') return send(res, 200, await listShells())
    if (req.method === 'POST') {
      const out = await createShell(JSON.parse((await body(req)) || '{}'))
      await terms.log({ pane: out.pane, action: 'create', text: out.cwd, ...who(req) })
      return send(res, 200, out)
    }
    return send(res, 405, { error: 'method' })
  }
  if (url.pathname === '/api/terminals/places' || pane === 'places') {
    const pl = await knownPlaces()
    return send(res, 200, { projects: pl.byRoot.map(([name, root]) => ({ name, root })), worktrees: pl.worktrees, home: pl.home, tmp: '/private/tmp' })
  }
  const p = await shellPane(pane)
  const sub = parts[3]
  if (req.method === 'DELETE' && !sub) {
    await herdr('pane', 'close', p.pane_id)
    await terms.log({ pane: p.pane_id, action: 'close', ...who(req) })
    return send(res, 200, { ok: true })
  }
  if (req.method === 'PATCH' && !sub) {
    const b = JSON.parse((await body(req)) || '{}')
    if (typeof b.name !== 'string' || !/^[\w .:@+-]{1,40}$/.test(b.name)) return send(res, 400, { error: 'name: 1–40 letters, digits, space . : @ + -' })
    await herdr('tab', 'rename', p.tab_id, b.name)
    return send(res, 200, { ok: true })
  }
  if (sub === 'screen' && req.method === 'GET') {
    const lines = Math.min(Number(url.searchParams.get('lines')) || 0, 5000)
    const screen = lines ? await herdr('pane', 'read', p.pane_id, '--source', 'recent', '--format', 'ansi', '--lines', String(lines))
      : await herdr('pane', 'read', p.pane_id, '--source', 'visible', '--format', 'ansi')
    return send(res, 200, { screen, rows: p.scroll?.viewport_rows ?? null })
  }
  if (sub === 'stream' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const stop = watchScreen(p.pane_id, res)
    const beat = setInterval(() => res.write(': hb\n\n'), 15_000)
    req.on('close', () => { stop(); clearInterval(beat) })
    return
  }
  if (sub === 'input' && req.method === 'POST') {
    const b = JSON.parse((await body(req)) || '{}')
    if (typeof b.text === 'string' && b.text) {
      if (b.text.length > 8000) return send(res, 400, { error: 'text too long' })
      await herdr('pane', 'send-text', p.pane_id, b.text)
      if (b.submit) await herdr('pane', 'send-keys', p.pane_id, 'enter')
      await terms.log({ pane: p.pane_id, action: 'input', text: b.text + (b.submit ? '⏎' : ''), ...who(req) })
    } else if (b.keys) {
      const keys = herdrKeys(b.keys)
      await herdr('pane', 'send-keys', p.pane_id, ...keys)
      await terms.log({ pane: p.pane_id, action: 'keys', text: b.keys.join(' '), ...who(req) })
    } else if (b.submit) {
      await herdr('pane', 'send-keys', p.pane_id, 'enter')
      await terms.log({ pane: p.pane_id, action: 'keys', text: 'Enter', ...who(req) })
    } else return send(res, 400, { error: 'text, keys or submit' })
    return send(res, 200, { ok: true })
  }
  send(res, 404, { error: 'not found' })
}

const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding + CSRF guard: this can type into agents running with bypassed permissions.
      if (!LOCAL.test(req.headers.host ?? '')) return send(res, 403, { error: 'bad host' })
      const origin = req.headers.origin
      if (origin && !LOCAL.test(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'bad origin' })

      const url = new URL(req.url, 'http://x')
      const parts = url.pathname.split('/').filter(Boolean)
      if (needsSession(req.method, url.pathname, req.headers) && !hasSession(req.headers.cookie)) {
        res.writeHead(403, { 'content-type': 'application/json', 'x-herdr-session': 'missing' })
        return res.end(JSON.stringify({ error: 'session expired — reload the dashboard' }))
      }
      if (url.pathname === '/api/health') return send(res, 200, await health())
      if (url.pathname === '/api/events') return streamEvents(req, res)
      if (url.pathname.startsWith('/api/notifications')) return await inboxApi(req, res, url)
      if (url.pathname === '/api/files' && req.method === 'GET') return serveFile(res, url)
      if (url.pathname.startsWith('/api/unfurl') && req.method === 'GET') {
        if (!hasSession(req.headers.cookie)) return send(res, 403, { error: 'session required' })
        return await (url.pathname === '/api/unfurl/image' ? unfurlImage(res, url) : unfurlApi(res, url)).catch((e) => send(res, 502, { error: e.message }))
      }
      if (parts[0] === 'api' && (parts[1] === 'rooms' || parts[1] === 'settings'))
        return await roomsApi(req, res, url, parts[1] === 'settings' ? ['api', 'settings'] : parts).catch((e) => send(res, e.status ?? 500, { error: e.message }))
      if (url.pathname === '/api/roles') return await rolesApi(req, res).catch((e) => send(res, e.status ?? 500, { error: e.message }))
      if (parts[0] === 'api' && parts[1] === 'memory') return await memoryApi(req, res, url, parts).catch((e) => send(res, e.status ?? 500, { error: e.message }))
      if (url.pathname === '/api/terminal-settings') return await terminalSettingsApi(req, res).catch((e) => send(res, e.status ?? 500, { error: e.message }))
      if (parts[0] === 'api' && parts[1] === 'terminals') return await terminalsApi(req, res, url, parts).catch((e) => send(res, e.status ?? 500, { error: e.message }))
      if (parts[0] === 'api' && parts[1] === 'config') return await configApi(req, res, parts).catch((e) => send(res, e.status ?? 500, { error: e.message }))
      if (url.pathname === '/api/overview') return send(res, 200, await overview())
      if (url.pathname === '/api/uploads' && req.method === 'POST') {
        const [code, out] = await saveUpload(req).catch((e) => [e.status ?? 500, { error: e.message }])
        return send(res, code, out)
      }
      if (parts[0] === 'api' && parts[1] === 'uploads' && req.method === 'GET') {
        const [day, file] = [parts[2], parts[3]]
        if (parts.length !== 4 || !UP_DAY.test(day) || !UP_FILE.test(file)) return send(res, 404, { error: 'not found' })
        const f = join(UPLOADS, day, file)
        if (!existsSync(f)) return send(res, 404, { error: 'not found' })
        res.writeHead(200, { 'content-type': EXT_MIME[extname(f).slice(1)], 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' })
        return res.end(await readFile(f))
      }
      if (url.pathname === '/api/usage' && req.method === 'GET') return send(res, 200, await usageApi())
      if (url.pathname === '/api/projects' && req.method === 'GET') return send(res, 200, await projectsApi())
      if (url.pathname === '/api/agents/spawn' && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'json only' })
        const [code, out] = await spawnAgent(JSON.parse((await body(req)) || '{}')).then((r) => [200, r], (e) => [e.status ?? 500, { error: e.message }])
        return send(res, code, out)
      }
      if (parts[0] === 'api' && parts[1] === 'tasks' && parts[3] === 'handoff' && parts.length === 4 && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'json only' })
        const b = JSON.parse((await body(req)) || '{}')
        const [code, out] = await handoffTask(decodeURIComponent(parts[2]), b.mode).then((r) => [200, r], (e) => [e.status ?? 500, { error: e.message }])
        return send(res, code, out)
      }
      if (parts[0] === 'api' && parts[1] === 'agents') {
        if (!parts[2]) return send(res, 200, await agents())
        // /api/agents/:machine/:pane[/stream]
        const m = await machineBy(decodeURIComponent(parts[2]))
        if (!m) return send(res, 404, { error: 'unknown machine' })
        const pane = decodeURIComponent(parts[3] ?? '')
        if (!PANE.test(pane) || pane.startsWith('-')) return send(res, 400, { error: 'bad pane' })
        if (parts[4] === 'stream' && req.method === 'GET') {
          if (!m.local) return send(res, 404, { error: 'no transcript for remote agents; use the pane read' })
          const a = (await agents()).find((x) => x.local && x.id === pane)
          return streamTranscript(req, res, a?.session, url)
        }
        // The live spinner line, for an open conversation: one visible-screen read per pane per second, shared.
        if (parts[4] === 'activity' && req.method === 'GET') {
          const text = await cached(`activity:${m.label}|${pane}`, 1000, () => herdrOn(m, 'pane', 'read', pane, '--source', 'visible')).catch(() => '')
          return send(res, 200, parseActivity(text))
        }
        if (parts[4] === 'answer' && req.method === 'POST') {
          if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'json only' })
          const a = (await agents()).find((x) => x.machine === m.label && x.id === pane)
          if (!a) return send(res, 404, { error: 'unknown agent' })
          const [code, out] = await answerQuestion(a, JSON.parse(await body(req))).catch((e) => [e.status ?? 500, { error: e.message }])
          store.delete('agents:local')
          store.delete('overview')
          return send(res, code, out)
        }
        // Stop = Escape, which interrupts Claude Code's current turn. Stale-checked on a fresh read:
        // never sent to an idle agent (Esc there would clear its input) or over a pending question.
        if (parts[4] === 'stop' && req.method === 'POST') {
          if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'json only' })
          store.delete('agents:local')
          if (!m.local) remote.get(m.label) && (remote.get(m.label).lastTry = 0)
          const a = (await agents()).find((x) => x.machine === m.label && x.id === pane)
          if (!a) return send(res, 404, { error: 'unknown agent' })
          if (a.asks) return send(res, 409, { error: 'a question is pending; use the question card' })
          if (a.status !== 'working') return send(res, 409, { error: `agent is ${a.status}, not working` })
          await herdrOn(m, 'agent', 'send-keys', pane, 'esc')
          store.delete('agents:local')
          store.delete('overview')
          return send(res, 200, { ok: true })
        }
        if (parts[4] === 'tags' && req.method === 'PATCH') {
          if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'json only' })
          const a = (await agents()).find((x) => x.machine === m.label && x.id === pane && x.local)
          if (!a) return send(res, 404, { error: 'unknown local agent' })
          const b = JSON.parse(await body(req))
          if (b.role && b.role !== 'other' && !roleStore.roles.some((r) => r.id === b.role)) return send(res, 400, { error: 'unknown role' })
          const next = { ...(roleStore.tags[a.name] ?? {}) }
          for (const k of ['role', 'ticket', 'branch', 'project']) if (k in b) next[k] = b[k]
          await roleStore.setTags(a.name, next)
          await syncTokens([{ ...a, paneTokens: a.paneTokens ?? {} }])
          store.delete('agents:local'); store.delete('overview')
          return send(res, 200, { tags: roleStore.tags[a.name] })
        }
        if (parts[4] === 'commands' && req.method === 'GET') {
          const a = (await agents()).find((x) => x.machine === m.label && x.id === pane)
          return send(res, 200, await commandsFor(a))
        }
        if (parts[4]) return send(res, 404, { error: 'not found' })
        // Remove = the wt-agents script's rm (closes the tab). Refuses a working agent unless forced;
        // an orchestrator needs its name typed back.
        if (req.method === 'DELETE') {
          if (!m.local) return send(res, 400, { error: 'removing remote agents is not supported yet' })
          const b = JSON.parse((await body(req)) || '{}')
          store.delete('agents:local')
          const a = (await agents()).find((x) => x.local && x.id === pane)
          if (!a) return send(res, 404, { error: 'unknown agent' })
          if (/orchestrator/i.test(a.name) && b.confirmName !== a.name) return send(res, 409, { error: 'type the orchestrator\'s name to remove it', needs: 'name' })
          if (a.status === 'working' && b.force !== true) return send(res, 409, { error: `${a.name} is working; a turn in flight dies with it`, needs: 'force' })
          const out = await run(AGENTS_SH, ['rm', pane, ...(b.force === true ? ['--force'] : [])], homedir(), 30_000)
          store.delete('agents:local'); store.delete('overview')
          return send(res, 200, { ok: true, message: out.trim() })
        }
        if (req.method === 'GET') {
          const lines = String(Math.min(2000, Number(url.searchParams.get('lines')) || 300))
          const raw = url.searchParams.get('visible') ? await herdrOn(m, 'agent', 'read', pane, '--source', 'visible', '--ansi') : await readPane(m, pane, lines)
          const text = stripAnsi(raw)
          return send(res, 200, { text, ...parsePane(text, raw) })
        }
        if (req.method === 'POST') {
          // JSON content-type forces a CORS preflight we never answer → no cross-site simple POSTs.
          if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'json only' })
          const { text, keys } = JSON.parse(await body(req))
          if (Array.isArray(keys)) {
            if (!keys.length || !keys.every((k) => typeof k === 'string' && KEY.test(k))) return send(res, 400, { error: 'bad keys' })
            await herdrOn(m, 'agent', 'send-keys', pane, ...keys)
          } else if (typeof text === 'string' && text.trim()) { recordSent(text); await herdrOn(m, 'agent', 'prompt', pane, text) }
          else return send(res, 400, { error: 'text or keys required' })
          store.delete('agents:local')
          if (!m.local) remote.get(m.label) && (remote.get(m.label).lastTry = 0)
          store.delete('overview')
          return send(res, 200, { ok: true })
        }
      }
      if (req.method === 'GET' && existsSync(DIST)) {
        const file = normalize(join(DIST, url.pathname === '/' ? 'index.html' : url.pathname))
        if (!file.startsWith(DIST)) return send(res, 403, { error: 'nope' })
        if (extname(file) && !existsSync(file)) return send(res, 404, { error: 'not found' })
        const target = extname(file) ? file : join(DIST, 'index.html')
        if (target.endsWith('index.html')) res.setHeader('set-cookie', SESSION_COOKIE)
        return send(res, 200, await readFile(target), MIME[extname(target)] ?? 'application/octet-stream')
      }
      send(res, 404, { error: 'not found' })
    } catch (e) {
      send(res, 500, { error: String(e.message ?? e) })
    }
  })
async function recordStart() {
  const f = join(DATA, 'server-starts.json')
  const prev = await readFile(f, 'utf8').then(JSON.parse, () => [])
  const { recent, warn } = restartBurst([...prev, Date.now()])
  await writeFile(f, JSON.stringify(recent))
  if (warn) inbox.add({ kind: 'server', key: `server|burst|${STARTED_AT}`, title: `Server restarted ${warn} times in 5 minutes`,
    body: MANAGED_BY === 'launchd' ? 'launchd restarts it after a crash (at most every 10s). Crashes: ~/Library/Logs/wt-dashboard/server.log' : MANAGED_BY === 'app' ? 'The app gives up after 3 automatic restarts in 5 minutes; if it stops again, use Start server in the menu-bar icon. Crashes: ~/Library/Logs/wt-dashboard/server.log' : 'Crashes: ~/Library/Logs/wt-dashboard/server.log', target: {} })
}
// The app spawns the server with stdio going nowhere, so a crash would leave no trace: write it to a log first.
const CRASH_LOG = join(homedir(), 'Library', 'Logs', 'wt-dashboard', 'server.log')
const crashed = (kind) => async (e) => {
  await mkdir(dirname(CRASH_LOG), { recursive: true }).then(() => appendFile(CRASH_LOG, `${new Date().toISOString()} pid ${process.pid} ${kind}: ${e?.stack ?? e}\n`)).catch(() => {})
  process.exit(1)
}
// Loopback only. Guarded so parse.test.mjs can import without listening.
// WT_DASHBOARD_SERVE=1: the desktop app's single-executable build, where argv/import.meta differ.
if (envOf('SERVE') === '1' || process.argv[1] === fileURLToPath(import.meta.url))
  Promise.all([cfg.load(), terms.load()]).catch((e) => console.error('config:', e.message)).finally(() => server.listen(PORT, '127.0.0.1', () => {
    console.log(`agent control room api → http://127.0.0.1:${PORT}`)
    // Background loops run only in a listening server (never when parse.test.mjs imports this module).
    process.on('uncaughtException', crashed('uncaughtException'))
    process.on('unhandledRejection', crashed('unhandledRejection'))
    setInterval(roomsLoop, 4000)
    setInterval(tick, 4000)
    setTimeout(tick, 500)
    recordStart().catch((e) => console.error('starts:', e.message))
    inbox.add({ kind: 'server', key: `server|start|${STARTED_AT}`, title: `Server started (${MANAGED_BY === 'app' ? 'app-managed' : MANAGED_BY})`, body: `pid ${process.pid}`, target: {}, quiet: true })
  }))
// Spawned by the desktop app: exit with it, however it quit (a macOS quit can skip the app's own kill).
if (envOf('APP') === '1') setInterval(() => process.ppid === 1 && process.exit(0), 2000).unref()

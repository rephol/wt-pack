// Agent control room: herdr panes + git worktrees + PRs + Linear, joined into tasks.
// ponytail: no deps, polling instead of websockets; switch to SSE if refresh feels laggy.
import http from 'node:http'
import { execFile } from 'node:child_process'
import { readFile, readdir, open as fopen, stat, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync, watch, realpathSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, extname, normalize, basename, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Rooms, ticketSuggestions } from './rooms.mjs'
import { Inbox, itemFromTransition, toResolve } from './inbox.mjs'

const PORT = Number(process.env.PORT ?? 7777)
const REPO = process.env.UMKMALL_REPO ?? join(homedir(), 'Work', 'projects', 'umkmall')
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
const run = (cmd, args, cwd, timeout = 20_000) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, maxBuffer: 32 << 20, timeout }, (err, out, stderr) =>
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
  const lastIsAssistant = out.at(-1)?.role === 'assistant'
  const endsWithQuestion = lastIsAssistant && /\?\s*$/.test(lastAssistant.text)
  const question = choicePrompt
    ? tail.split('\n').filter((l) => l.trim()).slice(-6).join('\n').trim()
    : endsWithQuestion
      ? lastAssistant.text.split('\n').filter((l) => l.trim()).at(-1).trim()
      : null

  return {
    picker: parsePicker(text, raw),
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
const poolOf = (name) => (/planner/i.test(name) ? 'planner' : /worker/i.test(name) ? 'worker' : /orchestrator/i.test(name) ? 'orchestrator' : 'other')
const GENERIC = /^(claude code|claude)?$/i

// ponytail: sequential + change-driven reads. Parallel reads every 3s flooded herdr's socket.
async function listAgents(m) {
  const { result } = JSON.parse(await herdrOn(m, 'agent', 'list'))
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
      pool: poolOf(name),
      status: a.agent_status,
      statusSince: since.get(k).at,
      cwd,
      // Remote: no git over SSH, so the cwd's basename stands in.
      project: m.local ? await projectOf(cwd) : cwd ? basename(cwd) : null,
      recap: p.recap ?? null,
      context: p.context ?? null,
      asks: Boolean(pk) || (p.asks ?? false),
      question: pk ? (pk.review ? 'Review and submit your answers' : `${pk.tabs[pk.current]?.header ? pk.tabs[pk.current].header + ': ' : ''}${pk.question}`) : p.question ?? null,
      picker: pk,
      lastPrompt: p.lastPrompt ?? null,
      session,
    })
  }
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
    return text.trim() ? [{ id: base, role: 'user', text, ts }] : []
  }
  if (!Array.isArray(c)) return []
  return c.flatMap((b, i) => {
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
    if (b.type === 'tool_use') return [{ id, role: 'tool', text: '', tool: { name: b.name, summary: toolSummary(b.input) }, ts }]
    if (b.type === 'tool_result') {
      const t = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n')
      const row = { id, role: 'tool', text: clip(t, 600), tool: { name: 'result', summary: clip(t.replace(/\s+/g, ' '), 120) }, ts }
      // Images a tool returned (e.g. Read of a PNG) surface as their own assistant row, not inside the collapsed group.
      const imgs = Array.isArray(b.content) ? b.content.filter((x) => x.type === 'image' && x.source?.type === 'base64') : []
      return imgs.length ? [row, ...imgs.map((x, k) => imageMsg(x, `${id}:img${k}`, 'assistant', ts))] : [row]
    }
    if (b.type === 'image' && b.source?.type === 'base64') return [imageMsg(b, id, e.type, ts)]
    return [] // thinking, etc.
  })
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
async function streamTranscript(req, res, session) {
  const file = session && (await findTranscript(session))
  if (!file) return send(res, 404, { error: 'no transcript for this agent' })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  const emit = (msgs) => msgs.length && res.write(`data: ${JSON.stringify(msgs)}\n\n`)
  res.write(`event: session\ndata: ${JSON.stringify(session)}\n\n`)
  // ponytail: backlog reads the whole file once; tail-read from the end if transcripts get huge.
  const all = await readFile(file, 'utf8')
  const nl = all.lastIndexOf('\n')
  let offset = Buffer.byteLength(all.slice(0, nl + 1)) // an unfinished last line is re-read on the next pull
  let partial = ''
  // Last 200 user/assistant turns; tool rows between them ride along uncounted.
  const asks = new Set()
  const backlog = foldQuestions(parseLines(all.slice(0, nl + 1), asks))
  let start = backlog.length
  for (let n = 0; start > 0 && n < 200; ) if (backlog[--start].role !== 'tool') n++
  emit(backlog.slice(start))

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
        emit(parseLines(text.slice(0, cut + 1), asks))
      }
    } catch {} finally { busy = false }
  }
  const w = watch(file, pull)
  const poll = setInterval(pull, 1000) // fs.watch on macOS can miss appends
  const beat = setInterval(() => res.write(': hb\n\n'), 15_000)
  req.on('close', () => (w.close(), clearInterval(poll), clearInterval(beat)))
}

// ---- git / gh / linear ----
const ticketOf = (s) => (s?.match(/umk-(\d+)/i) ? `UMK-${s.match(/umk-(\d+)/i)[1]}` : null)

// ---- spawn / remove agents: always through the wt-agents skill's script (naming, pools, trust seed) ----
const AGENTS_SH = join(homedir(), '.claude', 'skills', 'wt-agents', 'scripts', 'agents.sh')
// Project name → main checkout: the configured repo, $WT_DASHBOARD_PROJECTS (colon-separated repo paths),
// and every repo a local agent is working in.
async function projectRoots() {
  return cached('projectRoots', 30_000, async () => {
    const dirs = [REPO, ...(envOf('PROJECTS') ?? '').split(':').filter(Boolean), ...(await agents()).filter((a) => a.local && a.cwd).map((a) => a.cwd)]
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
  if (!['planner', 'worker'].includes(b.kind)) throw Object.assign(new Error('kind must be planner or worker'), { status: 400 })
  const root = (await projectRoots()).get(b.project)
  if (!root) throw Object.assign(new Error('unknown project'), { status: 400 })
  const args = ['spawn', b.kind]
  if (b.kind === 'worker') {
    // Never a free path: only one of this project's own worktrees.
    const wt = (await linkedWorktrees(root)).find((w) => w.path === b.cwd)
    if (!wt) throw Object.assign(new Error('cwd must be one of the project\'s worktrees'), { status: 400 })
    args.push(wt.path)
  }
  const out = await run(AGENTS_SH, args, root, 120_000)
  const [name, pane] = out.trim().split('\n').pop().split(' ')
  if (!name || !PANE.test(pane ?? '')) throw new Error(`unexpected agents.sh output: ${out.trim().slice(0, 200)}`)
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
          'number,title,headRefName,state,isDraft,baseRefName,mergedAt,updatedAt,url,reviewDecision,statusCheckRollup,mergeCommit'],
        REPO,
      ),
    )
    await git(REPO, 'fetch', '--quiet', 'origin', 'main').catch(() => {})
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
          mergedAt: p.mergedAt,
          updatedAt: p.updatedAt,
          shipped,
          ticket: ticketOf(p.headRefName),
        }
      }),
    )
  })
}

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
  }) { nodes { identifier title priority url updatedAt state { name } } }
}`
async function linear() {
  const key = process.env.LINEAR_API_KEY
  if (!key) return null
  return cached('linear', 60_000, async () => {
    const r = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: key },
      body: JSON.stringify({ query: LINEAR_Q }),
    })
    const j = await r.json()
    if (!r.ok || j.errors) throw new Error(`linear: ${JSON.stringify(j.errors ?? r.status)}`)
    return j.data.issues.nodes.map((i) => ({ ...i, state: i.state?.name }))
  })
}

// ---- task model ----
const inside = (cwd, dir) => cwd && (cwd === dir || cwd.startsWith(dir + '/'))

export function deriveTasks({ agents, worktrees, prs, issues }) {
  const now = Date.now()
  const ids = new Set([
    ...(issues ?? []).map((i) => i.identifier),
    ...worktrees.map((w) => w.ticket).filter(Boolean),
    ...prs.map((p) => p.ticket).filter(Boolean),
  ])
  const linked = new Set()
  const tasks = []
  for (const id of ids) {
    const issue = issues?.find((i) => i.identifier === id)
    const wt = worktrees.find((w) => w.ticket === id && w.path !== REPO)
    const pr = prs.filter((p) => p.ticket === id).sort((a, b) => (a.state === 'OPEN' ? -1 : b.state === 'OPEN' ? 1 : 0))[0]
    const ag = wt ? agents.filter((a) => a.local && inside(a.cwd, wt.path)) : []
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
      responder: (worker ?? planner) ? { key: (worker ?? planner).key, name: (worker ?? planner).name } : null,
      project: agent?.project ?? (issue ? PROJECT_BY_TEAM[id.split('-')[0]] ?? id.split('-')[0].toLowerCase() : REPO_PROJECT),
      question: asker?.question ?? null,
      branch: wt?.branch ?? pr?.branch ?? null,
      worktree: wt?.path ?? null,
      plan: wt?.plan ?? null,
      pr: pr ?? null,
      updatedAt: [issue?.updatedAt, pr?.updatedAt, agent && new Date(agent.statusSince).toISOString()]
        .filter(Boolean).sort().at(-1) ?? null,
      adHoc: false,
    })
  }
  for (const a of agents) {
    if (linked.has(a.key)) continue
    if (a.status === 'idle' && !a.asks) continue // idle with nothing to show
    const title = (a.recap ?? a.lastPrompt ?? a.name).slice(0, 120)
    tasks.push({
      id: `agent:${a.key}`,
      title,
      url: null,
      priority: null,
      linearState: null,
      state: a.asks && a.status !== 'working' ? 'needs_you' : a.status === 'done' ? 'done' : 'building',
      agent: { key: a.key, id: a.id, name: a.name, machine: a.machine },
      project: a.project,
      question: a.asks ? a.question : null,
      branch: null, worktree: null, plan: null, pr: null,
      updatedAt: new Date(a.statusSince).toISOString(),
      adHoc: true,
    })
  }
  return tasks
}

// Per-source health for /api/health: last success, last error. Filled by every overview.
const STARTED_AT = new Date().toISOString()
const SOURCES = Object.fromEntries(['herdr', 'git', 'gh', 'linear', 'machines'].map((k) => [k, { ok: null, lastOkAt: null, lastError: null }]))
const track = (name, p) => p.then(
  (v) => (Object.assign(SOURCES[name], { ok: true, lastOkAt: new Date().toISOString() }), v),
  (e) => { Object.assign(SOURCES[name], { ok: false, lastError: { at: new Date().toISOString(), message: String(e.message ?? e).slice(0, 300) } }); throw e })
async function health() {
  const dist = await stat(join(DIST, 'index.html')).catch(() => null)
  return {
    ok: true, app: 'wt-dashboard', runtime: RUNTIME, pid: process.pid, startedAt: STARTED_AT,
    managedBy: envOf('APP') === '1' ? 'app' : 'external',
    webBuiltAt: dist?.mtime.toISOString() ?? null,
    sources: { ...SOURCES, linear: { ...SOURCES.linear, enabled: Boolean(process.env.LINEAR_API_KEY) } },
  }
}

async function overview() {
  return cached('overview', 3000, async () => {
    const [ag, wt, pr, issues] = await Promise.all([
      track('herdr', agents()),
      track('git', worktrees()),
      track('gh', prs()).catch((e) => (console.error(e.message), [])),
      (process.env.LINEAR_API_KEY ? track('linear', linear()) : linear()).catch((e) => (console.error(e.message), [])),
    ])
    const tasks = [...deriveTasks({ agents: ag, worktrees: wt, prs: pr, issues }), ...(await rooms.needsTasks())]
    const taskOf = new Map(tasks.filter((t) => t.agent).map((t) => [t.agent.key, t.id]))
    const n = (s) => tasks.filter((t) => t.state === s).length
    return {
      at: new Date().toISOString(),
      linearEnabled: Boolean(process.env.LINEAR_API_KEY),
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
  needs: inbox.open().filter((it) => it.kind !== 'room-suggestion').map((it) => ({ key: it.target.agent ?? `room:${it.target.room}`, name: it.title, question: it.body })),
  working: lastSnap ? [...lastSnap.agents.values()].filter((a) => a.state === 'working').map((a) => ({ key: a.key, name: a.name })) : [],
})
const broadcastEvent = (event, data) => { for (const res of subs) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
inbox.subs.add((it) => broadcastEvent('notification', it))
async function tick() {
  try {
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
    const resolved = await inbox.resolve(toResolve(inbox.items, needs, new Set(sugg.map((x) => x.ticket))))
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
const EXTRA_HOSTS = (envOf('ALLOWED_HOSTS') ?? '')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
const LOCAL = {
  test: (h) =>
    /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h) || EXTRA_HOSTS.includes(h.toLowerCase().replace(/:443$/, '')),
}
const PANE = /^[\w.:-]+$/
const KEY = /^[\w+-]{1,20}$/
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }

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
      await userOnly()
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
    res.write(`event: backlog\ndata: ${JSON.stringify(await rooms.messages(slug))}\n\n`)
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
    return send(res, 200, await rooms.post(slug, { author, text: b.text, confirmAll: author.kind === 'user' && b.confirmAll === true, attachments: await roomAttachments(author, b) }))
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
      if (parts[0] === 'api' && (parts[1] === 'rooms' || parts[1] === 'settings'))
        return await roomsApi(req, res, url, parts[1] === 'settings' ? ['api', 'settings'] : parts).catch((e) => send(res, e.status ?? 500, { error: e.message }))
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
      if (url.pathname === '/api/projects' && req.method === 'GET') return send(res, 200, await projectsApi())
      if (url.pathname === '/api/agents/spawn' && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'json only' })
        const [code, out] = await spawnAgent(JSON.parse((await body(req)) || '{}')).then((r) => [200, r], (e) => [e.status ?? 500, { error: e.message }])
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
          return streamTranscript(req, res, a?.session)
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
          } else if (typeof text === 'string' && text.trim()) await herdrOn(m, 'agent', 'prompt', pane, text)
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
// Loopback only. Guarded so parse.test.mjs can import without listening.
// WT_DASHBOARD_SERVE=1: the desktop app's single-executable build, where argv/import.meta differ.
if (envOf('SERVE') === '1' || process.argv[1] === fileURLToPath(import.meta.url))
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`agent control room api → http://127.0.0.1:${PORT}`)
    // Background loops run only in a listening server (never when parse.test.mjs imports this module).
    setInterval(roomsLoop, 4000)
    setInterval(tick, 4000)
    setTimeout(tick, 500)
    inbox.add({ kind: 'server', key: `server|start|${STARTED_AT}`, title: `Server started (${envOf('APP') === '1' ? 'app-managed' : 'external'})`, body: `pid ${process.pid}`, target: {}, quiet: true })
  })
// Spawned by the desktop app: exit with it, however it quit (a macOS quit can skip the app's own kill).
if (envOf('APP') === '1') setInterval(() => process.ppid === 1 && process.exit(0), 2000).unref()

// Board Dispatch + reconcile (WP-52). Dispatch (per-board switch, default off) hands the top unassigned Ready ticket
// to a free agent through wt-handoff; reconcile (always on) moves a card to Done once its merge lands on origin/main,
// returns a dispatched card to Ready when its agent is gone, and flags an idle assignee. Not a routine: it keeps no
// routines row, but shares their cap and memory guard. The server injects every side effect, so tests need no herdr.
import { fileURLToPath } from 'node:url'
import { guard } from './routines.mjs'

// WP-122: the agent runs this pack's own handoff.sh, not a ~/.claude/skills link that a plugin install lacks.
const HANDOFF = fileURLToPath(new URL('../wt-handoff/scripts/handoff.sh', import.meta.url))

// Size L or the needs-plan label (set by hand or by Jev triage) → planner; anything else → worker.
export const roleFor = (t) => (t.size === 'L' || t.labels?.includes('needs-plan') ? 'planner' : 'worker')
const DAY = 86_400_000
const FETCH_MS = 5 * 60_000
const prio = (t) => t.priority || 5 // 1 urgent … 4 low; 0 (none) last

// Ticket numbers a merge subject names for board `key`: the merged branch's first number (`wp-33-35` → 33 only,
// ambiguous otherwise) and any explicit KEY-N.
export function mergeIds(subject, key) {
  const k = key.toLowerCase()
  const out = new Set()
  const b = subject.match(new RegExp(`^Merge branch '${k}-(\\d+)`, 'i'))
  if (b) out.add(`${key}-${Number(b[1])}`)
  for (const m of subject.matchAll(new RegExp(`\\b${key}-(\\d+)\\b`, 'g'))) out.add(`${key}-${Number(m[1])}`)
  return [...out]
}

// report (WP-75): { room, orch } from the board's 'Report to' — where the one-line result goes. A dispatched agent has
// no sender (handoff runs with HERDR_PANE_ID blank), so the orchestrator is named with its pane.
export function reportLine(report) {
  const parts = [
    report?.room && `post a one-line result in #${report.room} with \`room post ${report.room} "…"\``,
    report?.orch && `send a one-line result to ${report.orch.name} with \`${HANDOFF} --reply ${report.orch.pane} "…"\``,
  ].filter(Boolean)
  return parts.length ? `When done, ${parts.join(' and ')}.\n` : ''
}
// Settings → { room, orch }. reportRoom null = the room named after the project, '' = none, else that slug — only a
// live (not archived) room; the orchestrator must be LOCAL (a remote pane id means nothing on this machine).
export function resolveReport(project, { reportRoom = null, reportOrch = true } = {}, room = () => null, agents = []) {
  const slug = reportRoom === null ? project : reportRoom
  const r = slug ? room(slug) : null
  const o = reportOrch ? agents.find((x) => x.local && x.pool === 'orchestrator' && x.project === project) : null
  return { room: r && !r.archived ? r.slug : null, orch: o ? { name: o.name, pane: o.id } : null }
}
export function dispatchPrompt(t, role, report = null) {
  const line = reportLine(report)
  if (role === 'planner') return `Use wt-plan to plan ${t.id} (${t.title}) from the local board (\`wt-ticket show ${t.id}\`), then hand it off as wt-plan does.\n` + line
  const branch = `${t.id.toLowerCase()}-<short-slug>`
  return `Implement ${t.id} — ${t.title} (\`wt-ticket show ${t.id}\`).\n\n` +
    `Create a worktree on a new branch ${branch} from main, use wt-work, then wt-ship (review). ` +
    `Merge to main (no draft PR; merge commit "Merge branch '${branch}'") and push. ` +
    `Rebase on main and resolve conflicts; if you cannot, \`wt-ticket move ${t.id} blocked --note "<reason>"\`.\n` + line
}

// WP-128 model routing on a ticket's history: handoff.sh comments "routing: <tier> (<mode>, <source>, ref <run#i>)",
// wt-review comments "routing: send-back …", dispatch writes "routing: escalate opus". Returns (dispatch's own
// "returned: …" moves) and send-backs are strikes; two strikes escalate the ticket (live mode only).
export const routeRef = (t) => (t.history ?? []).map((h) => String(h.text ?? '').match(/^routing: .*\bref ([a-z0-9]+#\d+)/)?.[1]).filter(Boolean).pop() ?? null
export const strikes = (t) => (t.history ?? []).filter((h) => /^returned: /.test(h.text ?? '') || /^routing: send-back\b/.test(h.text ?? '')).length
export const escalated = (t) => (t.history ?? []).some((h) => /^routing: escalate /.test(h.text ?? ''))

// handoff.sh stdout: "created|reused …" first, then optional lines (e.g. WP-128 "routing: …"), a "target <name> <pane>"
// line and more. Find lines by prefix, never by position (WP-131: a routing line in 2nd place made the pane the name).
export function parseHandoff(out) {
  const lines = String(out).trim().split('\n')
  const f = (lines[0] ?? '').split(' ')
  const pane = f[0] === 'reused' ? f[1] : f[0] === 'created' ? f[2] : null
  if (!pane) throw new Error(`unparseable handoff output: ${(lines[0] ?? '').slice(0, 100)}`)
  const t = lines.find((l) => l.startsWith('target '))?.split(' ')
  return { pane, name: t && t[1] !== '?' ? t[1] : pane }
}

export class Dispatch {
  // deps: { agents(), host(), handoff(args, prompt, cwd) → stdout, repoOf(project) → path|null, git(repo, ...args) → stdout,
  //   reportOf(project) → { room: slug|null, orch: {name, pane}|null }, maxWorking(project) → n, baseBranch(project) → 'main' (WP-107), pending() → routine spawns in flight, ticketOf(agent) → ticket id|null,
  //   WP-128 (all optional): routeMode(project) → 'off'|'shadow'|'live', routeOutcome(ref, what, why), notify(inboxItem) }
  constructor({ tickets, deps, log = console.error }) {
    Object.assign(this, { tickets, deps, log, ticking: false, state: new Map(), gone: new Map(), fetched: new Map() })
  }
  get db() { return this.tickets.db }
  st(project) { return this.state.get(project) ?? this.state.set(project, { last: null, waiting: null }).get(project) }

  event(project, kind, ticket, text, now = Date.now()) {
    this.db.prepare('INSERT INTO board_events (project, at, kind, ticket, text) VALUES (?, ?, ?, ?, ?)').run(project, now, kind, ticket, text)
  }
  events(limit = 50) {
    return this.db.prepare('SELECT * FROM board_events ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, Number(limit) || 50)))
  }
  // Cards claimed but not yet handed off, across boards: they count against the shared cap.
  inflight(project) {
    const q = "SELECT count(*) n FROM tickets WHERE json_extract(json, '$.dispatch.state') = 'dispatching'"
    return (project ? this.db.prepare(q + ' AND project = ?').get(project) : this.db.prepare(q).get()).n
  }
  status(project) { const s = this.st(project); return { last: s.last, waiting: s.waiting, inflight: this.inflight(project) } }

  // Finish step 6 in one conditional write. handoff.sh's own wt-ticket move/assign fails from here (no pane: the
  // server rejects an empty x-herdr-pane), so the card is still unassigned; if that auth ever changes, this no-ops.
  // Only a card still claimed by us and unassigned moves.
  async #sent(id, role, agent, now = Date.now()) {
    let moved = false
    const t = await this.tickets.mutate(id, (t, at) => {
      if (t.dispatch?.state !== 'dispatching' || t.assignee) return t
      moved = true
      const to = role === 'planner' ? 'planning' : 'building'
      t.history.push({ at, author: 'dispatch', kind: 'move', from: t.column, to, text: `dispatched to ${agent.name}` })
      t.history.push({ at, author: 'dispatch', kind: 'assign', from: null, to: agent.name })
      Object.assign(t, { column: to, assignee: agent, dispatch: { state: 'sent', at, agent: agent.name } })
      return t
    })
    const project = await this.tickets.project(id)
    if (!moved) return this.log(`dispatch: ${id} changed during its handoff; left as is`)
    this.event(project, 'dispatch', id, `→ ${agent.name}`, now)
    this.st(project).last = { at: now, text: `${id} → ${agent.name}` }
    return t
  }

  // Startup: a card left 'dispatching' by a restart. An agent carrying its ticket token means the handoff landed.
  async recover() {
    const ids = this.db.prepare("SELECT id FROM tickets WHERE json_extract(json, '$.dispatch.state') = 'dispatching'").all().map((r) => r.id)
    if (!ids.length) return
    const ags = await this.deps.agents().catch(() => [])
    for (const id of ids) {
      const a = ags.find((x) => this.deps.ticketOf(x) === id)
      const t = await this.tickets.get(id)
      if (a) await this.#sent(id, roleFor(t), { name: a.name, pane: a.id })
      else await this.tickets.mutate(id, (t) => { if (t.dispatch?.state === 'dispatching') delete t.dispatch; return t })
    }
  }

  // One pass over every board. Re-entrancy: a tick in flight makes this a no-op (setInterval does not await).
  async tick(now = Date.now()) {
    if (this.ticking) return
    this.ticking = true
    try {
      this.db.prepare('DELETE FROM board_events WHERE at < ?').run(now - 30 * DAY) // ponytail: fixed 30d, as routines
      const ags = await this.deps.agents().catch((e) => (this.log(`dispatch: agents: ${e.message}`), null))
      for (const { project, key, dispatch } of this.db.prepare('SELECT project, key, dispatch FROM boards').all()) {
        await this.reconcile(project, key, ags, now).catch((e) => this.log(`reconcile ${project}: ${e.message}`))
        if (dispatch) await this.dispatchOne(project, ags, now).catch((e) => this.log(`dispatch ${project}: ${e.message}`))
        else this.st(project).waiting = null
      }
    } finally { this.ticking = false }
  }

  // Steps 1–7 of the plan: at most one dispatch per board per tick, so the next tick's cap check sees it.
  async dispatchOne(project, ags, now = Date.now()) {
    const s = this.st(project)
    const open = (await this.tickets.list(project, 'ready')).tickets
      .filter((t) => !t.assignee && (!t.dispatch || (t.dispatch.state === 'failed' && now - Date.parse(t.dispatch.at) > 120_000)))
    // Jev triage may still add needs-plan (roleFor): t.jev marks it done; fail-open after 60s, nothing to wait for when off.
    const triaging = this.deps.triageOn?.(project) ? (t) => !t.jev && now - Date.parse(t.created) < 60_000 : () => false
    const next = open.filter((t) => !triaging(t)).sort((a, b) => prio(a) - prio(b))[0] // stable: seq order within a priority
    if (!next) { s.waiting = open.length ? 'waiting for triage' : null; return }
    if (!ags) { s.waiting = 'agents unavailable'; return }
    const w = ags.filter((a) => a.status === 'working')
    const working = w.length
    const why = await guard({ working, pending: this.inflight() + (this.deps.pending?.(new Set(w.map((a) => a.id))) ?? 0), max: this.deps.maxWorking(project), host: this.deps.host })
    if (why) { s.waiting = why; return }
    const repo = await this.deps.repoOf(project)
    if (!repo) { s.waiting = `no checkout for ${project}`; return }
    s.waiting = null
    const claimed = await this.tickets.dispatchClaim(next.id, now)
    if (!claimed) return
    const role = roleFor(next)
    try {
      const out = await this.deps.handoff(['--role', role, '--kind', 'dispatch', '--from', 'wt-dashboard', '--task', `${next.id} ${next.title}`.slice(0, 80), repo], dispatchPrompt(next, role, (await this.deps.reportOf?.(project)) ?? null), repo)
      const { name, pane } = parseHandoff(out)
      this.log(`dispatch ${next.id} → ${name} ${pane}`)
      try { await this.#sent(next.id, role, { name, pane }, now) } catch (e) {
        // WP-131: the work was already sent; never re-dispatch it. Hold for a human.
        await this.tickets.mutate(next.id, (t, at) => {
          t.dispatch = { state: 'held', at, fails: 3, reason: `sent to ${name} but not recorded: ${String(e?.message ?? e).slice(0, 120)}` }
          return t
        })
        throw e
      }
    } catch (e) {
      const reason = String(e?.message ?? e).split('\n')[0].slice(0, 200)
      const fails = (claimed.dispatch.fails ?? 0) + 1
      const state = fails >= 3 ? 'held' : 'failed'
      await this.tickets.mutate(next.id, (t, at) => {
        if (t.dispatch?.state !== 'dispatching') return t
        t.dispatch = { state, at, fails, reason }
        t.history.push({ at, author: 'dispatch', kind: 'comment', text: `dispatch failed${state === 'held' ? ' (3rd time: held until Retry dispatch)' : ''}: ${reason}` })
        return t
      })
      this.event(project, 'fail', next.id, reason, now)
      s.last = { at: now, text: `${next.id} failed: ${reason}` }
    }
  }

  // Merge → done, gone assignee → ready, idle assignee → flagged. Touches only what it can prove.
  async reconcile(project, key, ags, now = Date.now()) {
    const { tickets: cards, stallMin } = await this.tickets.list(project)
    await this.#merged(project, key, cards, now)
    await this.#escalate(project, cards).catch((e) => this.log(`routing escalation ${project}: ${e.message}`))
    // herdr down (or no local agents at all) is not "every agent is gone".
    const local = ags?.filter((a) => a.local) ?? []
    if (!local.length) return
    for (const t of cards) {
      if (!t.assignee?.name || t.column === 'done') continue
      const a = local.find((x) => x.name === t.assignee.name)
      const g = `${t.id}|${t.assignee.name}`
      // WP-140: any open card an agent (not a human — those assignees have no pane) still holds when it's
      // gone unassigns; Planning/Building also return to Ready since nobody is working them and Dispatch
      // skips assigned cards (a Ready/Review/Blocked card just loses its stale assignee).
      if (!a && t.assignee.pane) {
        const n = (this.gone.get(g) ?? 0) + 1
        this.gone.set(g, n)
        if (n < 2) continue // one miss may be a herdr blip
        this.gone.delete(g)
        const name = t.assignee.name
        await this.tickets.dropAssignee(t.id, name, 'dispatch', `returned: ${name} is gone`)
        this.event(project, 'returned', t.id, `${name} is gone`, now)
        const ref = routeRef(t)
        if (ref) try { this.deps.routeOutcome?.(ref, 'returned', `${name} is gone`) } catch {}
        continue
      }
      this.gone.delete(g)
      if (!a || t.column !== 'building') continue
      const idleMin = (now - Number(new Date(a.lastActivity ?? a.statusSince ?? now))) / 60_000
      const stalled = (a.status === 'idle' || a.status === 'done') && idleMin > stallMin
      if (stalled && !t.dispatch?.stalled) {
        const text = `${a.name} idle ${Math.round(idleMin)}m`
        await this.tickets.mutate(t.id, (t, at) => {
          t.dispatch = { ...t.dispatch, stalled: text }
          t.history.push({ at, author: 'dispatch', kind: 'comment', text: `stalled: ${text}` })
          return t
        })
        this.event(project, 'stalled', t.id, text, now)
      } else if (!stalled && t.dispatch?.stalled) {
        await this.tickets.mutate(t.id, (t) => { delete t.dispatch.stalled; if (!Object.keys(t.dispatch).length) delete t.dispatch; return t })
      }
    }
  }

  // Merge commits on origin/<baseBranch> since the last scan (7 days on the first); fetch at most every 5 min per repo.
  // Two strikes (returns or review send-backs) → the next handoff of this ticket runs on opus. Live routing only.
  async #escalate(project, cards) {
    const due = cards.filter((t) => t.column !== 'done' && strikes(t) >= 2 && !escalated(t))
    if (!due.length || (await this.deps.routeMode?.(project)) !== 'live') return
    for (const t of due) {
      await this.tickets.comment(t.id, 'routing: escalate opus (two returns or review send-backs)', { name: 'dispatch' })
      const ref = routeRef(t)
      if (ref) try { this.deps.routeOutcome?.(ref, 'escalated', `${strikes(t)} strikes`) } catch {}
      await this.deps.notify?.({ kind: 'routing-escalation', key: `routing|${t.id}`, title: `${t.id} escalated to opus`,
        body: 'Returned or sent back twice; its next handoff runs on opus (model routing, live).', target: { ticket: t.id, project } })
    }
  }

  async #merged(project, key, cards, now) {
    if (!cards.some((t) => t.column === 'building' || t.column === 'review')) return
    const repo = await this.deps.repoOf(project)
    if (!repo) return
    if (now - (this.fetched.get(repo) ?? 0) > FETCH_MS) {
      this.fetched.set(repo, now)
      await this.deps.git(repo, 'fetch', '-q', 'origin').catch((e) => this.log(`reconcile fetch ${project}: ${e.message}`))
    }
    const k = `reconcile:${project}`
    const last = this.db.prepare('SELECT v FROM routine_settings WHERE k = ?').get(k)?.v
    const log = (range) => this.deps.git(repo, 'log', '--merges', '--first-parent', '--since=7.days', '--format=%H%x09%ct%x09%s', range)
    const base = `origin/${this.deps.baseBranch?.(project) ?? 'main'}`
    const out = await (last ? log(`${last}..${base}`).catch(() => log(base)) : log(base))
    const lines = out.split('\n').filter(Boolean).map((l) => l.split('\t'))
    const head = (await this.deps.git(repo, 'rev-parse', base)).trim()
    for (const [sha, ct, subject = ''] of lines.reverse()) for (const id of mergeIds(subject, key)) {
      const t = cards.find((c) => c.id === id)
      if (!t || (t.column !== 'building' && t.column !== 'review')) continue
      // A merge older than the card's latest move is an earlier round (a reopened card), not this one.
      const moved = t.history?.findLast((h) => h.kind === 'move')?.at
      if (moved && Number(ct) * 1000 < Date.parse(moved)) continue
      await this.tickets.patch(id, { column: 'done', note: `merged in ${sha.slice(0, 7)}` }, { name: 'dispatch' })
      const ref = routeRef(t)
      if (ref && !strikes(t)) try { this.deps.routeOutcome?.(ref, 'ok', `merged in ${sha.slice(0, 7)}`) } catch {}
      t.column = 'done'
      this.event(project, 'done', id, `merged in ${sha.slice(0, 7)}`, now)
    }
    this.db.prepare('INSERT INTO routine_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, head)
  }
}

// wt-handoff from the server: prompt on stdin, 120 s cap, and HERDR_PANE_ID blanked so a service started from a pane
// does not pose as that pane (sender tokens, wt-ticket auth).
export const runHandoff = (execFile, bin) => (args, prompt, cwd) => new Promise((resolve, reject) => {
  const child = execFile(bin, args, { cwd, maxBuffer: 1 << 20, timeout: 120_000, env: { ...process.env, HERDR_PANE_ID: '' } },
    (err, o, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(o))
  child.stdin.end(prompt)
})

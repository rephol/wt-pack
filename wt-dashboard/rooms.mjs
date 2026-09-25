// Chat rooms shared by the user and agents. Append-only JSONL per room + a rooms.json index + settings.json,
// all under the data root (~/.local/share/wt-dashboard/data). Pure delivery rules (mentions, @all, agent→agent, hops, rate limit) are exported
// for parse.test.mjs; the Rooms class does I/O and the per-agent delivery queue.
import { readFile, writeFile, appendFile, mkdir, rm, rename, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_SETTINGS = {
  agentToAgent: false, // agents may @mention other agents (delivered)
  maxHops: 3, // agent→agent deliveries in a row before a human must reply
  ticketRooms: 'suggest', // 'off' | 'suggest' | 'auto' — rooms #umk-NNNN per ticket
  dismissedTickets: [], // suggestions the user dismissed
  profile: { name: 'user', handle: 'user', avatar: null }, // how agents address the human (@handle)
  rateCount: 6, // agent posts…
  rateWindowMin: 10, // …per this many minutes
}

// @name tokens that name a known agent (exact, case-insensitive), plus the special `all`.
export function parseMentions(text, names) {
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]))
  const out = new Set()
  for (const m of text.matchAll(/(^|[^\w@])@([\w./:-]+)/g)) {
    const raw = m[2].replace(/[.:,;!?)]+$/, '')
    const t = raw.toLowerCase()
    if (t === 'all') out.add('all')
    else if (byLower.has(t)) out.add(byLower.get(t))
  }
  return [...out]
}

// Who a new message goes to, and why the rest don't. `agents`: [{key, name}]. Mutates nothing.
export function planDelivery({ msg, room, settings, agents, confirmAll = false }) {
  const handle = settings.profile?.handle?.toLowerCase()
  const byName = new Map(agents.map((a) => [a.name, a]))
  const fromAgent = msg.author.kind === 'agent'
  const deliver = []
  const blocked = []
  let hops = fromAgent ? room.hops ?? 0 : 0 // any user message resets the chain
  let pauseNote = null
  if (room.paused) return { deliver, blocked: msg.mentions.filter((n) => n.toLowerCase() !== handle).map((n) => ({ name: n, reason: 'room paused' })), hops, pauseNote, route: 'paused', broadcast: false }
  let targets = msg.mentions.filter((n) => n !== 'all' && n.toLowerCase() !== handle)
  let route = targets.length || msg.mentions.includes('all') ? 'mention' : 'none'
  let broadcast = false
  // A user message that names nobody: every agent member if the room broadcasts, else the responder, else nobody.
  if (!fromAgent && route === 'none') {
    if (room.broadcast) {
      targets = (room.members ?? []).filter((n) => byName.has(n))
      route = targets.length ? 'broadcast' : 'none'
      broadcast = true
    } else if (room.responder) {
      const r = agents.find((a) => a.key === room.responder)
      if (r) { targets = [r.name]; route = 'responder' } else blocked.push({ name: room.responder, reason: 'responder is not running' })
    }
  }
  if (msg.mentions.includes('all')) {
    if (fromAgent) blocked.push({ name: 'all', reason: 'agents cannot @all' })
    else if (!confirmAll) blocked.push({ name: 'all', reason: '@all needs confirmation' })
    else targets = [...new Set([...targets, ...(room.members ?? [])])]
  }
  for (const name of targets) {
    const a = byName.get(name)
    if (!a) { blocked.push({ name, reason: 'unknown agent' }); continue }
    if (fromAgent && a.name === msg.author.name) continue // never to yourself
    if (fromAgent && !settings.agentToAgent) { blocked.push({ name, reason: 'not delivered — agent-to-agent is off' }); continue }
    if (fromAgent && hops >= settings.maxHops) {
      blocked.push({ name, reason: 'hop limit reached' })
      pauseNote = 'paused: waiting for a human'
      continue
    }
    deliver.push(a.key)
  }
  if (fromAgent && deliver.length) hops++
  return { deliver, blocked, hops, pauseNote, route, broadcast }
}

// What the message view says per @mention: agents it was queued for, and whether it notified the user.
// The user's own handle is never a delivery target — an agent naming it creates a needs-you item instead.
export function mentionStatus(msg, plan, agents, handle) {
  const h = handle.toLowerCase()
  return {
    queuedFor: plan.deliver.map((k) => agents.find((a) => a.key === k)?.name).filter(Boolean),
    notified: msg.author.kind === 'agent' && msg.mentions.some((m) => m.toLowerCase() === h),
  }
}

// Sliding-window rate limit for agent posts. `times`: earlier post timestamps (ms) for that agent.
export function rateOk(times, now, settings) {
  const win = settings.rateWindowMin * 60_000
  return times.filter((t) => now - t < win).length < settings.rateCount
}

// A user message whose text (minus @mentions) starts with "/" is a command for exactly ONE agent:
// the single @mentioned agent, else the responder. Never broadcast; agents cannot send commands.
// Returns null (not a command), {error}, or {text, target}.
export const ONE_TARGET = 'A command goes to one agent: @mention it or set a responder'
export function parseCommand(msg, room, agents, handle) {
  if (msg.author.kind !== 'user') return null
  const h = handle.toLowerCase()
  const known = new Set([...agents.map((a) => a.name.toLowerCase()), 'all', h])
  const text = msg.text.replace(/(^|\s)@([\w./:-]+)/g, (m, sp, n) => (known.has(n.replace(/[.:,;!?)]+$/, '').toLowerCase()) ? sp : m)).trim()
  if (!text.startsWith('/')) return null
  const named = msg.mentions.filter((n) => n !== 'all' && n.toLowerCase() !== h)
  if (msg.mentions.includes('all') || named.length > 1) return { error: ONE_TARGET }
  const target = named.length ? agents.find((a) => a.name === named[0]) : agents.find((a) => a.key === room.responder)
  return target ? { text, target } : { error: ONE_TARGET }
}
// Image paths ride after the text, one per line — for a local agent only; a remote one cannot open them.
export function withAttachments(text, atts, local) {
  const n = atts?.length ?? 0
  if (!n) return text
  return local ? [text, ...atts.map((a) => a.path)].join('\n') : `${text}\n(${n} image${n === 1 ? '' : 's'} not delivered — remote agent)`
}

// One prompt per agent per flush, whatever is queued for it across rooms.
export const BROADCAST_NOTE = "Reply only if this is addressed to you or concerns your work; otherwise do nothing (don't post)."
export function batchPrompt(slug, msgs, broadcast = false, local = true) {
  const lines = msgs.map((m) => withAttachments(`${m.author.name}: ${m.text}`, m.attachments, local))
  return `[room #${slug}] ${msgs.length} new message${msgs.length === 1 ? '' : 's'}:\n${lines.join('\n')}\n` +
    (broadcast ? `${BROADCAST_NOTE}\n` : '') +
    `Reply with: ~/.claude/skills/wt-room/scripts/room post ${slug} "…" (mention @name to address someone)`
}

// An agent may be prompted only between turns, never while it asks something.
export const deliverable = (a) => a && (a.status === 'idle' || a.status === 'done') && !a.asks

// ---- ticket rooms ----
const TICKET = /^[A-Z]+-\d+$/
export const ticketSlug = (id) => id.toLowerCase()
const active = (t) => TICKET.test(t.id) && !t.adHoc && (t.worktree || t.pr || t.agent) && !['shipped', 'merged'].includes(t.state)
const who = (t) => t.agent?.name ?? 'someone'
// What is already known about a ticket, as system posts (the back-fill when its room is created).
export function ticketFacts(t) {
  const out = []
  if (t.worktree) out.push(`worktree ${t.branch ?? t.worktree}`)
  if (t.plan) out.push('plan committed')
  if (t.state === 'building') out.push(`worker started: ${who(t)}`)
  if (t.pr) out.push(`PR #${t.pr.number} ${t.pr.state === 'OPEN' ? 'opened' : t.pr.state.toLowerCase()}: ${t.pr.url ?? ''}`.trim())
  if (t.pr?.ci === 'fail') out.push(`CI failed on PR #${t.pr.number}`)
  if (t.state === 'needs_you') out.push(`needs you: ${who(t)} asks "${t.question ?? ''}"`)
  return out
}
// Transitions between two task snapshots of one ticket, as system posts.
export function ticketEvents(prev, t) {
  if (!prev) return []
  const out = []
  if (t.plan && !prev.plan) out.push('plan committed')
  if (t.state === 'building' && prev.state !== 'building') out.push(`worker started: ${who(t)}`)
  if (t.pr?.state === 'OPEN' && prev.pr?.state !== 'OPEN') out.push(`PR #${t.pr.number} opened: ${t.pr.url ?? ''}`.trim())
  if (t.pr?.ci === 'fail' && prev.pr?.ci !== 'fail') out.push(`CI failed on PR #${t.pr.number}`)
  if (t.state === 'needs_you' && prev.state !== 'needs_you') out.push(`needs you: ${who(t)} asks "${t.question ?? ''}"`)
  return out
}
// Tickets with activity and no room, that the user has not dismissed. Only in 'suggest' mode.
export function ticketSuggestions(tasks, roomSlugs, settings) {
  if (settings.ticketRooms !== 'suggest') return []
  const have = new Set(roomSlugs)
  const dismissed = new Set(settings.dismissedTickets)
  return tasks.filter((t) => active(t) && !have.has(ticketSlug(t.id)) && !dismissed.has(t.id)).map((t) => ({
    ticket: t.id, slug: ticketSlug(t.id), title: t.title, agent: t.agent?.name ?? null,
    reason: t.agent ? `${t.agent.name} is ${t.state.replace('_', ' ')}` : t.pr ? `PR #${t.pr.number} is open` : 'a worktree exists',
  }))
}

// An agent @mentioning the user marks the room as needing them (one entry per agent, latest text);
// any message from the user clears it.
export function nextNeedsYou(current, msg, handle) {
  if (msg.author.kind === 'user') return []
  if (msg.author.kind !== 'agent' || !msg.mentions.some((m) => m.toLowerCase() === handle.toLowerCase())) return current
  return [...current.filter((n) => n.agent !== msg.author.name), { agent: msg.author.name, text: msg.text.slice(0, 300), ts: msg.ts, id: msg.id }]
}

// Write-then-rename, so a crash mid-write never leaves a truncated index or settings file.
export async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}
// Every rooms/<slug>.jsonl keeps an index entry: a room whose file exists is re-added (never dropped).
export function reconcileIndex(index, files) {
  const have = new Set(index.map((r) => r.slug))
  const recovered = files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).filter((slug) => !have.has(slug))
  return [...index, ...recovered.map((slug) => ({ slug, title: slug, project: null, createdAt: new Date(0).toISOString(), paused: false, members: [], hops: 0, recovered: true }))]
}

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'room'

export class Rooms {
  constructor({ dir, agents, prompt, log = console.error }) {
    Object.assign(this, { dir, agentsFn: agents, promptFn: prompt, log })
    this.index = null // [{slug,title,project,createdAt,paused,members,hops}]
    this.settings = null
    this.msgs = new Map() // slug -> [message] (folded: deliveredTo filled in)
    this.subs = new Map() // slug -> Set(res)
    this.queue = new Map() // agentKey -> [{slug, msg, broadcast, command}]
    this.running = new Map() // agentKey -> {slug, cmd, at, seenWorking}: a room command in flight
    this.posts = new Map() // agentKey -> [ts] (rate limit)
    this.lock = Promise.resolve()
  }
  async load() {
    if (this.index) return
    await mkdir(join(this.dir, 'rooms'), { recursive: true })
    const raw = await readFile(join(this.dir, 'rooms.json'), 'utf8').catch(() => null)
    let index = []
    try { index = raw ? JSON.parse(raw) : [] } catch (e) {
      // A broken index is set aside, never overwritten blind; rooms are rebuilt from their files below.
      this.log(`rooms.json unreadable (${e.message}); kept as rooms.json.corrupt-${Date.now()}`)
      await rename(join(this.dir, 'rooms.json'), join(this.dir, `rooms.json.corrupt-${Date.now()}`)).catch(() => {})
    }
    this.index = reconcileIndex(index, await readdir(join(this.dir, 'rooms')).catch(() => []))
    if (this.index.length !== index.length) await this.saveIndex()
    this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse((await readFile(join(this.dir, 'settings.json'), 'utf8').catch(() => '{}'))) }
  }
  saveIndex() { return atomicWrite(join(this.dir, 'rooms.json'), JSON.stringify(this.index, null, 2)) }
  async setSettings(patch) {
    await this.load()
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS) || typeof v !== typeof DEFAULT_SETTINGS[k]) throw Object.assign(new Error(`bad setting ${k}`), { status: 400 })
      if (k === 'ticketRooms' && !['off', 'suggest', 'auto'].includes(v)) throw Object.assign(new Error('ticketRooms: off | suggest | auto'), { status: 400 })
      if (k === 'profile') {
        if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 40) throw Object.assign(new Error('profile.name: 1–40 chars'), { status: 400 })
        if (!/^[a-z0-9_-]{1,32}$/i.test(v.handle ?? '')) throw Object.assign(new Error('profile.handle: letters, digits, _ or -'), { status: 400 })
        if (v.avatar != null && !/^\/api\/uploads\/\d{4}-\d{2}-\d{2}\/[\w.-]+$/.test(v.avatar)) throw Object.assign(new Error('profile.avatar: an /api/uploads URL'), { status: 400 })
        patch.profile = { name: v.name.trim(), handle: v.handle, avatar: v.avatar ?? null }
      }
      if (k === 'dismissedTickets' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw Object.assign(new Error('dismissedTickets: string[]'), { status: 400 })
      if (typeof v === 'number' && !(Number.isInteger(v) && v >= 0 && v <= 1000)) throw Object.assign(new Error(`bad value for ${k}`), { status: 400 })
    }
    Object.assign(this.settings, patch)
    await atomicWrite(join(this.dir, 'settings.json'), JSON.stringify(this.settings, null, 2))
    return this.settings
  }
  room(slug) { return this.index.find((r) => r.slug === slug) }
  async list() { await this.load(); return this.index }
  async create({ title, project = null, slug, responder = null }) {
    await this.load()
    let s = slugify(slug ?? title)
    if (this.room(s)) { if (slug) return this.room(s); s = `${s}-${Date.now().toString(36)}` }
    const r = { slug: s, title: String(title).slice(0, 120), project, createdAt: new Date().toISOString(), paused: false, members: [], hops: 0, responder: null, broadcast: false }
    this.index.push(r)
    await this.saveIndex()
    return responder ? this.update(s, { responder }) : r
  }
  async update(slug, { paused, members, title, archived, responder, broadcast }, agentList = null) {
    await this.load()
    const r = this.room(slug)
    if (!r) return null
    if (typeof paused === 'boolean') r.paused = paused
    if (typeof archived === 'boolean') r.archived = archived
    if (typeof broadcast === 'boolean') r.broadcast = broadcast
    if (responder !== undefined) {
      // Set by the user: pinned (ticket sync stops moving it). null clears it and unpins.
      const a = responder && (agentList ?? (await this.agentsFn())).find((x) => x.key === responder)
      if (responder && !a) throw Object.assign(new Error('unknown agent'), { status: 400 })
      r.responder = a ? a.key : null
      r.responderName = a ? a.name : null
      r.responderPinned = Boolean(a)
      if (a && !r.members.includes(a.name)) r.members = [...r.members, a.name]
    }
    if (Array.isArray(members)) r.members = members.filter((m) => typeof m === 'string').slice(0, 50)
    if (typeof title === 'string' && title.trim()) r.title = title.slice(0, 120)
    await this.saveIndex()
    return r
  }
  async messages(slug) {
    await this.load()
    if (!this.msgs.has(slug)) {
      const lines = (await readFile(join(this.dir, 'rooms', `${slug}.jsonl`), 'utf8').catch(() => '')).split('\n').filter(Boolean)
      const out = [], byId = new Map()
      for (const l of lines) {
        try {
          const e = JSON.parse(l)
          if (e.type === 'delivered') {
            const m = byId.get(e.id)
            m?.deliveredTo.push(e.to)
            if (m && e.dropped) m.undelivered = [...(m.undelivered ?? []), { to: e.to, n: e.dropped }]
          }
          else { out.push(e); byId.set(e.id, e) }
        } catch { /* torn line */ }
      }
      this.msgs.set(slug, out)
    }
    return this.msgs.get(slug)
  }
  async append(slug, rec) {
    await appendFile(join(this.dir, 'rooms', `${slug}.jsonl`), JSON.stringify(rec) + '\n')
  }
  emit(slug, event, data) {
    for (const res of this.subs.get(slug) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // Post a message. author: {kind, name, machine?, pane?, key?}. Returns the stored message.
  async post(slug, { author, text, confirmAll = false, attachments = [] }) {
    await this.load()
    const room = this.room(slug)
    if (!room) throw Object.assign(new Error('unknown room'), { status: 404 })
    if (room.archived) throw Object.assign(new Error('room is archived (read-only)'), { status: 409 })
    text = String(text ?? '').trim().slice(0, 8000)
    if (!text) throw Object.assign(new Error('empty message'), { status: 400 })
    const now = Date.now()
    if (author.kind === 'agent') {
      const times = this.posts.get(author.key) ?? []
      if (!rateOk(times, now, this.settings))
        throw Object.assign(new Error(`rate limit: at most ${this.settings.rateCount} posts per ${this.settings.rateWindowMin} min`), { status: 429 })
      this.posts.set(author.key, [...times.filter((t) => now - t < this.settings.rateWindowMin * 60_000), now])
    }
    const agents = (await this.agentsFn()).filter((a) => a.name)
    const msg = { id: randomUUID(), ts: new Date(now).toISOString(), author, text, mentions: parseMentions(text, [...agents.map((a) => a.name), this.settings.profile.handle]), deliveredTo: [] }
    if (attachments.length) msg.attachments = attachments
    const cmd = parseCommand(msg, room, agents, this.settings.profile.handle)
    if (cmd?.error) throw Object.assign(new Error(cmd.error), { status: 400 })
    if (cmd) msg.command = { text: cmd.text, target: cmd.target.name }
    const plan = cmd
      ? room.paused
        ? { deliver: [], blocked: [{ name: cmd.target.name, reason: 'room paused' }], hops: 0, route: 'paused', broadcast: false }
        : { deliver: [cmd.target.key], blocked: [], hops: 0, route: 'command', broadcast: false }
      : planDelivery({ msg, room, settings: this.settings, agents, confirmAll })
    msg.blocked = plan.blocked
    msg.route = plan.route
    Object.assign(msg, mentionStatus(msg, plan, agents, this.settings.profile.handle))
    room.hops = plan.hops
    room.needsYou = nextNeedsYou(room.needsYou ?? [], msg, this.settings.profile.handle)
    // Everyone who speaks or is addressed becomes a member.
    const mem = new Set(room.members)
    if (author.kind === 'agent') mem.add(author.name)
    for (const k of plan.deliver) mem.add(agents.find((a) => a.key === k)?.name)
    room.members = [...mem].filter(Boolean)
    await this.saveIndex()
    await this.add(slug, msg)
    for (const key of plan.deliver) {
      const q = this.queue.get(key) ?? []
      q.push({ slug, msg, broadcast: plan.broadcast, command: Boolean(cmd) })
      this.queue.set(key, q)
    }
    if (plan.pauseNote) await this.system(slug, plan.pauseNote)
    return msg
  }
  async add(slug, msg) {
    (await this.messages(slug)).push(msg)
    await this.append(slug, msg)
    this.emit(slug, 'message', msg)
  }
  system(slug, text, extra = {}) {
    return this.add(slug, { id: randomUUID(), ts: new Date().toISOString(), author: { kind: 'system', name: 'system' }, text, mentions: [], deliveredTo: [], ...extra })
  }
  async markDelivered(slug, m, a) {
    const dropped = !a.local && m.attachments?.length ? m.attachments.length : 0
    m.deliveredTo.push(a.name)
    if (dropped) m.undelivered = [...(m.undelivered ?? []), { to: a.name, n: dropped }]
    await this.append(slug, { type: 'delivered', id: m.id, to: a.name, ts: new Date().toISOString(), ...(dropped ? { dropped } : {}) })
    this.emit(slug, 'delivered', { id: m.id, to: a.name, dropped })
  }
  // A command run from a room: "finished" once its agent is between turns again (seen working, or 30s on).
  async watchCommands(agents) {
    for (const [key, r] of this.running) {
      const a = agents.find((x) => x.key === key)
      if (!a) { this.running.delete(key); continue }
      if (a.status === 'working') r.seenWorking = true
      else if (deliverable(a) && (r.seenWorking || Date.now() - r.at > 30_000)) {
        this.running.delete(key)
        if (this.room(r.slug)) await this.system(r.slug, `finished ${r.cmd} on ${a.name}`, { agentKey: a.key })
      }
    }
  }
  // Deliver queued messages to agents that are between turns: one prompt per agent per flush. A command
  // goes alone and RAW (its own text is the prompt); plain messages are batched per room.
  async flush() {
    if (!this.queue.size && !this.running.size) return
    const agents = await this.agentsFn()
    await this.watchCommands(agents)
    for (const [key, items] of this.queue) {
      const a = agents.find((x) => x.key === key)
      if (!a) { this.queue.delete(key); continue }
      if (!deliverable(a) || this.running.has(key)) continue
      const n = items[0].command ? 1 : Math.max(1, items.findIndex((it) => it.command) === -1 ? items.length : items.findIndex((it) => it.command))
      const take = items.slice(0, n)
      const rest = items.slice(n)
      if (rest.length) this.queue.set(key, rest); else this.queue.delete(key)
      const requeue = (its) => this.queue.set(key, [...its, ...(this.queue.get(key) ?? [])])
      if (take[0].command) {
        const { slug, msg } = take[0]
        const room = this.room(slug)
        if (!room || room.archived) continue
        if (room.paused) { requeue(take); continue }
        try {
          await this.promptFn(a, withAttachments(msg.command.text, msg.attachments, a.local))
          await this.markDelivered(slug, msg, a)
          this.running.set(key, { slug, cmd: msg.command.text.split(/\s/)[0], at: Date.now(), seenWorking: false })
          await this.system(slug, `ran ${msg.command.text} on ${a.name}`, { agentKey: a.key })
        } catch (e) {
          this.log(`room command to ${a.name} failed: ${e.message}`)
          requeue(take)
        }
        continue
      }
      const bySlug = new Map()
      for (const it of take) bySlug.set(it.slug, [...(bySlug.get(it.slug) ?? []), it])
      for (const [slug, its] of bySlug) {
        const msgs = its.map((it) => it.msg)
        // The note applies only when every queued message reached this agent by broadcast.
        const broadcast = its.every((it) => it.broadcast)
        if (!this.room(slug) || this.room(slug).paused || this.room(slug).archived) continue
        try {
          await this.promptFn(a, batchPrompt(slug, msgs, broadcast, a.local))
          for (const m of msgs) await this.markDelivered(slug, m, a)
        } catch (e) {
          this.log(`room delivery to ${a.name} failed: ${e.message}`)
          requeue(its)
        }
      }
    }
  }
  // Called with every fresh task list: system posts into existing ticket rooms; auto-create in 'auto' mode.
  async syncTickets(tasks) {
    await this.load()
    const prev = this.taskPrev
    this.taskPrev = new Map(tasks.filter((t) => TICKET.test(t.id)).map((t) => [t.id, t]))
    if (this.settings.ticketRooms === 'off' || !prev) return // first snapshot is the baseline
    for (const t of tasks) {
      if (!TICKET.test(t.id)) continue
      const slug = ticketSlug(t.id)
      if (this.room(slug)) {
        for (const text of ticketEvents(prev.get(t.id), t)) await this.system(slug, text)
        await this.followTicketAgent(this.room(slug), t)
      }
      else if (this.settings.ticketRooms === 'auto' && active(t)) await this.createForTicket(t)
    }
  }
  // Room for a ticket: its title, the involved agent as a member, back-filled with what is known. Delivers nothing.
  async createForTicket(t) {
    const r = await this.create({ title: `${t.id} ${t.title}`.slice(0, 120), project: t.project ?? null, slug: ticketSlug(t.id) })
    await this.followTicketAgent(r, t)
    if (!(await this.messages(r.slug)).length) for (const f of ticketFacts(t)) await this.system(r.slug, f)
    return r
  }
  // Ticket rooms answer to whoever works the ticket (worker > planner), until the user pins a responder.
  async followTicketAgent(r, t) {
    const a = t.responder ?? t.agent
    if (r.responderPinned || !a?.key || r.responder === a.key) return
    r.responder = a.key
    r.responderName = a.name
    if (!r.members.includes(a.name)) r.members = [...r.members, a.name]
    await this.saveIndex()
    await this.system(r.slug, `responder: ${a.name}`)
  }
  // Delete: index entry, its jsonl, its live streams and anything still queued for it.
  async remove(slug) {
    await this.load()
    this.index = this.index.filter((r) => r.slug !== slug)
    await this.saveIndex()
    await rm(join(this.dir, 'rooms', `${slug}.jsonl`), { force: true })
    this.msgs.delete(slug)
    for (const res of this.subs.get(slug) ?? []) res.end()
    this.subs.delete(slug)
    for (const [k, q] of this.queue) {
      const left = q.filter((it) => it.slug !== slug)
      if (left.length) this.queue.set(k, left)
      else this.queue.delete(k)
    }
  }
  // Rooms where an agent @mentioned the user and the user has not replied yet, as needs-you pseudo tasks.
  async needsTasks() {
    await this.load()
    return this.index.filter((r) => !r.archived).flatMap((r) => (r.needsYou ?? []).map((n) => ({
      id: `room:${r.slug}:${n.agent}`, roomNeed: r.slug, title: `#${r.slug}: ${n.text}`.slice(0, 120), url: null, priority: null, linearState: null,
      state: 'needs_you', agent: { key: `room:${r.slug}`, id: null, name: n.agent, machine: null }, project: r.project ?? null,
      question: n.text, branch: null, worktree: null, plan: null, pr: null, updatedAt: n.ts, adHoc: true,
    })))
  }
  pending() { return Object.fromEntries([...this.queue].map(([k, v]) => [k, v.length])) }
}

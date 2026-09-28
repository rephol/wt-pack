// wt-ask cards ('A' in WP-164): a question an agent posts, the user answers from a room chip or the Inbox.
// A mirrored native picker ('B') is not stored here — the pane's screen is its source of truth.
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, tx } from './store.mjs'

const err = (status, m) => Object.assign(new Error(m), { status })
const STATUS = ['open', 'answered', 'resolved', 'undeliverable']

// { question, header, options: [{label, description}], multiSelect, recommended? }, 1-12 options each.
function cleanQuestion(q, i) {
  if (typeof q?.question !== 'string' || !q.question.trim() || q.question.length > 2000) throw err(400, `questions[${i}].question: 1-2000 chars`)
  if (typeof q.header !== 'string' || !q.header.trim() || q.header.length > 60) throw err(400, `questions[${i}].header: 1-60 chars`)
  if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > 12) throw err(400, `questions[${i}].options: 1-12`)
  const options = q.options.map((o, j) => {
    if (typeof o?.label !== 'string' || !o.label.trim() || o.label.length > 200) throw err(400, `questions[${i}].options[${j}].label: 1-200 chars`)
    if (o.description !== undefined && (typeof o.description !== 'string' || o.description.length > 2000)) throw err(400, `questions[${i}].options[${j}].description: up to 2000 chars`)
    return { label: o.label, ...(o.description ? { description: o.description } : {}) }
  })
  if (q.recommended !== undefined && q.recommended !== null && !options.some((o) => o.label === q.recommended)) throw err(400, `questions[${i}].recommended must match an option label`)
  return { question: q.question, header: q.header, options, multiSelect: !!q.multiSelect, ...(q.recommended ? { recommended: q.recommended } : {}) }
}

// Boundary validator for POST /api/asks. `pane`/`agent`/`project` come from the authenticated caller, not the body.
export function clean(b) {
  if (!Array.isArray(b?.questions) || b.questions.length < 1 || b.questions.length > 4) throw err(400, 'questions: 1-4')
  const questions = b.questions.map(cleanQuestion)
  if (b.room !== undefined && b.room !== null && (typeof b.room !== 'string' || b.room.length > 64)) throw err(400, 'room: a slug up to 64 chars')
  if (b.ticket !== undefined && b.ticket !== null && (typeof b.ticket !== 'string' || b.ticket.length > 20)) throw err(400, 'ticket: up to 20 chars')
  return { questions, room: b.room ?? null, ticket: b.ticket ?? null }
}

// The answer shape POST /api/asks/:id/answer takes: { selected: [label,...] per question, text? }.
function cleanAnswer(a, questions) {
  if (!Array.isArray(a?.selected) || a.selected.length !== questions.length) throw err(400, `answer.selected: one entry per question (${questions.length})`)
  const selected = a.selected.map((sel, i) => {
    const q = questions[i]
    const labels = q.options.map((o) => o.label)
    const arr = q.multiSelect ? sel : [sel].flat()
    if (!Array.isArray(arr) || !arr.every((l) => labels.includes(l))) throw err(400, `answer.selected[${i}] must be option label(s) of question ${i}`)
    if (!q.multiSelect && arr.length > 1) throw err(400, `answer.selected[${i}]: question ${i} is single-select`)
    return arr
  })
  if (a.text !== undefined && a.text !== null && (typeof a.text !== 'string' || a.text.length > 4000)) throw err(400, 'answer.text: up to 4000 chars')
  return { selected, ...(a.text ? { text: a.text } : {}) }
}

export class Asks {
  // notify(draft): posts an Inbox item, returns it (or null if deduped) — wired to inbox.add.
  // resolveNotify(key): resolves the Inbox item with this key, if any and still open — wired to inbox.
  // broadcast(event, data): SSE fan-out — wired to broadcastEvent.
  // deliver(pane, text): sends a kind=reply wt-message to the pane; rejects if the pane is gone — wired to
  // handoff.sh --reply via dispatch.mjs's runHandoff (decision 3: same mechanism, same busy-pane behaviour).
  constructor({ dir, log = console.error, notify = () => {}, resolveNotify = () => {}, broadcast = () => {}, deliver = async () => {} }) {
    Object.assign(this, { file: join(dir, 'wt.db'), log, notify, resolveNotify, broadcast, deliver })
  }
  get db() { return open(this.file, { log: this.log }) }
  row(id) {
    const r = this.db.prepare('SELECT json FROM asks WHERE id = ?').get(id)
    if (!r) throw err(404, `no ask ${id}`)
    return JSON.parse(r.json)
  }
  async get(id) { return this.row(id) }
  // room: filter to one room's asks; open: true → only status 'open'.
  async list(room, open) {
    const all = this.db.prepare('SELECT json FROM asks ORDER BY seq').all().map((r) => JSON.parse(r.json))
    return all.filter((a) => (!room || a.room === room) && (!open || a.status === 'open'))
  }
  async create(body, author) {
    const f = clean(body)
    const at = new Date().toISOString()
    const a = { id: randomUUID(), pane: author.pane, agent: author.name, project: author.project ?? null,
      room: f.room, ticket: f.ticket, questions: f.questions, status: 'open', answer: null, created: at, closed: null }
    this.db.prepare('INSERT INTO asks (id, json) VALUES (?, ?)').run(a.id, JSON.stringify(a))
    const it = await this.notify({
      kind: 'ask', key: `ask:${a.id}`, title: `${a.agent} · ${a.questions[0].header}`,
      body: a.questions[0].question.slice(0, 300), target: { ask: a.id, room: a.room, agent: a.agent },
    })
    this.broadcast('asks', { id: a.id, action: 'created' })
    return { ...a, notified: !!it }
  }
  // Conditional UPDATE ... WHERE status = 'open' (Risks: races a terminal answer/resolve in one statement).
  async answer(id, body, author) {
    const a = this.row(id)
    const ans = cleanAnswer(body, a.questions)
    const text = a.questions.map((q, i) => `${q.header}: ${ans.selected[i].join(', ')}`).join('\n') + (ans.text ? `\n\n${ans.text}` : '')
    let status = 'answered'
    try {
      await this.deliver(a.pane, text)
    } catch (e) {
      status = 'undeliverable'
      this.log(`asks: deliver to ${a.pane} failed: ${e.message}`)
    }
    const at = new Date().toISOString()
    const next = { ...a, status, answer: { ...ans, by: author.name, at }, closed: at }
    const changes = this.db.prepare("UPDATE asks SET json = ? WHERE id = ? AND json_extract(json, '$.status') = 'open'").run(JSON.stringify(next), id).changes
    if (!changes) throw err(409, `${id} is no longer open`)
    await this.resolveNotify(`ask:${id}`)
    if (status === 'undeliverable') await this.notify({ kind: 'server', key: `ask-undeliverable:${id}`, title: `Answer to ${a.agent} could not be delivered`, body: `Pane ${a.pane} is gone. The answer is saved on the ask.`, target: { ask: id } })
    this.broadcast('asks', { id, action: status })
    return next
  }
  // Only the asking pane may resolve (close without answering); also conditional on status = 'open'.
  async resolve(id, pane) {
    const a = this.row(id)
    if (a.pane !== pane) throw err(403, `${id} was not asked by ${pane}`)
    const at = new Date().toISOString()
    const next = { ...a, status: 'resolved', closed: at }
    const changes = this.db.prepare("UPDATE asks SET json = ? WHERE id = ? AND json_extract(json, '$.status') = 'open'").run(JSON.stringify(next), id).changes
    if (!changes) throw err(409, `${id} is no longer open`)
    await this.resolveNotify(`ask:${id}`)
    this.broadcast('asks', { id, action: 'resolved' })
    return next
  }
}

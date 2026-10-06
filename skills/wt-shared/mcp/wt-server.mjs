#!/usr/bin/env node
// WP-255: the wt MCP server — typed ticket, handoff, room and ask tools for an agent, over stdio (newline-delimited
// JSON-RPC, no deps, like wt-memory's). Every tool shells out to the existing CLI (wt-ticket, handoff.sh, room, wt-ask),
// so the CLIs stay the one source of truth and keep working on their own. What the server adds:
//   - typed arguments: a JSON schema per tool, checked here before anything runs (a bad call never reaches a CLI);
//   - typed errors: { error: { code, message, retryable, exit } } with isError, instead of a CLI's stderr text;
//   - an `idempotency_key` on every call that changes something: a repeat of the key returns the first result and
//     does nothing (handoff passes it on as --request-id, WP-251; the others use wt-shared's receipts);
//   - a deadline under Claude Code's ~60 s abort of an MCP call (WT_MCP_TIMEOUT_MS, default 50 s): a CLI still running
//     then is killed and the call fails `timeout`, retryable with the same key.
// Identity is the pane the CLIs read from $HERDR_PANE_ID, inherited from the agent's own env.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once as receiptOnce } from '../scripts/receipts.mjs'

const here = (p) => new URL(p, import.meta.url).pathname
const BIN = {
  ticket: process.env.WT_MCP_TICKET || here('../../wt-ticket/scripts/wt-ticket'),
  handoff: process.env.WT_MCP_HANDOFF || here('../../wt-handoff/scripts/handoff.sh'),
  room: process.env.WT_MCP_ROOM || here('../../wt-room/scripts/room'),
  ask: process.env.WT_MCP_ASK || here('../../wt-ask/scripts/wt-ask'),
}
const TIMEOUT_MS = Number(process.env.WT_MCP_TIMEOUT_MS) || 50_000

// ---- typed errors -------------------------------------------------------------------------------------------
class ToolError extends Error {
  constructor(code, message, { retryable = false, exit = null } = {}) { super(message); Object.assign(this, { code, retryable, exit }) }
}
const body = (e) => ({ error: { code: e.code, message: e.message, retryable: e.retryable, ...(e.exit == null ? {} : { exit: e.exit }) } })
// A CLI's failure → a code. The CLIs speak exit codes (handoff: 2 refused/usage, 3 pool or team full) and stderr text.
function classify(exit, text) {
  const t = text.trim()
  if (/not reachable|needs wt-dashboard|Connection refused|curl failed \((6|7|28)/.test(t)) return new ToolError('dashboard_unreachable', t, { retryable: true, exit })
  if (/team full|pool full/.test(t)) return new ToolError(/team full/.test(t) ? 'team_full' : 'pool_full', t, { retryable: true, exit })
  if (/not found|no such|unknown (agent|pane|ticket)|no message/i.test(t)) return new ToolError('not_found', t, { exit })
  if (exit === 2 || /^usage|refused|is on team|not on a team/i.test(t)) return new ToolError('refused', t, { exit })
  return new ToolError('failed', t || `exit ${exit}`, { exit })
}
// The CLI runs in its own process group so a deadline kills what it started too (handoff.sh spawns herdr and claude
// helpers; killing only the shell would leave them holding the pipes and the call hanging).
function run(bin, args, { input, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = '', done = false
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v) }
    const timer = setTimeout(() => {
      try { process.kill(-p.pid, 'SIGKILL') } catch { /* already gone */ }
      end(reject, new ToolError('timeout', `${args[0] ?? bin} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped. It may still have taken effect: repeat the call with the same idempotency_key.`, { retryable: true }))
    }, timeoutMs)
    p.stdout.setEncoding('utf8').on('data', (d) => { if (out.length < 4e6) out += d })
    p.stderr.setEncoding('utf8').on('data', (d) => { if (err.length < 4e6) err += d })
    p.on('error', (e) => end(reject, classify(1, e.message)))
    p.on('close', (code) => (code === 0 ? end(resolve, out.trim()) : end(reject, classify(code ?? 1, err || out))))
    p.stdin.on('error', () => {}) // a CLI that exits without reading its stdin
    p.stdin.end(input ?? '')
  })
}
const json = (s) => { try { return JSON.parse(s) } catch { return s } }

// ---- schema + validation ------------------------------------------------------------------------------------
const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const TICKET = { pattern: '^[A-Za-z][A-Za-z0-9]*-\\d+$' }
const PANE = { pattern: '^[A-Za-z0-9_:.-]{1,40}$' }
const SLUG = { pattern: '^[a-z0-9][a-z0-9-]{0,40}$' }
const COLUMNS = ['backlog', 'ready', 'planning', 'building', 'review', 'done', 'blocked']
const key = str('A caller-chosen id for this call (1-80 of A-Z a-z 0-9 _ : . -). Repeating it returns the first result and does nothing again, so a retry after a timeout is safe.', { pattern: '^[\\w:.-]{1,80}$' })
// A value passed to a CLI as its own argument must not read as a flag.
const text = (d, extra = {}) => str(d, { minLength: 1, maxLength: 20_000, noLeadingDash: true, ...extra })

function check(schema, a) {
  const bad = (m) => { throw new ToolError('invalid_argument', m) }
  if (a == null || typeof a !== 'object' || Array.isArray(a)) bad('arguments must be an object')
  for (const k of Object.keys(a)) if (!(k in schema.properties)) bad(`unknown argument ${k}`)
  for (const k of schema.required ?? []) if (a[k] === undefined) bad(`${k} is required`)
  for (const [k, v] of Object.entries(a)) {
    const s = schema.properties[k]
    if (s.type === 'string') {
      if (typeof v !== 'string') bad(`${k} must be a string`)
      if (s.minLength && v.length < s.minLength) bad(`${k} must not be empty`)
      if (s.maxLength && v.length > s.maxLength) bad(`${k} is longer than ${s.maxLength}`)
      if (s.pattern && !new RegExp(s.pattern).test(v)) bad(`${k} has the wrong shape (${s.pattern})`)
      if (s.enum && !s.enum.includes(v)) bad(`${k} must be one of ${s.enum.join(', ')}`)
      if (s.noLeadingDash && v.startsWith('-')) bad(`${k} must not start with "-"`)
    } else if (s.type === 'boolean') { if (typeof v !== 'boolean') bad(`${k} must be a boolean`) }
    else if (s.type === 'integer') { if (!Number.isInteger(v) || (s.minimum != null && v < s.minimum) || (s.maximum != null && v > s.maximum)) bad(`${k} must be an integer${s.maximum != null ? ` ${s.minimum ?? 0}-${s.maximum}` : ''}`) }
    else if (s.type === 'array') {
      if (!Array.isArray(v) || v.length > (s.maxItems ?? 20)) bad(`${k} must be a list of up to ${s.maxItems ?? 20}`)
      for (const x of v) if (typeof x !== 'string' || !x || x.startsWith('-') || (s.items.pattern && !new RegExp(s.items.pattern).test(x))) bad(`${k}: each item must be a non-empty string${s.items.pattern ? ` matching ${s.items.pattern}` : ''}, not starting with "-"`)
    }
  }
}
const flags = (a, map) => Object.entries(map).flatMap(([k, flag]) => (a[k] == null || a[k] === false ? [] : a[k] === true ? [flag] : Array.isArray(a[k]) ? a[k].flatMap((x) => [flag, x]) : [flag, String(a[k])]))

// ---- tools ----------------------------------------------------------------------------------------------------
// Each: description, props (inputSchema.properties), required, mutates (adds idempotency_key), exec(a) → result.
const T = {}
const tool = (name, description, props, required, exec, { mutates = false, keyIsRequestId = false } = {}) => { T[name] = { description, props: mutates ? { ...props, idempotency_key: key } : props, required, exec, mutates, keyIsRequestId } }

tool('ticket_list', 'List the cards of the local board (wt-ticket). Returns the board JSON.', {
  project: str('Board/project (default: the current repo)'), column: str('One column', { enum: COLUMNS }), mine: { type: 'boolean', description: 'Only cards assigned to you' }, query: text('Search text instead of a plain list (all words must match)'),
}, [], (a) => (a.query && a.mine ? Promise.reject(new ToolError('invalid_argument', 'mine cannot be combined with query')) : run(BIN.ticket, [...(a.query ? ['search', a.query] : ['list']), ...flags(a, { column: '--column', mine: '--mine', project: '--project' }), '--json']).then(json)))
tool('ticket_show', 'One card with its history (wt-ticket show).', { id: str('Card id, e.g. WP-12', TICKET) }, ['id'], (a) => run(BIN.ticket, ['show', a.id, '--json']).then(json))
tool('ticket_new', 'Create a card (wt-ticket new).', {
  title: text('Card title', { maxLength: 200 }), type: str('Card type', { enum: ['bug', 'ux', 'gap', 'debt', 'feature'] }), size: str('Size', { enum: ['S', 'M', 'L'] }),
  priority: { type: 'integer', minimum: 0, maximum: 4, description: '0 (urgent) - 4' }, labels: { type: 'array', items: { type: 'string' }, description: 'Labels' }, links: { type: 'array', items: { type: 'string' }, description: 'URLs' },
  body: str('Card body (markdown)', { maxLength: 20_000 }), column: str('Start column (default backlog)', { enum: COLUMNS }), project: str('Board/project'),
}, ['title'], (a) => run(BIN.ticket, ['new', a.title, ...flags(a, { type: '--type', size: '--size', priority: '--priority', labels: '--label', links: '--link', body: '--body', column: '--column', project: '--project' }), '--json']).then(json), { mutates: true })
tool('ticket_move', 'Move a card to a column (wt-ticket move). `blocked` needs a note; a stage gate can refuse the move (code refused).', {
  id: str('Card id', TICKET), column: str('Target column', { enum: COLUMNS }), note: str('Why (required for blocked)', { maxLength: 2000 }), force: { type: 'boolean', description: 'Override a stage gate' },
}, ['id', 'column'], (a) => run(BIN.ticket, ['move', a.id, a.column, ...flags(a, { note: '--note', force: '--force' }), '--json']).then(json), { mutates: true })
tool('ticket_comment', 'Add a comment to a card (wt-ticket comment).', { id: str('Card id', TICKET), text: text('The comment', { maxLength: 8000 }) }, ['id', 'text'], (a) => run(BIN.ticket, ['comment', a.id, a.text, '--json']).then(json), { mutates: true })

tool('handoff', 'Hand a prompt to another agent (handoff.sh): reuses a free agent or spawns one, and types the prompt wrapped as a wt-message. Returns { target, pane, created, route, output }. A new agent can take over a minute: on timeout repeat with the same idempotency_key.', {
  prompt: text('What the agent should do', { maxLength: 100_000, noLeadingDash: false }), task: text('"<TICKET> <title>" label for the target pane'), role: str('Target role', { enum: ['worker', 'planner', 'reviewer'] }),
  pane: str('A specific pane id (then no pick/spawn)', PANE), persona: str('Project persona (.wt-pack/roles/<name>.md)', { pattern: '^[a-z][a-z0-9-]{0,23}$' }), team: str('Team name', { pattern: '^[a-z][a-z0-9-]{0,23}$' }),
  goal: { type: 'boolean', description: 'Arm a /goal on the target (default: no goal)' }, no_goal: { type: 'boolean', description: 'Accepted, now the default' }, dry_run: { type: 'boolean', description: 'Say what would happen; send nothing' },
}, ['prompt'], async (a, ctx) => {
  const out = await run(BIN.handoff, [...flags(a, { pane: '--pane', role: '--role', persona: '--persona', team: '--team', task: '--task', goal: '--goal', no_goal: '--no-goal', dry_run: '--dry-run' }), ...(ctx.key ? ['--request-id', `mcp:${ctx.key}`] : [])], { input: a.prompt })
  if (a.dry_run) return { dry_run: true, output: out }
  const lines = out.split('\n'), first = lines[0].split(' ')
  const target = lines.find((l) => l.startsWith('target '))?.split(' ')
  return { created: first[0] === 'created', pane: first[0] === 'created' ? first[2] : first[1], target: target?.[1] ?? null, route: lines.find((l) => l.startsWith('route:')) ?? null, output: out }
}, { mutates: true, keyIsRequestId: true })
tool('handoff_reply', 'Answer a wt-message: send text back to the sender\'s pane (handoff.sh --reply), kind=reply.', { pane: str('The sender\'s pane (from the message footer)', PANE), text: text('The reply', { maxLength: 20_000, noLeadingDash: false }) }, ['pane', 'text'],
  (a) => run(BIN.handoff, ['--reply', a.pane], { input: a.text }).then((o) => ({ output: o })), { mutates: true })
tool('handoff_ack', 'Acknowledge (or mark answered) a wt-message by its id (handoff.sh --ack).', { id: str('The id in the <wt-message> tag', { pattern: '^[A-Za-z0-9_-]{1,64}$' }), answered: { type: 'boolean', description: 'Mark it answered, not only acknowledged' } }, ['id'],
  (a) => run(BIN.handoff, ['--ack', a.id, ...(a.answered ? ['--answered'] : [])]).then((o) => ({ output: o })))

tool('room_list', 'List the chat rooms (room list).', {}, [], (a) => run(BIN.room, ['list']).then((o) => ({ output: o })))
tool('room_read', 'Read a room\'s messages (room read).', { room: str('Room slug', SLUG), since: { type: 'integer', minimum: 0, maximum: 1_000_000_000, description: 'Only messages after this number' } }, ['room'],
  (a) => run(BIN.room, ['read', a.room, ...(a.since != null ? ['--since', String(a.since)] : [])]).then((o) => ({ output: o })))
tool('room_post', 'Post to a room (room post). @name addresses someone; attachments are images under your cwd or /tmp.', {
  room: str('Room slug', SLUG), text: text('The message', { maxLength: 20_000, noLeadingDash: false }), attach: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Image paths' },
}, ['room', 'text'], (a) => run(BIN.room, ['post', a.room, a.text, ...(a.attach ?? []).flatMap((f) => ['--attach', f])]).then((o) => ({ output: o })), { mutates: true })

tool('ask', 'Ask the user a question as a room chip and Inbox card (wt-ask). Returns the ask id; read the answer with ask_answer. Without no_deliver the answer also arrives as a wt-message.', {
  question: text('The question', { maxLength: 500 }), options: { type: 'array', items: { type: 'string' }, maxItems: 4, description: '1-4 answer options (required)' }, recommend: str('The recommended option label', { maxLength: 200 }),
  multi: { type: 'boolean', description: 'Allow several answers' }, header: str('Short header', { maxLength: 60 }), ticket: str('Ticket it concerns', TICKET), room: str('Room slug', SLUG), no_deliver: { type: 'boolean', description: 'Do not send the answer back as a message; use ask_answer' },
}, ['question', 'options'], async (a) => {
  if (!a.options.length) throw new ToolError('invalid_argument', 'options: at least one')
  return json(await run(BIN.ask, [a.question, ...a.options.flatMap((o) => ['--option', o]), ...flags(a, { recommend: '--recommend', multi: '--multi', header: '--header', ticket: '--ticket', room: '--room', no_deliver: '--no-deliver' })]))
}, { mutates: true })
tool('ask_answer', 'Wait for the answer to an ask, up to timeout_s (max 45, under the MCP call limit). { answered: false } means still open: call again.', { id: str('The ask id', { pattern: '^[\\w-]{1,64}$' }), timeout_s: { type: 'integer', minimum: 1, maximum: 45, description: 'Default 30' } }, ['id'],
  async (a) => {
    try { return { answered: true, answer: json(await run(BIN.ask, ['--wait', a.id, '--timeout', String(a.timeout_s ?? 30)], { timeoutMs: ((a.timeout_s ?? 30) + 5) * 1000 })) } }
    catch (e) { if (e.exit === 3 && /no answer/.test(e.message)) return { answered: false }; if (e.exit === 3) throw new ToolError('resolved', e.message, { exit: 3 }); throw e }
  })

// ---- dispatch -------------------------------------------------------------------------------------------------
export async function call(name, a = {}) {
  const t = T[name]
  if (!t) throw new ToolError('unknown_tool', `unknown tool ${name}`)
  check({ properties: t.props, required: t.required }, a)
  const k = a.idempotency_key
  const { idempotency_key, ...args } = a
  const exec = () => t.exec(args, { key: k })
  // handoff dedupes in handoff.sh (--request-id); the rest here. A failure is not remembered, so a retry runs again.
  if (!(t.mutates && k) || t.keyIsRequestId) return exec()
  return json(await receiptOnce(`wt-mcp:${name}:${k}`, async () => JSON.stringify(await exec())))
}
export const tools = () => Object.entries(T).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.props, required: t.required, additionalProperties: false } }))

async function toolResult(name, a) {
  try {
    const r = await call(name, a)
    return { content: [{ type: 'text', text: JSON.stringify(r) }], ...(r && typeof r === 'object' && !Array.isArray(r) ? { structuredContent: r } : {}) }
  } catch (e) {
    const te = e instanceof ToolError ? e : new ToolError('failed', e.message)
    return { content: [{ type: 'text', text: JSON.stringify(body(te)) }], structuredContent: body(te), isError: true }
  }
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return send({ id: null, error: { code: -32700, message: 'parse error' } }) }
    const { id, method, params = {} } = msg
    if (id === undefined) return // notifications need no reply
    try {
      let result
      if (method === 'initialize') result = { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wt', version: '0.1.0' } }
      else if (method === 'ping') result = {}
      else if (method === 'tools/list') result = { tools: tools() }
      else if (method === 'tools/call') result = await toolResult(params.name, params.arguments ?? {})
      else return send({ id, error: { code: -32601, message: `method not found: ${method}` } })
      send({ id, result })
    } catch (e) { send({ id, error: { code: -32603, message: e.message } }) }
  })
}

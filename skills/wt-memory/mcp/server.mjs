#!/usr/bin/env node
// Minimal stdio MCP server (newline-delimited JSON-RPC, no deps) exposing the wt-memory CLI as tools:
// remember, forget, list, context. Every call shells out to scripts/wt-memory, so the CLI stays the one
// source of truth. The CLI inherits this process's env and cwd, which the agent runtime sets to the session's.
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const BIN = process.env.WT_MEMORY_BIN || new URL('../scripts/wt-memory', import.meta.url).pathname
const str = (description) => ({ type: 'string', description })
const scope = { type: 'string', enum: ['role', 'project', 'global'], description: 'Default: project if inferable, else role. Global waits for user approval.' }
const TOOLS = {
  remember: {
    description: 'Store a standing user preference (concise imperative, one line) so future agent sessions follow it. Use when the user says always/never/from now on/stop doing. Not for one-off task details. Afterwards tell the user in one line: "Remembered: <what>".',
    inputSchema: { type: 'object', properties: { note: str('The preference, one line, <=500 chars'), scope, role: str('Role id (optional)'), project: str('Repo name (optional)') }, required: ['note'] },
    args: (a) => ['remember', a.note, ...opt(a, 'scope', 'role', 'project')],
  },
  forget: {
    description: 'Remove a remembered entry (or reject a pending global proposal) by its 6-hex id from `list`.',
    inputSchema: { type: 'object', properties: { id: str('6-hex entry id') }, required: ['id'] },
    args: (a) => ['forget', a.id],
  },
  list: {
    description: 'List agent-written memory entries and pending global proposals as JSON.',
    inputSchema: { type: 'object', properties: { scope } },
    args: (a) => ['list', '--json', ...opt(a, 'scope')],
  },
  context: {
    description: 'The merged standing preferences (global → role → project) this session should follow.',
    inputSchema: { type: 'object', properties: { role: str('Role id (optional)'), project: str('Repo name (optional)') } },
    args: (a) => ['context', ...opt(a, 'role', 'project')],
  },
}
function opt(a, ...keys) { return keys.flatMap((k) => (a[k] ? [`--${k}`, String(a[k])] : [])) }

function call(name, a = {}) {
  const t = TOOLS[name]
  if (!t) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 })
  try {
    const out = execFileSync(process.execPath, [BIN, ...t.args(a)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return { content: [{ type: 'text', text: out || '(empty)' }] }
  } catch (e) {
    return { content: [{ type: 'text', text: String(e.stderr || e.message).trim() }], isError: true }
  }
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return send({ id: null, error: { code: -32700, message: 'parse error' } }) }
  const { id, method, params = {} } = msg
  if (id === undefined) return // notifications (initialized, cancelled) need no reply
  try {
    let result
    if (method === 'initialize') result = { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wt-memory', version: '0.3.0' } }
    else if (method === 'ping') result = {}
    else if (method === 'tools/list') result = { tools: Object.entries(TOOLS).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema })) }
    else if (method === 'tools/call') result = call(params.name, params.arguments)
    else return send({ id, error: { code: -32601, message: `method not found: ${method}` } })
    send({ id, result })
  } catch (e) { send({ id, error: { code: e.code || -32603, message: e.message } }) }
})

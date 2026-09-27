#!/usr/bin/env node
// wt-message-cli.mjs --kind <k> [--from <name>] [--ticket <ID>] < body  →  the wrapped text on stdout (WP-104).
// Used by wt-handoff's handoff.sh; exits 2 on bad usage (unknown kind or flag).
import { wrap } from './wt-message.mjs'

const a = process.argv.slice(2), o = {}
for (let i = 0; i < a.length; i += 2) {
  const k = { '--kind': 'kind', '--from': 'from', '--ticket': 'ticket' }[a[i]]
  if (!k || a[i + 1] === undefined) { console.error(`wt-message-cli: bad argument ${a[i]}`); process.exit(2) }
  o[k] = a[i + 1]
}
let body = ''
for await (const c of process.stdin) body += c
try { process.stdout.write(wrap(o, body)) } catch (e) { console.error(e.message); process.exit(2) }

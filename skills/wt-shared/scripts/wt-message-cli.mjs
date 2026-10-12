#!/usr/bin/env node
// wt-message-cli.mjs --kind <k> [--from <name>] [--ticket <ID>] [--pr N] [--sha X] < body  →  the wrapped text on stdout (WP-104).
// Used by wt-handoff's handoff.sh; exits 2 on bad usage (unknown kind or flag).
import { wrap, pointerOf } from './wt-message.mjs'

// `pointer` (WP-352): an envelope on stdin → its short typed pointer (stdout); not an envelope → the text unchanged.
if (process.argv[2] === 'pointer') {
  let t = ''
  for await (const c of process.stdin) t += c
  t = t.replace(/\n$/, '')
  process.stdout.write(pointerOf(t) ?? t); process.exit(0)
}
// `show <id>` (WP-352): the body of a message addressed to THIS pane, read through the dashboard (pane + pane key).
if (process.argv[2] === 'show') {
  const id = process.argv[3]
  if (!/^[\w-]+$/.test(id ?? '')) { console.error('usage: wt-message show <id>'); process.exit(2) }
  const pane = process.env.HERDR_PANE_ID
  if (!pane) { console.error('wt-message show: needs a pane (HERDR_PANE_ID)'); process.exit(1) }
  try {
    const r = await fetch(`${process.env.HERDR_DASH_URL || 'http://127.0.0.1:7777'}/api/messages/${encodeURIComponent(id)}`,
      { headers: { 'x-herdr-pane': pane, ...(process.env.WT_PANE_KEY ? { 'x-wt-pane-key': process.env.WT_PANE_KEY } : {}) }, signal: AbortSignal.timeout(5000) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { console.error(`wt-message show: ${j.error ?? r.status}`); process.exit(1) }
    process.stdout.write(`${j.body}\n`)
  } catch (e) { console.error(`wt-message show: dashboard did not answer (${e.message})`); process.exit(1) }
  process.exit(0)
}
const a = process.argv.slice(2), o = {}
for (let i = 0; i < a.length; i += 2) {
  const k = { '--kind': 'kind', '--from': 'from', '--ticket': 'ticket', '--pr': 'pr', '--sha': 'sha' }[a[i]]
  if (!k || a[i + 1] === undefined) { console.error(`wt-message-cli: bad argument ${a[i]}`); process.exit(2) }
  o[k] = a[i + 1]
}
let body = ''
for await (const c of process.stdin) body += c
try { process.stdout.write(wrap({ ...o, hoist: true }, body)) } catch (e) { console.error(e.message); process.exit(2) }

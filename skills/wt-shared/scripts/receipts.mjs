#!/usr/bin/env node
// WP-251: idempotency receipts. A send carries a request id; the first run records its result here, and a repeat of
// the same id returns that result instead of sending again (t3code's clientRequestId + CommandReceiptStore).
//   receipts.mjs get <id>      prints the stored result, exit 0; exit 1 if the id has no receipt
//   receipts.mjs put <id>      stores stdin as the result
// Module: get(id), put(id, text), once(id, fn) — fn runs once per id, concurrent repeats share its promise.
// ponytail: one file per id (sha1 name), 7-day prune; no lock, so two processes racing the very same id can both send.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEEK_MS = 7 * 864e5
const dir = () => process.env.WT_RECEIPTS_DIR || join(homedir(), '.local/share/wt-dashboard/receipts')
const file = (id) => join(dir(), createHash('sha1').update(String(id)).digest('hex') + '.json')

export function get(id) {
  try { return JSON.parse(readFileSync(file(id), 'utf8')).result } catch { return null }
}
export function put(id, result) {
  try {
    mkdirSync(dir(), { recursive: true, mode: 0o700 })
    writeFileSync(file(id), JSON.stringify({ id, at: Date.now(), result }), { mode: 0o600 })
    for (const f of readdirSync(dir())) { const p = join(dir(), f); if (f.endsWith('.json') && Date.now() - statSync(p).mtimeMs > WEEK_MS) unlinkSync(p) }
  } catch { /* a receipt that cannot be written only costs the dedupe, never the send */ }
}
const inflight = new Map()
export async function once(id, fn) {
  const hit = get(id)
  if (hit !== null) return hit
  if (inflight.has(id)) return inflight.get(id)
  const p = Promise.resolve().then(fn).then((r) => { put(id, r ?? ''); return r ?? '' }).finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}

async function main() {
  const [cmd, id] = process.argv.slice(2)
  if (!id || !['get', 'put'].includes(cmd)) { console.error('usage: receipts.mjs get|put <id>'); process.exit(2) }
  if (cmd === 'get') { const r = get(id); if (r === null) process.exit(1); process.stdout.write(r) }
  else { let s = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) s += c; put(id, s) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()

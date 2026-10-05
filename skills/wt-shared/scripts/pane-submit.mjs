#!/usr/bin/env node
// WP-248: typing into a Claude session that is still starting (large start-up context) loses the Enter, and the task
// sits in the input box unsent. Two helpers around a typed prompt, shared by handoff.sh (CLI below) and the
// dashboard's promptOn.mjs (functions): wait until the session is ready, then confirm the text left the input box.
//   pane-submit.mjs ready <pane> [--timeout <s>]     exit 0 once registered and interactive, 1 on timeout
//   pane-submit.mjs confirm <pane> [--retries N] [--settle ms]     exit 0 once the input box is empty (Enter again if not), 1 if it stays full
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// get(): the agent object from `herdr agent get`, or null while it has not registered.
export async function waitReady(get, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const a = await get().catch(() => null)
    if (a && a.interactive_ready !== false && ['idle', 'done'].includes(a.agent_status)) return true
    if (Date.now() >= end) return false
    await sleep(intervalMs)
  }
}

// What is typed in Claude's input box: the lines after the last `❯` up to the box's closing rule. The greyed
// `Try "…"` suggestion is a placeholder, not input.
export function inputText(screen) {
  const lines = String(screen).split('\n')
  // the input box sits between two rules; a `❯` anywhere else is a menu (trust prompt, picker) that Enter would act on
  const i = lines.findLastIndex((l, k) => /^❯/.test(l) && /^[─━]{3,}/.test(lines[k - 1] ?? ''))
  if (i < 0) return ''
  const out = [lines[i].replace(/^❯\s?/, '')]
  for (let j = i + 1; j < lines.length && !/^[─━]{3,}/.test(lines[j]); j++) out.push(lines[j])
  const text = out.join('\n').trim()
  return /^Try "/.test(text) ? '' : text
}

// read(): the visible screen; press(): send Enter. Returns true once the box is empty.
export async function confirmSubmitted(read, press, { retries = 3, settleMs = 1500 } = {}) {
  for (let n = 0; ; n++) {
    await sleep(settleMs)
    if (!inputText(await read())) return true
    if (n >= retries) return false
    await press()
  }
}

const hx = promisify(execFile)
const herdr = async (...a) => (await hx('herdr', a, { timeout: 8000 })).stdout

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, pane, ...rest] = process.argv.slice(2)
  const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? Number(rest[i + 1]) : d }
  if (!pane || !['ready', 'confirm'].includes(cmd)) { console.error('usage: pane-submit.mjs ready|confirm <pane> [--timeout s | --retries n]'); process.exit(2) }
  const ok = cmd === 'ready'
    ? await waitReady(async () => JSON.parse(await herdr('agent', 'get', pane)).result.agent, { timeoutMs: opt('--timeout', 60) * 1000 })
    : await confirmSubmitted(() => herdr('pane', 'read', pane, '--source', 'visible', '--format', 'text'), () => herdr('pane', 'send-keys', pane, 'enter'), { retries: opt('--retries', 3), settleMs: opt('--settle', 1500) })
  process.exit(ok ? 0 : 1)
}

#!/usr/bin/env node
// WP-248: typing into a Claude session that is still starting (large start-up context) loses the Enter, and the task
// sits in the input box unsent. Two helpers around a typed prompt, shared by handoff.sh (CLI below) and the
// dashboard's promptOn.mjs (functions): wait until the session is ready, then confirm the text left the input box.
//   pane-submit.mjs ready <terminal> [--timeout <s>]     exit 0 once it reports idle or done, 1 on timeout
//   pane-submit.mjs confirm <terminal> [--retries N] [--settle ms]     exit 0 once the input box is empty and the prompt demonstrably went in (Enter again if text is still in it), 1 otherwise
// WP-378: the CLI talks to hc through wt-shared/scripts/hc.mjs (imported inside main(): the functions above it need no hc).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// get(): the agent's status object ({status}: idle|working|done|blocked, as hc.mjs get() returns it), or null while it
// reports none. `agent_status` is accepted for a caller that still passes the old shape.
export async function waitReady(get, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const a = await get().catch(() => null)
    if (a && a.interactive_ready !== false && ['idle', 'done'].includes(a.status ?? a.agent_status)) return true
    if (Date.now() >= end) return false
    await sleep(intervalMs)
  }
}

// What is typed in Claude's input box: the lines after the last `❯` up to the box's closing rule. The greyed
// `Try "…"` suggestion is a placeholder, not input. null = no input box on the screen at all (still starting, a
// trust or picker menu): that is NOT an empty box (WP-267).
export function inputState(screen) {
  const lines = String(screen).split('\n')
  // the input box sits between two rules; a `❯` anywhere else is a menu (trust prompt, picker) that Enter would act on
  const i = lines.findLastIndex((l, k) => /^❯/.test(l) && /^[─━]{3,}/.test(lines[k - 1] ?? ''))
  if (i < 0) return null
  const out = [lines[i].replace(/^❯\s?/, '')]
  for (let j = i + 1; j < lines.length && !/^[─━]{3,}/.test(lines[j]); j++) out.push(lines[j])
  const text = out.join('\n').trim()
  return /^Try "/.test(text) ? '' : text
}
export const inputText = (screen) => inputState(screen) ?? ''

// A submitted prompt stays in the transcript as a `❯ …` line that is not the input box (no rule above it).
const echoed = (screen) => String(screen).split('\n').some((l, k, a) => /^❯/.test(l) && !/^[─━]{3,}/.test(a[k - 1] ?? ''))

// read(): the visible screen; press(): send Enter; status(): the agent's status, optional; log(): one line per poll.
// Returns true once the box is found empty AND the text demonstrably went in: the agent is no longer idle or the
// transcript echoes a prompt. An empty read alone proves nothing: right after the paste the box is still empty
// (Claude renders it ~1 s later), and a screen with no box at all (a menu, a session still starting) reads empty too.
// ponytail: on a reused agent an old echo still counts as evidence; add an expected-text match if that ever bites.
export async function confirmSubmitted(read, press, { retries = 3, settleMs = 1500, status, log = () => {} } = {}) {
  let busy = false
  for (let n = 0; ; n++) {
    await sleep(settleMs)
    const screen = await read()
    const st = status ? await status().catch(() => undefined) : undefined
    if (st && st !== 'idle' && st !== 'done') busy = true // hc: a finished turn RESTS at `done` (it is not evidence the prompt went in)
    const box = inputState(screen)
    log(`confirm poll ${n}: box=${box === null ? 'none' : JSON.stringify(box.slice(0, 40))} status=${st ?? '-'}`)
    if (box === '' && (!status || busy || echoed(screen))) return true
    if (n >= retries && box !== null) return false
    if (n >= retries + 4) return false // no box for a long while (menu, hung start): give up without pressing anything
    if (box) await press() // text still in the box: Enter again. Never on an empty or missing box.
  }
}

async function main() {
  const [cmd, pane, ...rest] = process.argv.slice(2)
  const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? Number(rest[i + 1]) : d }
  if (!pane || !['ready', 'confirm'].includes(cmd)) { console.error('usage: pane-submit.mjs ready|confirm <terminal> [--timeout s | --retries n]'); process.exit(2) }
  const hc = await import('./hc.mjs')
  const ok = cmd === 'ready'
    ? await waitReady(() => hc.get(pane), { timeoutMs: opt('--timeout', 60) * 1000 })
    : await confirmSubmitted(() => hc.read(pane, { lines: 0 }), () => hc.keys(pane, 'enter'), { retries: opt('--retries', 3), settleMs: opt('--settle', 1500), status: async () => (await hc.get(pane)).status ?? undefined, log: (l) => process.env.WT_SUBMIT_DEBUG && console.error(l) })
  process.exit(ok ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()

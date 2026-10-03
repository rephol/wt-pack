import type { Register } from 'claude-code'

// WP-210: pull wt-pack traffic from wt-dashboard's per-pane queue and submit it as a plugin-origin prompt, one at a
// time and only while no turn runs (order kept, nothing interleaved into a turn). The 20 s hello tells the dashboard
// to queue for this pane; without it (mod off, crashed, dashboard down) senders paste keystrokes as before.
const HELLO_MS = 20_000
const PULL_MS = 3_000

export const register: Register = (on) => {
  let turnRunning = false
  let pulling = false
  let lastSubmitted = ''

  on('session.start', async ($, e, next) => {
    const wt = `${$.plugin.root}/scripts/wt-deliver`
    const run = (argv: string[]) => $.process.run([wt, ...argv], { timeoutMs: 6000 }).catch(() => null)
    const pull = async () => {
      if (turnRunning || pulling) return
      pulling = true
      try {
        const r = await run(['next'])
        if (r?.exitCode !== 0) return
        let item: { id?: string; text?: string }
        try { item = JSON.parse(r.stdout) } catch { return }
        if (!item.id || typeof item.text !== 'string') return // {} : nothing queued
        if (item.id !== lastSubmitted) { // a failed ack leaves the row queued: retry only the ack, never the submit
          turnRunning = true // a submitted prompt starts a turn; do not wait for turn.start to say so
          try { await $.prompt.submit({ text: item.text }) } catch (err) { turnRunning = false; throw err }
          lastSubmitted = item.id
        }
        for (let i = 0; i < 3 && (await run(['ack', item.id, 'delivered']))?.exitCode !== 0; i++);
      } catch { /* retry next tick */ } finally { pulling = false }
    }
    pullNow = pull
    await run(['hello'])
    $.clock.every(HELLO_MS, () => { void run(['hello']) })
    $.clock.every(PULL_MS, () => { void pull() })
    return next(e)
  })

  let pullNow: () => Promise<void> = async () => {}
  on('turn.start', ($, e, next) => { turnRunning = true; return next(e) })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    turnRunning = false
    void pullNow()
    return r
  })
}

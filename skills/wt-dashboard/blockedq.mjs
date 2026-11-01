// WP-378: `hc send` refuses a blocked agent (exit 9: typing would answer its dialog) and the pack never forces it. A server send that meets
// one waits here, in memory, behind the target: flushed when the agent stops being blocked, given up after maxAgeMs (the question/Inbox card
// is what asks the user to answer; the message row stays `queued`, so the sweep's resend is the fallback after a restart).
export class BlockedQueue {
  #q = new Map() // pane -> [{ at, id, run }]
  constructor({ now = Date.now, maxAgeMs = 30 * 60_000 } = {}) { this.now = now; this.maxAgeMs = maxAgeMs }
  // run(): Promise, types the message. id: the envelope id (for has()), or null.
  add(pane, { id = null, run }) { (this.#q.get(pane) ?? this.#q.set(pane, []).get(pane)).push({ at: this.now(), id, run }) }
  has(id) { return !!id && [...this.#q.values()].some((l) => l.some((e) => e.id === id)) }
  size() { return [...this.#q.values()].reduce((n, l) => n + l.length, 0) }
  // statusOf(pane) -> status word, or undefined when the agent is gone. onGone(entry, why) for an entry that will never be typed.
  async flush(statusOf, onGone = () => {}) {
    for (const [pane, list] of [...this.#q]) {
      const st = await Promise.resolve().then(() => statusOf(pane)).catch(() => 'blocked') // an unreadable status is not "free"
      if (st === undefined) { for (const e of list) onGone(e, 'the agent is gone'); this.#q.delete(pane); continue }
      const keep = []
      for (const e of list) {
        if (st === 'blocked' || keep.length) { if (this.now() - e.at > this.maxAgeMs) onGone(e, 'blocked too long'); else keep.push(e); continue }
        try { await e.run() } catch (err) {
          if (err?.kind === 'blocked' || err?.kind === 'status_mismatch') keep.push(e) // refused again: nothing was typed
          else onGone(e, err?.message ?? String(err))
        }
      }
      if (keep.length) this.#q.set(pane, keep); else this.#q.delete(pane)
    }
  }
}

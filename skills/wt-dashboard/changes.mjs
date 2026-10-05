// WP-253: a sequence-numbered change stream (SSE, GET /api/changes). An event says WHAT changed ('tickets' | 'inbox' |
// 'rooms' + a small payload such as {project} or {slug}); the client refetches it through the existing GET routes. Every
// event has the id `<epoch>:<seq>`; a client that reconnects with its last id (the browser sends Last-Event-ID itself) gets
// exactly the events it missed. When it cannot be given them — no id, another epoch (the server restarted: the ring lives
// in memory), or a gap past the ring — it gets `reset` instead, which means "refetch everything" (the snapshot).
export class Changes {
  constructor(keep = 1000, now = Date.now) {
    Object.assign(this, { keep, epoch: now().toString(36), seq: 0, ring: [], subs: new Set() })
  }
  get id() { return `${this.epoch}:${this.seq}` }
  add(topic, data = {}) {
    const e = { seq: ++this.seq, topic, data }
    this.ring.push(e)
    if (this.ring.length > this.keep) this.ring.splice(0, this.ring.length - this.keep)
    for (const res of this.subs) this.#write(res, e)
    return e
  }
  #write(res, e) { res.write(`id: ${this.epoch}:${e.seq}\nevent: change\ndata: ${JSON.stringify({ topic: e.topic, ...e.data })}\n\n`) }
  // The events after `lastId`, or null when that id cannot be resumed from.
  since(lastId) {
    const m = /^([a-z0-9]+):(\d+)$/.exec(String(lastId ?? ''))
    if (!m || m[1] !== this.epoch) return null
    const n = Number(m[2])
    if (n > this.seq || this.seq - n > this.ring.length) return null // from the future, or older than the ring holds
    return this.ring.filter((e) => e.seq > n)
  }
  // Attach a response as an SSE stream. lastId: the Last-Event-ID header or ?since=.
  stream(req, res, lastId) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const missed = this.since(lastId)
    if (missed) for (const e of missed) this.#write(res, e)
    else res.write(`id: ${this.id}\nevent: reset\ndata: {}\n\n`)
    this.subs.add(res)
    const beat = setInterval(() => res.write(': hb\n\n'), 15_000).unref()
    req.on('close', () => { clearInterval(beat); this.subs.delete(res) })
  }
}

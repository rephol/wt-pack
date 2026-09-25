// Per-conversation message cache (agents and rooms), owned by the module rather than a component:
// - a view reads the cache instantly on mount; the stream is ref-counted and stays open 30s after the last view
//   closes, so a close/reopen or a tab flip never reconnects;
// - (re)connecting sends the cursor (?since=, and EventSource's own Last-Event-ID), so the server sends only what
//   is newer; everything is merged by id against the ONE array (no separate seen-set that can drift from it);
// - the last 200 messages and the cursor are kept in IndexedDB, so a reload paints history before the stream
//   connects. An agent's copy is keyed by its session id: a /clear or restart starts clean.
import { useEffect, useSyncExternalStore } from 'react'

export interface Keyed { id: string }
// Merge `incoming` into `prev` by id, keeping order (new ids append). `update` decides what a re-sent id becomes.
export function mergeById<T extends Keyed>(prev: T[], incoming: T[], update: (old: T, next: T) => T = (o) => o): T[] {
  if (!incoming.length) return prev
  const at = new Map(prev.map((m, i) => [m.id, i]))
  const out = prev.slice()
  let changed = false
  for (const m of incoming) {
    const i = at.get(m.id)
    if (i == null) { at.set(m.id, out.length); out.push(m); changed = true; continue }
    const u = update(out[i], m)
    if (u !== out[i]) { out[i] = u; changed = true }
  }
  return changed ? out : prev
}

// Agent transcript: a question's answer arrives as an update to the same id; any other re-sent id keeps ours.
type QMsg = Keyed & { role: string; questions?: unknown }
export const mergeAgentMsgs = <T extends QMsg>(prev: T[], incoming: T[]) =>
  mergeById(prev, incoming, (o, n) => (n.role === 'question' ? { ...o, ...n, questions: o.questions ?? n.questions } : o))

export interface Entry<T> { items: T[]; cursor: string | null; error: boolean; loaded: boolean; version: number }
interface Spec<T> {
  url: (cursor: string | null, items: T[]) => string
  attach: (es: EventSource, apply: (fn: (items: T[]) => T[], cursor?: string | null) => void) => void
  persistKey?: string // IndexedDB key; absent = memory only
  persistTag?: string // e.g. the session id: a stored copy with another tag is discarded
  keep?: number // how many to persist (default 200); rooms keep all, since their cursor is a message count
}
interface Live<T> extends Entry<T> { spec: Spec<T>; es: EventSource | null; refs: number; timer: ReturnType<typeof setTimeout> | null; subs: Set<() => void> }

const GRACE_MS = 30_000
const KEEP = 200
const entries = new Map<string, Live<unknown>>()
export const connections = { opened: 0 } // for the reconnect measurement

function notify<T>(e: Live<T>) { e.version++; e.subs.forEach((f) => f()) }

function open<T>(key: string, e: Live<T>) {
  if (e.es || !e.refs) return
  const es = new EventSource(e.spec.url(e.cursor, e.items))
  connections.opened++
  e.es = es
  const apply = (fn: (items: T[]) => T[], cursor?: string | null) => {
    const next = fn(e.items)
    const moved = cursor !== undefined && cursor !== e.cursor
    if (moved) e.cursor = cursor
    if (next !== e.items || moved || e.error) { e.items = next; e.error = false; notify(e); save(key, e) }
  }
  e.spec.attach(es, apply)
  es.onerror = () => { if (!e.error) { e.error = true; notify(e) } } // EventSource retries on its own, with Last-Event-ID
}

export function acquire<T>(key: string, spec: Spec<T>): () => void {
  let e = entries.get(key) as Live<T> | undefined
  if (!e) {
    e = { items: [], cursor: null, error: false, loaded: !spec.persistKey, version: 0, spec, es: null, refs: 0, timer: null, subs: new Set() }
    entries.set(key, e as Live<unknown>)
    if (spec.persistKey) {
      const ent = e
      load<T>(spec.persistKey).then((saved) => {
        if (saved && saved.tag === (spec.persistTag ?? null) && !ent.items.length) { ent.items = saved.items; ent.cursor = saved.cursor }
        ent.loaded = true
        notify(ent)
        open(key, ent)
      })
    }
  }
  e.refs++
  if (e.timer) { clearTimeout(e.timer); e.timer = null }
  if (e.loaded) open(key, e)
  const ent = e
  return () => {
    ent.refs--
    if (ent.refs > 0) return
    ent.timer = setTimeout(() => { ent.timer = null; if (!ent.refs) { ent.es?.close(); ent.es = null } }, GRACE_MS)
  }
}

const EMPTY: Entry<never> = { items: [], cursor: null, error: false, loaded: false, version: 0 }
export function useStream<T>(key: string | null, spec: () => Spec<T>): Entry<T> {
  useEffect(() => (key ? acquire(key, spec()) : undefined), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const e = key ? (entries.get(key) as Live<T> | undefined) : undefined
  useSyncExternalStore((f) => { if (!key) return () => {}; const x = entries.get(key); x?.subs.add(f); return () => { x?.subs.delete(f) } },
    () => (key ? entries.get(key)?.version ?? -1 : -1))
  return e ?? (EMPTY as Entry<T>)
}

// ---- IndexedDB (best effort: a private window or blocked storage just means no instant history) ----
type Saved<T> = { tag: string | null; items: T[]; cursor: string | null }
let dbp: Promise<IDBDatabase | null> | null = null
function db() {
  dbp ??= new Promise((ok) => {
    try {
      const r = indexedDB.open('wtd-streams', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('c')
      r.onsuccess = () => ok(r.result)
      r.onerror = () => ok(null)
    } catch { ok(null) }
  })
  return dbp
}
async function load<T>(k: string): Promise<Saved<T> | null> {
  const d = await db()
  if (!d) return null
  return new Promise((ok) => {
    try {
      const r = d.transaction('c').objectStore('c').get(k)
      r.onsuccess = () => ok((r.result as Saved<T>) ?? null)
      r.onerror = () => ok(null)
    } catch { ok(null) }
  })
}
const pending = new Map<string, ReturnType<typeof setTimeout>>()
function save<T>(key: string, e: Live<T>) {
  const k = e.spec.persistKey
  if (!k) return
  clearTimeout(pending.get(key))
  pending.set(key, setTimeout(async () => {
    const d = await db()
    try { d?.transaction('c', 'readwrite').objectStore('c').put({ tag: e.spec.persistTag ?? null, items: e.items.slice(-(e.spec.keep ?? KEEP)), cursor: e.cursor } satisfies Saved<T>, k) } catch { /* quota, private mode */ }
  }, 1000))
}

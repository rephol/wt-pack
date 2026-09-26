// One SQLite file (DATA/wt.db) for tickets, rooms and the inbox, on Node's built-in node:sqlite (node >= 22.13).
// The server is the only writer. Each migration stage imports its legacy JSON/JSONL once, then moves those
// files to DATA/pre-sqlite-<ISO>/; `node store.mjs export [--to <dir>]` writes the old layout back (rollback).
// No I/O on module load: server.mjs is imported by tests, so a DB opens only on first use.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// node:sqlite prints an ExperimentalWarning on load; drop only that one. getBuiltinModule, not a top-level
// await import: the desktop sidecar is a CJS bundle.
let sqlite
function DatabaseSync() {
  if (!sqlite) {
    const emit = process.emitWarning
    process.emitWarning = (w, ...a) => /SQLite/.test(String(w?.message ?? w)) ? undefined : emit.call(process, w, ...a)
    try { sqlite = process.getBuiltinModule('node:sqlite') } finally { process.emitWarning = emit }
  }
  return sqlite.DatabaseSync
}

const PROJECT = /^[\w.-]{1,64}$/

// BEGIN IMMEDIATE … COMMIT around a synchronous fn; no await may sit between BEGIN and COMMIT.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    if (typeof r?.then === 'function') throw new Error('tx(fn): fn must be synchronous')
    db.exec('COMMIT')
    return r
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }

function importTickets(db, data, log) {
  const dir = join(data, 'tickets')
  if (!existsSync(dir) || db.prepare('SELECT 1 FROM boards LIMIT 1').get()) return
  const files = readdirSync(dir)
  const board = db.prepare('INSERT INTO boards (project, key, next) VALUES (?, ?, ?)')
  const ticket = db.prepare('INSERT INTO tickets (id, project, seq, json) VALUES (?, ?, ?, ?)')
  const taken = new Set()
  const done = new Set()
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const p = f.slice(0, -5), b = readJson(join(dir, f))
    if (!PROJECT.test(p) || typeof b?.key !== 'string' || !Array.isArray(b.tickets)) continue
    board.run(p, b.key, b.next)
    b.tickets.forEach((t, i) => ticket.run(t.id, p, i, JSON.stringify(t)))
    taken.add(b.key); done.add(p)
  }
  // Unreadable boards (<p>.json that failed to parse, or <p>.json.corrupt-*): keep the key and id range so new
  // ids never reuse ones already handed out. Regex, since the text is not JSON.
  const salvage = new Map()
  for (const f of files) {
    const m = f.match(/^(.+)\.json(\.corrupt-.*)?$/)
    if (!m || done.has(m[1]) || !PROJECT.test(m[1])) continue
    log(`store: tickets/${f} is unreadable; salvaging key and id range, the file moves to the backup`)
    const raw = readFileSync(join(dir, f), 'utf8'), s = salvage.get(m[1]) ?? { key: null, next: 1 }
    s.key ??= raw.match(/"key"\s*:\s*"([A-Z]{2,5})"/)?.[1] ?? null
    for (const n of raw.matchAll(/"next"\s*:\s*(\d+)|"id"\s*:\s*"[A-Z]+-(\d+)"/g)) s.next = Math.max(s.next, Number(n[1] ?? Number(n[2]) + 1))
    salvage.set(m[1], s)
  }
  for (const [p, s] of salvage) if (s.key && !taken.has(s.key)) { board.run(p, s.key, s.next); taken.add(s.key) }
}

function exportTickets(db, to) {
  mkdirSync(join(to, 'tickets'), { recursive: true })
  for (const b of db.prepare('SELECT project, key, next FROM boards').all()) {
    const tickets = db.prepare('SELECT json FROM tickets WHERE project = ? ORDER BY seq').all(b.project).map((r) => JSON.parse(r.json))
    writeFileSync(join(to, 'tickets', `${b.project}.json`), JSON.stringify({ key: b.key, next: b.next, tickets }, null, 2))
  }
}

// Stage n sets user_version = n. legacy: top-level names under DATA that the stage imports and then moves away.
export const MIGRATIONS = [
  { sql: `CREATE TABLE boards (project TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, next INTEGER NOT NULL);
          CREATE TABLE tickets (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES boards, seq INTEGER NOT NULL, json TEXT NOT NULL);
          CREATE INDEX tickets_project ON tickets (project, seq);`,
    legacy: ['tickets'], import: importTickets, export: exportTickets },
]

// Move DATA/<name> into the backup dir; a directory that already exists there is merged (resumed move).
function moveInto(from, to) {
  if (!existsSync(to)) { mkdirSync(dirname(to), { recursive: true }); return renameSync(from, to) }
  if (!statSync(from).isDirectory()) return renameSync(from, `${to}.${Date.now()}`)
  for (const f of readdirSync(from)) moveInto(join(from, f), join(to, f))
  rmdirSync(from)
}

// Newest mtime under a path (appends to a .jsonl do not touch its directory's mtime).
const newest = (p) => { const s = statSync(p); return s.isDirectory() ? Math.max(s.mtimeMs, ...readdirSync(p).map((f) => newest(join(p, f)))) : s.mtimeMs }

const dbs = new Map()
export function open(file, { log = console.error } = {}) {
  if (dbs.has(file)) return dbs.get(file)
  const mem = file === ':memory:'
  const data = dirname(file)
  if (!mem) mkdirSync(data, { recursive: true })
  // before opening: opening in WAL mode touches wt.db-wal
  const dbTime = mem ? 0 : Math.max(...['', '-wal'].map((s) => existsSync(file + s) ? statSync(file + s).mtimeMs : 0))
  const Db = DatabaseSync()
  const db = new Db(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON')
  const version = db.prepare('PRAGMA user_version').get().user_version
  // Legacy files left in DATA by a stage already applied: a crash between commit and move (finish the move),
  // or a rollback to the JSON code that wrote them after wt.db (leave them, say so loudly).
  const backups = mem ? [] : readdirSync(data).filter((f) => f.startsWith('pre-sqlite-')).sort()
  let backup = backups.at(-1)
  const moveLegacy = (names) => {
    backup ??= `pre-sqlite-${new Date().toISOString().replace(/[:.]/g, '-')}`
    for (const n of names) moveInto(join(data, n), join(data, backup, n))
  }
  const present = (m) => mem ? [] : m.legacy.filter((n) => existsSync(join(data, n)))
  MIGRATIONS.forEach((m, i) => {
    const left = present(m)
    if (i < version) {
      if (!left.length) return
      if (left.some((n) => newest(join(data, n)) > dbTime))
        return log(`store: legacy JSON newer than wt.db (${left.join(', ')}) — rolled back? see wt-dashboard/README.md; not importing`)
      log(`store: finishing the move of ${left.join(', ')} to ${data}/${backup ?? 'pre-sqlite-*'}`)
      return moveLegacy(left)
    }
    tx(db, () => {
      db.exec(m.sql)
      if (left.length) m.import(db, data, log)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    })
    if (left.length) { backup = undefined; moveLegacy(left); log(`store: imported ${left.join(', ')}; originals in ${join(data, backup)}`) }
  })
  dbs.set(file, db)
  return db
}

// `node store.mjs export [--to <dir>]`: read-only, never migrates or imports; exits 1 without a wt.db.
export function exportTo(file, to) {
  if (!existsSync(file)) throw new Error(`no ${file}`)
  const db = new (DatabaseSync())(file, { readOnly: true })
  const version = db.prepare('PRAGMA user_version').get().user_version
  MIGRATIONS.slice(0, version).forEach((m) => m.export(db, to))
  db.close()
}

// basename too: in the sidecar's CJS bundle import.meta.url is the bundle itself, which is also argv[1].
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[1].endsWith('store.mjs')) {
  const [cmd, flag, dir] = process.argv.slice(2)
  const data = join(process.env.WT_DASHBOARD_DATA ?? join(homedir(), '.local', 'share', 'wt-dashboard'), 'data')
  if (cmd !== 'export' || (flag && flag !== '--to')) { console.error('usage: node store.mjs export [--to <dir>]'); process.exit(2) }
  try { exportTo(join(data, 'wt.db'), dir ?? data); console.log(`exported to ${dir ?? data}`) } catch (e) { console.error(e.message); process.exit(1) }
}

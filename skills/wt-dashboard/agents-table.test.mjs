import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentTable, reconcile } from './agents-table.mjs'
import { ProjectStore } from './project-store.mjs'

const mem = () => { const db = new DatabaseSync(':memory:'); return () => db }
const dataDir = (files) => { const d = mkdtempSync(join(tmpdir(), 'at-')); for (const [f, v] of Object.entries(files)) writeFileSync(join(d, f), JSON.stringify(v)); return d }
const legacy = (open, pauses) => {
  const db = open()
  db.exec('CREATE TABLE project_pauses (project TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL)')
  db.prepare('INSERT INTO project_pauses VALUES (?, ?, ?)').run('p', 5, JSON.stringify({ agents: pauses }))
}
const snap = { kind: 'pane', name: 'z', role: 'worker', cwd: '/c', session: 's-z', midTurn: true, tokens: { role: 'worker', ticket: 'WP-1', task: 'WP-1 secret', task_state: 'x', handoff_from: 'o', handoff_to_pane: '%1', dnd: '1' } }

test('import: all three sources, no task/handoff keys, project flagged paused', () => {
  const open = mem(); legacy(open, [snap])
  const t = new AgentTable(open), ps = new ProjectStore(open)
  const dir = dataDir({ 'agent-tags.json': { a: { role: 'worker', project: 'p', task: 'nope', handoff_from: 'x' } }, 'watchdog.json': { settings: {}, lastSeen: { '%9': { name: 'b', session: 's-b', cwd: '/b', role: 'planner', goneAt: 7 } } } })
  assert.equal(t.importLegacy(dir, (p, at) => ps.setPaused(p, at)), true)
  const byName = Object.fromEntries(t.list().map((r) => [r.name, r]))
  assert.deepEqual([byName.a.state, byName.b.state, byName.z.state], ['idle', 'exited', 'paused'])
  assert.equal(byName.b.session, 's-b'); assert.equal(byName.z.mid_turn, true); assert.equal(byName.z.tags.ticket, 'WP-1')
  assert.ok(ps.isPaused('p'))
  for (const r of t.list()) for (const k of Object.keys(r.tags)) assert.ok(!/^(task|task_state|handoff_|dnd|pair)/.test(k), k)
  assert.equal(t.importLegacy(dir), false) // second call: nothing
})

test('import: only project_pauses present, no legacy files', () => {
  const open = mem(); legacy(open, [snap])
  const t = new AgentTable(open)
  assert.equal(t.importLegacy(dataDir({})), true)
  assert.equal(t.get('z').state, 'paused')
})

test('import: a second open of an existing table imports nothing', () => {
  const open = mem(); new AgentTable(open).importLegacy(dataDir({}))
  const t2 = new AgentTable(open)
  assert.equal(t2.importLegacy(dataDir({ 'agent-tags.json': { late: { role: 'worker' } } })), false)
  assert.equal(t2.get('late'), undefined)
})

const row = (o) => ({ name: 'w', session: 's1', pane: '%1', stable_pane: null, state: 'idle', cwd: '/c', role: 'worker', project: 'p', ticket: null, gone_at: null, ...o })
const live = (o) => ({ name: 'w', id: '%1', session: 's1', status: 'idle', cwd: '/c', pool: 'worker', project: 'p', paneTokens: {}, ...o })

test('reconcile: new pane → new row; unchanged → nothing', () => {
  const r = reconcile([], [live()], new Set(['%1']))
  assert.equal(r.length, 1); assert.equal(r[0].patch.state, 'idle'); assert.ok(r[0].created)
  assert.deepEqual(reconcile([row()], [live()], new Set(['%1'])), [])
})

test('reconcile: same session on a new pane id → the row follows it', () => {
  const r = reconcile([row()], [live({ id: '%2' })], new Set(['%2']))
  assert.deepEqual(r.map((x) => [x.name, x.patch.pane]), [['w', '%2']])
})

test('reconcile: fresh-session respawn under an exited name rebinds the row', () => {
  const r = reconcile([row({ state: 'exited', session: 'old' })], [live({ id: '%3', session: 'new' })], new Set(['%3']))
  assert.deepEqual([r[0].name, r[0].patch.state, r[0].patch.session], ['w', 'idle', 'new'])
})

test('reconcile: herdr exited → exited; pane gone → missing and kept', () => {
  assert.equal(reconcile([row()], [live({ status: 'exited' })], new Set(['%1']))[0].patch.state, 'exited')
  const m = reconcile([row()], [], new Set(['%other']), 99)
  assert.deepEqual([m[0].patch.state, m[0].patch.gone_at], ['missing', 99])
  assert.deepEqual(reconcile([row({ state: 'missing', gone_at: 1 })], [], new Set()), [])
})

test('reconcile: a paused row is untouched even when a live agent has its name or session', () => {
  const p = row({ state: 'paused', pane: null })
  assert.deepEqual(reconcile([p], [live({ id: '%5' })], new Set(['%5'])), [])
})

test('reconcile: two panes on one session do not flap', () => {
  const rows = [row(), row({ name: 'x', pane: '%2' })]
  const lv = [live(), live({ name: 'x', id: '%2' })]
  assert.deepEqual(reconcile(rows, lv, new Set(['%1', '%2'])), [])
})

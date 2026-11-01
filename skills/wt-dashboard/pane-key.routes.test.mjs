// Run: node --test pane-key.routes.test.mjs — WP-327: x-herdr-pane alone is not identity once a pane has a key.
// Real server process, isolated data dir, a fake `hc` knowing panes t1 (keyed), t2 (keyed, the "foreign" one), t3 (no key).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hcStub, terminal } from './test-hc.mjs'

// WP-378: the agents are terminals of a stubbed hc core (test-hc.mjs)
const T = () => [
  terminal({ address: 't1', name: 'demo-worker-01', status: 'working', cwd: '/tmp', labels: {}, pid: 41, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 41 } }),
  terminal({ address: 't2', name: 'demo-worker-02', status: 'working', cwd: '/tmp', labels: {}, pid: 42, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 42 } }),
  terminal({ address: 't3', name: 'demo-worker-03', status: 'working', cwd: '/tmp', labels: {}, pid: 43, foreground: { name: '2.1', argv: ['claude'], cwd: '/tmp', pid: 43 } }),
]
const KEY = 'k'.repeat(64)
const children = []
const stubs = []
after(async () => { children.forEach((c) => c.kill()); for (const h of stubs) await h.close() }) // the servers' own pids

async function start(extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-panekey-'))
  const bin = join(root, 'bin')
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(bin); mkdirSync(join(root, 'pane-keys'))
  const hc = await hcStub({ terminals: T() }); stubs.push(hc)
  writeFileSync(join(root, 'pane-keys', 't1'), KEY + '\n'); writeFileSync(join(root, 'pane-keys', 't2'), 'o'.repeat(64) + '\n')
  const port = 30000 + Math.floor(Math.random() * 20000)
  children.push(spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(port), WT_DASHBOARD_DATA: root, HOME: root, ...hc.env, ...extraEnv } }))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  return (path, pane, key, method = 'GET') => fetch(`${base}${path}`, { method, body: method === 'POST' ? '{}' : undefined, headers: { 'x-herdr-pane': pane, ...(key ? { 'x-wt-pane-key': key } : {}) } })
}

test('a keyed pane needs its key on deliveries next/hello/ack; unkeyed is accepted (grace)', async () => {
  const call = await start()
  const routes = [['/api/deliveries/next', 'GET'], ['/api/deliveries/hello', 'POST'], ['/api/deliveries/none/ack', 'POST']]
  for (const [path, m] of routes) {
    assert.notEqual((await call(path, 't1', KEY, m)).status, 403, `${path}: right key`)
    assert.equal((await call(path, 't1', undefined, m)).status, 403, `${path}: no key`)
    assert.equal((await call(path, 't1', 'x'.repeat(64), m)).status, 403, `${path}: wrong key`)
    assert.equal((await call(path, 't1', 'short', m)).status, 403, `${path}: wrong length`)
    assert.equal((await call(path, 't2', KEY, m)).status, 403, `${path}: claims p2 with p1's key`)
    assert.notEqual((await call(path, 't3', undefined, m)).status, 403, `${path}: unkeyed pane, grace`)
  }
  const r = await call('/api/deliveries/next', 't1', KEY)
  assert.equal(r.status, 200)
  assert.match(await (await call('/api/deliveries/next', 't2', 'bad')).text(), /pane key mismatch/)
})

test('WT_PANE_KEY_STRICT=1 refuses a pane without a key but keeps keyed ones', async () => {
  const call = await start({ WT_PANE_KEY_STRICT: '1' })
  const r = await call('/api/deliveries/next', 't3')
  assert.equal(r.status, 403)
  assert.match(await r.text(), /respawn/)
  assert.equal((await call('/api/deliveries/next', 't1', KEY)).status, 200)
})

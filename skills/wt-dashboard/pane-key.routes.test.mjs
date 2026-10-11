// Run: node --test pane-key.routes.test.mjs — WP-327: x-herdr-pane alone is not identity once a pane has a key.
// Real server process, isolated data dir, a fake `herdr` knowing panes w9:p1 (keyed), w9:p2 (keyed, the "foreign" one), w9:p3 (no key).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_HERDR = `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ')
const P = (id, name) => ({ pane_id: id, name, agent_status: 'working', cwd: '/tmp', state_change_seq: 1 })
if (a === 'agent list') console.log(JSON.stringify({ result: { agents: [P('w9:p1', 'demo-worker-01'), P('w9:p2', 'demo-worker-02'), P('w9:p3', 'demo-worker-03')] } }))
else if (/^pane get w9:p[123]$/.test(a)) console.log(JSON.stringify({ result: { pane: { pane_id: a.slice(-5) } } }))
else if (a === 'machine list') console.log('')
else process.exit(1)
`
const KEY = 'k'.repeat(64)
const children = []
after(() => children.forEach((c) => c.kill())) // the servers' own pids

async function start(extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-panekey-'))
  const bin = join(root, 'bin')
  mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(bin); mkdirSync(join(root, 'pane-keys'))
  writeFileSync(join(bin, 'herdr'), FAKE_HERDR); chmodSync(join(bin, 'herdr'), 0o755)
  writeFileSync(join(root, 'pane-keys', 'w9:p1'), KEY + '\n'); writeFileSync(join(root, 'pane-keys', 'w9:p2'), 'o'.repeat(64) + '\n')
  const port = 30000 + Math.floor(Math.random() * 20000)
  children.push(spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(port), WT_DASHBOARD_DATA: root, HOME: root, PATH: `${bin}:${process.env.PATH}`, ...extraEnv } }))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  return (path, pane, key, method = 'GET') => fetch(`${base}${path}`, { method, body: method === 'POST' ? '{}' : undefined, headers: { 'x-herdr-pane': pane, ...(key ? { 'x-wt-pane-key': key } : {}) } })
}

test('a keyed pane needs its key on deliveries next/hello/ack; unkeyed is accepted (grace)', async () => {
  const call = await start()
  const routes = [['/api/deliveries/next', 'GET'], ['/api/deliveries/hello', 'POST'], ['/api/deliveries/none/ack', 'POST']]
  for (const [path, m] of routes) {
    assert.notEqual((await call(path, 'w9:p1', KEY, m)).status, 403, `${path}: right key`)
    assert.equal((await call(path, 'w9:p1', undefined, m)).status, 403, `${path}: no key`)
    assert.equal((await call(path, 'w9:p1', 'x'.repeat(64), m)).status, 403, `${path}: wrong key`)
    assert.equal((await call(path, 'w9:p1', 'short', m)).status, 403, `${path}: wrong length`)
    assert.equal((await call(path, 'w9:p2', KEY, m)).status, 403, `${path}: claims p2 with p1's key`)
    assert.notEqual((await call(path, 'w9:p3', undefined, m)).status, 403, `${path}: unkeyed pane, grace`)
  }
  const r = await call('/api/deliveries/next', 'w9:p1', KEY)
  assert.equal(r.status, 200)
  assert.match(await (await call('/api/deliveries/next', 'w9:p2', 'bad')).text(), /pane key mismatch/)
})

test('WT_PANE_KEY_STRICT=1 refuses a pane without a key but keeps keyed ones', async () => {
  const call = await start({ WT_PANE_KEY_STRICT: '1' })
  const r = await call('/api/deliveries/next', 'w9:p3')
  assert.equal(r.status, 403)
  assert.match(await r.text(), /respawn/)
  assert.equal((await call('/api/deliveries/next', 'w9:p1', KEY)).status, 200)
})

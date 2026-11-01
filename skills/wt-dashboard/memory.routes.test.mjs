// Run: node --test memory.routes.test.mjs — WP-369: /api/memory/preview passes the agent's persona to wt-memory, so a
// `[role: <persona>]` line previews for that persona. Real server process, temp data dir and WT_MEMORY_HOME, stubbed hc (WP-378).
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hcStub } from './test-hc.mjs'

let hc, child, base, cookie
const PORT = 30000 + Math.floor(Math.random() * 20000)
const get = (path) => fetch(`${base}${path}`, { headers: { cookie } }).then((r) => r.json())
before(async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-memroutes-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  hc = await hcStub({ terminals: [] }) // a quiet hc core, so the server's agent sync never touches the user's real one
  const mem = join(root, 'mem'); mkdirSync(mem)
  writeFileSync(join(mem, 'global.md'), '- for-all\n- [role: p] persona-only\n')
  child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PORT: String(PORT), WT_DASHBOARD_DATA: root, HOME: root, WT_MEMORY_HOME: mem, ...hc.env } })
  base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/push`)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  cookie = `hd_session=${readFileSync(join(root, 'session'), 'utf8').trim()}`
})
after(async () => { child?.kill(); await hc?.close() })

test('preview with a persona shows its [role: persona] line, tag stripped; without it the line is absent', async () => {
  const withP = (await get('/api/memory/preview?role=worker&persona=p')).text
  assert.match(withP, /^- persona-only$/m); assert.doesNotMatch(withP, /\[role: p\]/); assert.match(withP, /for-all/)
  const without = (await get('/api/memory/preview?role=worker')).text
  assert.doesNotMatch(without, /persona-only/); assert.match(without, /for-all/)
  const bad = (await get('/api/memory/preview?role=worker&persona=../x')).text
  assert.doesNotMatch(bad, /persona-only/)
})

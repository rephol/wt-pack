// Run: node --test wt-keepwarm.test.mjs — WP-358: `wt-keepwarm on|off` against a stub dashboard (HERDR_DASH_URL is always the stub, never the live one).
// Async execFile: a synchronous child would block this process's event loop and starve the stub (CLAUDE.md WP-164 trap).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('./wt-keepwarm', import.meta.url))
const execFileP = promisify(execFile)

async function stub() {
  const seen = []
  const server = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => { seen.push({ method: req.method, url: req.url, pane: req.headers['x-herdr-pane'], key: req.headers['x-wt-pane-key'], body: JSON.parse(b || '{}') }); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}') })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}
const run = (args, url) => execFileP(BIN, args, { encoding: 'utf8', env: { ...process.env, HERDR_PANE_ID: 'w1:p2', WT_PANE_KEY: 'k2', HERDR_DASH_URL: url } })

test('on posts {event:"arm"} to the pane\'s own report route; off still posts the stop/off report', async () => {
  const s = await stub()
  try {
    const on = await run(['on'], s.url)
    assert.match(on.stdout, /keepwarm armed for this agent/)
    assert.deepEqual(s.seen[0], { method: 'POST', url: '/api/keepwarm/me/report', pane: 'w1:p2', key: 'k2', body: { event: 'arm' } })
    const off = await run(['off'], s.url)
    assert.match(off.stdout, /\/wt keepwarm on/)
    assert.deepEqual(s.seen[1].body, { event: 'stop', off: true, reason: 'turned off' })
  } finally { s.close() }
})

test('an unknown subcommand prints usage (with on) and exits 2', async () => {
  const s = await stub()
  try {
    await assert.rejects(run(['nap'], s.url), (e) => e.code === 2 && /wt-keepwarm on /.test(e.stderr))
    assert.equal(s.seen.length, 0)
  } finally { s.close() }
})

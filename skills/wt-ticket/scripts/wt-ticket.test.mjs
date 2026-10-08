// Run: node --test wt-ticket.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('./wt-ticket', import.meta.url))
const execFileP = promisify(execFile)

// Async on purpose (see wt-ask.test.mjs): a sync exec would starve the in-process stub of its event loop.
async function stub(handler) {
  const server = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => handler(req, JSON.parse(b || '{}'), res))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}
const run = (args, env) => execFileP(BIN, args, { encoding: 'utf8', env: { ...process.env, HERDR_PANE_ID: 'w1:p2', ...env } })

test('WP-276: move <ID> cancelled --note sends the column and the reason', async () => {
  let seen
  const s = await stub((req, body, res) => {
    if (req.method === 'PATCH') seen = { method: req.method, url: req.url, body } // the CLI follows a mutation with a text-format GET
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'WP-9', title: 't', type: 'debt', column: 'cancelled', priority: 0 }))
  })
  try {
    const { stdout } = await run(['move', 'WP-9', 'cancelled', '--note', 'superseded by WP-10'], { HERDR_DASH_URL: s.url })
    assert.deepEqual(seen, { method: 'PATCH', url: '/api/tickets/WP-9', body: { column: 'cancelled', note: 'superseded by WP-10' } })
    assert.match(stdout, /WP-9/)
    await run(['move', 'WP-9', 'cancelled'], { HERDR_DASH_URL: s.url }) // the reason is optional
    assert.deepEqual(seen.body, { column: 'cancelled' })
  } finally { s.close() }
})

test('WP-276: the usage text lists cancelled', async () => {
  await assert.rejects(run([], { HERDR_DASH_URL: 'http://127.0.0.1:1' }), (e) => e.code === 2 && /done blocked cancelled/.test(e.stderr))
})

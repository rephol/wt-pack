// WP-378 U1: the hc adapter on recorded real output (fixtures/hc, replayed by fake-hc/hc). Opt-in real test: see the bottom.
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { installFakeHc } from './fake-hc.mjs'
import * as hc from './hc.mjs'

const run = promisify(execFile)
const HC_MJS = new URL('./hc.mjs', import.meta.url).pathname
function require_(verb) { return readFileSync(new URL(`./fixtures/hc/${verb}.json`, import.meta.url), 'utf8') }

let fake, saved
// The adapter reads PATH/HC_BIN from process.env at call time: point the test process at the fake, restore after.
function use(cases = {}) {
  fake = installFakeHc({ cases })
  saved = { ...process.env }
  for (const k of Object.keys(process.env)) if (/^(HC_|HERDR_)/.test(k)) delete process.env[k]
  Object.assign(process.env, { PATH: fake.env.PATH, HC_BIN: fake.env.HC_BIN, FAKE_HC_CASES: fake.env.FAKE_HC_CASES, FAKE_HC_LOG: fake.env.FAKE_HC_LOG, FAKE_HC_STATE: fake.env.FAKE_HC_STATE })
  return fake
}
afterEach(() => {
  if (saved) { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); saved = null }
  fake?.cleanup(); fake = null
})
const argsOf = (verb) => fake.calls().filter((c) => c.args[0] === verb).map((c) => c.args)

describe('fixtures are real recordings', () => {
  test('every verb the plan names has a recorded file', () => {
    for (const v of ['run', 'ls', 'get', 'label', 'send', 'keys', 'read', 'wait', 'interrupt', 'kill', 'rm', 'server-status', 'templates', 'connect']) {
      assert.ok(existsSync(new URL(`./fixtures/hc/${v}.json`, import.meta.url)), `fixtures/hc/${v}.json`)
    }
  })
  test('the recordings carry no username or hostname', () => {
    for (const v of ['connect', 'get', 'ls', 'run']) assert.doesNotMatch(require_(v), /octeumkm|Octes-MacBook/i)
  })
})

describe('normalisation', () => {
  test('list(): claude rows carry status, labels, program; one connect call per list', async () => {
    use({ connect: ['claude_states', 'working'] })
    const rows = await hc.list({ all: true })
    assert.equal(fake.calls().length, 1, 'exactly one hc invocation per list')
    assert.equal(JSON.parse(fake.calls()[0].stdin).method, 'terminal.list')
    const s3 = rows.find((r) => r.name === 's3')
    assert.equal(s3.status, 'blocked'); assert.equal(s3.statusKind, 'permission'); assert.match(s3.statusMsg, /approve Write/)
    assert.equal(s3.program, 'claude', 'foreground.name is the version string; the program comes from argv[0]')
    assert.ok(hc.isAgent(s3)); assert.ok(!hc.isShell(s3))
    assert.ok(hc.isShell(rows.find((r) => r.name === 'k1')), 'the keep shell in the same listing')
    const s1 = (await hc.list()).find((r) => r.name === 's1')
    assert.equal(s1.labels['wt.pool'], 'r-workers'); assert.equal(s1.status, 'working'); assert.equal(s1.alive, true)
  })
  test('list(): a machine/ row is dropped', async () => {
    const doc = JSON.parse(require_('connect')).cases.claude_states
    const res = JSON.parse(doc.stdout)
    res.result.terminals.push({ ...res.result.terminals[0], address: 'vps/t3', name: 'remote' })
    use({ connect: { exit: 0, stdout: JSON.stringify(res) + '\n', stderr: '' } })
    const rows = await hc.list()
    assert.ok(rows.length >= 1); assert.ok(!rows.some((r) => r.id.includes('/')))
    assert.ok(!rows.some((r) => r.name === 'remote'))
  })
  test('list(): a finished row keeps exit code and reason', async () => {
    use({ connect: 'terminal.list_all' })
    const fin = (await hc.list({ all: true })).find((r) => r.state === 'finished')
    assert.ok(fin, 'recording has a finished terminal'); assert.equal(fin.alive, false)
    assert.ok(!hc.isAgent(fin)); assert.equal(typeof fin.exitCode, 'number')
  })
  test('a keep shell is a shell, not an agent, and has lost its labels', async () => {
    use({ get: 'keep_shell' })
    const t = await hc.get('k1')
    assert.ok(hc.isShell(t)); assert.ok(!hc.isAgent(t)); assert.equal(t.keep, true); assert.deepEqual(t.labels, {})
  })
  test('get(): a claude at rest (done), then blocked on a permission', async () => {
    use({ get: ['claude_done', 'claude_blocked'] })
    assert.equal((await hc.get('s1')).status, 'done')
    const b = await hc.get('s3'); assert.equal(b.status, 'blocked'); assert.equal(b.statusKind, 'permission')
  })
})

describe('error mapping', () => {
  test('blocked is exit 9 kind blocked', async () => {
    use({ send: 'blocked' })
    await assert.rejects(hc.send('s3', 'hi'), (e) => e instanceof hc.HcError && e.kind === 'blocked' && e.exit === 9 && /hc read/.test(e.hint))
  })
  test('status_mismatch is exit 10, finished 11, not_found 3', async () => {
    use({ send: ['if_idle_but_working', 'finished', 'not_found'] })
    await assert.rejects(hc.send('s1', 'x', { ifIdle: true }), (e) => e.kind === 'status_mismatch' && e.exit === 10)
    await assert.rejects(hc.send('x', 'x'), (e) => e.kind === 'finished' && e.exit === 11)
    await assert.rejects(hc.send('x', 'x'), (e) => e.kind === 'not_found' && e.exit === 3)
  })
  test('hc missing is kind unavailable', async () => {
    use({})
    process.env.HC_BIN = '/nonexistent/hc'
    await assert.rejects(hc.get('t1'), (e) => e.kind === 'unavailable')
  })
  test('an hc that never answers is kind timeout', async () => {
    use({})
    const slow = join(fake.dir, 'slow'); writeFileSync(slow, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
    process.env.HC_BIN = slow
    await assert.rejects(hc.hc(['get', 't1'], { timeoutMs: 150 }), (e) => e.kind === 'timeout')
  })
})

describe('send', () => {
  test('never passes --force', async () => {
    use({ send: 'ok_done' })
    await hc.send('s1', 'hello'); await hc.send('s1', 'hello', { ifIdle: true })
    for (const a of argsOf('send')) assert.ok(!a.includes('--force'))
  })
  test('blocked: thrown once, no retry, nothing forced', async () => {
    use({ send: ['blocked', 'ok_done'] })
    await assert.rejects(hc.send('s3', 'hi', { ifIdle: true }), (e) => e.kind === 'blocked')
    assert.equal(argsOf('send').length, 1)
  })
  test('--if idle refused because the agent rests at done -> one plain send', async () => {
    use({ send: ['if_idle_but_done', 'ok_done'] })
    const r = await hc.send('s1', 'hi', { ifIdle: true })
    assert.equal(r.restedAsDone, true)
    const [first, second] = argsOf('send')
    assert.deepEqual(first.slice(0, 4), ['send', '--json', '--if', 'idle'])
    assert.ok(!second.includes('--if'))
  })
  test('--if idle refused because it is working: not retried (the caller queues)', async () => {
    use({ send: ['if_idle_but_working', 'ok_done'] })
    await assert.rejects(hc.send('s1', 'hi', { ifIdle: true }), (e) => e.kind === 'status_mismatch' && /working/.test(e.message))
    assert.equal(argsOf('send').length, 1)
  })
  test('a shell is never typed into: --if idle on a silent terminal is refused and not retried', async () => {
    use({ send: ['if_idle_shell', 'ok_done'] })
    await assert.rejects(hc.send('k1', 'rm -rf x', { ifIdle: true }), (e) => e.kind === 'status_mismatch')
    assert.equal(argsOf('send').length, 1)
  })
  test('the text is one argument, byte for byte (the WP-352 pointer line)', async () => {
    use({ send: 'ok_done' })
    const p = '<wt-message id=abc123 kind=handoff from="orch" ticket=WP-1>Read it with: wt-message show abc123, do what it asks, then report as it says</wt-message>'
    await hc.send('s1', p, { ifIdle: true })
    assert.equal(argsOf('send')[0].at(-1), p); assert.equal(argsOf('send')[0].at(-2), 's1')
  })
})

describe('timeouts', () => {
  test('hc takes seconds: ms rounds up, minimum 1', () => {
    assert.equal(hc.secondsOf(1), 1); assert.equal(hc.secondsOf(1000), 1); assert.equal(hc.secondsOf(1001), 2); assert.equal(hc.secondsOf(90_500), 91)
  })
  test('wait passes --timeout in seconds', async () => {
    use({ wait: 'status_done' })
    await hc.wait('s1', { timeoutMs: 90_500 })
    assert.deepEqual(argsOf('wait')[0].slice(-2), ['--timeout', '91'])
  })
  test('waitUntil loops over check-ins until the status ends it', async () => {
    use({ wait: ['working_timeout', 'working_timeout', 'status_done'] })
    const r = await hc.waitUntil('s1', { deadlineMs: 600_000 })
    assert.equal(r.status, 'done'); assert.equal(argsOf('wait').length, 3)
  })
  test('waitUntil does not stop on a message to the waiter', async () => {
    const msg = { exit: 0, stdout: '{"children":[],"ended":true,"reason":"message","from":"t7","status":null,"terminal":"t2","turn":1}\n', stderr: '' }
    use({ wait: [msg, 'status_done'] })
    assert.equal((await hc.waitUntil('s1', { deadlineMs: 600_000 })).reason, 'status')
  })
  test('waitUntil gives up at the caller deadline', async () => {
    use({ wait: 'working_timeout' })
    const r = await hc.waitUntil('s1', { deadlineMs: 50 })
    assert.equal(r.ended, false)
  })
})

describe('keys, read, interrupt', () => {
  test('interrupt passes seconds and returns the outcome', async () => {
    use({ interrupt: 'claude' })
    const r = await hc.interrupt('s1', { timeoutMs: 2500 })
    assert.equal(r.outcome, 'stopped'); assert.deepEqual(argsOf('interrupt')[0].slice(-2), ['--timeout', '3'])
  })
  test('read returns plain text with --lines', async () => {
    use({ read: 'text' })
    const t = await hc.read('rec-a', { lines: 3 })
    assert.equal(typeof t, 'string'); assert.deepEqual(argsOf('read')[0], ['read', 'rec-a', '--lines', '3'])
  })
  test('keys passes the key names through', async () => {
    use({ keys: 'claude' })
    await hc.keys('s3', 'down', 'enter')
    assert.deepEqual(argsOf('keys')[0].slice(-3), ['s3', 'down', 'enter'])
  })
})

describe('labels', () => {
  test('values are cut at 80 characters', () => {
    const { set } = hc.planLabels({ task: 'x'.repeat(200) })
    assert.equal([...set.task].length, 80)
  })
  test('a 33rd label is refused; replacing an existing key is not', () => {
    const cur = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, 'v']))
    assert.throws(() => hc.planLabels({ extra: '1' }, cur), (e) => e.kind === 'too_many_labels')
    assert.doesNotThrow(() => hc.planLabels({ k3: 'new' }, cur))
    assert.doesNotThrow(() => hc.planLabels({ extra: '1', k0: '' }, cur), 'clearing one makes room for one')
  })
  test('bad keys are refused (hc itself would store "bad key")', () => {
    for (const k of ['bad key', 'a=b', '', '-x']) assert.throws(() => hc.planLabels({ [k]: 'v' }), (e) => e.kind === 'invalid_label')
  })
  test('an unknown role is dropped when the caller knows the roles', () => {
    assert.deepEqual(hc.planLabels({ role: 'wizard' }, {}, { roles: ['worker', 'planner'] }).dropped, ['role'])
    assert.equal(hc.planLabels({ role: 'worker' }, {}, { roles: ['worker'] }).set.role, 'worker')
    assert.equal(hc.planLabels({ role: 'anything' }).set.role, 'anything', 'no roles given: no filter')
  })
  test('setLabels sends k=v to set and k= to clear, in one hc label call', async () => {
    use({ label: 'set', get: 'live' })
    await hc.setLabels('rec-a', { pair: 'rec-b', task: '' })
    const l = argsOf('label')
    assert.equal(l.length, 1); assert.deepEqual(l[0].slice(2), ['rec-a', 'pair=rec-b', 'task='])
  })
  test('clearLabel needs no read', async () => {
    use({ label: 'clear' })
    await hc.clearLabel('rec-a', 'pair', 'task')
    assert.equal(argsOf('get').length, 0); assert.deepEqual(argsOf('label')[0].slice(-2), ['pair=', 'task='])
  })
  test('over-long values reach hc already cut', async () => {
    use({ label: 'set', get: 'live' })
    await hc.setLabels('rec-a', { task: 'y'.repeat(300) })
    assert.equal(argsOf('label')[0].at(-1).length, 'task='.length + 80)
  })
})

describe('names', () => {
  test('nextName takes the lowest free number', () => {
    assert.equal(hc.nextName('wt-pack-worker', []), 'wt-pack-worker-01')
    assert.equal(hc.nextName('wt-pack-worker', ['wt-pack-worker-01', 'wt-pack-worker-03']), 'wt-pack-worker-02')
    assert.equal(hc.nextName('p', new Set(['p-01', 'p-02'])), 'p-03')
  })
  test('a name over 32 characters or with capitals is refused', () => {
    assert.throws(() => hc.nextName('x'.repeat(30), []), (e) => e.kind === 'invalid_params')
    assert.throws(() => hc.nextName('Wt-Pack', []), (e) => e.kind === 'invalid_params')
  })
  test('name_taken (recorded terminal.run error) maps to kind name_taken', async () => {
    use({ 'connect:terminal.run': 'terminal.run_name_taken' })
    await assert.rejects(hc.spawn({ name: 'rec-a', argv: ['sleep', '5'] }), (e) => e.kind === 'name_taken')
  })
  test('spawnNumbered retries on name_taken with the next number', async () => {
    use({ 'connect:terminal.run': ['terminal.run_name_taken', 'terminal.run'] })
    const r = await hc.spawnNumbered({ prefix: 'rec', argv: ['sleep', '5'] })
    assert.deepEqual(runCalls().map((p) => p.name), ['rec-01', 'rec-02']); assert.ok(r.id)
  })
  test('spawnNumbered gives up after three tries', async () => {
    use({ 'connect:terminal.run': 'terminal.run_name_taken' })
    await assert.rejects(hc.spawnNumbered({ prefix: 'rec', argv: ['sleep', '5'] }), (e) => e.kind === 'name_taken')
    assert.equal(runCalls().length, 3)
  })
})

// WP-378 D3: spawn is terminal.run over `hc connect`; the env rides in the request body.
const runCalls = () => fake.calls().filter((c) => c.args[0] === 'connect' && c.stdin).map((c) => JSON.parse(c.stdin)).filter((q) => q.method === 'terminal.run').map((q) => q.params)
describe('spawn', () => {
  test('always detached and silent: outlive_parent and no_notify, labels and cwd as given', async () => {
    use({})
    const r = await hc.spawn({ name: 'rec-r', cwd: '/tmp', labels: { 'wt.pool': 'rec-workers', role: 'worker' }, argv: ['claude', '--model', 'sonnet'] })
    const [p] = runCalls()
    assert.equal(p.outlive_parent, true); assert.equal(p.no_notify, true)
    assert.deepEqual(p.argv, ['claude', '--model', 'sonnet']); assert.equal(p.cwd, '/tmp'); assert.equal(p.name, 'rec-r')
    assert.deepEqual(p.labels, { 'wt.pool': 'rec-workers', role: 'worker' })
    assert.equal(r.id, 't1')
  })
  test('with a launcher: program is <launch> -- <argv> and WT_LAUNCH_KEYS names the keys set; the env value is in the body, never in argv', async () => {
    use({})
    await hc.spawn({ name: 'rec-r', argv: ['claude'], launch: '/pack/hc-launch', runEnv: { GH_TOKEN: 'ghp_SECRETVALUE', WT_PANE_KEY: 'k3y' } })
    const [p] = runCalls()
    assert.deepEqual(p.argv, ['/pack/hc-launch', '--', 'claude'])
    assert.equal(p.env.GH_TOKEN, 'ghp_SECRETVALUE'); assert.equal(p.env.WT_LAUNCH_KEYS, 'GH_TOKEN,WT_PANE_KEY')
    assert.ok(!JSON.stringify(fake.calls().map((c) => c.args)).includes('SECRETVALUE'), 'no hc argument carries a value')
  })
  test('labels past the limits are refused before hc runs', async () => {
    use({})
    const labels = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']))
    await assert.rejects(hc.spawn({ name: 'rec-a', argv: ['x'], labels }), (e) => e.kind === 'too_many_labels')
    assert.equal(runCalls().length, 0)
  })
  test('CLI: spawn --prefix prints the id and name; --env-names reads VALUES from its own env, not argv', async () => {
    use({})
    const { stdout } = await run(process.execPath, [HC_MJS, 'spawn', '--prefix', 'rec', '--cwd', '/tmp', '--label', 'role=worker', '--taken', 'rec-01', '--launch', '/pack/hc-launch', '--env-names', 'GH_TOKEN', '--', 'sleep', '5'], { env: { ...fake.env, GH_TOKEN: 'ghp_FROMENV' } })
    const o = JSON.parse(stdout); assert.ok(o.id)
    const [p] = runCalls(); assert.equal(p.name, 'rec-02'); assert.equal(p.env.GH_TOKEN, 'ghp_FROMENV')
    assert.ok(!JSON.stringify(fake.calls().map((c) => c.args)).includes('FROMENV'))
  })
  test('CLI: --env-names with an unset name exits 2 and runs nothing', async () => {
    use({})
    await assert.rejects(run(process.execPath, [HC_MJS, 'spawn', '--name', 'ok-name', '--env-names', 'NOPE_NOT_SET', '--', 'sleep'], { env: fake.env }), (e) => e.code === 2)
    assert.equal(runCalls().length, 0)
  })
  test('CLI: a failed spawn exits non-zero with the error on stderr', async () => {
    const bad = { exit: 0, stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad name', data: { kind: 'invalid_params' } } }) + '\n' }
    use({ 'connect:terminal.run': bad })
    await assert.rejects(run(process.execPath, [HC_MJS, 'spawn', '--name', 'ok-name', '--', 'sleep'], { env: fake.env }), (e) => e.code === 6 && JSON.parse(e.stderr).error.kind === 'invalid_params')
  })
  test('CLI: core-up exits 1 when no core is running (and starts nothing)', async () => {
    use({})
    const st = mkdtempSync(join('/tmp', 'hcu-'))
    try { await assert.rejects(run(process.execPath, [HC_MJS, 'core-up'], { env: { ...fake.env, XDG_STATE_HOME: st, HC_SESSION: 'wtt-none' } }), (e) => e.code === 1) } finally { rmSync(st, { recursive: true, force: true }) }
    assert.equal(fake.calls().length, 0)
  })
})

describe('kill and rm', () => {
  test('killRm: kill then rm; a missing terminal is fine', async () => {
    use({ kill: 'not_found', rm: 'not_found' })
    await hc.killRm('gone')
    assert.deepEqual([argsOf('kill').length, argsOf('rm').length], [1, 1])
  })
  test('killRm: a real failure is not swallowed', async () => {
    use({ kill: { exit: 1, stdout: '', stderr: '{"error":{"kind":"unavailable","message":"core down"}}\n' } })
    await assert.rejects(hc.killRm('t1'), (e) => e.kind === 'unavailable')
  })
})

describe('coreUp (never starts a core)', () => {
  test('false with no lock file, and it ran no hc', async () => {
    use({})
    const st = mkdtempSync(join(tmpdir(), 'hc-state-'))
    assert.equal(await hc.coreUp({ env: { XDG_STATE_HOME: st, HC_SESSION: 'nosuch' } }), false)
    assert.equal(fake.calls().length, 0); rmSync(st, { recursive: true, force: true })
  })
  test('true when the socket named in core.lock accepts, false when it does not', async () => {
    const st = mkdtempSync(join(tmpdir(), 'hc-state-'))
    const sockDir = mkdtempSync(join(tmpdir(), 'hcs-')); const sock = join(sockDir, 's.sock')
    mkdirSync(join(st, 'herdr-core', 'wtt-u1'), { recursive: true })
    writeFileSync(join(st, 'herdr-core', 'wtt-u1', 'core.lock'), sock)
    const env = { XDG_STATE_HOME: st, HC_SESSION: 'wtt-u1' }
    assert.equal(await hc.coreUp({ env }), false, 'stale lock, nothing listening')
    const srv = createServer(() => {}); await new Promise((r) => srv.listen(sock, r))
    try { assert.equal(await hc.coreUp({ env }), true) } finally { srv.close(); rmSync(st, { recursive: true, force: true }); rmSync(sockDir, { recursive: true, force: true }) }
  })
})

// Opt-in: the real hc on an ISOLATED core. WT_REAL_HC=1 HC_SESSION=wtt-<id> XDG_STATE_HOME=<scratch> XDG_RUNTIME_DIR=<scratch> (short paths: 103-byte socket limit).
const real = process.env.WT_REAL_HC === '1' && process.env.HC_SESSION && process.env.HC_SESSION !== 'default' && process.env.XDG_STATE_HOME
describe('real hc (WT_REAL_HC=1, isolated session)', { skip: real ? false : 'set WT_REAL_HC=1 HC_SESSION=wtt-x XDG_STATE_HOME=… to run' }, () => {
  test('spawn, label, list, send refused for a program, kill and rm', async () => {
    const made = []
    try {
      const r = await hc.spawnNumbered({ prefix: `wtt-real${process.pid}`, cwd: tmpdir(), labels: { 'wt.pool': 'real-test', role: 'worker' }, argv: ['sleep', '120'] })
      made.push(r.id)
      await hc.setLabels(r.id, { model: 'sonnet', task: 'x'.repeat(200) })
      const row = (await hc.list()).find((t) => t.id === r.id)
      assert.equal(row.labels.model, 'sonnet'); assert.equal(row.labels.task.length, 80); assert.ok(row.alive)
      await assert.rejects(hc.send(r.id, 'nope', { ifIdle: true }), (e) => e.kind === 'status_mismatch')
      await hc.clearLabel(r.id, 'task')
      assert.equal((await hc.get(r.id)).labels.task, undefined)
    } finally { for (const t of made) await hc.killRm(t).catch(() => {}) }
  })
})

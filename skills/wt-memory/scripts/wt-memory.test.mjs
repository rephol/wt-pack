// node --test: merge order, empty-scope skipping, inference from herdr tokens and git, and never failing loudly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = new URL('./wt-memory', import.meta.url).pathname
const home = mkdtempSync(join(tmpdir(), 'wt-memory-'))
const fakeBin = join(home, 'bin')
mkdirSync(join(home, 'roles'), { recursive: true })
mkdirSync(join(home, 'projects'))
mkdirSync(fakeBin)
writeFileSync(join(home, 'global.md'), 'G1\n')
writeFileSync(join(home, 'roles', 'worker.md'), '<!-- template only -->\n')
writeFileSync(join(home, 'roles', 'planner.md'), '<!--\n  template\n-->\nP1 <!-- note -->')
writeFileSync(join(home, 'projects', 'demo.md'), 'D1')
// A fake herdr that answers `pane get` with role/project tokens.
writeFileSync(join(fakeBin, 'herdr'), `#!/bin/sh\necho '{"result":{"pane":{"cwd":"/nowhere","tokens":{"role":"planner","project":"demo"}}}}'\n`)
chmodSync(join(fakeBin, 'herdr'), 0o755)
// Run it once now: macOS scans a new executable on its first launch (~0.7s), past the CLI's 500ms herdr timeout.
execFileSync(join(fakeBin, 'herdr'))

// Jev off unless a test turns it on with a stub judge: tests never call the real API.
const run = (args, env = {}) => execFileSync(BIN, args, { encoding: 'utf8', env: { ...process.env, HERDR_PANE_ID: '', WT_MEMORY_HOME: home, WT_JEV_MEMORY_DUP: 'off', WT_JEV_MEMORY_SUGGEST: 'off', ...env } }).trimEnd()

test('merges global → role → project with headings', () => {
  assert.equal(run(['context', '--role', 'planner', '--project', 'demo', '--cwd', '/']),
    '## Global preferences\n\nG1\n\n## Role preferences (planner)\n\nP1\n\n## Project preferences (demo)\n\nD1')
})
test('skips empty and template-only scopes, and bad names', () => {
  assert.equal(run(['context', '--role', 'worker', '--project', '../etc', '--cwd', '/']), '## Global preferences\n\nG1')
})
test('prints nothing when every scope is empty', () => {
  assert.equal(run(['context', '--cwd', '/'], { WT_MEMORY_HOME: join(home, 'none') }), '')
})
test('infers role and project from the herdr pane tokens', () => {
  const out = run(['context'], { HERDR_PANE_ID: 'w1:p1', PATH: `${fakeBin}:${process.env.PATH}` })
  assert.match(out, /\(planner\)[\s\S]*\(demo\)/)
})
test('WT_ROLE (a headless run, no pane) selects the role context (WP-307)', () => {
  assert.match(run(['context', '--cwd', '/'], { WT_ROLE: 'planner' }), /Role preferences \(planner\)\n\nP1/)
})
test('falls back to the git repo name of the cwd', () => {
  const repo = join(home, 'demo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  assert.match(run(['context', '--cwd', repo]), /Project preferences \(demo\)/)
})
test('a broken herdr still exits 0', () => {
  writeFileSync(join(fakeBin, 'herdr'), '#!/bin/sh\nexit 7\n')
  assert.equal(run(['context', '--cwd', '/'], { HERDR_PANE_ID: 'w1:p1', PATH: `${fakeBin}:${process.env.PATH}` }), '## Global preferences\n\nG1')
})
test('hash changes with content', () => {
  const a = run(['hash', '--cwd', '/'])
  writeFileSync(join(home, 'global.md'), 'G2')
  assert.notEqual(run(['hash', '--cwd', '/']), a)
  assert.match(a, /^[0-9a-f]{16}$/)
})
test('remember / dedupe / list / forget, and context hides trailers', () => {
  const h = mkdtempSync(join(tmpdir(), 'wt-memory-r-'))
  const r = (args) => run(args, { WT_MEMORY_HOME: h })
  assert.match(r(['remember', 'Never push to main', '--project', 'demo']), /^remembered \(project demo\) [0-9a-f]{6}/)
  assert.match(r(['remember', 'never push to MAIN!', '--project', 'demo']), /already remembered/)
  const [e] = JSON.parse(r(['list', '--json']))
  assert.equal(e.text, 'Never push to main')
  assert.equal(r(['context', '--project', 'demo', '--cwd', '/']), '## Project preferences (demo)\n\n- Never push to main')
  r(['forget', e.id])
  assert.equal(r(['context', '--project', 'demo', '--cwd', '/']), '')
})
test('global is a proposal until accepted', () => {
  const h = mkdtempSync(join(tmpdir(), 'wt-memory-g-'))
  const r = (args) => run(args, { WT_MEMORY_HOME: h })
  const id = r(['remember', 'Answer in English', '--scope', 'global']).match(/awaiting approval\) ([0-9a-f]{6})/)[1]
  assert.equal(r(['context', '--cwd', '/']), '')
  r(['accept', id])
  assert.equal(r(['context', '--cwd', '/']), '## Global preferences\n\n- Answer in English')
  assert.equal(JSON.parse(r(['list', '--json'])).filter((e) => e.pending).length, 0)
})
test('MCP server: initialize, tools/list, remember, list, error', () => {
  const h = mkdtempSync(join(tmpdir(), 'wt-memory-mcp-'))
  const reqs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: { note: 'Use pnpm', project: 'demo' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'forget', arguments: { id: 'zz' } } },
  ]
  const out = execFileSync(new URL('../mcp/server.mjs', import.meta.url).pathname, {
    input: reqs.map((r) => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8',
    env: { ...process.env, HERDR_PANE_ID: '', WT_MEMORY_HOME: h, WT_JEV_MEMORY_DUP: 'off' },
  }).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(out.map((m) => m.id), [1, 2, 3, 4, 5])
  assert.equal(out[0].result.protocolVersion, '2025-06-18')
  assert.deepEqual(out[1].result.tools.map((t) => t.name), ['remember', 'forget', 'list', 'context'])
  assert.match(out[2].result.content[0].text, /^remembered \(project demo\)/)
  assert.equal(JSON.parse(out[3].result.content[0].text)[0].text, 'Use pnpm')
  assert.equal(out[4].result.isError, true)
})

// ---- Jev (stub judge through WT_TYPESAFE_MODULE) ----
const stub = (body) => { const f = join(mkdtempSync(join(tmpdir(), 'ts-stub-')), 'typesafe.mjs'); writeFileSync(f, body); return f }
const stubAnswers = (answers) => stub(`export const enabled = (f, d) => { const v = process.env['WT_JEV_' + f.toUpperCase()]; return v == null ? d : v === 'on' }
export const minFor = (_f, d) => d
export const judge = async () => (${JSON.stringify(answers)})`)
test('remember + Jev: similar/conflict printed and still written; --strict refuses; null judge = unchanged', () => {
  const h = mkdtempSync(join(tmpdir(), 'wt-memory-jev-'))
  const r = (args, ans) => run(args, { WT_MEMORY_HOME: h, WT_JEV_MEMORY_DUP: 'on', WT_TYPESAFE_MODULE: stubAnswers(ans) })
  r(['remember', 'Always run web tests before committing', '--scope', 'project', '--project', 'demo'], null)
  assert.match(r(['remember', 'Run web tests prior to each commit', '--scope', 'project', '--project', 'demo'], { e0: { choice: 'duplicate' } }),
    /^similar to: Always run web tests before committing\nremembered \(project demo\)/)
  assert.throws(() => r(['remember', 'Never run tests before committing', '--scope', 'project', '--project', 'demo', '--strict'], { e0: { choice: 'conflicts' }, e1: { choice: 'unrelated' } }),
    (e) => e.status === 1 && /conflicts with: Always run web tests/.test(e.stdout) && /refused/.test(e.stderr))
  assert.match(r(['remember', 'Use pnpm', '--scope', 'project', '--project', 'demo'], null), /^remembered \(project demo\)/)
  assert.equal(JSON.parse(run(['list', '--json'], { WT_MEMORY_HOME: h })).length, 3)
})

const HOOK = new URL('../claude-plugin/hooks/inject.mjs', import.meta.url).pathname
const hook = (input, env) => execFileSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8',
  env: { ...process.env, HERDR_PANE_ID: '', WT_MEMORY_HOME: home, WT_MEMORY_BIN: BIN, HOME: mkdtempSync(join(tmpdir(), 'hook-home-')), ...env } })
test('hook + Jev suggest: a standing preference adds the remember hint; off or no answer adds nothing', () => {
  const ev = { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'from now on always answer in English', cwd: '/' }
  const on = hook(ev, { WT_JEV_MEMORY_SUGGEST: 'on', WT_TYPESAFE_MODULE: stubAnswers({ standing: { noul: 0.93 } }) })
  assert.match(JSON.parse(on).hookSpecificOutput.additionalContext, /looks like a standing preference/)
  const off = hook(ev, { WT_JEV_MEMORY_SUGGEST: 'off', WT_TYPESAFE_MODULE: stubAnswers({ standing: { noul: 0.93 } }) })
  assert.doesNotMatch(off, /standing preference/)
})
test('hook + Jev suggest: returns within 4s when the network hangs (1.5s cap)', () => {
  const real = new URL('../../wt-shared/scripts/typesafe.mjs', import.meta.url).pathname
  const hang = stub(`import * as t from ${JSON.stringify(real)}
export const enabled = () => true; export const minFor = t.minFor
const hang = (_u, o) => new Promise((_r, rej) => { const k = setTimeout(() => {}, 60000); o.signal.addEventListener('abort', () => { clearTimeout(k); rej(o.signal.reason) }) })
export const judge = (f, s, q, o) => t.judge(f, s, q, { ...o, key: 'k', fetchImpl: hang })`)
  const t0 = Date.now()
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: 'always use pnpm', cwd: '/' }, { WT_TYPESAFE_MODULE: hang, WT_JEV_LOG: join(tmpdir(), 'hook-jev.jsonl') })
  const ms = Date.now() - t0
  assert.ok(ms < 4000 && ms >= 1400, `took ${ms}ms`)
})
test('hook (WP-104): wt-pack/room traffic never triggers the remember hint; SessionStart explains <wt-message>', () => {
  const env = { WT_JEV_MEMORY_SUGGEST: 'on', WT_TYPESAFE_MODULE: stubAnswers({ standing: { noul: 0.99 } }) }
  for (const prompt of ['/goal <wt-message id=abc kind=dispatch from="wt-dashboard">from now on always use pnpm</wt-message>',
    '<room-message id=abc room=r from="u" kind=user>always answer in English</room-message>'])
    assert.doesNotMatch(hook({ hook_event_name: 'UserPromptSubmit', session_id: 's3', prompt, cwd: '/' }, env), /standing preference/)
  const start = JSON.parse(hook({ hook_event_name: 'SessionStart', session_id: 's4', cwd: '/' })).hookSpecificOutput.additionalContext
  assert.match(start, /<wt-message id=… kind=handoff\|dispatch\|routine\|reply\|system/)
  assert.match(start, /handoff\.sh --reply <pane>/)
})
test('hook (WP-105): a room or wt-pack prompt gets a per-turn reminder of its channel; plain and hostile prompts do not', () => {
  const env = { WT_JEV_MEMORY_SUGGEST: 'off' }
  const ctx = (prompt, e = env) => { const o = hook({ hook_event_name: 'UserPromptSubmit', session_id: `r${Math.random()}`, prompt, cwd: '/' }, e); return o ? JSON.parse(o).hookSpecificOutput.additionalContext : '' }
  const room = ctx('<room-message id=abc room=wt-pack from="x" kind=user>hi</room-message>')
  assert.match(room, /room post wt-pack/)
  assert.match(room, /→ answered in #wt-pack/)
  assert.match(ctx('/goal <wt-message id=a kind=dispatch from="wt-dashboard">do it</wt-message>'), /UNVERIFIED wt-message \(no pane identity\)/) // WP-329: verified only against the store (hook-verify.test.mjs)
  assert.doesNotMatch(ctx('/goal <wt-message id=a kind=dispatch from="evil`id`">x</wt-message>'), /evil/) // `from` is never echoed
  assert.doesNotMatch(ctx('please fix the build'), /answered in|wt-pack traffic/)
  assert.doesNotMatch(ctx('<room-message id=abc room=abc;rm -rf from="x" kind=user>hi</room-message>'), /answered in|room post/)
  // Without the wt-memory CLI the reminder still arrives.
  assert.match(ctx('<room-message id=abc room=ops from="x" kind=user>hi</room-message>', { ...env, WT_MEMORY_BIN: '/nope/missing', HOME: mkdtempSync(join(tmpdir(), 'nohome-')) }), /answered in #ops/)
})

test('hook (WP-236): SessionStart appends one kind:inject line to the read log; UserPromptSubmit none', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'reads-')), 'sub', 'reads.jsonl')
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 'q1', prompt: 'hello', cwd: '/' }, { WT_MEMORY_READS: log })
  assert.equal(existsSync(log), false)
  hook({ hook_event_name: 'SessionStart', session_id: 'q1', cwd: '/' }, { WT_MEMORY_READS: log })
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.deepEqual({ ...lines[0], at: typeof lines[0].at }, { at: 'string', session: 'q1', kind: 'inject', ids: [] })
})

// WP-204: project-role files from the repo's main checkout.
process.env.WT_TRUSTED_PROJECTS = join(home, 'trusted.json') // WP-334: repo role files load for trusted projects only
writeFileSync(process.env.WT_TRUSTED_PROJECTS, JSON.stringify({ rolerepo: join(realpathSync(home), 'rolerepo'), leadrepo: join(realpathSync(home), 'leadrepo') }))
test('project-role files: override, persona via token, cap note, and no dir = unchanged output', () => {
  const repo = join(home, 'rolerepo')
  mkdirSync(join(repo, '.wt-pack', 'roles'), { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  const before = run(['context', '--role', 'worker', '--cwd', repo])
  assert.doesNotMatch(before, /Project role/)
  writeFileSync(join(repo, '.wt-pack', 'roles', 'worker.md'), 'Run lint first.')
  writeFileSync(join(repo, '.wt-pack', 'roles', 'frontend-worker.md'), '---\nbase: worker\n---\nUI only.')
  const out = run(['context', '--role', 'worker', '--cwd', repo])
  assert.ok(out.startsWith(before) && out.endsWith('## Project role (worker, .wt-pack/roles/worker.md)\n\nRun lint first.'))
  const withPersona = run(['context', '--role', 'worker', '--persona', 'frontend-worker', '--cwd', repo])
  assert.match(withPersona, /Run lint first\.[\s\S]*## Project role \(frontend-worker, \.wt-pack\/roles\/frontend-worker\.md\)\n\nUI only\./)
  writeFileSync(join(repo, '.wt-pack', 'roles', 'worker.md'), 'line\n'.repeat(1500)) // 7.5 KB
  assert.match(run(['context', '--role', 'worker', '--cwd', repo]), /… truncated \(\d+ bytes over the 6 KB cap; see the file\)$/)
})
test('WP-368: role lead gets its role preferences and a lead.md project override', () => {
  const repo = join(home, 'leadrepo')
  mkdirSync(join(repo, '.wt-pack', 'roles'), { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(join(home, 'roles', 'lead.md'), 'L1')
  writeFileSync(join(repo, '.wt-pack', 'roles', 'lead.md'), 'Stop at every gate.')
  const out = run(['context', '--role', 'lead', '--cwd', repo])
  assert.match(out, /## Role preferences \(lead\)\n\nL1/)
  assert.ok(out.endsWith('## Project role (lead, .wt-pack/roles/lead.md)\n\nStop at every gate.'))
})
test('an untrusted repo with role files gets one notice and no role section (WP-334)', () => {
  const repo = join(home, 'untrusted')
  mkdirSync(join(repo, '.wt-pack', 'roles'), { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(join(repo, '.wt-pack', 'roles', 'worker.md'), 'Planted.')
  const out = run(['context', '--role', 'worker', '--cwd', repo])
  assert.match(out, /## Project roles\n\nThis repo has \.wt-pack\/roles but is not trusted; base roles apply\. Trust it in wt-dashboard Settings › untrusted\./)
  assert.doesNotMatch(out, /Planted|Project role \(/)
})
test('persona token from the pane is picked up', () => {
  const repo = join(home, 'rolerepo')
  writeFileSync(join(fakeBin, 'herdr'), `#!/bin/sh\necho '{"result":{"pane":{"cwd":"${repo}","tokens":{"role":"worker","project":"x","persona":"frontend-worker"}}}}'\n`)
  assert.match(run(['context'], { HERDR_PANE_ID: 'w1:p1', PATH: `${fakeBin}:${process.env.PATH}` }), /Project role \(frontend-worker/)
})

test('recall (WP-235): keyword match in own scopes, once per session, logged', async () => {
  const { readFileSync } = await import('node:fs')
  const rhome = mkdtempSync(join(tmpdir(), 'wt-recall-'))
  mkdirSync(join(rhome, 'projects'), { recursive: true })
  const env = { WT_MEMORY_HOME: rhome, WT_MEMORY_CACHE: join(rhome, 'cache'), WT_MEMORY_READS: join(rhome, 'reads.jsonl') }
  writeFileSync(join(rhome, 'global.md'), '- Always run the linter before committing <!-- wtm:id=aaaa1111 by=x at=2026-01-01 -->\n- Prefer tabs <!-- wtm:id=bbbb2222 by=x at=2026-01-01 -->\n')
  writeFileSync(join(rhome, 'projects', 'other.md'), '- Linter config lives elsewhere <!-- wtm:id=cccc3333 by=x at=2026-01-01 -->\n')
  const rec = (p) => run(['recall', p, '--session', 's1', '--project', 'demo'], env)
  assert.equal(rec('please run the linter now'), '- Always run the linter before committing') // not the other project's entry, not unrelated "tabs"
  assert.equal(rec('run the linter again'), '') // already shown this session
  assert.equal(run(['recall', 'run the linter', '--session', 's2', '--project', 'demo'], env), '- Always run the linter before committing')
  const log = readFileSync(env.WT_MEMORY_READS, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(log.map((l) => [l.session, l.kind, l.ids]), [['s1', 'recall', ['aaaa1111']], ['s2', 'recall', ['aaaa1111']]])
})

// ---- WP-369 U1: UserPromptSubmit sends only the changed lines ----
const { diffPrefs } = await import('../claude-plugin/hooks/prefdiff.mjs').catch(() => ({ diffPrefs: null }))
test('diffPrefs: add, remove, edit, new/vanished section, identical, CRLF', () => {
  assert.ok(diffPrefs, 'prefdiff.mjs exports diffPrefs')
  const base = '## Global preferences\n\n- a\n- b\n\n## Role preferences (w)\n\n- r1'
  const add = diffPrefs(base, base + '\n- r2')
  assert.match(add, /^Preferences changed/); assert.match(add, /## Role preferences \(w\)\n\+ - r2/); assert.doesNotMatch(add, /- a|r1/)
  const rm = diffPrefs(base, base.replace('\n- b', ''))
  assert.match(rm, /## Global preferences\n- - b/)
  const ed = diffPrefs(base, base.replace('- r1', '- r1x'))
  assert.match(ed, /- - r1\n\+ - r1x/)
  assert.match(diffPrefs(base, base + '\n\n## Project preferences (p)\n\n- p1'), /## Project preferences \(p\)\n\+ - p1/)
  assert.match(diffPrefs(base, '## Global preferences\n\n- a\n- b'), /## Role preferences \(w\)\n- - r1/)
  assert.equal(diffPrefs(base, base), null)
  assert.equal(diffPrefs(base, base.replace(/\n/g, '\r\n').replace('- a', '- a  ')), null)
})

const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
function hookEnv() {
  const wm = mkdtempSync(join(tmpdir(), 'wp369-wm-')), hh = mkdtempSync(join(tmpdir(), 'wp369-home-'))
  mkdirSync(join(wm, 'roles')); mkdirSync(join(wm, 'projects'))
  writeFileSync(join(wm, 'global.md'), 'GLOBAL-LINE\n')
  writeFileSync(join(wm, 'roles', 'worker.md'), '- worker-one\n- worker-two\n')
  writeFileSync(join(wm, 'roles', 'orchestrator.md'), '- orch-only-line\n')
  writeFileSync(join(wm, 'projects', 'demo.md'), '- demo-line\n')
  const cache = join(hh, '.cache', 'wt-memory')
  const h = (event, extra = {}, env = {}) => { const o = execFileSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: event, session_id: 'sx', cwd: '/', prompt: 'hello', ...extra }), encoding: 'utf8',
    env: { ...process.env, HERDR_PANE_ID: '', WT_ROLE: 'worker', WT_MEMORY_HOME: wm, WT_MEMORY_BIN: BIN, HOME: hh, WT_JEV_MEMORY_SUGGEST: 'off', ...env } }); return o ? JSON.parse(o).hookSpecificOutput.additionalContext : '' }
  return { wm, hh, cache, h }
}
test('hook (WP-369): edit after SessionStart → only the changed lines, not the rest', () => {
  const { wm, h } = hookEnv()
  const start = h('SessionStart')
  assert.match(start, /GLOBAL-LINE[\s\S]*worker-one[\s\S]*demo-line|GLOBAL-LINE[\s\S]*worker-one/)
  assert.doesNotMatch(start, /orch-only-line/)
  writeFileSync(join(wm, 'roles', 'worker.md'), '- worker-one\n- worker-NEW\n')
  const out = h('UserPromptSubmit')
  assert.match(out, /Preferences changed/); assert.match(out, /\+ - worker-NEW/); assert.match(out, /- - worker-two/)
  assert.doesNotMatch(out, /worker-one|GLOBAL-LINE|Preferences updated/)
  assert.equal(h('UserPromptSubmit'), '') // nothing changed since
})
test('hook (WP-369): an edit to another role file is no change for a worker', () => {
  const { wm, h } = hookEnv()
  h('SessionStart')
  writeFileSync(join(wm, 'roles', 'orchestrator.md'), '- orch-changed\n')
  assert.equal(h('UserPromptSubmit'), '')
})
test('hook (WP-369): no .ctx but a stale .hash, or a .ctx that is not the text of .hash → full Preferences updated', () => {
  const { wm, cache, h } = hookEnv()
  h('SessionStart')
  rmSync(join(cache, 'sx.ctx'), { force: true })
  writeFileSync(join(wm, 'roles', 'worker.md'), '- worker-one\n- worker-NEW\n')
  const a = h('UserPromptSubmit')
  assert.match(a, /^Preferences updated:\n\n## Global preferences/); assert.match(a, /worker-one/)
  writeFileSync(join(wm, 'roles', 'worker.md'), '- worker-three\n')
  writeFileSync(join(cache, 'sx.ctx'), '## Global preferences\n\nsomething else')
  const b = h('UserPromptSubmit')
  assert.match(b, /^Preferences updated:\n\n/); assert.doesNotMatch(b, /Preferences changed/)
  assert.equal(sha16(readFileSync(join(cache, 'sx.ctx'), 'utf8')), readFileSync(join(cache, 'sx.hash'), 'utf8'))
})
test('hook (WP-369): every preference removed → (all standing preferences were removed)', () => {
  const { wm, h } = hookEnv()
  h('SessionStart')
  for (const f of ['global.md', 'roles/worker.md', 'projects/demo.md']) writeFileSync(join(wm, f), '')
  assert.match(h('UserPromptSubmit', { cwd: '/' }, { WT_MEMORY_HOME: wm }), /all standing preferences were removed/)
})

// ---- WP-369 U1b: a failed pane lookup is not a preference change ----
function paneShim(ok) {
  const d = mkdtempSync(join(tmpdir(), 'wp369-shim-'))
  writeFileSync(join(d, 'herdr'), ok === 'ok' ? `#!/bin/sh\necho '{"result":{"pane":{"cwd":"/","tokens":{"role":"worker"}}}}'\n` : ok === 'norole' ? `#!/bin/sh\necho '{"result":{"pane":{"cwd":"/","tokens":{}}}}'\n` : '#!/bin/sh\nexit 1\n')
  chmodSync(join(d, 'herdr'), 0o755); try { execFileSync(join(d, 'herdr'), { stdio: 'ignore' }) } catch {}
  return d
}
const runRaw = (args, env) => { try { return { code: 0, out: execFileSync(BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, WT_MEMORY_HOME: home, WT_JEV_MEMORY_DUP: 'off', ...env } }).trimEnd() } } catch (e) { return { code: e.status, out: String(e.stdout ?? '') } } }
test('context --strict-pane: failing herdr → exit 75, empty; without the flag unchanged; no role token is not a failure', () => {
  const bad = paneShim('bad'), none = paneShim('norole')
  const env = (d) => ({ HERDR_PANE_ID: 'p1', WT_ROLE: '', PATH: `${d}:${process.env.PATH}` })
  const s = runRaw(['context', '--cwd', '/', '--strict-pane'], env(bad))
  assert.equal(s.code, 75); assert.equal(s.out, '')
  const n = runRaw(['context', '--cwd', '/'], env(bad))
  assert.equal(n.code, 0); assert.match(n.out, /## Global preferences/)
  assert.equal(runRaw(['context', '--cwd', '/', '--strict-pane'], env(none)).code, 0)
})
test('hook (WP-369 U1b): herdr failing on a prompt → no preference text, .hash kept; healthy again → only the edited line', () => {
  const { wm, cache, h } = hookEnv()
  const ok = paneShim('ok'), bad = paneShim('bad')
  const pe = (d) => ({ WT_ROLE: '', HERDR_PANE_ID: 'p1', PATH: `${d}:${process.env.PATH}` })
  h('SessionStart', {}, pe(ok))
  const before = readFileSync(join(cache, 'sx.hash'), 'utf8')
  writeFileSync(join(wm, 'roles', 'worker.md'), '- worker-one\n- worker-NEW\n')
  assert.equal(h('UserPromptSubmit', {}, pe(bad)), '')
  assert.equal(readFileSync(join(cache, 'sx.hash'), 'utf8'), before)
  const out = h('UserPromptSubmit', {}, pe(ok))
  assert.match(out, /\+ - worker-NEW/); assert.match(out, /- - worker-two/); assert.doesNotMatch(out, /worker-one|GLOBAL-LINE/)
})

// ---- WP-369 U4: [role: x] / [project: y] line tags ----
test('tags: filter by role/persona/project in global, role and project files; strip the tag; fail open', () => {
  const t = mkdtempSync(join(tmpdir(), 'wp369-tags-')); mkdirSync(join(t, 'roles')); mkdirSync(join(t, 'projects'))
  writeFileSync(join(t, 'global.md'), [
    '- [role: orchestrator] only-orch', '- for-all', '- [role: a, b] a-or-b', '- [role: orchestrator] [project: p] orch-in-p',
    '- [role: orchestrator] multi first', '  multi continuation', '- [role: x-persona] persona-line', '- [WIP] wip-line', '- [role: bad/name] badname-line', '- [project: p] proj-only'].join('\n') + '\n')
  writeFileSync(join(t, 'roles', 'a.md'), '- [project: p] role-file-tagged\n')
  writeFileSync(join(t, 'projects', 'p.md'), '- [role: zzz] proj-file-tagged\n- plain-proj\n')
  const c = (...a) => runRaw(['context', '--cwd', '/', ...a], { WT_MEMORY_HOME: t, WT_ROLE: '' }).out
  const w = c('--role', 'worker', '--project', 'p')
  assert.doesNotMatch(w, /only-orch|a-or-b|orch-in-p|multi|persona-line|proj-file-tagged/)
  assert.match(w, /- for-all/); assert.match(w, /- \[WIP\] wip-line/); assert.match(w, /- \[role: bad\/name\] badname-line/); assert.match(w, /- proj-only/)
  const o = c('--role', 'orchestrator', '--project', 'p')
  assert.match(o, /- only-orch/); assert.match(o, /- orch-in-p/); assert.match(o, /- multi first\n  multi continuation/); assert.doesNotMatch(o, /\[role: orchestrator\]/)
  assert.doesNotMatch(c('--role', 'orchestrator', '--project', 'q'), /orch-in-p|proj-only/)
  assert.match(c('--role', 'a', '--project', 'p'), /- a-or-b/); assert.match(c('--role', 'b'), /- a-or-b/)
  assert.match(c('--role', 'worker', '--persona', 'x-persona'), /- persona-line/)
  assert.match(c('--role', 'a', '--project', 'p'), /role-file-tagged/); assert.doesNotMatch(c('--role', 'a', '--project', 'q'), /role-file-tagged/)
  assert.match(c('--role', 'zzz', '--project', 'p'), /- proj-file-tagged/); assert.doesNotMatch(w, /\[project: p\]/)
  assert.doesNotMatch(c(), /only-orch|a-or-b|persona-line/) // no role at all: role-tagged lines dropped
})
test('tags: remember writes tags, dup compares tags, list --json carries them, accept keeps them', () => {
  const t = mkdtempSync(join(tmpdir(), 'wp369-rem-')); const r = (a) => run(a, { WT_MEMORY_HOME: t })
  assert.match(r(['remember', 'x', '--scope', 'project', '--project', 'p', '--role', 'orchestrator']), /^remembered \(project p\)/)
  assert.match(readFileSync(join(t, 'projects', 'p.md'), 'utf8'), /^- \[role: orchestrator\] x <!-- wtm:id=[0-9a-f]{6} /)
  assert.match(r(['remember', 'x', '--scope', 'project', '--project', 'p', '--role', 'orchestrator']), /already remembered/)
  assert.match(r(['remember', 'x', '--scope', 'project', '--project', 'p', '--role', 'worker']), /^remembered/)
  assert.match(r(['remember', 'y', '--scope', 'role', '--role', 'r']), /^remembered \(role r\)/)
  assert.match(readFileSync(join(t, 'roles', 'r.md'), 'utf8'), /^- y <!--/)
  const id = r(['remember', 'g', '--scope', 'global', '--role', 'r']).match(/awaiting approval\) ([0-9a-f]{6})/)[1]
  assert.deepEqual(JSON.parse(r(['list', '--json'])).find((e) => e.id === id).tags, { role: ['r'] })
  r(['accept', id]); assert.match(readFileSync(join(t, 'global.md'), 'utf8'), /^- \[role: r\] g </)
  const l = JSON.parse(r(['list', '--json'])); const x = l.find((e) => e.text === 'x' && e.tags?.role?.[0] === 'orchestrator')
  assert.equal(x.text, 'x'); assert.deepEqual(x.tags, { role: ['orchestrator'] }); assert.equal('tags' in l.find((e) => e.text === 'y'), false)
  assert.match(r(['list']), /\[role: orchestrator\] x/)
})
test('tags: recall never returns a line tagged for another role', () => {
  const t = mkdtempSync(join(tmpdir(), 'wp369-rec-')); writeFileSync(join(t, 'global.md'), '- [role: orchestrator] Always run the linter <!-- wtm:id=aaaa1111 by=x at=2026-01-01 -->\n')
  const env = { WT_MEMORY_HOME: t, WT_MEMORY_CACHE: join(t, 'c'), WT_MEMORY_READS: join(t, 'r.jsonl'), WT_ROLE: '' }
  assert.equal(runRaw(['recall', 'run the linter', '--session', 's', '--role', 'worker'], env).out, '')
  assert.equal(runRaw(['recall', 'run the linter', '--session', 's', '--role', 'orchestrator'], env).out, '- Always run the linter')
})
test('hook (WP-369 U4): an edit to an orchestrator-tagged global line is no change for a worker', () => {
  const { wm, h } = hookEnv()
  writeFileSync(join(wm, 'global.md'), '- GLOBAL-LINE\n- [role: orchestrator] orch-tag v1\n')
  const start = h('SessionStart'); assert.doesNotMatch(start, /orch-tag/)
  writeFileSync(join(wm, 'global.md'), '- GLOBAL-LINE\n- [role: orchestrator] orch-tag v2\n')
  assert.equal(h('UserPromptSubmit'), '')
})

// ---- WP-369 U2: the context already holds only global + own role + own project ----
test('scoping (WP-369 U2): worker context never has orchestrator text; a project file only for its own project; same through the hook', () => {
  const { h } = hookEnv()
  const t = mkdtempSync(join(tmpdir(), 'wp369-sc-')); mkdirSync(join(t, 'roles')); mkdirSync(join(t, 'projects'))
  writeFileSync(join(t, 'roles', 'orchestrator.md'), '- ORCH-X\n'); writeFileSync(join(t, 'roles', 'worker.md'), '- WORK-X\n'); writeFileSync(join(t, 'projects', 'p1.md'), '- P1-X\n')
  const cc = (...a) => runRaw(['context', '--cwd', '/', ...a], { WT_MEMORY_HOME: t, WT_ROLE: '' }).out
  assert.doesNotMatch(cc('--role', 'worker', '--project', 'p1'), /ORCH-X/); assert.match(cc('--role', 'worker', '--project', 'p1'), /WORK-X[\s\S]*P1-X/)
  assert.doesNotMatch(cc('--role', 'worker', '--project', 'p2'), /P1-X/)
  assert.doesNotMatch(h('SessionStart'), /ORCH-X|orch-only-line/)
})

// ---- WP-369 review fixes ----
test('hook (WP-369 review): a failed pane lookup still emits the recall block, no preference text, .hash kept', () => {
  const { wm, cache, h } = hookEnv()
  const ok = paneShim('ok'), bad = paneShim('bad')
  const pe = (d) => ({ WT_ROLE: '', HERDR_PANE_ID: 'p1', PATH: `${d}:${process.env.PATH}` })
  h('SessionStart', {}, pe(ok))
  const before = readFileSync(join(cache, 'sx.hash'), 'utf8')
  writeFileSync(join(wm, 'global.md'), 'GLOBAL-LINE\n- Always run the zebra linter <!-- wtm:id=aaaa1111 by=x at=2026-01-01 -->\n')
  const out = h('UserPromptSubmit', { prompt: 'please run the zebra linter' }, pe(bad))
  assert.match(out, /Memories that match this prompt/); assert.match(out, /zebra linter/)
  assert.doesNotMatch(out, /Preferences (updated|changed)|GLOBAL-LINE/)
  assert.equal(readFileSync(join(cache, 'sx.hash'), 'utf8'), before)
})
test('tags: a blank line inside a dropped tagged bullet does not end the skip', () => {
  const t = mkdtempSync(join(tmpdir(), 'wp369-blank-'))
  writeFileSync(join(t, 'global.md'), '- [project: x] secret\n\n  more after blank\n- plain\n')
  const out = runRaw(['context', '--cwd', '/', '--project', 'y'], { WT_MEMORY_HOME: t, WT_ROLE: '' }).out
  assert.doesNotMatch(out, /secret|more after blank/); assert.match(out, /- plain/)
})
test('remember: tags written in the note text are parsed once and dedupe on the second call', () => {
  const t = mkdtempSync(join(tmpdir(), 'wp369-nt-')); mkdirSync(join(t, 'projects'))
  const r = (a) => runRaw(a, { WT_MEMORY_HOME: t, WT_ROLE: '' }).out
  assert.match(r(['remember', '[role: orchestrator] x', '--scope', 'project', '--project', 'p']), /^remembered/)
  assert.match(r(['remember', '[role: orchestrator] x', '--scope', 'project', '--project', 'p']), /already remembered/)
  assert.equal(readFileSync(join(t, 'projects', 'p.md'), 'utf8').trim().split('\n').length, 1)
  assert.match(readFileSync(join(t, 'projects', 'p.md'), 'utf8'), /^- \[role: orchestrator\] x </)
})

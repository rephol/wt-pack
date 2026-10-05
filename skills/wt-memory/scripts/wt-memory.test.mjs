// node --test: merge order, empty-scope skipping, inference from herdr tokens and git, and never failing loudly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
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
  assert.equal(run(['context', '--role', 'planner', '--project', 'demo']),
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
  assert.match(ctx('/goal <wt-message id=a kind=dispatch from="wt-dashboard">do it</wt-message>'), /kind=dispatch/)
  assert.doesNotMatch(ctx('/goal <wt-message id=a kind=dispatch from="evil`id`">x</wt-message>'), /evil/) // `from` is never echoed
  assert.doesNotMatch(ctx('please fix the build'), /answered in|wt-pack traffic/)
  assert.doesNotMatch(ctx('<room-message id=abc room=abc;rm -rf from="x" kind=user>hi</room-message>'), /answered in|room post/)
  // Without the wt-memory CLI the reminder still arrives.
  assert.match(ctx('<room-message id=abc room=ops from="x" kind=user>hi</room-message>', { ...env, WT_MEMORY_BIN: '/nope/missing', HOME: mkdtempSync(join(tmpdir(), 'nohome-')) }), /answered in #ops/)
})

// WP-204: project-role files from the repo's main checkout.
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
  assert.deepEqual(log.map((l) => [l.session, l.ids]), [['s1', ['aaaa1111']], ['s2', ['aaaa1111']]])
})

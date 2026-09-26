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

const run = (args, env = {}) => execFileSync(BIN, args, { encoding: 'utf8', env: { ...process.env, HERDR_PANE_ID: '', WT_MEMORY_HOME: home, ...env } }).trimEnd()

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

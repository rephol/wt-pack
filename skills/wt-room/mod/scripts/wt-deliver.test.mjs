// Run: node --test skills/wt-room/mod/scripts/wt-deliver.test.mjs — WP-320: a claude nested inside a terminal's claude
// inherits HC_TERMINAL_ID but must not take the terminal's deliveries. WP-378: the terminal's parent is the holder
// `<dir>/hc hold --socket …` (or `herdr-core hold …`), whose own ancestors (the core, the shell that started it) do not count.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'wt-deliver-'))
const hit = join(tmp, 'curl.hit')
symlinkSync('/bin/sh', join(tmp, 'claude')) // a symlink to sh, so ps comm is `claude`
symlinkSync('/bin/sh', join(tmp, 'lone')) // run with no arguments (script on stdin): its ps args are ONE word
// The holder: a script named hc (or herdr-core) started as `hc hold --socket S <cmd>`; its ps args read `/bin/sh <dir>/hc hold --socket S …`.
for (const n of ['hc', 'herdr-core']) { writeFileSync(join(tmp, n), '#!/bin/sh\nshift 3\neval "$1"\n'); chmodSync(join(tmp, n), 0o755) }
writeFileSync(join(tmp, 'curl'), `#!/bin/sh\necho hit >> ${hit}\nprintf '{}\\n200'\n`); chmodSync(join(tmp, 'curl'), 0o755)
const deliver = join(import.meta.dirname, 'wt-deliver')
const q = (c) => `'${c.replaceAll("'", `'\\''`)}'`
// depth = claudes below the holder; above = claudes above it (the core started from an agent's shell); holder = hc | herdr-core | none
const run = (depth, { above = 0, holder = 'hc', env = { HC_TERMINAL_ID: 't7' }, decoy = false, bash = '', lone = false } = {}) => {
  rmSync(hit, { force: true })
  let cmd = `${bash ? bash + ' ' : ''}${deliver} hello; echo $? > ${tmp}/rc`
  for (let i = 0; i < depth; i++) cmd = `${tmp}/claude -c ${q(cmd)}${decoy && i === depth - 1 ? ' x "see hc hold --socket y herdr-core hold z"' : ''}; :`
  if (holder !== 'none') cmd = `${tmp}/${holder} hold --socket /x/holder.t7.sock ${q(cmd)}; :`
  for (let i = 0; i < above; i++) cmd = `${tmp}/claude -c ${q(cmd)}; :`
  if (lone) spawnSync(join(tmp, 'lone'), [], { input: cmd, env: { PATH: `${tmp}:${process.env.PATH}`, ...env } })
  else spawnSync('sh', ['-c', cmd], { env: { PATH: `${tmp}:${process.env.PATH}`, ...env } })
  return existsSync(hit)
}

test('the pane\'s own (outermost) claude reaches the dashboard', () => assert.equal(run(1), true))
test('a claude nested inside it does not', () => assert.equal(run(2), false))

test('WP-378: claudes above the hc holder (the core was started from an agent) do not count', () => {
  assert.equal(run(1, { above: 1 }), true)
  assert.equal(run(2, { above: 1 }), false)
})
test('WP-378: the holder may be herdr-core hold', () => {
  assert.equal(run(1, { holder: 'herdr-core', above: 1 }), true)
  assert.equal(run(2, { holder: 'herdr-core', above: 1 }), false)
})
test('WP-378: an hc process that is not a holder (no `hold` argument) is no boundary', () => {
  // `hc run …` in the chain: the claude above it still counts, so two claudes means nested
  assert.equal(run(1, { holder: 'none', above: 1 }), false)
})
test('WP-378: without HC_TERMINAL_ID it stands down; the old pane id alone is no identity', () => {
  assert.equal(run(1, { env: {} }), false)
  assert.equal(run(1, { env: { HERDR_PANE_ID: 'w1:p1' } }), false) // legacy-herdr
})
test('WP-378 F5: only an argv[0] hc/herdr-core with `hold` next is the holder: a claude whose args merely mention `hc hold` is no boundary', () => {
  assert.equal(run(2, { decoy: true }), false, 'the decoy outer claude must still count as a nested claude')
  assert.equal(run(1, { decoy: true }), true, 'a lone claude with such args still reaches the dashboard')
})

// WP-378 F6: an ancestor whose args are ONE word (a login shell `-zsh`, a bare `claude`) has no W[1]/W[2]; bash 4.4+/5 under `set -u` aborts on an
// unset array element, which read as "stand down" and silently cut the pane's deliveries. Runs under /bin/bash (3.2 on macOS) and a newer bash if present.
const newerBash = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/usr/bin/bash'].filter(existsSync).filter((b) => spawnSync(b, ['-c', '[ "${BASH_VERSINFO[0]}" -ge 4 ]']).status === 0)
for (const b of ['/bin/bash', ...newerBash]) {
  test(`WP-378 F6: a one-word ancestor in the process tree does not abort the walk (${b})`, () => {
    assert.equal(run(1, { bash: b, lone: true }), true)
    assert.equal(run(2, { bash: b, lone: true }), false)
  })
}
test('WP-378 F6: is_holder indexes the word array with a default (set -u safe on every bash)', () => {
  const src = readFileSync(deliver, 'utf8')
  assert.match(src, /set -u/)
  assert.deepEqual(src.match(/\$\{W\[\d\](?![-:}#]*-)[^}]*\}/g) ?? [], [], 'every ${W[n]} needs a ${W[n]-} default')
})

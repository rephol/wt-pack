// Run: node --test skills/wt-room/mod/scripts/wt-deliver.test.mjs — WP-320: a claude nested inside a terminal's claude
// inherits HC_TERMINAL_ID but must not take the terminal's deliveries. WP-378: the terminal's parent is the holder
// `<dir>/hc hold --socket …` (or `herdr-core hold …`), whose own ancestors (the core, the shell that started it) do not count.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'wt-deliver-'))
const hit = join(tmp, 'curl.hit')
symlinkSync('/bin/sh', join(tmp, 'claude')) // a symlink to sh, so ps comm is `claude`
// The holder: a script named hc (or herdr-core) started as `hc hold --socket S <cmd>`; its ps args read `/bin/sh <dir>/hc hold --socket S …`.
for (const n of ['hc', 'herdr-core']) { writeFileSync(join(tmp, n), '#!/bin/sh\nshift 3\neval "$1"\n'); chmodSync(join(tmp, n), 0o755) }
writeFileSync(join(tmp, 'curl'), `#!/bin/sh\necho hit >> ${hit}\nprintf '{}\\n200'\n`); chmodSync(join(tmp, 'curl'), 0o755)
const deliver = join(import.meta.dirname, 'wt-deliver')
const q = (c) => `'${c.replaceAll("'", `'\\''`)}'`
// depth = claudes below the holder; above = claudes above it (the core started from an agent's shell); holder = hc | herdr-core | none
const run = (depth, { above = 0, holder = 'hc', env = { HC_TERMINAL_ID: 't7' } } = {}) => {
  rmSync(hit, { force: true })
  let cmd = `${deliver} hello; echo $? > ${tmp}/rc`
  for (let i = 0; i < depth; i++) cmd = `${tmp}/claude -c ${q(cmd)}; :`
  if (holder !== 'none') cmd = `${tmp}/${holder} hold --socket /x/holder.t7.sock ${q(cmd)}; :`
  for (let i = 0; i < above; i++) cmd = `${tmp}/claude -c ${q(cmd)}; :`
  spawnSync('sh', ['-c', cmd], { env: { PATH: `${tmp}:${process.env.PATH}`, ...env } })
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

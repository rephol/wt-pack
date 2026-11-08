// Run: node --test skills/wt-room/mod/scripts/wt-deliver.test.mjs — WP-320: a claude nested inside a pane's claude
// inherits HERDR_PANE_ID but must not take the pane's deliveries.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'wt-deliver-'))
const hit = join(tmp, 'curl.hit')
for (const n of ['claude', 'herdr']) { symlinkSync('/bin/sh', join(tmp, n)) } // symlinks to sh, so ps comm is that name
writeFileSync(join(tmp, 'curl'), `#!/bin/sh\necho hit >> ${hit}\nprintf '{}\\n200'\n`); chmodSync(join(tmp, 'curl'), 0o755)
const deliver = join(import.meta.dirname, 'wt-deliver')
const run = (depth) => {
  rmSync(hit, { force: true })
  let cmd = `${deliver} hello; echo $? > ${tmp}/rc`
  for (let i = 0; i < depth; i++) cmd = `${tmp}/claude -c '${cmd.replaceAll("'", `'\\''`)}'; :`
  cmd = `${tmp}/herdr -c '${cmd.replaceAll("'", `'\\''`)}'; :`
  spawnSync('sh', ['-c', cmd], { env: { PATH: `${tmp}:${process.env.PATH}`, HERDR_PANE_ID: 'w1:p1' } })
  return existsSync(hit)
}

test('the pane\'s own (outermost) claude reaches the dashboard', () => assert.equal(run(1), true))
test('a claude nested inside it does not', () => assert.equal(run(2), false))

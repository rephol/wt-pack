// Run: node --test skills/wt-agents/scripts/kill-guard.test.mjs — WP-120 pkill/pgrep/killall PATH shim.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { refuse } from './kill-guard.mjs'

const bin = join(import.meta.dirname, '..', 'bin')

test('refuses an option after the pattern (the WP-109/WP-120 kill), allows options first', () => {
  assert.match(refuse('pkill', ['-f', 'tsx src/index.ts', '-n']), /after the pattern/)
  assert.match(refuse('pgrep', ['-f', 'apps/worker', '-U', '501']), /after the pattern/)
  assert.match(refuse('killall', ['node', '-9']), /after the pattern/)
  assert.equal(refuse('pkill', ['-n', '-f', 'tsx src/index.ts']), null)
  assert.equal(refuse('pkill', ['-9', '-U', '501', '-f', 'vite --port 5219']), null)
  assert.equal(refuse('pkill', ['-KILL', 'node']), null)
  assert.equal(refuse('killall', ['-9', 'node']), null)
  assert.equal(refuse('pkill', ['-f', '--', 'tsx src/index.ts']), null)
})

test('refuses a -f / killall -m pattern under 6 characters or starting with "-"', () => {
  assert.match(refuse('pkill', ['-f', 'tsx']), /too broad/)
  assert.match(refuse('pgrep', ['-lf', 'node']), /too broad/)
  assert.match(refuse('pkill', ['-f', '--', '-n']), /too broad/)
  assert.match(refuse('killall', ['-m', 'ab']), /too broad/)
  assert.equal(refuse('pkill', ['node']), null) // exact-name match without -f: not broad
  assert.equal(refuse('pkill', ['-F', '/tmp/x.pid']), null) // -F takes a pidfile, not -f
})

test('bin shims: refused → exit 2 without running the real binary; allowed → the real exit status', () => {
  let r = spawnSync(join(bin, 'pgrep'), ['-f', 'wt-kill-guard-no-such-proc', '-n'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /refused/)
  r = spawnSync(join(bin, 'pgrep'), ['-f', 'wt-kill-guard-no-such-proc'], { encoding: 'utf8' })
  assert.equal(r.status, 1) // real pgrep: no match
  r = spawnSync('sh', ['-c', `WT_KILL_SHIM_DIR=${bin}; PATH=/usr/bin:/bin; . ${join(bin, 'env.sh')}; command -v pkill`], { encoding: 'utf8' })
  assert.equal(r.stdout.trim(), join(bin, 'pkill'))
})

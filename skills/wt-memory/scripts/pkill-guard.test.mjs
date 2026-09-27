import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { misordered } from '../claude-plugin/hooks/pkill-guard.mjs'

const hook = fileURLToPath(new URL('../claude-plugin/hooks/pkill-guard.mjs', import.meta.url))
const run = (command) => execFileSync('node', [hook], { input: JSON.stringify({ tool_input: { command } }) }).toString()

test('denies the WP-109 incident command', () => {
  assert.ok(misordered('pkill -f "node server.mjs" -U $(id -u) -n'))
  assert.ok(misordered('cd x && pgrep -lf zzz -U 501 -n'))
  const out = JSON.parse(run('pkill -f "node server.mjs" -U $(id -u) -n'))
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
})

test('allows correctly ordered and unrelated commands', () => {
  for (const c of ['pkill -U 1 -n -f "x"', 'kill 123', 'echo pkill', 'pgrep -U 501 -f "a -n"', 'git commit -m "pkill -f x -n"'])
    assert.equal(misordered(c), null, c)
  assert.equal(run('pkill -U 1 -n -f "x"'), '')
})

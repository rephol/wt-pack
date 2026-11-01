// WP-378: the ~/.local/bin/claude guard, on a temp HOME only (never the user's link).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quietEnv, snapshot, verify } from './claude-link-guard.mjs'

const GUARD = new URL('./claude-link-guard.mjs', import.meta.url).pathname
function home() {
  const h = mkdtempSync(join(tmpdir(), 'clg-'))
  mkdirSync(join(h, '.local/bin'), { recursive: true }); mkdirSync(join(h, 'real')); writeFileSync(join(h, 'real/v1'), 'x'); writeFileSync(join(h, 'real/v2'), 'y')
  symlinkSync(join(h, 'real/v1'), join(h, '.local/bin/claude'))
  return h
}

test('unchanged link passes', () => {
  const h = home(); try { assert.equal(verify(snapshot(h), h), null) } finally { rmSync(h, { recursive: true, force: true }) }
})
test('red proof: a repointed link fails the check', () => {
  const h = home()
  try {
    const s = snapshot(h)
    unlinkSync(join(h, '.local/bin/claude')); symlinkSync(join(h, 'real/v2'), join(h, '.local/bin/claude'))
    assert.match(verify(s, h), /changed/)
  } finally { rmSync(h, { recursive: true, force: true }) }
})
test('red proof: a link left dangling fails, and so does a removed one', () => {
  const h = home()
  try {
    const s = snapshot(h)
    unlinkSync(join(h, 'real/v1'))
    assert.match(verify(s, h), /does not resolve/)
    unlinkSync(join(h, '.local/bin/claude'))
    assert.match(verify(s, h), /changed/)
  } finally { rmSync(h, { recursive: true, force: true }) }
})
test('CLI: snapshot then check exits 0, then 1 after a repoint (temp HOME)', () => {
  const h = home(), f = join(h, 'snap.json'), env = { ...process.env, HOME: h }
  try {
    execFileSync('node', [GUARD, 'snapshot', f], { env })
    execFileSync('node', [GUARD, 'check', f], { env })
    unlinkSync(join(h, '.local/bin/claude')); symlinkSync(join(h, 'real/v2'), join(h, '.local/bin/claude'))
    assert.equal(spawnSync('node', [GUARD, 'check', f], { env }).status, 1)
  } finally { rmSync(h, { recursive: true, force: true }) }
})
test('quietEnv disables the updater and drops an isolated XDG_DATA_HOME', () => {
  const e = quietEnv({ XDG_DATA_HOME: '/tmp/x', A: '1' })
  assert.equal(e.DISABLE_AUTOUPDATER, '1'); assert.equal(e.XDG_DATA_HOME, undefined); assert.equal(e.A, '1')
})

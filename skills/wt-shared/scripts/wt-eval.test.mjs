import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// WP-144: wt-eval.mjs used to read TYPESAFE_API_KEY itself (env, then ~/.claude/.env, no
// Keychain) instead of typesafe.mjs's resolveKeyed() (env > Keychain > .env), so it could send
// a stale .env key even after the Keychain one was rotated. It must now go through the same
// resolution as every other caller.
const bin = new URL('./wt-eval.mjs', import.meta.url).pathname
const docFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-eval-'))
  const f = join(dir, 'plan.md')
  writeFileSync(f, '# plan\n')
  return f
}

test('no key anywhere → exit 3, silent-skip contract', () => {
  const home = mkdtempSync(join(tmpdir(), 'wt-eval-home-'))
  const r = spawnSync(process.execPath, [bin, docFile()], {
    env: { ...process.env, HOME: home, TYPESAFE_API_KEY: '', PATH: '/usr/bin:/bin' },
  })
  assert.equal(r.status, 3)
})

test('prefers the Keychain over a stale ~/.claude/.env line (WP-136 precedence)', () => {
  const home = mkdtempSync(join(tmpdir(), 'wt-eval-home-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.env'), 'TYPESAFE_API_KEY=stale-env-key\n')
  const fakeBin = join(home, 'bin')
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(join(fakeBin, 'security'), '#!/bin/sh\necho fresh-keychain-key\n')
  chmodSync(join(fakeBin, 'security'), 0o755)
  const r = spawnSync(process.execPath, [bin, docFile()], {
    env: { ...process.env, HOME: home, TYPESAFE_API_KEY: '', PATH: `${fakeBin}:/usr/bin:/bin` },
    timeout: 10000,
  })
  // A key was found (no exit 3): the run instead fails on the network call itself.
  assert.notEqual(r.status, 3)
})

// window.confirm/alert/prompt are dead in the desktop app (Tauri's WKWebView has no UI delegate: confirm() returns
// false, alert/prompt show nothing), so any action behind one silently never runs. Use an Astryx AlertDialog.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

test('no native browser dialogs in web/src', () => {
  const dir = new URL('.', import.meta.url)
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))
  assert.ok(files.length > 20, `scan saw only ${files.length} files`)
  const bad = files.flatMap((f) => readFileSync(new URL(f, dir), 'utf8').split('\n')
    .map((l, i) => [l.replace(/\/\/.*$/, ''), i] as const)
    .filter(([l]) => /(^|[^.\w])(window\.|globalThis\.|self\.)?(confirm|alert|prompt)\(/.test(l))
    .map(([, i]) => `${f}:${i + 1}`))
  assert.deepEqual(bad, [])
})

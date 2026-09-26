// Run: node --test webfresh.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webStale, freshener } from './webfresh.mjs'

async function web({ src, built }) {
  const w = await mkdtemp(join(tmpdir(), 'webfresh-'))
  await mkdir(join(w, 'src', 'deep'), { recursive: true })
  await mkdir(join(w, 'node_modules'), { recursive: true })
  await writeFile(join(w, 'src', 'deep', 'App.tsx'), 'x')
  await writeFile(join(w, 'node_modules', 'newer.js'), 'x') // never counts
  const t = (s) => new Date(s * 1000)
  await utimes(join(w, 'src', 'deep', 'App.tsx'), t(src), t(src))
  await utimes(join(w, 'node_modules', 'newer.js'), t(9e9), t(9e9))
  if (built) { await mkdir(join(w, 'dist')); await writeFile(join(w, 'dist', 'index.html'), 'x'); await utimes(join(w, 'dist', 'index.html'), t(built), t(built)) }
  return w
}

test('webStale: no build, older build, newer build; node_modules ignored (WP-81)', async () => {
  assert.equal(await webStale(await web({ src: 1000 })), true)
  assert.equal(await webStale(await web({ src: 2000, built: 1000 })), true)
  assert.equal(await webStale(await web({ src: 1000, built: 2000 })), false)
})

test('freshener: builds only when stale, one build at a time, reports failure', async () => {
  let builds = 0
  const w = await web({ src: 2000, built: 1000 })
  const run = freshener({ web: w, build: async () => { builds++; await new Promise((r) => setTimeout(r, 20)) } })
  assert.deepEqual(await Promise.all([run(), run()]), [true, true]) // the second call shares the first build
  assert.equal(builds, 1)
  let failed = null
  const bad = freshener({ web: w, build: async () => { throw new Error('tsc failed') }, onFail: (e) => { failed = e.message } })
  assert.equal(await bad(), false)
  assert.equal(failed, 'tsc failed')
  assert.equal(await freshener({ web: await web({ src: 1000, built: 2000 }), build: () => { throw new Error('no') } })(), false)
})

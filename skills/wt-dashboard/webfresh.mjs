// WP-81: the web UI is static files the server only serves, so a merge that changes web/src changes nothing the
// user sees until someone runs the build — and several shipped tickets went unseen that way. The server checks
// the sources against dist/index.html (the same test as ./setup doctor's `built`) and rebuilds when they are newer.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Newest mtime (ms) under the given files/dirs; missing paths are skipped. node_modules and dist never count.
export async function newestMtime(paths) {
  let max = 0
  const walk = async (p) => {
    const s = await stat(p).catch(() => null)
    if (!s) return
    if (!s.isDirectory()) { max = Math.max(max, s.mtimeMs); return }
    for (const e of await readdir(p).catch(() => [])) if (e !== 'node_modules' && e !== 'dist') await walk(join(p, e))
  }
  for (const p of paths) await walk(p)
  return max
}

// web: the web/ dir. Stale = no build yet, or a source newer than the build.
export async function webStale(web) {
  const built = (await stat(join(web, 'dist', 'index.html')).catch(() => null))?.mtimeMs ?? 0
  const src = await newestMtime([join(web, 'src'), join(web, 'index.html'), join(web, 'package.json')])
  return src > 0 && src > built
}

// One build at a time; `build()` runs `npm run build` and rejects with its output on failure.
export function freshener({ web, build, onBuilt = () => {}, onFail = () => {} }) {
  let running = null
  return () => (running ??= (async () => {
    if (!(await webStale(web))) return false
    try { await build(); onBuilt(); return true } catch (e) { onFail(e); return false }
  })().finally(() => { running = null }))
}

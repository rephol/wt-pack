// WP-334: repo role files (<checkout>/.wt-pack/roles) load only for projects the user marked trusted
// (project setting trustRepoRoles). Hooks and CLIs cannot open wt.db cheaply, so the server mirrors the trusted
// projects to DATA_ROOT/trusted-projects.json = { "<project>": "<main checkout realpath>" } (0600, atomic).
// wt-shared/scripts/roles.mjs reads it (same default path). Only the server writes.
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const KEY = 'trustRepoRoles'
const read = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } }

// Rewrite the mirror from the settings rows. A trusted project whose checkout is unknown right now (projectRoots()
// is derived from live agents) keeps its previous entry rather than silently losing its roles.
export function syncTrusted({ dataRoot, db, roots }) {
  const file = join(dataRoot, 'trusted-projects.json'), prev = read(file), out = {}
  for (const { project } of db.prepare('SELECT project FROM project_settings WHERE key = ? AND value = ?').all(KEY, 'on')) {
    try { out[project] = realpathSync(roots.get(project) ?? prev[project]) } catch {}
  }
  if (JSON.stringify(out) === JSON.stringify(prev)) return out
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 })
  renameSync(tmp, file)
  return out
}

// Once per data dir (marker file): projects in use today keep their repo roles — the wt-pack repo itself and any
// project with a non-empty .wt-pack/roles. New clones start untrusted (Q5); an explicit row is never overwritten.
// ponytail: grandfathered once at migration; the marker stops a restart re-trusting what the user switched off
export function grandfather({ dataRoot, psettings, roots, log = console.log }) {
  const marker = join(dataRoot, 'trust-grandfathered')
  if (existsSync(marker)) return []
  const done = []
  for (const [project, root] of roots) {
    let has = false
    try { has = readdirSync(join(root, '.wt-pack', 'roles')).some((f) => f.endsWith('.md')) } catch {}
    if ((has || project === 'wt-pack') && psettings.row(project, KEY) == null) { psettings.set(project, KEY, 'on'); done.push(project); log(`trust: ${project} keeps its repo role files (grandfathered; turn off in Settings)`) }
  }
  writeFileSync(marker, new Date().toISOString())
  return done
}

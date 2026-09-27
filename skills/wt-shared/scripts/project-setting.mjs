#!/usr/bin/env node
// Read-only view of the dashboard's project settings (WP-107; wt-dashboard/project-settings.mjs) for shell scripts.
//   project-setting.mjs get <key> [--project P | --cwd DIR]   the project's own value, or nothing
//   project-setting.mjs list-accounts                         project<TAB>githubAccount, one line per project
// Prints only the PROJECT layer: callers keep their own env-var and global fallbacks. The project is the basename of
// the main checkout (git --git-common-dir), as the dashboard and agents.sh name it. Never writes (the server is the
// only writer), never fails: a missing DB, table or project prints nothing and exits 0.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const [cmd, ...rest] = process.argv.slice(2)
const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined }
const file = join(process.env.WT_DASHBOARD_DATA ?? join(homedir(), '.local', 'share', 'wt-dashboard'), 'data', 'wt.db')

function projectOf(dir) {
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return basename(basename(common) === '.git' ? dirname(common) : common.replace(/\.git$/, ''))
  } catch { return null }
}

async function rows(sql, ...args) {
  if (!existsSync(file)) return []
  process.removeAllListeners('warning') // node:sqlite's ExperimentalWarning would land in the caller's output
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare(sql).all(...args) } finally { db.close() }
}

try {
  if (cmd === 'get' && rest[0]) {
    const project = opt('--project') ?? projectOf(resolve(opt('--cwd') ?? '.'))
    if (project) for (const r of await rows('SELECT value FROM project_settings WHERE project = ? AND key = ?', project, rest[0])) console.log(r.value)
  } else if (cmd === 'list-accounts') {
    for (const r of await rows("SELECT project, value FROM project_settings WHERE key = 'githubAccount' ORDER BY project")) console.log(`${r.project}\t${r.value}`)
  } else {
    console.error('usage: project-setting.mjs get <key> [--project P | --cwd DIR] | list-accounts')
    process.exitCode = 2
  }
} catch { /* no table yet, busy, old node: the caller falls back */ }

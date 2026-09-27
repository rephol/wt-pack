// Project settings (WP-107): one value per (project, key) in DATA/wt.db (store.mjs stage 8), layered over the
// global value and then the default. Order: process env var (a real override, as cfg.get) > project > global > default.
// scope 'project' has no global layer; 'overridable' falls back to a config.mjs key (env file / Keychain) or a
// routine_settings row. Board automation stays in `boards` (tickets.settings) — already per project.
// CLIs read the same table read-only through wt-shared/scripts/project-setting.mjs; only the server writes.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { open } from './store.mjs'

const err = (status, m) => Object.assign(new Error(m), { status })
const oneOf = (...vs) => (v) => vs.includes(v) || `one of: ${vs.join(', ')}`
const jev = (label) => ({ scope: 'overridable', label, cfg: true, check: oneOf('on', 'off') })

export const PKEYS = {
  githubAccount: { scope: 'project', label: 'GitHub account',
    check: (v) => /^[A-Za-z0-9-]{1,39}$/.test(v) || 'a GitHub login (letters, digits, -; ≤39)' },
  reviewerGithubAccount: { scope: 'project', label: 'Reviewer GitHub account',
    check: (v) => /^[A-Za-z0-9-]{1,39}$/.test(v) || 'a GitHub login (letters, digits, -; ≤39)' },
  baseBranch: { scope: 'project', label: 'Base branch', default: 'main',
    check: (v) => (!v.startsWith('-') && spawnSync('git', ['check-ref-format', '--branch', v]).status === 0) || 'not a valid branch name' },
  WT_AGENTS_MCP: { scope: 'overridable', label: 'Agent MCP', cfg: true, default: 'full', check: oneOf('full', 'lean') },
  maxWorking: { scope: 'overridable', label: 'Max working agents', routine: true, default: '4',
    check: (v) => (/^\d{1,3}$/.test(v) && Number(v) <= 100) || '0–100' },
  // WP-121: wt-watch-prs dispatch spawns reviewers only while fewer than this are live in <repo>-reviewers.
  maxReviewers: { scope: 'overridable', label: 'Max reviewers', routine: true, default: '2',
    check: (v) => (/^\d{1,2}$/.test(v) && Number(v) <= 20) || '0–20' },
  WT_JEV_TICKET_TRIAGE: jev('Ticket triage'),
}

export class ProjectSettings {
  // cfg: config.mjs Config (the global layer for cfg keys, and env overrides).
  constructor({ dir, cfg, log = console.error }) { Object.assign(this, { file: join(dir, 'wt.db'), cfg, log }) }
  get db() { return open(this.file, { log: this.log }) } // lazy, like Tickets
  row(project, key) { return this.db.prepare('SELECT value FROM project_settings WHERE project = ? AND key = ?').get(project, key)?.value ?? null }
  // The layer under the project value: { value, source: 'global'|'default' }.
  inherited(key) {
    const d = PKEYS[key]
    if (d.cfg && this.cfg && this.cfg.source(key) !== 'default') return { value: this.cfg.get(key), source: 'global' }
    if (d.routine) {
      const v = this.db.prepare('SELECT v FROM routine_settings WHERE k = ?').get(key)?.v
      if (v != null) return { value: v, source: 'global' }
    }
    return { value: d.cfg ? this.cfg?.get(key) ?? d.default ?? null : d.default ?? null, source: 'default' }
  }
  // { value, source: 'env'|'project'|'global'|'default' }. value is a string or null.
  resolve(project, key) {
    const d = PKEYS[key]
    if (!d) throw err(404, `unknown setting ${key}`)
    const env = d.cfg ? this.cfg?.override(key) : null
    if (env != null) return { value: env, source: 'env' }
    const v = project ? this.row(project, key) : null
    return v != null ? { value: v, source: 'project' } : this.inherited(key)
  }
  get(project, key) { return this.resolve(project, key).value }
  list(project) {
    return Object.entries(PKEYS).map(([key, d]) => ({ key, label: d.label, scope: d.scope, ...this.resolve(project, key),
      project: this.row(project, key), inherited: this.inherited(key) }))
  }
  set(project, key, value) {
    const d = PKEYS[key]
    if (!d) throw err(404, `unknown setting ${key}`)
    if (!/^[\w.-]{1,64}$/.test(project ?? '')) throw err(400, 'bad project')
    const v = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : null
    if (!v) throw err(400, 'value required (DELETE resets)')
    const ok = d.check(v)
    if (ok !== true) throw err(400, `${key}: ${ok}`)
    this.db.prepare('INSERT INTO project_settings (project, key, value) VALUES (?, ?, ?) ON CONFLICT(project, key) DO UPDATE SET value = excluded.value').run(project, key, v)
    return this.resolve(project, key)
  }
  reset(project, key) {
    if (!PKEYS[key]) throw err(404, `unknown setting ${key}`)
    this.db.prepare('DELETE FROM project_settings WHERE project = ? AND key = ?').run(project, key)
    return this.resolve(project, key)
  }
}

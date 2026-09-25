// Configurable agent roles (Settings › Roles) and the per-agent tags wt-dashboard mirrors into herdr pane tokens.
// A role resolves as: the pane's `role` token > the role's workspace glob > its name glob > "other".
// Tokens (source "wt-dashboard") are display-only, one merged map per pane, values cut at 80 chars, and they live
// only in the running herdr server — so data/agent-tags.json is the source of truth and they are re-applied.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const DEFAULT_ROLES = [
  { id: 'orchestrator', name: 'Orchestrator', color: 'purple', letter: 'O', match: { workspace: '*-orchestrator', name: '*orchestrator*' }, spawn: null },
  { id: 'planner', name: 'Planner', color: 'blue', letter: 'P', match: { workspace: '*-planners', name: '*planner*' },
    spawn: { start: 'main', workspace: '<repo>-planners', prompt: '/wt-plan ', projects: [] } },
  { id: 'worker', name: 'Worker', color: 'green', letter: 'W', match: { workspace: '*-workers', name: '*worker*' },
    spawn: { start: 'worktree', workspace: '<repo>-workers', prompt: '/wt-work', projects: [] } },
]
export const COLORS = ['blue', 'green', 'purple', 'orange', 'red', 'teal', 'pink', 'gray']
export const TAG_KEYS = ['role', 'project', 'ticket', 'branch', 'spawned_by', 'created']
const ID = /^[a-z][a-z0-9-]{0,20}$/

export function glob(pattern, s) {
  if (!pattern) return false
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
  return re.test(s ?? '')
}

export function resolveRole(roles, { token, workspace, name }) {
  if (token && (token === 'other' || roles.some((r) => r.id === token))) return { id: token, by: 'token' }
  const w = roles.find((r) => glob(r.match?.workspace, workspace))
  if (w) return { id: w.id, by: 'workspace' }
  const n = roles.find((r) => glob(r.match?.name, name))
  return n ? { id: n.id, by: 'name' } : { id: 'other', by: 'none' }
}

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
export function validateRoles(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20) throw Object.assign(new Error('1–20 roles'), { status: 400 })
  const seen = new Set()
  return list.map((r) => {
    const id = str(r?.id, 21).toLowerCase()
    if (!ID.test(id) || id === 'other') throw Object.assign(new Error(`bad role id "${id}" (lowercase letters, digits, dashes; not "other")`), { status: 400 })
    if (seen.has(id)) throw Object.assign(new Error(`duplicate role id "${id}"`), { status: 400 })
    seen.add(id)
    const s = r.spawn
    return {
      id, name: str(r.name, 40) || id, color: COLORS.includes(r.color) ? r.color : 'gray',
      letter: (str(r.letter, 1) || id[0]).toUpperCase(),
      match: { workspace: str(r.match?.workspace, 64), name: str(r.match?.name, 64) },
      spawn: s ? {
        start: ['main', 'worktree', 'choose'].includes(s.start) ? s.start : 'main',
        workspace: str(s.workspace, 64) || `<repo>-${id}s`,
        prompt: typeof s.prompt === 'string' ? s.prompt.slice(0, 2000) : '',
        projects: Array.isArray(s.projects) ? s.projects.filter((p) => typeof p === 'string').slice(0, 50) : [],
      } : null,
    }
  })
}

// Tags an agent gets the first time the dashboard sees it (a one-off backfill from what it can infer).
export function inferTags({ name, role, project, ticket, branch, now = new Date() }) {
  return clean({
    role, project, ticket, branch,
    spawned_by: /-(planner|worker)-\d+$/.test(name ?? '') ? 'wt-agents' : 'manual',
    created: now.toISOString().slice(0, 10),
  })
}
export function clean(tags) {
  const out = {}
  for (const k of TAG_KEYS) { const v = tags?.[k]; if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 80) }
  return out
}
// What to send so the pane's tokens match `want` (only keys we own).
export function tokenDiff(have = {}, want = {}) {
  const set = Object.entries(want).filter(([k, v]) => have[k] !== v)
  const clear = TAG_KEYS.filter((k) => k in have && !(k in want))
  return { set, clear }
}

export class RoleStore {
  constructor(dir) { this.rolesFile = `${dir}/roles.json`; this.tagsFile = `${dir}/agent-tags.json`; this.roles = DEFAULT_ROLES; this.tags = {} }
  async load() {
    try { this.roles = validateRoles(JSON.parse(await readFile(this.rolesFile, 'utf8'))) } catch { this.roles = DEFAULT_ROLES }
    try { this.tags = JSON.parse(await readFile(this.tagsFile, 'utf8')) } catch { this.tags = {} }
    return this
  }
  async saveRoles(list) { this.roles = validateRoles(list); await this.#write(this.rolesFile, this.roles) }
  async setTags(name, tags) { this.tags[name] = clean(tags); await this.saveTags() }
  async saveTags() { await this.#write(this.tagsFile, this.tags) }
  async #write(f, v) { await mkdir(dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(v, null, 2)) }
}

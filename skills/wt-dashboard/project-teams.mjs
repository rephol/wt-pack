// Teams page writes (WP-241): create / edit / delete a repo's team file `<settings root>/teams/<name>.md` in the MAIN
// checkout. Same confinement as project-roles.mjs: the name is validated with NAME before it touches a path, the file
// is never reached through a symlink, nothing is committed.
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { NAME, mainCheckout, settingsRoot } from '../wt-shared/scripts/roles.mjs'
import { TEMPLATES, check, get, teamText, teamsDir, templateText } from '../wt-shared/scripts/teams.mjs'

const bad = (m, status = 400) => Object.assign(new Error(m), { status })
function target(root, name) {
  const co = mainCheckout(root, 3000)
  if (!co) throw bad('not a git repo', 404)
  if (!NAME.test(name ?? '')) throw bad(`bad team name (lowercase letters, digits, -; ≤ 24): ${name}`)
  const dir = teamsDir(co)
  return { co, dir, file: join(dir, `${name}.md`) }
}
const confine = ({ co, dir, file }, mustExist) => {
  mkdirSync(dir, { recursive: true })
  if (!realpathSync(dir).startsWith(realpathSync(settingsRoot(co)) + sep)) throw bad('teams dir is outside the settings root')
  try { if (lstatSync(file).isSymbolicLink()) throw bad('team file is a symlink') } catch (e) { if (e.status) throw e; if (mustExist) throw bad('no such team', 404) }
}
const write = (t, text) => { const tmp = `${t.file}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, t.file) }
const problems = (co, name) => check(co).filter((f) => f.name === name && f.level === 'error').map((f) => f.msg)

// body: { template: solo|standard|full } or { description, members, stages }. Returns the team's error findings.
export function createTeam(root, name, b) {
  const t = target(root, name)
  confine(t)
  if (existsSync(t.file)) throw bad(`team ${name} already exists`, 409)
  const tpl = b.template ? TEMPLATES[b.template] : null
  if (b.template && !tpl) throw bad(`template: ${Object.keys(TEMPLATES).join(', ')}`)
  write(t, tpl ? templateText(name, tpl) : teamText(b, `Notes for ${name} (free-form; not injected into agents).\n`))
  return problems(t.co, name)
}
// Keeps the file's free-form notes; replaces description, members and stages.
export function updateTeam(root, name, b) {
  const t = target(root, name)
  confine(t, true)
  const cur = get(t.co, name)
  if (!cur) throw bad('no such team', 404)
  write(t, teamText(b, cur.body))
  return problems(t.co, name)
}
export function deleteTeam(root, name) {
  const t = target(root, name)
  confine(t, true)
  if (!get(t.co, name)) throw bad('no such team', 404)
  unlinkSync(t.file)
}

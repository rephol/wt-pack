// WP-223: create / hide a dashboard project. Deps are injected so the test runs against a temp $HOME with no server.
//   d = { home, roots(): Map name→root, repoRoot(p), run(cmd,args,cwd,timeout,env), cfg, rooms, spawnOrchestrator?(root) }
import { existsSync, statSync } from 'node:fs'
import { rm, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { validName, validCloneUrl, underHome } from './projectPaths.mjs'

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })
const NAME_MSG = 'lowercase letters, digits, - and _ only (start with a letter or digit, max 32)'
const PROJECTS = 'WT_DASHBOARD_PROJECTS'
const HIDDEN = 'WT_DASHBOARD_HIDDEN_PROJECTS'
const locked = (d, k) => { if (d.cfg.override(k) != null) throw bad(`${k} is set in the server's environment; change it there`, 409) }

export async function createProject(d, b) {
  const { source } = b
  let root, name
  if (source === 'existing') {
    if (typeof b.path !== 'string' || !b.path.startsWith('/')) throw bad('path: an absolute path to a git repository')
    root = await d.repoRoot(b.path)
    if (!underHome(root, d.home)) throw bad('the repository must be inside your home directory')
    name = basename(root)
    if (!validName(name)) throw bad(`folder name "${name}" is not a valid project name (${NAME_MSG}); rename the folder`)
  } else if (source === 'clone' || source === 'init') {
    name = b.name
    if (!validName(name)) throw bad(`name: ${NAME_MSG}`)
    if (typeof b.parent !== 'string' || !b.parent.startsWith('/')) throw bad('parent: an absolute folder path')
    root = join(b.parent, name)
    if (!underHome(root, d.home)) throw bad('the project must be inside your home directory')
    if (!existsSync(b.parent) || !statSync(b.parent).isDirectory()) throw bad(`parent folder does not exist: ${b.parent}`)
    if (existsSync(root)) throw bad(`${root} already exists`, 409)
    if (source === 'clone' && !validCloneUrl(b.url)) throw bad('url: https://…, ssh://… or git@host:path')
  } else throw bad('source: existing, clone or init')

  const hidden = d.cfg.list(HIDDEN)
  if ((await d.roots()).has(name) && !hidden.includes(name)) throw bad(`project "${name}" already exists`, 409)
  locked(d, PROJECTS)
  if (hidden.includes(name)) locked(d, HIDDEN)

  if (source === 'clone') {
    await d.run('git', ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
      'clone', '--no-recurse-submodules', '--', b.url, root], b.parent, 300_000, { GIT_TERMINAL_PROMPT: '0' })
      .catch(async (e) => { await rm(root, { recursive: true, force: true }); throw bad(`git clone failed: ${e.message.trim().slice(0, 300)}`) })
    root = await d.repoRoot(root)
  } else if (source === 'init') {
    try {
      await d.run('git', ['init', '-b', 'main', root], b.parent)
      await d.run('git', ['-C', root, 'commit', '--allow-empty', '-m', 'Initial commit'])
    } catch (e) { await rm(root, { recursive: true, force: true }); throw bad(`git init failed: ${e.message.trim().slice(0, 300)}`) }
  }

  const list = d.cfg.list(PROJECTS)
  if (!list.includes(root)) await d.cfg.setValue(PROJECTS, [...list, root])
  if (hidden.includes(name)) await d.cfg.setValue(HIDDEN, hidden.filter((h) => h !== name))
  const out = { name, root, room: null, orchestrator: null }
  if (b.room !== false) out.room = (await d.rooms.create({ title: name, project: name, slug: name })).slug
  if (b.orchestrator === true && d.spawnOrchestrator) out.orchestrator = await d.spawnOrchestrator(root).catch((e) => ({ error: e.message }))
  return out
}

// Hide: out of the config list and onto the hide list (agent cwds re-add a project otherwise). Deletes nothing on disk.
export async function hideProject(d, name) {
  const root = (await d.roots()).get(name)
  if (!root) throw bad('unknown project', 404)
  locked(d, HIDDEN)
  const list = d.cfg.list(PROJECTS)
  if (list.includes(root)) { locked(d, PROJECTS); await d.cfg.setValue(PROJECTS, list.filter((p) => p !== root)) }
  const hidden = d.cfg.list(HIDDEN)
  if (!hidden.includes(name)) await d.cfg.setValue(HIDDEN, [...hidden, name])
  return { name }
}

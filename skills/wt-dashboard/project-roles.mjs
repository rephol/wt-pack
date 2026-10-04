// Settings › Projects › Roles (WP-204): list, check and write a repo's role files (.wt-pack/roles/<name>.md in the
// MAIN checkout). Never commits: the files are committed like code. A name is validated with roles.mjs's NAME
// before it touches a path, so nothing outside <checkout>/.wt-pack/roles/*.md is ever read or written.
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { NAME, BASES, catalog, check, list, mainCheckout, moveSettings, rolesDir, settingsWhere, userRoot } from '../wt-shared/scripts/roles.mjs'

export const MAX_BYTES = 64 * 1024
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

// `git` = async (repo, ...args) → stdout, injected by the server.
export async function rolesState(root, git) {
  const co = mainCheckout(root, 3000)
  if (!co) throw bad('not a git repo', 404)
  const found = check(co, { catalog: catalog() })
  const files = list(co).map((r) => ({
    name: r.name, kind: r.override ? 'override' : 'persona', base: r.base ?? null, bytes: r.bytes,
    text: readFileSync(r.file, 'utf8'), findings: found.filter((f) => f.name === r.name),
  }))
  const status = await git(co, 'status', '--porcelain', '--', '.wt-pack/roles').catch(() => '')
  return { dir: rolesDir(co), where: settingsWhere(co), userDir: userRoot(co), bases: BASES, files, git: String(status).trim() }
}

export function writeRole(root, name, text) {
  const co = mainCheckout(root, 3000)
  if (!co) throw bad('not a git repo', 404)
  if (!NAME.test(name ?? '')) throw bad(`bad role name (lowercase letters, digits, -; ≤ 24): ${name}`)
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw bad(`text required, up to ${MAX_BYTES} bytes`)
  const dir = rolesDir(co), file = join(dir, `${name}.md`)
  mkdirSync(dir, { recursive: true })
  // never write through a symlink out of the checkout (the directory itself or an existing <name>.md)
  if (!realpathSync(dir).startsWith(realpathSync(settingsWhere(co) === 'user' ? userRoot(co) : co) + sep)) throw bad('roles dir is outside the checkout')
  try { if (lstatSync(file).isSymbolicLink()) throw bad('role file is a symlink') } catch (e) { if (e.status) throw e }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

// WP-234: where this project's settings live. Moves the files across; the repo side is left as uncommitted changes.
export function setLocation(root, where) {
  const co = mainCheckout(root, 3000)
  if (!co) throw bad('not a git repo', 404)
  if (where !== 'repo' && where !== 'user') throw bad('where: repo or user')
  if (settingsWhere(co) === where) return []
  return moveSettings(co, where)
}

// Settings › Projects › Roles (WP-204): list, check and write a repo's role files (.wt-pack/roles/<name>.md in the
// MAIN checkout). Never commits: the files are committed like code. A name is validated with roles.mjs's NAME
// before it touches a path, so nothing outside <checkout>/.wt-pack/roles/*.md is ever read or written.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAME, BASES, catalog, check, list, mainCheckout, rolesDir } from '../wt-shared/scripts/roles.mjs'

export const MAX_BYTES = 64 * 1024
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

// `git` = async (repo, ...args) → stdout, injected by the server.
export async function rolesState(root, git) {
  const co = mainCheckout(root)
  if (!co) throw bad('not a git repo', 404)
  const found = check(co, { catalog: catalog() })
  const files = list(co).map((r) => ({
    name: r.name, kind: r.override ? 'override' : 'persona', base: r.base ?? null, bytes: r.bytes,
    text: readFileSync(r.file, 'utf8'), findings: found.filter((f) => f.name === r.name),
  }))
  const status = await git(co, 'status', '--porcelain', '--', '.wt-pack/roles').catch(() => '')
  return { dir: rolesDir(co), bases: BASES, files, git: String(status).trim() }
}

export function writeRole(root, name, text) {
  const co = mainCheckout(root)
  if (!co) throw bad('not a git repo', 404)
  if (!NAME.test(name ?? '')) throw bad(`bad role name (lowercase letters, digits, -; ≤ 24): ${name}`)
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw bad(`text required, up to ${MAX_BYTES} bytes`)
  const dir = rolesDir(co), file = join(dir, `${name}.md`)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

#!/usr/bin/env node
// WP-378: spikes, recorders and QA runs start throwaway claude terminals under an isolated env. A `claude` started with an
// isolated XDG_DATA_HOME ran its installer and repointed the user's ~/.local/bin/claude into the scratch dir (dangling after
// cleanup). This guard snapshots where ~/.local/bin/claude points and fails when it differs afterwards. It never writes the link.
//   claude-link-guard.mjs snapshot <file>   record the link target (or "absent") in <file>
//   claude-link-guard.mjs check <file>      exit 1 unless the link is the recorded target AND still resolves
// Library: snapshot(home?), verify(snap, home?) -> null | problem text; quietEnv(env) -> env for isolated children.
import { lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const linkOf = (home) => join(home || homedir(), '.local', 'bin', 'claude')

export function snapshot(home = process.env.HOME) {
  const path = linkOf(home)
  try {
    const st = lstatSync(path)
    return { path, kind: st.isSymbolicLink() ? 'link' : 'file', target: st.isSymbolicLink() ? readlinkSync(path) : null }
  } catch { return { path, kind: 'absent', target: null } }
}

export function verify(snap, home = process.env.HOME) {
  const now = snapshot(home)
  if (now.kind !== snap.kind || now.target !== snap.target) return `${snap.path} changed: ${snap.kind} ${snap.target ?? ''} -> ${now.kind} ${now.target ?? ''}`
  if (snap.kind === 'link') { try { realpathSync(snap.path) } catch { return `${snap.path} -> ${snap.target} does not resolve` } }
  return null
}

// Env for a child that may run claude in isolation: no auto-update/installer, and never an isolated XDG_DATA_HOME
// (claude keeps its versions dir and the ~/.local/bin link under it).
export function quietEnv(env = process.env) {
  const e = { ...env, DISABLE_AUTOUPDATER: '1', DISABLE_INSTALLATION_CHECKS: '1', DISABLE_UPDATES: '1' }
  delete e.XDG_DATA_HOME
  return e
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2)
  if (cmd === 'snapshot' && file) { writeFileSync(file, JSON.stringify(snapshot())); console.log(`recorded ${snapshot().path}`) }
  else if (cmd === 'check' && file) {
    const bad = verify(JSON.parse(readFileSync(file, 'utf8')))
    if (bad) { console.error(`claude-link-guard: ${bad}`); process.exit(1) }
    console.log('claude link unchanged')
  } else { console.error('usage: claude-link-guard.mjs snapshot|check <file>'); process.exit(2) }
}

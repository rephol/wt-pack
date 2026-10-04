// WP-223: validation for the dashboard's "New project" action — pure, no I/O beyond realpath.
import { realpathSync } from 'node:fs'
import { dirname, resolve, sep, join } from 'node:path'

// herdr-safe, and the project key is basename(root): lowercase, digits, - _ (≤32).
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const validName = (n) => typeof n === 'string' && NAME_RE.test(n)

// https://host/…, ssh://host/…, git@host:path. Never file:, ext::, a leading '-', or whitespace/control chars.
export function validCloneUrl(u) {
  if (typeof u !== 'string' || u.length > 500 || /[\s\x00-\x1f]/.test(u) || u.startsWith('-')) return false
  return /^(https|ssh):\/\/[^/@\s]+(@[^/\s]+)?\/\S+$/.test(u) || /^[\w.-]+@[\w.-]+:\S+$/.test(u)
}

// The nearest existing ancestor, realpath'd (a symlink out of $HOME resolves outside it), then the rest re-appended.
export function realish(p) {
  let cur = resolve(p)
  const tail = []
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()) } catch {
      const up = dirname(cur)
      if (up === cur) return resolve(p)
      tail.push(cur.slice(up.length + 1)); cur = up
    }
  }
}
// True when p is strictly inside home (not home itself). No NUL, absolute only.
export function underHome(p, home) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) return false
  const h = realish(home)
  return realish(p).startsWith(h + sep)
}

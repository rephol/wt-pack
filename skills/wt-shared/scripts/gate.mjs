// WP-332: the destructive-action gate's policy, as two pure functions. `classify` names the outward or irreversible action a Bash
// command performs (null = ordinary); `allowed` says whether this turn's origin may do it without asking the user.
// Loose parsing on purpose, like wt-mods' guards.ts: it stops accidents and injected text, not a determined obfuscator
// (`sh -c "$(…)"`, a script that pushes internally). ponytail: pattern list, not a shell parser — extend it when a bypass shows up.
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const words = (seg) => [...seg.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0].replace(/^["']|["']$/g, ''))
// Scratch space is the agent's own: deleting there is not "outside the task".
const TEMP = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()]
const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
const SECRET_VAR = /\$\{?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\}?/

// WP-361: every hit names its rule id (`rule`) and the segment that matched (`segment`: whitespace-collapsed, ≤120 chars), so a deny says
// what to split out of a compound command. Rule ids: push, merge, branch-delete, worktree-remove, gh-pr, rm-outside, upload, secret-var, raw-socket.
export const SEGMENT_MAX = 120
const clip = (seg) => { const t = seg.replace(/\s+/g, ' ').trim(); return t.length > SEGMENT_MAX ? t.slice(0, SEGMENT_MAX - 1) + '…' : t }

// WP-361 localhost exemption: curl (not wget: it follows redirects and re-sends headers by default) whose every URL host is literally 127.0.0.1, localhost or [::1] reach only this machine, so a
// pane-key header or token in it is not "sent off the machine". Strict on purpose: any proxy / connection-rewriting flag, any redirect
// follow (-L: the target is unknowable), any config/input file, any non-http(s) scheme, any glob or userinfo trick, and no URL at all
// all fall back to the normal rules; uploads are never exempt. nc/scp/rsync never are.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const CURL_VALUE = new Set('HXdoumAebcwFTDEKQrtyYzC'.split('')) // curl short options that consume the next word
const CURL_VALUE_LONG = /^--(header|request|data|data-raw|data-binary|data-urlencode|output|user|max-time|connect-timeout|retry|retry-delay|user-agent|referer|cookie|cookie-jar|write-out|json|form|url|oauth2-bearer|range|limit-rate)$/
const NO_EXEMPT = /^(--proxy\S*|--preproxy|--socks\S*|--haproxy\S*|--connect-to|--resolve|--unix-socket|--abstract-unix-socket|--location\S*|--config|--next|--input-file|--execute|--base|--force-html|--ftp-proxy)(=|$)/
const localOnly = (name, raw, env) => {
  if (name !== 'curl' || env.some((e) => /proxy=/i.test(e))) return false
  const urls = []
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k]
    if (t.startsWith('--')) {
      if (NO_EXEMPT.test(t)) return false
      if (t.startsWith('--url=')) urls.push(t.slice(6))
      else if (t === '--url') urls.push(raw[++k] ?? '')
      else if (!t.includes('=') && CURL_VALUE_LONG.test(t)) k++
    } else if (t.startsWith('-') && t.length > 1) {
      if (/^-[a-zA-Z]*[xLK]/.test(t)) return false
      if (CURL_VALUE.has(t[t.length - 1]) && !t.includes('=')) k++
    } else urls.push(t)
  }
  if (!urls.length) return false
  return urls.every((u) => {
    if (/[{}\\\s`]|\$\(/.test(u)) return false
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:[^/?#@]*@)?(\[[^\]/]*\]|[^/?#:\[\]]*)(?::\d*)?(?:[/?#]|$)/i.exec(u)
    return !!m && (!m[1] || /^https?$/i.test(m[1])) && LOCAL_HOSTS.has(m[2].toLowerCase())
  })
}

// WP-361: the shell expands $VAR inside double quotes but not inside single quotes, so the secret-var test reads a segment with its
// single-quoted strings blanked (and double-quoted ones intact). Quote state is tracked left to right: `"it's $K"` stays whole.
const blankSingle = (seg) => {
  let out = '', q = ''
  for (const ch of seg) {
    if (q === "'") { if (ch === "'") { q = ''; out += ch } continue }
    if (!q && ch === "'") { q = ch; out += ch; continue }
    if (ch === '"') q = q === '"' ? '' : q || '"'
    out += ch
  }
  return out
}

// → null | { action, rule, segment }. `ctx`: { cwd, root } — the session's cwd and its worktree/checkout root (for the rm-outside test).
export function classify(cmd, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd(), root = ctx.root ?? cwd
  for (const seg of String(cmd).split(/&&|\|\||[;\n|]/)) {
    const hit = (action, rule) => ({ action, rule, segment: clip(seg) })
    const bare = seg.replace(/"[^"]*"|'[^']*'/g, '""') // words inside a message are not subcommands
    const w = words(bare)
    // strip leading VAR=val and env/sudo/command wrappers
    let i = 0
    while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['env', 'sudo', 'command', 'nohup', 'time'].includes(w[i]))) i++
    const [c, ...rest] = w.slice(i)
    if (!c) continue
    const name = c.split('/').pop()
    if (name === 'git') {
      let j = 0
      while (j < rest.length && rest[j].startsWith('-')) j += /^-[cC]$/.test(rest[j]) ? 2 : 1 // git -C dir / -c k=v
      const sub = rest[j], args = rest.slice(j + 1)
      if (sub === 'push' && !args.includes('--dry-run') && !args.includes('-n')) return args.some((a) => a === '--delete' || a === '-d' || /^:\S/.test(a)) ? hit('delete a remote branch', 'branch-delete') : hit('git push', 'push')
      if (sub === 'merge' && !args.some((a) => ['--abort', '--help', '-h', '--quit'].includes(a))) return hit('git merge', 'merge')
      if (sub === 'branch' && args.some((a) => /^(-D|-d|--delete)$/.test(a))) return hit('delete a branch', 'branch-delete')
      if (sub === 'worktree' && ['remove', 'prune'].includes(args[0])) return hit('remove a worktree', 'worktree-remove')
    } else if (name === 'gh') {
      if (rest[0] === 'pr' && ['approve', 'merge', 'close'].includes(rest[1])) return hit(`gh pr ${rest[1]}`, 'gh-pr')
    } else if (name === 'rm' || name === 'rmdir') {
      for (const t of rest.filter((x) => !x.startsWith('-'))) {
        const p = resolve(cwd, t.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
        if (/[*?$]/.test(t) && !/^[\w./-]*\*?[\w./-]*$/.test(t)) return hit('delete files outside the worktree', 'rm-outside') // $VAR / globbing we cannot place
        if (!inside(p, root) && !TEMP.some((d) => inside(p, d))) return hit('delete files outside the worktree', 'rm-outside')
      }
    } else if (['curl', 'wget', 'scp', 'rsync', 'nc', 'ncat'].includes(name)) {
      const text = rest.join(' '), rawText = words(seg).slice(i + 1).join(' ')
      const CURL_UP = /(^|\s)(-T|--upload-file)(\s|=)|(^|\s)(-d|--data(?:-binary|-raw|-urlencode)?|-F|--form)(\s|=)\S*@|\s-d\s+@|--data\S*\s+@/
      const upload = name === 'curl' ? CURL_UP.test(' ' + text) || CURL_UP.test(' ' + rawText) // rawText: a quoted `-d "@f"` is an upload too
        : name === 'wget' ? /--post-file|--body-file/.test(rawText)
        : name === 'scp' ? rest.some((a) => /^[^-\s/][^\s/]*:/.test(a) && !a.startsWith('http')) && rest.filter((a) => !a.startsWith('-')).length >= 2
        : name === 'rsync' ? rest.some((a) => /^[^-\s/][^\s/]*:/.test(a))
        : true
      const OUT = 'send files or secrets off the machine'
      if (name === 'nc' || name === 'ncat') return hit(OUT, 'raw-socket')
      if (upload) return hit(OUT, 'upload')
      if (localOnly(name, words(seg).slice(i + 1), w.slice(0, i))) continue
      if (SECRET_VAR.test(blankSingle(seg.slice(seg.search(/\b(curl|wget|scp|rsync)\b/))))) return hit(OUT, 'secret-var')
    }
  }
  return null
}

export const ALLOWED_KINDS = ['handoff', 'dispatch', 'routine']
// `turn`: the record inject.mjs writes per prompt: { trust: 'user'|'peer'|'verified'|'unverified', kind, sender, senderRole }.
// A missing/stale record is the caller's `unverified`. mode 'off' = the setting WT_GATE=off.
export const allowed = (turn, mode = 'ask') => {
  if (mode === 'off') return true
  if (turn?.trust === 'peer') return false // WP-357: another Claude session's message (SendMessage) is never the user's word; WT_GATE=off above stays the user's explicit choice
  if (turn?.trust === 'user') return true
  if (turn?.trust !== 'verified') return false
  if (turn.kind === 'reply') return turn.replyAllowed === true // the server checked: current assignee's report on a ticket this orchestrator handed off
  return ALLOWED_KINDS.includes(turn.kind) && (turn.senderRole === 'orchestrator' || turn.senderRole === 'server')
}

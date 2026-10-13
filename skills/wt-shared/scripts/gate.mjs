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

// → null | { action }. `ctx`: { cwd, root } — the session's cwd and its worktree/checkout root (for the rm-outside test).
export function classify(cmd, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd(), root = ctx.root ?? cwd
  for (const seg of String(cmd).split(/&&|\|\||[;\n|]/)) {
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
      if (sub === 'push' && !args.includes('--dry-run') && !args.includes('-n')) return { action: args.some((a) => a === '--delete' || a === '-d' || /^:\S/.test(a)) ? 'delete a remote branch' : 'git push' }
      if (sub === 'merge' && !args.some((a) => ['--abort', '--help', '-h', '--quit'].includes(a))) return { action: 'git merge' }
      if (sub === 'branch' && args.some((a) => /^(-D|-d|--delete)$/.test(a))) return { action: 'delete a branch' }
      if (sub === 'worktree' && ['remove', 'prune'].includes(args[0])) return { action: 'remove a worktree' }
    } else if (name === 'gh') {
      if (rest[0] === 'pr' && ['approve', 'merge', 'close'].includes(rest[1])) return { action: `gh pr ${rest[1]}` }
    } else if (name === 'rm' || name === 'rmdir') {
      for (const t of rest.filter((x) => !x.startsWith('-'))) {
        const p = resolve(cwd, t.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
        if (/[*?$]/.test(t) && !/^[\w./-]*\*?[\w./-]*$/.test(t)) return { action: 'delete files outside the worktree' } // $VAR / globbing we cannot place
        if (!inside(p, root) && !TEMP.some((d) => inside(p, d))) return { action: 'delete files outside the worktree' }
      }
    } else if (['curl', 'wget', 'scp', 'rsync', 'nc', 'ncat'].includes(name)) {
      const text = rest.join(' ')
      const upload = name === 'curl' ? /(^|\s)(-T|--upload-file)(\s|=)|(^|\s)(-d|--data(?:-binary|-raw|-urlencode)?|-F|--form)(\s|=)\S*@|\s-d\s+@|--data\S*\s+@/.test(' ' + text)
        : name === 'wget' ? /--post-file|--body-file/.test(text)
        : name === 'scp' ? rest.some((a) => /^[^-\s/][^\s/]*:/.test(a) && !a.startsWith('http')) && rest.filter((a) => !a.startsWith('-')).length >= 2
        : name === 'rsync' ? rest.some((a) => /^[^-\s/][^\s/]*:/.test(a))
        : true
      if (upload || SECRET_VAR.test(text)) return { action: 'send files or secrets off the machine' }
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

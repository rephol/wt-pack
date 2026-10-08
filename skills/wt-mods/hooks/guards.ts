// WP-208/WP-279 — Bash tool.call guards for wt-pack conventions: a one-line refusal naming the rule and the fix. Loose
// shell parsing on purpose (like wt-memory's pkill-guard.mjs, which stays): it stops accidents, not obfuscation.
import type { Register } from 'claude-code'

const SENDS = /handoff\.sh|wt-room|\broom\s+post|\bherdr\b|wt-ticket|wt-ask/ // commands whose strings reach another agent or a card
const words = (seg: string) => [...seg.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0])
const TAKES_VALUE = new Set('FGgPstUucJjMNd'.split('')) // pkill/pgrep options that consume the next word
const SKILLS_PATH = /(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.claude\/skills\//

// WP-279: `git push --force`/`-f`/`+ref` (--force-with-lease passes), and `pkill|pgrep -f` with a pattern under 6
// characters or starting with "-" (it matches unrelated processes, WP-120).
const forcePush = (w: string[]) => {
  const i = w.findIndex((t) => t === 'push')
  return w[0] === 'git' && i > 0 && w.slice(i + 1).some((t) => t === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) || /^\+\S/.test(t))
}
const broadKill = (w: string[]) => {
  const i = w.findIndex((t) => /^(?:\S*\/)?p(?:kill|grep)$/.test(t))
  if (i < 0) return false
  let full = false
  const ops: string[] = []
  for (let j = i + 1; j < w.length; j++) {
    const t = w[j]
    if (/^-[a-zA-Z]+$/.test(t)) { if (t.includes('f')) full = true; if (TAKES_VALUE.has(t[t.length - 1])) j++ } else if (!/^-\d+$/.test(t)) ops.push(t.replace(/^["']|["']$/g, ''))
  }
  return full && ops.some((p) => p.length < 6 || p.startsWith('-'))
}
// In the main checkout a branch change moves every other agent's base: only a worktree may switch branches.
const branchSwitch = (w: string[]) => {
  const i = w.findIndex((t) => t === 'checkout' || t === 'switch')
  if (w[0] !== 'git' || i < 1 || w.includes('--')) return false
  const rest = w.slice(i + 1)
  if (w[i] === 'switch') return !rest.some((t) => t === '--help' || t === '-h')
  return rest.some((t) => /^(-[bBc]|--orphan|--detach)$/.test(t)) || rest.filter((t) => !t.startsWith('-')).length === 1 // ponytail: `git checkout <file>` is refused too (use `git restore`)
}

// The refusal for a command, or null. Each segment of `a && b ; c` is judged alone. `here`: the session is in a
// wt-pack checkout, where the repo's own rules (no drafts, own paths, repo-local identity) apply; the skills-path
// rule is pack-wide. `main`: that checkout is the main one, not a worktree. Other projects keep wt-ship's draft PRs
// and their own commit habits.
export const guard = (cmd: string, here = true, main = here): string | null => {
  for (const seg of cmd.split(/&&|\|\||[;\n]/)) {
    const bare = seg.replace(/"[^"]*"|'[^']*'/g, '""') // flags inside a message are not flags
    const gh = /\bgh\s+pr\s+create\b/.test(bare) && /(^|\s)(--draft|-d)(\s|=|$)/.test(bare)
    if (gh && here) return 'wt-pack: no draft PRs. Drop --draft: review, merge to main, push.'
    if (here && /\bgit\s+(?:-c\s+\S+\s+|-\S+\s+)*commit\b/.test(seg)) {
      if (/\bcommit\b[^|]*\s-[a-zA-Z]*a[a-zA-Z]*(\s|$)|--all\b/.test(bare)) return 'wt-pack: never `git commit -a`. Commit only your own paths: `git commit <paths>`.'
      if (/--author\b|\s-c\s+user\.(name|email)|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)=/.test(bare)) return 'wt-pack: commits use the repo-local git identity. Drop --author / -c user.* / GIT_AUTHOR_*; fix it with `./setup doctor`.'
    }
    const w = words(bare)
    if (here && forcePush(w)) return 'wt-pack: no force-push. Push normally (the orchestrator merges and pushes); --force-with-lease only if you must.'
    if (here && broadKill(words(seg))) return 'wt-pack: pkill/pgrep -f needs a specific pattern (6+ characters, not a flag) — a short one matches every agent and Chrome (WP-120). Kill by recorded pid.'
    if (main && branchSwitch(w)) return 'wt-pack: never change branch in the main checkout. Work in a worktree: `git worktree add .claude/worktrees/<slug> -b <branch> main`.'
    if (here && w.some((t, k) => /(^|\/)wt-ticket$/.test(t) && w[k + 1] === 'new' && /^(--help|-h|help)$/.test(w[k + 2] ?? ''))) return 'wt-pack: `wt-ticket new --help` creates a ticket titled "--help". Run `wt-ticket` with no arguments for usage.'
    if (SENDS.test(seg) && SKILLS_PATH.test(seg)) return 'wt-pack: never write ~/.claude/skills/… in sent strings. Refer to the skill by name or a repo-relative path.'
  }
  return null
}

// From the session's cwd: exit 1 = not a wt-pack checkout (the marker setup uses; worktrees carry it too),
// 10 = a wt-pack worktree, 0 = the main checkout.
const WHERE = 'test -f "$(git rev-parse --show-toplevel 2>/dev/null)/.claude-plugin/marketplace.json" || exit 1; [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ] && exit 0; exit 10'

export const registerGuards = (on: Parameters<Register>[0]) => {
  let where: Promise<number> | undefined // ponytail: once per session, keyed on the session's cwd, not a `cd` in the command
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let deny = guard(e.command, false, false)
    if (!deny && guard(e.command, true, true)) { // only a command a repo rule would refuse pays for the check
      where ??= $.process.run(['sh', '-c', WHERE], { timeoutMs: 3000 }).then((r) => r.exitCode, () => 1)
      const at = await where
      if (at !== 1) deny = guard(e.command, true, at === 0)
    }
    return deny ? { deny } : next(e)
  })
}

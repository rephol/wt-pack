// WP-208 — Bash tool.call guards for wt-pack conventions: a one-line refusal naming the rule and the fix. Loose
// shell parsing on purpose (like wt-memory's pkill-guard.mjs, which stays): it stops accidents, not obfuscation.
import type { Register } from 'claude-code'

const SENDS = /handoff\.sh|wt-room|\broom\s+post|\bherdr\b|wt-ticket|wt-ask/ // commands whose strings reach another agent or a card
const SKILLS_PATH = /(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.claude\/skills\//

// The refusal for a command, or null. Each segment of `a && b ; c` is judged alone. `here`: the session is in a
// wt-pack checkout, where the repo's own rules (no drafts, own paths, repo-local identity) apply; the skills-path
// rule is pack-wide. Other projects keep wt-ship's draft PRs and their own commit habits.
export const guard = (cmd: string, here = true): string | null => {
  for (const seg of cmd.split(/&&|\|\||[;\n]/)) {
    const bare = seg.replace(/"[^"]*"|'[^']*'/g, '""') // flags inside a message are not flags
    const gh = /\bgh\s+pr\s+create\b/.test(bare) && /(^|\s)(--draft|-d)(\s|=|$)/.test(bare)
    if (gh && here) return 'wt-pack: no draft PRs. Drop --draft: review, merge to main, push.'
    if (here && /\bgit\s+(?:-c\s+\S+\s+|-\S+\s+)*commit\b/.test(seg)) {
      if (/\bcommit\b[^|]*\s-[a-zA-Z]*a[a-zA-Z]*(\s|$)|--all\b/.test(bare)) return 'wt-pack: never `git commit -a`. Commit only your own paths: `git commit <paths>`.'
      if (/--author\b|\s-c\s+user\.(name|email)|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)=/.test(bare)) return 'wt-pack: commits use the repo-local git identity. Drop --author / -c user.* / GIT_AUTHOR_*; fix it with `./setup doctor`.'
    }
    if (SENDS.test(seg) && SKILLS_PATH.test(seg)) return 'wt-pack: never write ~/.claude/skills/… in sent strings. Refer to the skill by name or a repo-relative path.'
  }
  return null
}

// The marker setup uses for a wt-pack checkout (worktrees carry it too), checked from the session's cwd.
const MARKER = 'test -f "$(git rev-parse --show-toplevel 2>/dev/null)/.claude-plugin/marketplace.json"'

export const registerGuards = (on: Parameters<Register>[0]) => {
  let here: Promise<boolean> | undefined // ponytail: once per session, keyed on the session's cwd, not a `cd` in the command
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let deny = guard(e.command, false)
    if (!deny && guard(e.command, true)) { // only a command a repo rule would refuse pays for the check
      here ??= $.process.run(['sh', '-c', MARKER], { timeoutMs: 3000 }).then((r) => r.exitCode === 0, () => false)
      if (await here) deny = guard(e.command, true)
    }
    return deny ? { deny } : next(e)
  })
}

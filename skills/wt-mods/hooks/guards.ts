// WP-208 — Bash tool.call guards for wt-pack conventions: a one-line refusal naming the rule and the fix. Loose
// shell parsing on purpose (like wt-memory's pkill-guard.mjs, which stays): it stops accidents, not obfuscation.
import type { Register } from 'claude-code'

const SENDS = /handoff\.sh|wt-room|\broom\s+post|\bherdr\b|wt-ticket|wt-ask/ // commands whose strings reach another agent or a card
const SKILLS_PATH = /(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.claude\/skills\//

// The refusal for a command, or null. Each segment of `a && b ; c` is judged alone.
export const guard = (cmd: string): string | null => {
  for (const seg of cmd.split(/&&|\|\||[;\n]/)) {
    const bare = seg.replace(/"[^"]*"|'[^']*'/g, '""') // flags inside a message are not flags
    const gh = /\bgh\s+pr\s+create\b/.test(bare) && /(^|\s)(--draft|-d)(\s|=|$)/.test(bare)
    if (gh) return 'wt-pack: no draft PRs. Drop --draft: review, merge to main, push.'
    if (/\bgit\s+(?:-c\s+\S+\s+|-\S+\s+)*commit\b/.test(seg)) {
      if (/\bcommit\b[^|]*\s-[a-zA-Z]*a[a-zA-Z]*(\s|$)|--all\b/.test(bare)) return 'wt-pack: never `git commit -a`. Commit only your own paths: `git commit <paths>`.'
      if (/--author\b|\s-c\s+user\.(name|email)|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)=/.test(bare)) return 'wt-pack: commits use the repo-local git identity. Drop --author / -c user.* / GIT_AUTHOR_*; fix it with `./setup doctor`.'
    }
    if (SENDS.test(seg) && SKILLS_PATH.test(seg)) return 'wt-pack: never write ~/.claude/skills/… in sent strings. Refer to the skill by name or a repo-relative path.'
  }
  return null
}

export const registerGuards = (on: Parameters<Register>[0]) => {
  on('tool.call', { tool: 'Bash' }, (_$, e, next) => {
    const deny = guard(e.command)
    return deny ? { deny } : next(e)
  })
}

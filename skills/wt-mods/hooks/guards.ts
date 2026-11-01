// WP-208/WP-279 — Bash tool.call guards for wt-pack conventions: a one-line refusal naming the rule and the fix. Loose
// shell parsing on purpose (like wt-memory's pkill-guard.mjs, which stays): it stops accidents, not obfuscation.
import type { Register } from 'claude-code'

const SENDS = /handoff\.sh|wt-room|\broom\s+post|\bhc\b|herdr-app\s+(?:-\S+\s+)*do\b|wt-ticket|wt-ask/ // commands whose strings reach another agent or a card
const words = (seg: string) => [...seg.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0])
const clip = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 120 ? t.slice(0, 119) + '…' : t }
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
    const tag = (rule: string, msg: string) => `${msg} [rule: ${rule}, segment: \`${clip(seg)}\`]` // WP-361: name the rule and the part that matched
    const bare = seg.replace(/"[^"]*"|'[^']*'/g, '""') // flags inside a message are not flags
    const gh = /\bgh\s+pr\s+create\b/.test(bare) && /(^|\s)(--draft|-d)(\s|=|$)/.test(bare)
    if (gh && here) return tag('no-draft-pr', 'wt-pack: no draft PRs. Drop --draft: review, merge to main, push.')
    if (here && /\bgit\s+(?:-c\s+\S+\s+|-\S+\s+)*commit\b/.test(seg)) {
      if (/\bcommit\b[^|]*\s-[a-zA-Z]*a[a-zA-Z]*(\s|$)|--all\b/.test(bare)) return tag('commit-all', 'wt-pack: never `git commit -a`. Commit only your own paths: `git commit <paths>`.')
      if (/--author\b|\s-c\s+user\.(name|email)|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)=/.test(bare)) return tag('commit-identity', 'wt-pack: commits use the repo-local git identity. Drop --author / -c user.* / GIT_AUTHOR_*; fix it with `./setup doctor`.')
    }
    const w = words(bare)
    if (here && forcePush(w)) return tag('force-push', 'wt-pack: no force-push. Push normally (the orchestrator merges and pushes); --force-with-lease only if you must.')
    if (here && broadKill(words(seg))) return tag('broad-kill', 'wt-pack: pkill/pgrep -f needs a specific pattern (6+ characters, not a flag) — a short one matches every agent and Chrome (WP-120). Kill by recorded pid.')
    if (main && branchSwitch(w)) return tag('branch-switch', 'wt-pack: never change branch in the main checkout. Work in a worktree: `git worktree add .claude/worktrees/<slug> -b <branch> main`.')
    if (here && w.some((t, k) => /(^|\/)wt-ticket$/.test(t) && w[k + 1] === 'new' && /^(--help|-h|help)$/.test(w[k + 2] ?? ''))) return tag('ticket-help', 'wt-pack: `wt-ticket new --help` creates a ticket titled "--help". Run `wt-ticket` with no arguments for usage.')
    if (SENDS.test(seg) && SKILLS_PATH.test(seg)) return tag('skills-path', 'wt-pack: never write ~/.claude/skills/… in sent strings. Refer to the skill by name or a repo-relative path.')
  }
  return null
}

// From the session's cwd: exit 1 = not a wt-pack checkout (the marker setup uses; worktrees carry it too),
// 10 = a wt-pack worktree, 0 = the main checkout.
const WHERE = 'test -f "$(git rev-parse --show-toplevel 2>/dev/null)/.claude-plugin/marketplace.json" || exit 1; [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ] && exit 0; exit 10'

// WP-332: a command that might push, merge, delete outside the worktree or send files/secrets out is checked against the turn's
// origin by `wt-gate` (the policy is wt-shared/scripts/gate.mjs; the mod has no Node and no env, so it asks the CLI). Cheap prefilter
// first: only a command that could be gated pays for the process.
// WP-378 F8: the prefilter must pass EVERY command gate.mjs classifies (guards.test.ts holds it to wt-shared/scripts/fixtures/gate-cases.mjs): hc (any verb), and commands inside
// a quoted `sh -c '…'` / `eval '…'` / `hc run "…"` string, which blanking the quotes would hide. Linear: one pass per segment, no regex that rescans a long line per `git`.
const GIT_SUB = /\b(push|merge|branch|worktree)\b/
const TOOLS = /\bgh\s+pr\b|\b(rm|rmdir|curl|wget|scp|rsync|nc|ncat|hc)\b/
const WRAPPER = /\b(?:ba|z|da|k|c)?sh\b|\beval\b/
const blank = (s: string) => s.replace(/"[^"]*"|'[^']*'/g, '""') // words inside a message are not subcommands
const SIMPLE = /^(["'])[\w./~=-]+\1$/
const hit = (text: string) => text.split(/[|;&\n]/).some((seg) => TOOLS.test(seg) || (/\bgit\b/.test(seg) && GIT_SUB.test(seg)))
// What the gate refuses outright instead of reading (it caps what it scans, and the command is an argv word, ~1 MB is the OS limit): a longer command that mentions any tool.
export const GATE_MAX = 131072
const ANY_TOOL = /\b(?:hc|git|gh|rm|rmdir|curl|wget|scp|rsync|nc|ncat)\b/
// WP-378 F9: a superset of classify BY CONSTRUCTION. classify reads quoted words (`"git" push`, `gh "pr" merge`), escapes and continuations, so the tool-word test runs on the text with
// backslash-newline joined and every ' " \ removed (a quote can then hide nothing); a message that merely mentions a tool word spawns the gate too (classify allows it). Separators are
// the ones classify splits on unconditionally (; | & newline), so the segment split below mirrors it.
const unquote = (s: string) => s.replace(/\\\n/g, '').replace(/['"\\]/g, '')
export const maybeGated = (cmd: string) => {
  if (cmd.length > GATE_MAX) return ANY_TOOL.test(cmd)
  const b = blank(cmd)
  return hit(unquote(cmd)) || /\bhc\b/.test(cmd.replace(/"[^"]*"|'[^']*'/g, (m) => (SIMPLE.test(m) ? m : '""'))) || (WRAPPER.test(b) && hit(cmd))
}
// WP-361: a gate deny names the rule id and the matched segment (wt-gate sends both) and says how to get the rest of a compound command through.
const SPLIT = ' Only that segment is gated: run the other parts of the command as their own command.'
const gateDeny = (stdout: string) => {
  let g: { action?: string; rule?: string; segment?: string; asked?: boolean; peer?: boolean } = {}
  try { g = JSON.parse(stdout) } catch { /* the text below still denies */ }
  const at = g.rule ? ` [rule: ${g.rule}${g.segment ? `, segment: \`${clip(g.segment)}\`` : ''}]` : ''
  if (g.peer) return `wt-pack gate${at}: ${g.action ?? 'this action'} was requested by a peer session (another Claude session, not the user). Do not retry it; ask the user in chat.${SPLIT}` // WP-357: no Inbox ask exists for it
  return `wt-pack gate${at}: ${g.action ?? 'this action'} needs the user's OK (this turn was not typed by the user or a verified handoff/dispatch/routine from the orchestrator). ` +
    (g.asked ? 'I asked them in the Inbox; wait for their answer, then retry the same command. Do not retry before it arrives.' : 'The dashboard could not be reached to ask; ask the user in chat and wait.') + SPLIT
}

export const registerGuards = (on: Parameters<Register>[0], skills: (root: string) => string) => {
  let where: Promise<number> | undefined // ponytail: once per session, keyed on the session's cwd, not a `cd` in the command
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let deny = guard(e.command, false, false)
    if (!deny && guard(e.command, true, true)) { // only a command a repo rule would refuse pays for the check
      where ??= $.process.run(['sh', '-c', WHERE], { timeoutMs: 3000 }).then((r) => r.exitCode, () => 1)
      const at = await where
      if (at !== 1) deny = guard(e.command, true, at === 0)
    }
    if (!deny && maybeGated(e.command) && e.command.length > GATE_MAX) deny = `wt-pack gate [rule: long-command]: command too long for the gate (over ${GATE_MAX / 1024} KB) and it mentions git, hc, rm or a network tool. Split it into smaller commands (or put the long text in a file).`
    else if (!deny && maybeGated(e.command)) {
      // exit 3 = gated; anything else (allowed, spawn error, timeout) lets it through: a broken gate must not wedge every agent
      const r = await $.process.run([`${skills($.plugin.root)}/wt-shared/scripts/wt-gate`, 'check', '--', e.command], { timeoutMs: 8000 }).catch(() => undefined)
      if (r && r.exitCode === 3) deny = gateDeny(r.stdout)
    }
    return deny ? { deny } : next(e)
  })
}

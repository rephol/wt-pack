// WP-207/212 — one instant slash command, `/wt <sub> …`: wrappers that run existing wt-pack scripts directly, with
// no Claude turn, and `immediate` so they also run while the agent is mid-turn. No logic of their own: argv in,
// stdout out. One namespaced command (not /room, /ticket, …) so it cannot clash with another plugin's commands.
import type { Register } from 'claude-code'

type Ctx = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]
// Where the skills dir is, from the plugin root: the repo's root plugin keeps it at `<root>/skills`, the wt-mods
// skill plugin sits inside it (`<root>/..`). Passed in by whichever entry registers this.
export type SkillsDir = (root: string) => string

// Shell-style split (quotes, no expansion): the scripts are run by argv, never through a shell.
export const split = (s: string): string[] => {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]))
  return out
}

type Cmd = { description: string; hint: string; script: string; argv: (a: string[], pane: string) => string[] | string }

// script is relative to the skills dir; argv returns the script's args, or a usage string.
export const COMMANDS: Record<string, Cmd> = {
  room: { description: 'wt-room: list | read <slug> | post <slug> "text"', hint: '<list|read|post> …', script: 'wt-room/scripts/room', argv: a => (a.length ? a : ['list']) },
  ticket: { description: 'wt-ticket: show|move|list|comment … (e.g. show WP-12)', hint: '<show|move|list|…> …', script: 'wt-ticket/scripts/wt-ticket', argv: a => (a.length ? a : ['list', '--mine']) },
  dnd: { description: 'Do-not-disturb for this agent: on [--for 2h] | off | (status)', hint: '[on|off]', script: 'wt-agents/scripts/agents.sh', argv: (a, pane) => ['dnd', pane, ...a] },
  herd: { description: 'List the herdr agents (wt-agents list; /agents is built in)', hint: '[role] [--json]', script: 'wt-agents/scripts/agents.sh', argv: a => ['list', ...a] },
  watch: { description: 'PR poller status (wt-watch-prs poller-status)', hint: 'status', script: 'wt-watch-prs/scripts/watch-prs.sh', argv: a => (a.length === 0 || a[0] === 'status' ? ['poller-status', ...a.slice(1)] : 'usage: /watch status') },
}

export const usage = `usage: /wt <${Object.keys(COMMANDS).join('|')}> …\n` + Object.entries(COMMANDS).map(([n, c]) => `  /wt ${n} ${c.hint} — ${c.description}`).join('\n')

// `/wt room post dev "hi"` → name 'room', rest 'post dev "hi"'; no/unknown sub → the usage text.
export const subOf = (args: string): [string, string] => {
  const m = args.trim().match(/^(\S+)\s*([\s\S]*)$/)
  return m && Object.hasOwn(COMMANDS, m[1]) ? [m[1], m[2]] : ['', '']
}

async function run($: Ctx, skills: SkillsDir, name: string, args: string) {
  const c = COMMANDS[name]
  let pane = (await $.env.get('HERDR_PANE_ID')) ?? ''
  if (name === 'dnd') {
    if (!pane) return { text: 'dnd: not inside a herdr pane (HERDR_PANE_ID is unset)' }
    // HERDR_PANE_ID may be the stable id; agents.sh matches the canonical pane_id (CLAUDE.md trap).
    const got = await $.process.run(['herdr', 'pane', 'get', pane]).catch(() => undefined)
    try { pane = JSON.parse(got?.stdout ?? '').result.pane.pane_id || pane } catch { return { text: 'dnd: cannot resolve this pane (herdr pane get failed)' } }
  }
  const argv = c.argv(split(args), pane)
  if (typeof argv === 'string') return { text: argv }
  const r = await $.process.run([`${skills($.plugin.root)}/${c.script}`, ...argv], { timeoutMs: 20000 }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  const text = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n')
  return { text: (text || `/${name}: no output`) + (r.exitCode ? `\n(exit ${r.exitCode})` : '') }
}

export const registerCommands = (on: Parameters<Register>[0], skills: SkillsDir) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'wt', description: 'wt-pack: room | ticket | dnd | herd | watch (runs the script, no model turn)', argumentHint: '<room|ticket|dnd|herd|watch> …', immediate: true })
    return next(e)
  })
  on('command.run', { command: 'wt' }, ($, e) => {
    const [name, rest] = subOf(e.args)
    return name ? run($, skills, name, rest) : { text: usage }
  })
}

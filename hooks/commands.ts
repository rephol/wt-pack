// WP-207 — instant slash commands: wrappers that run existing wt-pack scripts directly, with no Claude turn,
// and `immediate` so they also run while the agent is mid-turn. No logic of their own: argv in, stdout out.
import type { Register } from 'claude-code'

type Ctx = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]

// Shell-style split (quotes, no expansion): the scripts are run by argv, never through a shell.
export const split = (s: string): string[] => {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]))
  return out
}

type Cmd = { description: string; hint: string; script: string; argv: (a: string[], pane: string) => string[] | string }

// script is relative to the plugin root; argv returns the script's args, or a usage string.
export const COMMANDS: Record<string, Cmd> = {
  room: { description: 'wt-room: list | read <slug> | post <slug> "text"', hint: '<list|read|post> …', script: 'skills/wt-room/scripts/room', argv: a => (a.length ? a : ['list']) },
  ticket: { description: 'wt-ticket: show|move|list|comment … (e.g. show WP-12)', hint: '<show|move|list|…> …', script: 'skills/wt-ticket/scripts/wt-ticket', argv: a => (a.length ? a : ['list', '--mine']) },
  dnd: { description: 'Do-not-disturb for this agent: on [--for 2h] | off | (status)', hint: '[on|off]', script: 'skills/wt-agents/scripts/agents.sh', argv: (a, pane) => ['dnd', pane, ...a] },
  herd: { description: 'List the herdr agents (wt-agents list; /agents is built in)', hint: '[role] [--json]', script: 'skills/wt-agents/scripts/agents.sh', argv: a => ['list', ...a] },
  watch: { description: 'PR poller status (wt-watch-prs poller-status)', hint: 'status', script: 'skills/wt-watch-prs/scripts/watch-prs.sh', argv: a => (a.length === 0 || a[0] === 'status' ? ['poller-status', ...a.slice(1)] : 'usage: /watch status') },
}

async function run($: Ctx, name: string, args: string) {
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
  const r = await $.process.run([`${$.plugin.root}/${c.script}`, ...argv], { timeoutMs: 20000 }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  const text = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n')
  return { text: (text || `/${name}: no output`) + (r.exitCode ? `\n(exit ${r.exitCode})` : '') }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const [name, c] of Object.entries(COMMANDS)) {
      await $.command.register({ name, description: c.description, argumentHint: c.hint, immediate: true })
    }
    return next(e)
  })

  // Matchers are literals (the validator reads them off the source), so each command gets its own line.
  on('command.run', { command: 'room' }, ($, e) => run($, 'room', e.args))
  on('command.run', { command: 'ticket' }, ($, e) => run($, 'ticket', e.args))
  on('command.run', { command: 'dnd' }, ($, e) => run($, 'dnd', e.args))
  on('command.run', { command: 'herd' }, ($, e) => run($, 'herd', e.args))
  on('command.run', { command: 'watch' }, ($, e) => run($, 'watch', e.args))
}

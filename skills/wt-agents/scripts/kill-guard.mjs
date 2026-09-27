// WP-120: pkill / pgrep / killall shim (bin/<tool> execs this), first on PATH in every agent pane (agents.sh spawn: --env PATH and
// CLAUDE_ENV_FILE=env.sh). A second layer under wt-memory's PreToolUse guard that needs no plugin cache and no
// session restart. BSD stops parsing options at the first operand, so `pkill -f x -n` also matches "-n" against
// every command line — every `claude --name` agent AND Chrome's renderers (--no-sandbox …). Refuses:
//   - an option after the pattern
//   - with -f (killall: -m), a pattern shorter than 6 characters or one starting with "-"
// then execs the real /usr/bin binary. Bypass on purpose only: call /usr/bin/pkill by full path.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const TAKES_VALUE = { pkill: 'FGgPstUucJjMNd', pgrep: 'FGgPstUucJjMNd', killall: 'utcs' } // killall: -u user, -t tty, -c proc, -SIG handled below

// Returns why the call is refused, or null.
export function refuse(tool, args) {
  const takes = new Set((TAKES_VALUE[tool] ?? '').split(''))
  let full = false, operand = false
  const ops = []
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    if (t === '--' && !operand) { ops.push(...args.slice(i + 1)); break }
    if (/^-./.test(t)) {
      if (operand) return `option ${t} after the pattern — BSD ${tool} treats it as another pattern (WP-109/WP-120)`
      if (tool === 'killall' ? /m/.test(t.slice(1)) && !/^-[A-Z]/.test(t) : /f/.test(t.slice(1)) && !/^-[A-Z]{2,}$/.test(t)) full = true
      if (!/^-[A-Z]{2,}$/.test(t) && !/^-\d+$/.test(t) && takes.has(t[t.length - 1])) i++
    } else { operand = true; ops.push(t) }
  }
  if (full) for (const p of ops) if (p.length < 6 || p.startsWith('-')) return `pattern "${p}" is too broad for ${tool === 'killall' ? '-m' : '-f'} (under 6 characters or a flag) — it would match unrelated processes (WP-120)`
  return null
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [tool, ...args] = process.argv.slice(2) // bin/<tool> runs: node kill-guard.mjs <tool> args…
  const why = refuse(tool, args)
  if (why) {
    process.stderr.write(`wt-agents ${tool} guard: refused — ${why}. Put every option before the pattern, use a specific pattern, or kill by recorded pid.\n`)
    process.exit(2)
  }
  const r = spawnSync(`/usr/bin/${tool}`, args, { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

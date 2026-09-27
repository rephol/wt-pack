// PreToolUse(Bash): deny `pkill`/`pgrep` with an option after the pattern (WP-109).
// BSD pkill stops parsing options at the first operand, so `pkill -f "x" -U 501 -n` also matches `-n` against every
// `claude --name …` command line and SIGTERMs the whole agent pool. Loose shell parsing on purpose: it guards
// against accidents, not obfuscation. Any failure → exit 0, no output.
import { pathToFileURL } from 'node:url'

const TAKES_VALUE = new Set('FGgPstUucJjMN'.split(''))

function words(seg) {
  return [...seg.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0])
}

// Returns the offending segment, or null.
export function misordered(cmd) {
  for (const seg of String(cmd).split(/&&|\|\||[;|\n&]|\$\(|`/)) {
    const w = words(seg)
    let i = 0
    while (w[i] === 'sudo' || w[i] === 'exec' || w[i] === 'command' || /^\w+=/.test(w[i] ?? '')) i++
    if (!/^(?:\S*\/)?p(?:kill|grep)$/.test(w[i] ?? '')) continue
    let operand = false
    for (let j = i + 1; j < w.length; j++) {
      const t = w[j]
      if (t === '--') break
      if (/^-./.test(t)) {
        if (operand) return seg.trim()
        const last = t[t.length - 1]
        if (t.length === 2 && TAKES_VALUE.has(last)) j++
      } else operand = true
    }
  }
  return null
}

async function main() {
  let raw = ''
  for await (const c of process.stdin) raw += c
  const seg = misordered(JSON.parse(raw)?.tool_input?.command ?? '')
  if (!seg) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `BSD pkill/pgrep treat options after the pattern as more patterns (\`${seg.slice(0, 120)}\`); with -f, "-n" matches every \`claude --name\` agent (WP-109). Put all options before the pattern, or kill by recorded pid.`,
  } }))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(() => {})

// SessionStart / UserPromptSubmit: feed `wt-memory context` to Claude as additionalContext.
// SessionStart always injects (it also fires after /clear and compaction, which drop earlier context);
// UserPromptSubmit only when the content hash moved since this session's last injection.
// Never blocks or errors a session: any failure → exit 0, no output.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const event = input.hook_event_name
  // The plugin is installed as a COPY, so the CLI is found where the pack is linked, not next to this file.
  const bin = [process.env.WT_MEMORY_BIN, join(homedir(), '.claude', 'skills', 'wt-memory', 'scripts', 'wt-memory')].find((p) => p && existsSync(p))
  if (!bin) process.exit(0)
  const ctx = execFileSync(process.execPath, [bin, 'context', ...(input.cwd ? ['--cwd', input.cwd] : [])], { encoding: 'utf8', timeout: 2000 }).trim()
  const hash = createHash('sha256').update(ctx).digest('hex').slice(0, 16)
  const dir = join(homedir(), '.cache', 'wt-memory')
  const state = join(dir, `${String(input.session_id ?? 'none').replace(/[^\w-]/g, '_')}.hash`)
  let prev = null
  try { prev = readFileSync(state, 'utf8') } catch {}
  let text = ''
  if (event === 'SessionStart') text = ctx
  else if (prev !== hash && (ctx || prev !== null)) text = `Preferences updated:\n\n${ctx || '(all standing preferences were removed)'}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(state, hash)
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }))
} catch {}

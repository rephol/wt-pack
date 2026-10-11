// WP-315: the Agent SDK side of headless runs. Takes the same arguments as `claude -p …` and speaks the same stream-json on stdin
// and stdout, so Headless (headless.mjs) keeps owning everything else. Extra events: system/context_usage after each result and
// system/commands once after init. The SDK is imported dynamically (WT_HEADLESS_SDK_MODULE is test-only); missing = exit 3.
// stdin: user lines feed the prompt; control_request interrupt / set_permission_mode; control_response answers can_use_tool.
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const note = (m) => process.stderr.write(`headless-sdk: ${m}\n`)

// claude -p flags → query() options. Unknown flags (--input-format, --output-format, --verbose, --permission-prompt-tool) are skipped with their value.
export function parseArgs(argv, env = process.env) {
  const o = { settingSources: ['user', 'project', 'local'], cwd: process.cwd() }
  if (env.WT_CLAUDE_BIN) o.pathToClaudeCodeExecutable = env.WT_CLAUDE_BIN
  const val = (i) => argv[i + 1]
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--permission-mode') o.permissionMode = val(i++)
    else if (a === '--tools') o.tools = val(i++).split(',').filter(Boolean)
    else if (a === '--strict-mcp-config') o.strictMcpConfig = true
    else if (a === '--mcp-config') o.mcpServers = JSON.parse(val(i++)).mcpServers ?? {}
    else if (a === '--model') o.model = val(i++)
    else if (a === '--effort') o.effort = val(i++)
    else if (a === '--settings') o.settings = val(i++)
    else if (a === '--resume') o.resume = val(i++)
    else if (['--input-format', '--output-format', '--permission-prompt-tool'].includes(a)) i++
  }
  return o
}

async function main() {
  let sdk
  try { sdk = await import(process.env.WT_HEADLESS_SDK_MODULE || '@anthropic-ai/claude-agent-sdk') } catch (e) {
    process.stderr.write(`SDK driver not installed: run ./setup (${e.code ?? e.message})\n`)
    return process.exit(3)
  }
  const abortController = new AbortController()
  const pending = new Map() // request_id → resolve(answer)
  const queue = []
  let wake = null, eof = false
  const push = (m) => { queue.push(m); wake?.(); wake = null }
  async function* input() {
    for (;;) {
      if (queue.length) yield queue.shift()
      else if (eof) return
      else await new Promise((r) => { wake = r })
    }
  }

  const canUseTool = (tool_name, toolInput, { signal }) => new Promise((resolve) => {
    const request_id = randomBytes(8).toString('hex')
    const done = (a) => { signal?.removeEventListener('abort', onAbort); pending.delete(request_id); resolve(a) }
    const onAbort = () => { out({ type: 'control_cancel_request', request_id }); done({ behavior: 'deny', message: 'aborted' }) }
    if (signal?.aborted) return resolve({ behavior: 'deny', message: 'aborted' })
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(request_id, done)
    out({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name, input: toolInput } })
  })

  const q = sdk.query({ prompt: input(), options: { ...parseArgs(process.argv.slice(2)), abortController, canUseTool } })

  const ctl = async (e) => {
    const { subtype, mode } = e.request ?? {}
    let error
    try {
      if (subtype === 'interrupt') await q.interrupt()
      else if (subtype === 'set_permission_mode') await q.setPermissionMode(mode)
      else error = `unsupported control request: ${subtype}`
    } catch (x) { error = x.message }
    out({ type: 'control_response', response: error ? { subtype: 'error', request_id: e.request_id, error } : { subtype: 'success', request_id: e.request_id } })
  }
  createInterface({ input: process.stdin }).on('line', (line) => {
    let e
    try { e = JSON.parse(line) } catch { return }
    if (e.type === 'user') push(e)
    else if (e.type === 'control_request') ctl(e)
    else if (e.type === 'control_response') {
      const r = e.response
      pending.get(r?.request_id)?.(r?.subtype === 'success' ? r.response : { behavior: 'deny', message: r?.error ?? 'denied' })
    }
  }).on('close', () => { eof = true; wake?.(); wake = null })

  process.on('SIGTERM', () => { abortController.abort(); setTimeout(() => process.exit(0), 2000) })

  const extra = async (subtype, fn) => { // swallowed: a failure here must not end the run
    try { out({ type: 'system', subtype, ...(await fn()) }) } catch (e) { note(`${subtype}: ${e.message}`) }
  }
  let inited = false
  try {
    for await (const m of q) {
      if (abortController.signal.aborted) break
      out(m)
      if (m.type === 'system' && m.subtype === 'init' && !inited) {
        inited = true
        extra('commands', async () => ({ commands: await q.supportedCommands() }))
      } else if (m.type === 'result') {
        await extra('context_usage', async () => {
          const { totalTokens, maxTokens, percentage } = await q.getContextUsage()
          return { totalTokens, maxTokens, percentage }
        })
      }
    }
  } catch (e) {
    if (!abortController.signal.aborted) { note(e.message); return process.exit(1) }
  }
  process.exit(0)
}

main()

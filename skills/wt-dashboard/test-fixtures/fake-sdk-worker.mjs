#!/usr/bin/env node
// Stand-in for headless-sdk/worker.mjs (WP-315) until it is wired to the real one: runs fake-claude (same argv/stdin contract) and adds the worker's
// extra stdout lines: system/worker (who ran, with which claude binary), system/commands after init, system/context_usage after each result.
const w = process.stdout.write.bind(process.stdout)
const line = (o) => w(JSON.stringify(o) + '\n')
line({ type: 'system', subtype: 'worker', script: process.argv[1], claudeBin: process.env.WT_CLAUDE_BIN ?? null })
process.stdout.write = (c, ...a) => {
  const r = w(c, ...a)
  for (const l of String(c).split('\n')) {
    if (l.startsWith('{"type":"system","subtype":"init"')) line({ type: 'system', subtype: 'commands', commands: [{ name: 'compact', description: 'x' }] })
    else if (l.startsWith('{"type":"result"')) line({ type: 'system', subtype: 'context_usage', totalTokens: 12345, maxTokens: 400000, percentage: 3 })
  }
  return r
}
await import('./fake-claude.mjs')

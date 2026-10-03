import { test, expect, mock } from 'claude-code/testing'

// The engine beneath the plugin is stubbed: `wt-ask <flag> …` is answered from a script, so no dashboard runs.
const Q = { tool: 'AskUserQuestion' as const, questions: [
  { question: 'Which env?', header: 'Env', options: [{ label: 'staging', description: 's' }, { label: 'prod', description: 'p' }], multiSelect: false },
  { question: 'Which flags?', header: 'Flags', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }], multiSelect: true },
] }
const out = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

function stubWtAsk(on: any, script: (flag: string, stdin?: string) => ReturnType<typeof out> | Promise<ReturnType<typeof out>>) {
  const calls: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('process.run', async (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    calls.push(e.argv[1])
    return { value: await script(e.argv[1], e.init?.stdin) }
  })
  return calls
}

test('a reachable dashboard answers: both answers come back as the tool result', async ($, on) => {
  mock.clock(on)
  let posted = ''
  const calls = stubWtAsk(on, (flag, stdin) => {
    if (flag === '--json') { posted = stdin ?? ''; return out(0, 'ask-1\n') }
    if (flag === '--wait') return out(0, JSON.stringify({ selected: [['prod'], ['a', 'b']] }))
    return out(0)
  })
  const r: any = await $.tool.call(Q)
  expect(r.result.answers).toEqual({ 'Which env?': 'prod', 'Which flags?': 'a, b' })
  expect(r.result.questions).toEqual(Q.questions)
  expect(JSON.parse(posted).questions[1].multiSelect).toBe(true)
  expect(calls).toEqual(['--ping', '--json', '--wait'])
})

test('an unreachable dashboard falls through to the native dialog', async ($, on) => {
  mock.clock(on)
  const calls = stubWtAsk(on, () => out(1))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { questions: Q.questions, answers: { native: 'yes' } } }))
  const r: any = await $.tool.call(Q)
  expect(r.result.answers).toEqual({ native: 'yes' })
  expect(calls).toEqual(['--ping'])
})

test('a wait that never gets an answer is resolved and denied at the timeout', { options: { timeoutMin: 1 } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = stubWtAsk(on, async (flag) => {
    if (flag === '--json') return out(0, 'ask-2')
    if (flag === '--wait') { await clock.advance(40_000); return out(3, '', 'wt-ask: no answer') } // each slice burns 40 s
    return out(0)
  })
  const r: any = await $.tool.call(Q)
    expect(r.deny).toContain('No answer from the user within 1 min')
  expect(calls.at(-1)).toBe('--resolve')
})

test('closed in the dashboard without an answer is denied', async ($, on) => {
  mock.clock(on)
  stubWtAsk(on, (flag) => (flag === '--json' ? out(0, 'ask-3') : flag === '--wait' ? out(3, '', 'wt-ask: ask-3 was resolved without an answer') : out(0)))
  const r: any = await $.tool.call(Q)
  expect(r.deny).toContain('closed in wt-dashboard')
})

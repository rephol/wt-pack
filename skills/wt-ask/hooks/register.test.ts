import { test, expect, mock } from 'claude-code/testing'

// The engine beneath the plugin is stubbed: `wt-ask <flag> …` is answered from a script, so no dashboard runs.
const Q = { tool: 'AskUserQuestion' as const, questions: [
  { question: 'Which env?', header: 'Env', options: [{ label: 'staging', description: 's' }, { label: 'prod', description: 'p' }], multiSelect: false },
  { question: 'Which flags?', header: 'Flags', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }], multiSelect: true },
] }
const out = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

function stubWtAsk(on: any, script: (flag: string, stdin?: string) => ReturnType<typeof out> | Promise<ReturnType<typeof out>>) {
  const calls: string[] = []
  const argvs: string[][] = []
  on('ui.status', () => ({ value: undefined }))
  on('process.run', async (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    calls.push(e.argv[1])
    argvs.push(e.argv)
    return { value: await script(e.argv[1], e.init?.stdin) }
  })
  return Object.assign(calls, { argvs })
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
  expect(calls.argvs[1].slice(1)).toEqual(['--json', '-', '--no-deliver']) // no-deliver: the answer returns only as the tool result
  expect(calls.argvs[2].slice(1)).toEqual(['--wait', 'ask-1', '--timeout', '300'])
  expect(calls.argvs[0][0]).toMatch(/\/scripts\/wt-ask$/)
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

const native = (on: any) => on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { questions: Q.questions, answers: { native: 'yes' } } }))

test('free text comes back as the `response` field, and answers an unselected first question', async ($, on) => {
  mock.clock(on)
  stubWtAsk(on, (flag) => (flag === '--json' ? out(0, 'ask-4') : flag === '--wait' ? out(0, JSON.stringify({ selected: [['prod'], ['a']], text: 'use blue/green' })) : out(0)))
  const r: any = await $.tool.call(Q)
  expect(r.result.response).toBe('use blue/green')
  expect(r.result.answers['Which flags?']).toBe('a')
})

test('Other text answers its question; Chat about this denies so the agent talks to the user', async ($, on) => {
  mock.clock(on)
  stubWtAsk(on, (flag) => (flag === '--json' ? out(0, 'ask-5') : flag === '--wait' ? out(0, JSON.stringify({ selected: [['prod'], []], other: ['', 'my own'] })) : out(0)))
  const r: any = await $.tool.call(Q)
  expect(r.result.answers['Which flags?']).toBe('my own')
})

test('Chat about this is a deny', async ($, on) => {
  mock.clock(on)
  stubWtAsk(on, (flag) => (flag === '--json' ? out(0, 'ask-6') : flag === '--wait' ? out(0, JSON.stringify({ selected: [[], []], chat: true })) : out(0)))
  const r: any = await $.tool.call(Q)
  expect(r.deny).toContain('Chat about this')
})

test('a text/number question is never captured', async ($, on) => {
  mock.clock(on)
  const calls = stubWtAsk(on, () => out(0))
  native(on)
  const r: any = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ ...Q.questions[0], kind: 'text' }] } as any)
  expect(r.result.answers).toEqual({ native: 'yes' })
  expect(calls).toEqual([])
})

test('a failed post falls through to the native dialog', async ($, on) => {
  mock.clock(on)
  const calls = stubWtAsk(on, (flag) => (flag === '--json' ? out(1, '', 'wt-ask: 400') : out(0)))
  native(on)
  const r: any = await $.tool.call(Q)
  expect(r.result.answers).toEqual({ native: 'yes' })
  expect(calls).toEqual(['--ping', '--json'])
})

test('the dashboard dying mid-wait resolves the ask and falls back to native', async ($, on) => {
  mock.clock(on)
  const calls = stubWtAsk(on, (flag) => (flag === '--json' ? out(0, 'ask-5') : flag === '--wait' ? out(1, '', 'wt-dashboard not reachable') : out(0)))
  native(on)
  const r: any = await $.tool.call(Q)
  expect(r.result.answers).toEqual({ native: 'yes' })
  expect(calls).toEqual(['--ping', '--json', '--wait', '--resolve'])
})

test('the question is shown in the pane while waiting', async ($, on) => {
  mock.clock(on)
  const logs: string[] = []
  on('ui.log', (_$: unknown, e: { text: string }) => { logs.push(e.text); return { value: undefined } })
  stubWtAsk(on, (flag) => (flag === '--json' ? out(0, 'ask-6') : flag === '--wait' ? out(0, JSON.stringify({ selected: [['prod'], ['a']] })) : out(0)))
  await $.tool.call(Q)
  expect(logs).toContain('Which env? — staging / prod')
})

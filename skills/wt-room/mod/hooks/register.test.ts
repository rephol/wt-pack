import { test, expect, mock } from 'claude-code/testing'

const out = (exitCode: number, stdout = '') => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const item = (id: string, text: string) => out(0, JSON.stringify({ id, kind: 'reply', text }))

// `wt-deliver <cmd>` is answered from a script; prompt.submit is recorded beneath the plugin.
function setup(on: any, script: (cmd: string, id?: string) => ReturnType<typeof out>) {
  const calls: string[] = []
  const submitted: string[] = []
  on('process.run', async (_$: unknown, e: { argv: string[] }) => { calls.push(e.argv.slice(1).join(' ')); return { value: script(e.argv[1], e.argv[2]) } })
  on('prompt.submit', (_$: unknown, e: { text: string }) => { submitted.push(e.text); return { text: e.text } })
  on('session.start', (_$: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_$: unknown, e: any) => ({ text: e.text, turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { calls, submitted }
}

test('says hello at start and every 20 s', async ($, on) => {
  const clock = mock.clock(on)
  const { calls } = setup(on, () => out(0, '{}'))
  await $.session.start({ cwd: '/', surface: 'terminal', interactive: true } as any)
  await clock.advance(41_000)
  expect(calls.filter((c) => c === 'hello').length).toBe(3)
})

test('a queued item is submitted once and acked', async ($, on) => {
  const clock = mock.clock(on)
  let queued = true
  const { calls, submitted } = setup(on, (cmd) => (cmd === 'next' ? (queued ? item('d1', '<wt-message id=a kind=reply from="x">hi</wt-message>') : out(0, '{}')) : (cmd === 'ack' && (queued = false), out(0))))
  await $.session.start({ cwd: '/', surface: 'terminal', interactive: true } as any)
  await clock.advance(10_000)
  expect(submitted).toEqual(['<wt-message id=a kind=reply from="x">hi</wt-message>'])
  expect(calls).toContain('ack d1 delivered')
})

test('a running turn defers the pull until it completes', async ($, on) => {
  const clock = mock.clock(on)
  const { calls, submitted } = setup(on, (cmd) => (cmd === 'next' ? item('d2', 'later') : out(0)))
  await $.session.start({ cwd: '/', surface: 'terminal', interactive: true } as any)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await clock.advance(10_000)
  expect(calls.filter((c) => c === 'next').length).toBe(0)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false } as any)
  await clock.advance(1)
  expect(submitted).toEqual(['later'])
})

test('an unreachable dashboard submits nothing and retries next tick', async ($, on) => {
  const clock = mock.clock(on)
  let up = false
  const { submitted } = setup(on, (cmd) => (cmd === 'next' ? (up ? item('d3', 'x') : out(1)) : out(0)))
  await $.session.start({ cwd: '/', surface: 'terminal', interactive: true } as any)
  await clock.advance(7_000)
  expect(submitted).toEqual([])
  up = true
  await clock.advance(4_000)
  expect(submitted).toEqual(['x'])
})

test('WP-272: a turn ending runs the finish check once, and a failing check is ignored', async ($, on) => {
  const clock = mock.clock(on)
  const { calls } = setup(on, (cmd) => (cmd === 'check-finish' ? out(1) : out(0, '{}')))
  await $.session.start({ cwd: '/', surface: 'terminal', interactive: true } as any)
  const done = (turnId: string) => $.turn.complete({ turnId, reason: 'answer', answer: '', durationMs: 1, isAborted: false } as any)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await done('t1')
  await done('t1') // a second complete in the same turn: no second call
  await clock.advance(1)
  expect(calls.filter((c) => c === 'check-finish').length).toBe(1)
  await $.turn.start({ text: 'more', turnId: 't2' })
  await done('t2')
  await clock.advance(1)
  expect(calls.filter((c) => c === 'check-finish').length).toBe(2)
})

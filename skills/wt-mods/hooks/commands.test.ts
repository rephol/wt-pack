import { test, expect, mock } from 'claude-code/testing'
import { split, subOf, usage, COMMANDS } from './commands'

test('split honours quotes without a shell', () => {
  expect(split('post dev "hi there" \'a b\' x')).toEqual(['post', 'dev', 'hi there', 'a b', 'x'])
  expect(split('')).toEqual([])
})

test('argv mapping', () => {
  expect(COMMANDS.watch.argv(['foo'], '')).toBe('usage: /wt watch status')
  expect(COMMANDS.watch.argv([], '')).toEqual(['poller-status'])
  expect(COMMANDS.dnd.argv(['on'], 'w1:p2')).toEqual(['dnd', 'w1:p2', 'on'])
  expect(COMMANDS.room.argv([], '')).toEqual(['list'])
})

test('subOf splits the sub-command off; an unknown or missing one is empty', () => {
  expect(subOf('room post dev "hi there"')).toEqual(['room', 'post dev "hi there"'])
  expect(subOf('  herd ')).toEqual(['herd', ''])
  expect(subOf('')).toEqual(['', ''])
  expect(subOf('nope x')).toEqual(['', ''])
  expect(subOf('constructor x')).toEqual(['', '']) // not an inherited property
  expect(usage).toContain('/wt ticket')
})

// The engine beneath: process.run answers from a script and records argv.
function rig(on: any) {
  const ran: string[][] = []
  mock.env(on, { HC_TERMINAL_ID: 't7' })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push(e.argv)
    return { value: { exitCode: 0, stdout: 'out\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({}))
  return ran
}

test('/wt ticket show WP-1 runs the sibling script and returns its output', async ($, on) => {
  const ran = rig(on)
  const r: any = await $.command.run({ command: 'wt', args: 'ticket show WP-1' } as never)
  expect(ran).toHaveLength(1)
  expect(ran[0].at(-3)).toMatch(/\/wt-ticket\/scripts\/wt-ticket$/)
  expect(ran[0].slice(-2)).toEqual(['show', 'WP-1'])
  expect(r.text).toBe('out')
})

test('/wt dnd acts on the current terminal (HC_TERMINAL_ID, no lookup: the address is the id)', async ($, on) => {
  const ran = rig(on)
  await $.command.run({ command: 'wt', args: 'dnd on' } as never)
  expect(ran).toHaveLength(1)
  expect(ran[0].slice(-3)).toEqual(['dnd', 't7', 'on'])
})

test('/wt dnd outside an hc terminal says so and runs nothing', async ($, on) => {
  const ran: string[][] = []
  mock.env(on, { HERDR_PANE_ID: 'w1:p2' }) // the old id is no identity
  on('process.run', (_$: unknown, e: { argv: string[] }) => { ran.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('command.register', () => ({}))
  const r: any = await $.command.run({ command: 'wt', args: 'dnd on' } as never)
  expect(r.text).toMatch(/HC_TERMINAL_ID is unset/)
  expect(ran).toEqual([])
})

test('/wt with no or an unknown sub prints the usage and runs nothing', async ($, on) => {
  const ran = rig(on)
  expect(((await $.command.run({ command: 'wt', args: '' } as never)) as any).text).toBe(usage)
  expect(((await $.command.run({ command: 'wt', args: 'bogus' } as never)) as any).text).toBe(usage)
  expect(ran).toEqual([])
})

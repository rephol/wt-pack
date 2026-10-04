import { test, expect } from 'claude-code/testing'
import { guard } from './guards'

test('refuses draft PRs, commit -a, a foreign author, skills paths in sent strings', () => {
  expect(guard('gh pr create --draft --title x')).toMatch(/draft/)
  expect(guard('git add x && git commit -am "m"')).toMatch(/-a/)
  expect(guard('git commit --all -m m')).toMatch(/-a/)
  expect(guard('git commit --author="A <a@b>" -m m')).toMatch(/identity/)
  expect(guard('GIT_AUTHOR_EMAIL=a@b git commit -m m')).toMatch(/identity/)
  expect(guard('git -c user.email=a@b commit -m m')).toMatch(/identity/)
  expect(guard('handoff.sh --reply w1:p2 "run ~/.claude/skills/wt-x/y"')).toMatch(/skills/)
})

test('lets the normal forms through', () => {
  expect(guard('gh pr create --title x')).toBeNull()
  expect(guard('git commit skills/a -m "msg -a --draft"')).toBeNull()
  expect(guard('git commit -m "x" -- a')).toBeNull()
  expect(guard('ls ~/.claude/skills/')).toBeNull()
  expect(guard('git log --author=me')).toBeNull()
})

test('repo rules apply only in a wt-pack checkout; the skills-path rule everywhere', () => {
  expect(guard('gh pr create --draft', false)).toBeNull()
  expect(guard('git commit -am m', false)).toBeNull()
  expect(guard('herdr pane send p "see ~/.claude/skills/x"', false)).toMatch(/skills/)
})

const stub = (on: any, exitCode: number) => {
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => { runs.push(e.argv); return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  return runs
}

test('the registered hook denies in a wt-pack checkout, checking the marker once', async ($, on) => {
  const runs = stub(on, 0)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft' })
  expect(r.deny).toMatch(/draft/)
  const r2: any = await $.tool.call({ tool: 'Bash', command: 'git commit -a -m m' })
  expect(r2.deny).toMatch(/-a/)
  expect(runs.length).toBe(1)
  expect(runs[0].join(' ')).toMatch(/marketplace\.json/)
})

test('the registered hook lets repo-rule commands through elsewhere', async ($, on) => {
  stub(on, 1)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft' })
  expect(r.deny).toBeUndefined()
})

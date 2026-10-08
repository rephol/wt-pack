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

test('WP-279: refuses force-push, short pkill -f patterns, branch changes in the main checkout, wt-ticket new --help', () => {
  expect(guard('git push --force origin main')).toMatch(/force/)
  expect(guard('git push -f')).toMatch(/force/)
  expect(guard('git push origin +main')).toMatch(/force/)
  expect(guard('pkill -f node')).toMatch(/pkill/)
  expect(guard('/usr/bin/pgrep -fl "-n"')).toMatch(/pkill/)
  expect(guard('git checkout main')).toMatch(/main checkout/)
  expect(guard('git checkout -b wp-1-x')).toMatch(/main checkout/)
  expect(guard('git switch wp-1-x')).toMatch(/main checkout/)
  expect(guard('skills/wt-ticket/scripts/wt-ticket new --help')).toMatch(/--help/)
})

test('WP-279: lets the safe forms through', () => {
  expect(guard('git push')).toBeNull()
  expect(guard('git push --force-with-lease')).toBeNull()
  expect(guard('git commit -m "push --force"')).toBeNull()
  expect(guard('pkill -f "tsx src/index.ts"')).toBeNull()
  expect(guard('kill 123')).toBeNull()
  expect(guard('git checkout -- file')).toBeNull()
  expect(guard('git checkout main -- file')).toBeNull()
  expect(guard('git branch --show-current')).toBeNull()
  expect(guard('wt-ticket new "title"')).toBeNull()
})

test('WP-279: a worktree may switch branches; the main-checkout rule needs the main checkout', () => {
  expect(guard('git checkout main', true, false)).toBeNull()
  expect(guard('git push -f', true, false)).toMatch(/force/)
  expect(guard('git checkout main', false, false)).toBeNull()
})

test('WP-279: the hook asks once where the session is; exit 10 = a worktree', async ($, on) => {
  const runs = stub(on, 10)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }))
  expect(((await $.tool.call({ tool: 'Bash', command: 'git push --force' })) as any).deny).toMatch(/force/)
  expect(((await $.tool.call({ tool: 'Bash', command: 'git checkout main' })) as any).deny).toBeUndefined()
  expect(runs.length).toBe(1)
})

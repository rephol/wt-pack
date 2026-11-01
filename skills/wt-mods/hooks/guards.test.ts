import { test, expect } from 'claude-code/testing'
import { guard, maybeGated, GATE_MAX } from './guards'
import cases from '../../wt-shared/scripts/fixtures/gate-cases.mjs'

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
  expect(guard('hc send t7 "see ~/.claude/skills/x"', false)).toMatch(/skills/)
})

test('WP-378: SENDS covers every hc verb and herdr-app do (flag before the verb too)', () => {
  for (const c of ['hc send t7 "see ~/.claude/skills/x"', 'hc label t7 note="~/.claude/skills/x"', 'hc put t7 ~/.claude/skills/x/f', 'hc --json send t7 "$HOME/.claude/skills/x"',
    'env -u HC_TERMINAL_ID hc keys t7 "~/.claude/skills/x"', 'herdr-app do send "~/.claude/skills/x"', 'herdr-app --json do open ~/.claude/skills/x'])
    expect(guard(c, false)).toMatch(/skills/)
  expect(guard('hc ls', false)).toBeNull()
  expect(guard('echo "wchc" ~/.claude/skills/x', false)).toBeNull() // \bhc\b is a word, not a substring
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

// WP-332: the destructive-action gate. The mod only prefilters and asks `wt-gate`; exit 3 = gated.
const gateRig = (on: any, answer: (argv: string[]) => { exitCode: number; stdout: string } | 'throw') => {
  const runs: string[][] = []
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    const a = answer(e.argv)
    if (a === 'throw') throw new Error('spawn failed')
    return { value: { exitCode: a.exitCode, stdout: a.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }))
  return runs
}

test('WP-332: a gated command is denied with the reason, after asking wt-gate', async ($, on) => {
  const runs = gateRig(on, () => ({ exitCode: 3, stdout: '{"action":"git push","rule":"push","segment":"git push origin main","asked":true}\n' }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(r.deny).toMatch(/git push needs the user's OK/)
  expect(r.deny).toMatch(/\[rule: push, segment: `git push origin main`\]/) // WP-361
  expect(r.deny).toMatch(/run the other parts of the command as their own command/)
  expect(r.deny).toMatch(/asked them in the Inbox/)
  expect(runs.length).toBe(1)
  expect(runs[0].slice(-3)).toEqual(['check', '--', 'git push origin main'])
  expect(runs[0][0]).toMatch(/skills\/wt-shared\/scripts\/wt-gate$/)
  const un: any = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/x' })
  expect(un.deny).toMatch(/needs the user's OK/)
})

test('WP-357: a peer-requested action is denied with the peer reason, not "I asked them in the Inbox"', async ($, on) => {
  gateRig(on, () => ({ exitCode: 3, stdout: '{"action":"git push","asked":false,"peer":true,"reason":"requested by a peer session; ask the user in chat"}\n' }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(r.deny).toMatch(/git push was requested by a peer session/)
  expect(r.deny).toMatch(/ask the user in chat/)
  expect(r.deny).not.toMatch(/Inbox/)
})

test('WP-332: an ordinary command never spawns the gate; allowed (exit 0) and a broken gate both let it run', async ($, on) => {
  const runs = gateRig(on, () => ({ exitCode: 0, stdout: '' }))
  for (const command of ['npm test', 'git status', 'git commit skills/a -m "push"', 'ls -la']) {
    const r: any = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny).toBeUndefined()
  }
  expect(runs.length).toBe(0)
  const ok: any = await $.tool.call({ tool: 'Bash', command: 'git push' }) // exit 0 = allowed
  expect(ok.deny).toBeUndefined()
  expect(runs.length).toBe(1)
})

test('WP-332: a gate that cannot run fails open (it must not wedge every agent)', async ($, on) => {
  gateRig(on, () => 'throw')
  const r: any = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(r.deny).toBeUndefined()
})

// WP-378 F8: the prefilter must pass every command wt-gate would classify. The cases are wt-shared's fixtures/gate-cases.mjs, the same list gate.test.mjs holds the
// policy to, so a new gate class with no prefilter path fails here.
test('WP-378 F8: the prefilter lets every command the gate classifies through to wt-gate', () => {
  expect((cases as { cmd: string }[]).length).toBeGreaterThan(150)
  const missed = (cases as { cmd: string; rule: string }[]).filter((c) => !maybeGated(c.cmd)).map((c) => `${c.rule}: ${c.cmd.slice(0, 80)}`)
  expect(missed).toEqual([])
})

test('WP-378 F8: the prefilter reads quoted hc, wrapped hc and hc run payloads; plain commit messages still do not spawn the gate', () => {
  for (const c of ['hc kill t3', '"hc" kill t3', "'hc' rm t3", '\\hc kill t3', "sh -c 'hc kill t3'", 'eval "hc kill t3"', 'hc run "git push"', "hc run 'rm -rf /etc/x'", "bash -c 'git push'", 'env -i hc send t3 x'])
    expect(maybeGated(c)).toBe(true)
  for (const c of ['npm test', 'git status', 'git commit skills/a -m "push"', 'git commit -m "docs: A & git merge notes"', 'git commit -m "hc kill t3"', 'echo "git push"', 'ls -la', "sh -c 'echo hi'", 'eval "echo hi"', 'echo hi && cat x'])
    expect(maybeGated(c)).toBe(false)
})

test('WP-378 F8: a command over the gate limit that reaches the gate is denied by the mod, not passed to argv', async ($, on) => {
  const runs = gateRig(on, () => ({ exitCode: 0, stdout: '' }))
  const big = 'git push ' + ' '.repeat(GATE_MAX + 10)
  const r: any = await $.tool.call({ tool: 'Bash', command: big })
  expect(r.deny).toMatch(/too long for the gate/)
  expect(r.deny).toMatch(/Split/)
  expect(r.deny).toMatch(/long-command/)
  expect(runs.length).toBe(0)
  const ok: any = await $.tool.call({ tool: 'Bash', command: 'echo ' + 'a'.repeat(GATE_MAX + 10) }) // nothing gated in it: runs
  expect(ok.deny).toBeUndefined()
  expect(runs.length).toBe(0)
})

test('WP-378 F8: the prefilter is linear on a long line (git git git … of 120 KB)', () => {
  const t = Date.now()
  expect(maybeGated('git '.repeat(30000))).toBe(false)
  expect(maybeGated('(' .repeat(120000) + 'sh -c')).toBe(false)
  expect(Date.now() - t).toBeLessThan(500)
})

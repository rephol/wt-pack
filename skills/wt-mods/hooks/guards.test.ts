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

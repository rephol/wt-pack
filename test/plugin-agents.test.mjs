// Run: node --test test/plugin-agents.test.mjs — WP-368: the plugin's agents/ folder (wt-pack:wt-<name>).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'agents')
const ROLES = ['lead', 'product-planner', 'tech-lead', 'engineer', 'qa-auditor', 'qa-lead', 'reviewer']
const frontmatter = (src) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src)
  assert.ok(m, 'frontmatter')
  return Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]))
}
const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()

test('exactly the seven wt roles ship', () => {
  assert.deepEqual(files, ROLES.map((r) => `wt-${r}.md`).sort())
})

for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8')
  const fm = frontmatter(src)
  test(`${f}: frontmatter`, () => {
    assert.equal(fm.name, f.replace(/\.md$/, ''))
    assert.ok(fm.description.length > 20, 'description')
    assert.match(fm.model, /^(opus|sonnet|haiku)$/)
    assert.match(fm.effort, /^(low|medium|high)$/)
    // the engineer takes every tool; each other role lists its own
    if (f === 'wt-engineer.md') assert.equal(fm.tools, undefined)
    else assert.match(fm.tools, /^[A-Za-z]+(, [A-Za-z]+)*$/)
  })
  test(`${f}: generic body with the common block`, () => {
    assert.ok(!/~\/\.claude\/skills|\.claude\/skills\//.test(src), 'no ~/.claude/skills path')
    assert.match(src, /Common rules \(every wt role\)/)
    for (const rule of ['CLAUDE.md', '.claude/worktrees', 'by pathspec', 'Never prompt real agents', 'never `pkill -f`', 'Never ask the user']) {
      assert.ok(src.includes(rule), `common block names: ${rule}`)
    }
  })
}

test('read-only roles cannot edit; the lead cannot be told to implement', () => {
  const tools = (r) => frontmatter(readFileSync(join(dir, `wt-${r}.md`), 'utf8')).tools
  assert.doesNotMatch(tools('reviewer'), /Write|Edit/)
  assert.doesNotMatch(tools('qa-auditor'), /Edit/)
  assert.match(tools('lead'), /Agent/)
  assert.match(tools('qa-lead'), /Agent/)
  assert.doesNotMatch(tools('product-planner'), /Agent/)
})

// node --test: project-role files — frontmatter, override vs persona, check findings, prompt sections and the cap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, list, resolve, check, sections, mainCheckout, personas, CAP } from './roles.mjs'

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'roles-')))
execFileSync('git', ['init', '-q', repo])
const dir = join(repo, '.wt-pack', 'roles')
mkdirSync(dir, { recursive: true })
const put = (n, t) => writeFileSync(join(dir, `${n}.md`), t)

test('parse: flat keys, lists, quotes; no frontmatter = all body', () => {
  assert.deepEqual(parse('---\nbase: worker\nmcp: [figma, context7]\nmodel: "opus"\n---\nHello\n'),
    { meta: { base: 'worker', mcp: ['figma', 'context7'], model: 'opus' }, body: 'Hello' })
  assert.deepEqual(parse('just text'), { meta: {}, body: 'just text' })
})

test('override + persona resolve; a persona without a valid base does not', () => {
  put('worker', 'Be careful.')
  put('frontend-worker', '---\nbase: worker\nmodel: sonnet\neffort: low\nmcp: [figma]\nlabels: [ui]\n---\nUI work.')
  put('broken', '---\nbase: nope\n---\nx')
  assert.deepEqual(resolve(repo, 'frontend-worker'), { name: 'frontend-worker', base: 'worker', model: 'sonnet', effort: 'low', mcp: ['figma'], skills: [], labels: ['ui'] })
  assert.equal(resolve(repo, 'worker').base, 'worker')
  assert.equal(resolve(repo, 'broken'), null)
  assert.equal(resolve(repo, '../x'), null)
  assert.equal(list(repo).length, 3)
})

test('check: bad base, unknown mcp, bad enum, unknown key, size', () => {
  put('big', `---\nbase: worker\nmcp: [nope]\neffort: max\ncolor: red\n---\n${'x\n'.repeat(CAP)}`)
  const f = check(repo, { catalog: ['figma'] })
  const has = (name, re) => f.some((x) => x.name === name && re.test(x.msg))
  assert.ok(has('broken', /needs `base:`/))
  assert.ok(has('big', /unknown MCP/) && has('big', /effort/) && has('big', /unknown key/) && has('big', /bytes; only/))
  assert.ok(!f.some((x) => x.name === 'worker'))
})

test('sections: base override first, then persona; cap truncates at a line with a note', () => {
  const s = sections(repo, 'worker', 'frontend-worker')
  assert.deepEqual(s.map(([h]) => h), ['Project role (worker, .wt-pack/roles/worker.md)', 'Project role (frontend-worker, .wt-pack/roles/frontend-worker.md)'])
  const [[, big]] = sections(repo, null, 'big')
  assert.match(big, /… truncated \(\d+ bytes over the 6 KB cap; see the file\)$/)
  assert.deepEqual(sections(repo, 'planner', null), [])
})

test('a worktree reads the main checkout; outside a repo is null', () => {
  assert.equal(mainCheckout(join(repo, '.wt-pack')), repo)
  assert.equal(mainCheckout(tmpdir()), null)
})

test('personas: only valid persona files (not broken ones), with labels, in filename order', () => {
  assert.deepEqual(personas(repo).map((p) => [p.name, p.base, p.labels]), [['big', 'worker', []], ['frontend-worker', 'worker', ['ui']]])
})

test('parse: trailing # comments are dropped, so the SKILL.md example file is valid', async () => {
  const { readFileSync } = await import('node:fs')
  const md = readFileSync(new URL('../../wt-roles/SKILL.md', import.meta.url), 'utf8')
  const ex = /```markdown\n(---[\s\S]*?\n---\n)/.exec(md)[1]
  const { meta } = parse(ex)
  assert.deepEqual(meta, { base: 'worker', model: 'sonnet', effort: 'low', mcp: ['figma'], skills: ['impeccable'], labels: ['ui', 'frontend'] })
})

test('hostile files: a huge run of spaces / unclosed comments is bounded; a symlink out of the checkout is ignored', async () => {
  const { symlinkSync } = await import('node:fs')
  put('hostile', `---\nbase: worker\n---\n${' '.repeat(70_000)}<!-- ${'<!--'.repeat(10_000)}`)
  const t = Date.now()
  sections(repo, null, 'hostile')
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`)
  const outside = join(tmpdir(), `roles-outside-${process.pid}.md`)
  writeFileSync(outside, '---\nbase: worker\n---\nSECRET')
  symlinkSync(outside, join(dir, 'linked.md'))
  assert.equal(resolve(repo, 'linked'), null)
  assert.ok(!sections(repo, null, 'linked').length)
})

test('a linked git worktree reads the main checkout', () => {
  const wt = join(realpathSync(tmpdir()), `roles-wt-${process.pid}`)
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'])
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'wtb'])
  assert.equal(mainCheckout(wt), repo)
  assert.equal(sections(mainCheckout(wt), 'worker', null).length, 1)
})

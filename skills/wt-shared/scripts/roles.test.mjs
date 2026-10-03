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

test('check: bad base, unknown mcp, bad enum, unknown key, collision, size', () => {
  put('big', `---\nbase: worker\nmcp: [nope]\neffort: max\ncolor: red\n---\n${'x\n'.repeat(CAP)}`)
  const f = check(repo, { catalog: ['figma'], settingsRoles: ['frontend-worker'] })
  const has = (name, re) => f.some((x) => x.name === name && re.test(x.msg))
  assert.ok(has('broken', /needs `base:`/))
  assert.ok(has('big', /unknown MCP/) && has('big', /effort/) && has('big', /unknown key/) && has('big', /bytes; only/))
  assert.ok(has('frontend-worker', /collides/))
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

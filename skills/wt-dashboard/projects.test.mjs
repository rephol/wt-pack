import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { createProject, hideProject } from './projects.mjs'

const run = (cmd, args, cwd, t, env) => new Promise((ok, no) => execFile(cmd, args, { cwd, env: { ...process.env, ...env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }, (e, o, s) => e ? no(new Error(s || e.message)) : ok(o)))
function setup(over = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wt-proj-')))
  const vals = { WT_DASHBOARD_PROJECTS: [], WT_DASHBOARD_HIDDEN_PROJECTS: [] }
  const rooms = []
  const calls = []
  const d = {
    home, run: (...a) => { calls.push(a); return (over.run ?? run)(...a) },
    cfg: { override: () => null, list: (k) => vals[k], setValue: async (k, v) => { vals[k] = v } },
    rooms: { create: async (r) => { rooms.push(r); return r } },
    roots: async () => new Map(vals.WT_DASHBOARD_PROJECTS.map((p) => [p.split('/').pop(), p])),
    repoRoot: (p) => run('git', ['-C', p, 'rev-parse', '--show-toplevel']).then((o) => o.trim(), (e) => { throw Object.assign(e, { status: 400 }) }),
  }
  return { d, home, vals, rooms, calls }
}

test('init creates a repo with a commit, persists it and makes the room', async () => {
  const { d, home, vals, rooms } = setup()
  const out = await createProject(d, { source: 'init', parent: home, name: 'qa-proj' })
  assert.equal(out.root, join(home, 'qa-proj'))
  assert.equal((await run('git', ['-C', out.root, 'log', '--oneline'])).trim().split('\n').length, 1)
  assert.deepEqual(vals.WT_DASHBOARD_PROJECTS, [out.root])
  assert.deepEqual(rooms, [{ title: 'qa-proj', project: 'qa-proj', slug: 'qa-proj' }])
  await assert.rejects(createProject(d, { source: 'init', parent: home, name: 'qa-proj' }), { status: 409 })
})
test('existing registers a repo; a bad name, non-repo and outside-home path are refused', async () => {
  const { d, home, vals } = setup()
  const repo = join(home, 'my-app'); mkdirSync(repo); await run('git', ['init', repo])
  assert.equal((await createProject(d, { source: 'existing', path: repo, room: false })).room, null)
  assert.deepEqual(vals.WT_DASHBOARD_PROJECTS, [realpathSync(repo)])
  const caps = join(home, 'Caps'); mkdirSync(caps); await run('git', ['init', caps])
  await assert.rejects(createProject(d, { source: 'existing', path: caps }), /not a valid project name/)
  await assert.rejects(createProject(d, { source: 'existing', path: home }), { status: 400 })
  await assert.rejects(createProject(d, { source: 'existing', path: tmpdir() }), { status: 400 })
})
test('validation: name, parent, url, source, env lock', async () => {
  const { d, home } = setup()
  await assert.rejects(createProject(d, { source: 'init', parent: home, name: 'QA' }), /lowercase/)
  await assert.rejects(createProject(d, { source: 'init', parent: join(home, 'nope'), name: 'x' }), /does not exist/)
  await assert.rejects(createProject(d, { source: 'init', parent: tmpdir(), name: 'x' }), /home directory/)
  await assert.rejects(createProject(d, { source: 'clone', parent: home, name: 'x', url: 'file:///x' }), /url/)
  await assert.rejects(createProject(d, { source: 'clone', parent: home, name: 'x', url: '-uevil' }), /url/)
  await assert.rejects(createProject(d, { source: 'zip' }), /source/)
  d.cfg.override = () => 'x'
  await assert.rejects(createProject(d, { source: 'init', parent: home, name: 'x' }), { status: 409 })
  assert.ok(!existsSync(join(home, 'x')))
})
test('clone runs git with protocols locked down and cleans up on failure', async () => {
  const { d, home, calls } = setup({ run: async (cmd, args) => { if (args.includes('clone')) { mkdirSync(args.at(-1)); throw new Error('boom') } } })
  await assert.rejects(createProject(d, { source: 'clone', parent: home, name: 'c', url: 'https://example.com/a/b.git' }), /clone failed: boom/)
  assert.ok(calls[0][1].includes('protocol.allow=never') && calls[0][1].includes('--') && calls[0][4].GIT_TERMINAL_PROMPT === '0')
  assert.ok(!existsSync(join(home, 'c')))
})
test('hide drops it from the list, unhides on re-add, deletes nothing', async () => {
  const { d, home, vals } = setup()
  const { root } = await createProject(d, { source: 'init', parent: home, name: 'gone' })
  d.roots = async () => new Map(vals.WT_DASHBOARD_PROJECTS.map((p) => [p.split('/').pop(), p]))
  await hideProject(d, 'gone')
  assert.deepEqual(vals.WT_DASHBOARD_PROJECTS, [])
  assert.deepEqual(vals.WT_DASHBOARD_HIDDEN_PROJECTS, ['gone'])
  assert.ok(existsSync(root))
  await assert.rejects(hideProject(d, 'nope'), { status: 404 })
  await createProject(d, { source: 'existing', path: root })
  assert.deepEqual(vals.WT_DASHBOARD_HIDDEN_PROJECTS, [])
})

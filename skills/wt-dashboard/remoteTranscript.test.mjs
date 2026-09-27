import test from 'node:test'
import assert from 'node:assert/strict'
import { ssh, hostOk, paneHints, projectDir, candidatesScript, tailScript, readScript, parseCandidates, matchCandidate, cutLines, Limiter, locate } from './remoteTranscript.mjs'

const A = '655088a9-831f-4fb0-bbf2-28b96c355918', B = '37b2a164-fbe5-4a47-8ebb-d8b353718924'
const user = (text) => JSON.stringify({ type: 'user', message: { content: text } })

test('ssh refuses a host that could become a flag or carry shell', async () => {
  for (const h of ['-oProxyCommand=x', 'a b', 'a;id', '', null]) {
    assert.equal(hostOk(h), false, String(h))
    await assert.rejects(ssh(h, 'true'), /refused ssh host/)
  }
  assert.equal(hostOk('herdr-box'), true)
  assert.equal(hostOk('me@10.0.0.2'), true)
})

test("projectDir is Claude's encoding and only ever [A-Za-z0-9-]; hostile cwds cannot escape", () => {
  assert.equal(projectDir('/work/projects/umkmall'), '-work-projects-umkmall')
  assert.equal(projectDir('/Users/x/my.repo_1'), '-Users-x-my-repo-1')
  for (const cwd of ['/x"; rm -rf ~; "', '/x$(id)', '/x\nid', '/../..', '/x`id`']) {
    const d = projectDir(cwd)
    assert.match(d, /^-[A-Za-z0-9-]+$/, cwd)
  }
  assert.equal(projectDir('relative/path'), null)
  assert.equal(projectDir(null), null)
})

test('scripts: only validated parts, double-quoted with $HOME; non-UUID ids and bad sizes refused', () => {
  const d = projectDir('/work/projects/umkmall')
  assert.equal(candidatesScript(d), `cd "$HOME/.claude/projects/-work-projects-umkmall" 2>/dev/null && find . -maxdepth 1 -name '*.jsonl' -mmin -10080 -printf '%T@ %s %f\\n'`)
  assert.equal(tailScript(d, A, 65536), `tail -c 65536 "$HOME/.claude/projects/-work-projects-umkmall/${A}.jsonl"`)
  assert.equal(readScript(d, A, 100, 4194304), `tail -c +101 "$HOME/.claude/projects/-work-projects-umkmall/${A}.jsonl" | head -c 4194304`)
  assert.throws(() => tailScript(d, '../../etc/passwd', 10), /refused/)
  assert.throws(() => tailScript('-x"; id; "', A, 10), /refused/)
  assert.throws(() => candidatesScript('/abs'), /refused/)
  assert.throws(() => readScript(d, A, -1, 10), /bad size/)
  assert.throws(() => readScript(d, A, 1.5, 10), /bad size/)
})

test('parseCandidates reads the live find output, newest first, UUIDs only', () => {
  const out = `1790480183.3938758170 46627945 ${B}.jsonl\n1790480304.0686004010 41053714 ${A}.jsonl\n1790480000.1 12 notes.jsonl\n`
  assert.deepEqual(parseCandidates(out).map((c) => [c.id, c.size]), [[A, 41053714], [B, 46627945]])
})

test('matchCandidate: one hit → it; two hits → unmatched; no hit with one candidate → it; no prompt, many → unmatched', () => {
  const cands = [{ id: A }, { id: B }]
  const tail = (...ps) => ['{"cut', ...ps.map(user)].join('\n')
  const tails = new Map([[A, tail('fix the  login\nbug please', 'other')], [B, tail('something else')]])
  assert.equal(matchCandidate(cands, tails, 'fix the login bug please')?.id, A) // whitespace-normalised
  assert.equal(matchCandidate(cands, new Map([[A, tail('same')], [B, tail('same')]]), 'same'), null)
  assert.equal(matchCandidate([{ id: A }], new Map([[A, tail('x')]]), 'nope')?.id, A)
  assert.equal(matchCandidate(cands, tails, 'nope'), null)
  assert.equal(matchCandidate(cands, tails, null), null)
  // A pane with no visible prompt: its last reply, wrapped at the pane width, still matches the assistant text.
  const reply = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: "The new-commits watcher expired with nothing new, and I've re-armed it." }] } })
  const t2 = new Map([[A, `cut\n${reply}`], [B, tail('other')]])
  assert.equal(matchCandidate(cands, t2, "The new-commits watcher expired\n  with nothing new, and I've")?.id, A)
  const tailText = "● Monitor(new commits on open\n  PRs)\n  ⎿  Monitor started\n\n● The new-commits watcher expired with nothing new,\n  and I've re-armed it.\n\n✻ Baked for 6s"
  assert.deepEqual(paneHints(tailText), ["The new-commits watcher expired with nothing new, and I've re-armed it."])
  assert.equal(matchCandidate(cands, t2, [null, 'short', ...paneHints(tailText)])?.id, A)
})

test('cutLines is byte-safe: a read boundary splitting é and an emoji still yields whole lines and exact offsets', () => {
  const text = `${user('café')}\n${user('ok 🎉 done')}\n`
  const bytes = Buffer.from(text)
  const splitAt = [bytes.indexOf(Buffer.from('é')) + 1, bytes.indexOf(Buffer.from('🎉')) + 2] // inside both multibyte chars
  let left = Buffer.alloc(0), from = 0, got = '', last = null
  for (const [a, b] of [[0, splitAt[0]], [splitAt[0], splitAt[1]], [splitAt[1], bytes.length]]) {
    const r = cutLines(left, bytes.subarray(a, b), a)
    got += r.text; left = r.left; if (r.end !== null) last = r.end
    from = b
  }
  assert.equal(got, text)
  assert.equal(last, bytes.length)
  assert.equal(left.length, 0)
  assert.equal(from, bytes.length)
})

test('Limiter: one in-flight call per pane, at most N per host, released after errors', async () => {
  const l = new Limiter(2)
  let release
  const hold = new Promise((r) => { release = r })
  const first = l.run('h', 'p1', () => hold)
  assert.equal(await l.run('h', 'p1', async () => 'dup'), null) // same pane busy
  const second = l.run('h', 'p2', () => hold)
  assert.equal(await l.run('h', 'p3', async () => 'x'), null) // host cap
  release('ok')
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok'])
  await assert.rejects(l.run('h', 'p1', async () => { throw new Error('boom') }))
  assert.equal(await l.run('h', 'p1', async () => 'again'), 'again')
})

test('locate: lists, tails and matches through the injected ssh', async () => {
  const calls = []
  const run = async (host, script) => {
    calls.push(script)
    if (script.includes('find')) return Buffer.from(`2 10 ${A}.jsonl\n1 10 ${B}.jsonl\n`)
    return Buffer.from(`cut\n${user(script.includes(A) ? 'deploy it' : 'hello')}`)
  }
  assert.equal((await locate({ host: 'herdr-box', cwd: '/work/projects/umkmall', prompt: 'hello', run }))?.id, B)
  assert.equal(await locate({ host: 'herdr-box', cwd: 'nope', prompt: 'x', run }), null)
  assert.equal(calls.length, 3)
})

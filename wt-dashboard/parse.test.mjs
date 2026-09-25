// Run: node --test
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePane , snapshot, transitions } from './server.mjs'

const rule = '─'.repeat(40)
const pane = `❯ fix the bug
⏺ Looked at it.
  Should I open a PR?

※ recap: Fixing the bug. Next, decide
  whether to open a PR.
${rule}
❯
${rule}
   Context: ▓▓░░ 383k/1M (38%)  Model: X
   cwd: /tmp/wt/umk-12
  ⏵⏵ bypass permissions on`

test('parsePane', () => {
  const p = parsePane(pane)
  assert.equal(p.recap, 'Fixing the bug. Next, decide whether to open a PR.')
  assert.deepEqual(p.context, { used: '383k', total: '1M', pct: 38 })
  assert.equal(p.cwd, '/tmp/wt/umk-12')
  assert.equal(p.asks, true)
  assert.equal(p.question, 'Should I open a PR?')
  assert.deepEqual(p.turns.map((t) => t.role), ['user', 'assistant'])
  assert.equal(p.lastPrompt, 'fix the bug')
})

test('answerPlan maps one picker question to keys', async () => {
  const { answerPlan } = await import('./server.mjs')
  const single = { multiSelect: false, cursor: 1, other: null, options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }] }
  assert.deepEqual(answerPlan(single, { selected: ['Blue'] }), [{ keys: ['2'] }])
  assert.deepEqual(answerPlan(single, { other: 'Purple' }), [{ keys: ['4'] }, { text: 'Purple' }, { keys: ['enter'] }])
  const multi = { multiSelect: true, cursor: 1, other: null, options: [{ label: 'Cat', checked: false }, { label: 'Dog', checked: true }, { label: 'Fish', checked: false }] }
  assert.deepEqual(answerPlan(multi, { selected: ['Cat', 'Dog'] }), [{ keys: ['1'] }, { keys: ['down', 'down', 'down', 'down', 'enter'] }])
  assert.deepEqual(answerPlan(multi, { selected: [], other: 'Bird' }), [{ keys: ['2'] }, { keys: ['4'] }, { keys: ['down', 'down', 'down'] }, { text: 'Bird' }, { keys: ['down', 'enter'] }])
  assert.throws(() => answerPlan(single, { selected: ['Nope'] }))
})

test('parsePicker: preview layout (left options, boxed preview of the focused one)', async () => {
  const { parsePicker, answerPlan } = await import('./server.mjs')
  const { readFileSync } = await import('node:fs')
  const pk = parsePicker(readFileSync(new URL('./test-fixtures/picker-preview.txt', import.meta.url), 'utf8'))
  assert.equal(pk.layout, 'preview')
  assert.equal(pk.question, 'What should the planners pick up next?')
  assert.deepEqual(pk.tabs.map((t) => t.header), ['Next up', 'Polish'])
  assert.deepEqual(pk.options.map((o) => [o.label, o.description]), [
    ['UMK-1177 OTP hang (Recommended)', ''], ['M5 video tickets', ''], ['UMK-1176 download log', ''],
  ])
  assert.equal(pk.preview, 'planner-02 -> /wt-plan UMK-1177')
  assert.equal(pk.cursor, 1)
  const pk2 = parsePicker(readFileSync(new URL('./test-fixtures/picker-preview-focus2.txt', import.meta.url), 'utf8'))
  assert.equal(pk2.cursor, 2)
  assert.equal(pk2.preview, 'planner-03 -> M5 tickets\nthen review')
  assert.deepEqual(answerPlan(pk, { selected: ['M5 video tickets'] }), [{ keys: ['2'] }, { keys: ['enter'] }])
  assert.throws(() => answerPlan(pk, { other: 'x' }))
})

test('parsePicker: wrapped option descriptions are joined, not cut', async () => {
  const { parsePicker } = await import('./server.mjs')
  const { readFileSync } = await import('node:fs')
  const pk = parsePicker(readFileSync(new URL('./test-fixtures/picker-wrapped-description.txt', import.meta.url), 'utf8'))
  assert.equal(pk.multiSelect, true)
  assert.deepEqual(pk.options.map((o) => o.description), [
    'Make the pinned question card collapsible so the conversation is not squeezed, and also remember whether it was collapsed across reloads of the dashboard page in local storage so it stays out of the way.',
    'Stop the Agents table scrolling sideways when the chat panel is open.',
  ])
})

test('chatPlan picks "Chat about this" per layout', async () => {
  const { chatPlan } = await import('./server.mjs')
  assert.deepEqual(chatPlan({ options: [1, 2, 3] }), [{ keys: ['5'] }])
  assert.deepEqual(chatPlan({ layout: 'preview', options: [1, 2, 3] }), [{ keys: ['3'] }, { keys: ['down'] }, { keys: ['enter'] }])
})

test('parsePicker: single question header without a tab bar', async () => {
  const { parsePicker } = await import('./server.mjs')
  const { readFileSync } = await import('node:fs')
  const pk = parsePicker(readFileSync(new URL('./test-fixtures/picker-single-question.txt', import.meta.url), 'utf8'))
  assert.equal(pk.question, 'Which color?')
  assert.deepEqual(pk.tabs, [{ header: 'Color', done: false }])
  assert.deepEqual(pk.options.map((o) => o.label), ['Red', 'Blue', 'Green'])
})

test('parsePicker: the exact Next up / Polish pair (focused tab from ANSI, revisit ✔, review)', async () => {
  const { parsePicker, stripAnsi } = await import('./server.mjs')
  const { readFileSync } = await import('node:fs')
  const read = (f) => { const raw = readFileSync(new URL(`./test-fixtures/${f}`, import.meta.url), 'utf8'); return parsePicker(stripAnsi(raw), raw) }
  const back = read('pair-back-to-q1.ansi.txt') // Q1 revisited after answering it
  assert.equal(back.current, 0)
  assert.equal(back.layout, 'preview')
  assert.deepEqual(back.options.map((o) => [o.label, o.checked]), [['UMK-1177 OTP hang (Recommended)', true], ['M5 video tickets', false], ['UMK-1176 download log', false]])
  const q2 = read('pair-q2-multiselect.ansi.txt')
  assert.equal(q2.current, 1)
  assert.equal(q2.multiSelect, true)
  assert.equal(q2.options[0].description, "Make the pinned question card collapsible so the conversation isn't squeezed.")
  const review = read('pair-review.ansi.txt')
  assert.equal(review.review, true)
  assert.deepEqual(review.answers.map((a) => a.answer), ['UMK-1177 OTP hang (Recommended)', 'Wider Task column, Nav overlay dots'])
})

test('transitions: baseline is silent, then one event per transition into needs/done/stalled and CI fail', () => {
  const ov = (agents, tasks = [], prs = []) => ({ agents, tasks, prs })
  const a = (status, extra = {}) => ({ key: 'm|p1', id: 'p1', machine: 'm', name: 'w1', project: 'x', status, ...extra })
  const s0 = snapshot(ov([a('idle', { asks: true, question: 'Q?' })], [], [{ number: 1, state: 'OPEN', ci: 'pass' }]))
  assert.deepEqual(transitions(null, s0), [])
  assert.deepEqual(transitions(s0, s0), [])
  const s1 = snapshot(ov([a('working')], [], [{ number: 1, state: 'OPEN', ci: 'fail', title: 't' }]))
  assert.deepEqual(transitions(s0, s1).map((e) => e.type), ['ci_failed'])
  const s2 = snapshot(ov([a('idle', { asks: true, question: 'Pick?' })], [], [{ number: 1, state: 'OPEN', ci: 'fail' }]))
  const e = transitions(s1, s2)
  assert.deepEqual(e.map((x) => [x.type, x.text, x.dedupe]), [['needs_you', 'Pick?', 'm|p1|needs_you|Pick?']])
  const s3 = snapshot(ov([a('done', { recap: 'did it' })]))
  assert.deepEqual(transitions(s2, s3).map((x) => [x.type, x.text]), [['done', 'did it']])
  const s4 = snapshot(ov([a('idle')], [{ state: 'stalled', agent: { key: 'm|p1' } }]))
  assert.deepEqual(transitions(s3, s4).map((x) => x.type), ['stalled'])
})

test('normalizeEntry: tool_result images surface as assistant rows; SendUserFile becomes file cards', async () => {
  const { normalizeEntry } = await import('./server.mjs')
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
  const r = normalizeEntry({ type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [img] }] } })
  assert.deepEqual(r.map((m) => m.role), ['tool', 'assistant'])
  assert.match(r[1].images[0], /^data:image\/png;base64,/)
  const f = normalizeEntry({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'x', name: 'SendUserFile', input: { files: [new URL('./package.json', import.meta.url).pathname, '/nope/missing.html'], caption: 'c' } }] } })
  assert.equal(f[0].role, 'assistant')
  assert.deepEqual(f[0].files.map((x) => [x.name, x.size === null]), [['package.json', false], ['missing.html', true]])
  assert.equal(f[0].caption, 'c')
})

test('rooms: mentions, @all, agent→agent gating, hop limit, rate limit, idle-only delivery, ticket rooms', async () => {
  const R = await import('./rooms.mjs')
  const agents = [{ key: 'm/a', name: 'room-test-a' }, { key: 'm/b', name: 'room-test-b' }]
  const names = agents.map((a) => a.name)
  assert.deepEqual(R.parseMentions('@room-test-a say hi to @room-test-b. cc @nobody @ALL', names), ['room-test-a', 'room-test-b', 'all'])
  assert.deepEqual(R.parseMentions('mail a@room-test-a', names), [])
  const S = { ...R.DEFAULT_SETTINGS }
  const room = { hops: 0, members: ['room-test-a', 'room-test-b'] }
  const user = (text) => ({ author: { kind: 'user', name: 'you' }, mentions: R.parseMentions(text, names) })
  const fromA = (text) => ({ author: { kind: 'agent', name: 'room-test-a' }, mentions: R.parseMentions(text, names) })
  assert.deepEqual(R.planDelivery({ msg: user('@room-test-a hi'), room, settings: S, agents }).deliver, ['m/a'])
  // @all: user needs confirmation; agents never
  assert.deepEqual(R.planDelivery({ msg: user('@all'), room, settings: S, agents }).deliver, [])
  assert.deepEqual(R.planDelivery({ msg: user('@all'), room, settings: S, agents, confirmAll: true }).deliver, ['m/a', 'm/b'])
  assert.equal(R.planDelivery({ msg: fromA('@all'), room, settings: { ...S, agentToAgent: true }, agents }).blocked[0].reason, 'agents cannot @all')
  // agent→agent off by default: shown, not delivered
  const off = R.planDelivery({ msg: fromA('hi @room-test-b'), room, settings: S, agents })
  assert.deepEqual([off.deliver, off.blocked[0].reason], [[], 'not delivered — agent-to-agent is off'])
  // on: delivered and counted; stops at maxHops with a pause note; a user message resets
  const on = { ...S, agentToAgent: true, maxHops: 3 }
  let r = { ...room }
  for (let i = 0; i < 3; i++) { const p = R.planDelivery({ msg: fromA('@room-test-b go'), room: r, settings: on, agents }); assert.deepEqual(p.deliver, ['m/b']); r.hops = p.hops }
  const stop = R.planDelivery({ msg: fromA('@room-test-b go'), room: r, settings: on, agents })
  assert.deepEqual([stop.deliver, stop.pauseNote], [[], 'paused: waiting for a human'])
  assert.equal(R.planDelivery({ msg: user('@room-test-b ok'), room: r, settings: on, agents }).hops, 0)
  assert.deepEqual(R.planDelivery({ msg: user('@room-test-a'), room: { ...room, paused: true }, settings: S, agents }).deliver, [])
  // rate limit: 6 per 10 min
  const t0 = 1_000_000
  assert.equal(R.rateOk(Array(5).fill(t0), t0 + 1, S), true)
  assert.equal(R.rateOk(Array(6).fill(t0), t0 + 1, S), false)
  assert.equal(R.rateOk(Array(6).fill(t0), t0 + 10 * 60_000, S), true)
  // idle-only delivery
  assert.equal(R.deliverable({ status: 'idle' }), true)
  assert.equal(R.deliverable({ status: 'working' }), false)
  assert.equal(R.deliverable({ status: 'idle', asks: true }), false)
  assert.match(R.batchPrompt('x', [{ author: { name: 'you' }, text: 'hi' }]), /^\[room #x\] 1 new message:\nyou: hi\nReply with: ~\/\.claude\/skills\/wt-room\/scripts\/room post x/)
  // ticket rooms: suggest mode lists active tickets without a room, minus dismissed; off/auto list none
  const task = { id: 'UMK-1177', title: 'OTP hang', state: 'planning', agent: { name: 'umkmall-planner-02' }, worktree: '/w', plan: null, pr: null }
  const sug = R.ticketSuggestions([task, { ...task, id: 'agent:x', adHoc: true }], [], S)
  assert.deepEqual(sug.map((x) => [x.ticket, x.reason]), [['UMK-1177', 'umkmall-planner-02 is planning']])
  assert.deepEqual(R.ticketSuggestions([task], ['umk-1177'], S), [])
  assert.deepEqual(R.ticketSuggestions([task], [], { ...S, dismissedTickets: ['UMK-1177'] }), [])
  assert.deepEqual(R.ticketSuggestions([task], [], { ...S, ticketRooms: 'auto' }), [])
  assert.equal(S.ticketRooms, 'suggest')
  const later = { ...task, state: 'in_review', plan: 'p.md', pr: { number: 9, state: 'OPEN', ci: 'fail', url: 'u' } }
  assert.deepEqual(R.ticketEvents(null, later), [])
  assert.deepEqual(R.ticketEvents(task, later), ['plan committed', 'PR #9 opened: u', 'CI failed on PR #9'])
  assert.ok(R.ticketFacts(later).includes('plan committed'))
})

test('session gate: state-changing API calls need the page cookie; only an agent room post is exempt', async () => {
  const { needsSession, hasSession } = await import('./server.mjs')
  assert.equal(needsSession('GET', '/api/overview', {}), false)
  assert.equal(needsSession('POST', '/api/agents/m/p1', {}), true)
  assert.equal(needsSession('POST', '/api/agents/m/p1/stop', {}), true)
  assert.equal(needsSession('POST', '/api/uploads', {}), true)
  assert.equal(needsSession('PATCH', '/api/settings', {}), true)
  assert.equal(needsSession('POST', '/api/rooms/x/messages', {}), true)
  assert.equal(needsSession('POST', '/api/rooms/x/messages', { 'x-herdr-pane': 'w1:p1' }), false)
  assert.equal(needsSession('DELETE', '/api/rooms/x', { 'x-herdr-pane': 'w1:p1' }), true) // agents cannot delete
  assert.equal(needsSession('POST', '/api/rooms', { 'x-herdr-pane': 'w1:p1' }), true)
  assert.equal(hasSession('a=1; hd_session=tok', 'tok'), true)
  assert.equal(hasSession('hd_session=nope', 'tok'), false)
  assert.equal(hasSession(undefined, 'tok'), false)
})

test('rooms: @user from an agent needs you until the user replies; the handle is never an agent target', async () => {
  const R = await import('./rooms.mjs')
  const fromA = { author: { kind: 'agent', name: 'a' }, text: '@user which one?', ts: 't1', id: '1', mentions: ['user'] }
  let n = R.nextNeedsYou([], fromA, 'user')
  assert.deepEqual(n.map((x) => [x.agent, x.text]), [['a', '@user which one?']])
  n = R.nextNeedsYou(n, { ...fromA, text: '@USER again', id: '2', mentions: ['USER'] }, 'user')
  assert.equal(n.length, 1) // one entry per agent, latest text
  assert.deepEqual(R.nextNeedsYou(n, { author: { kind: 'agent', name: 'b' }, mentions: [] }, 'user'), n) // FYI without @user: unchanged
  assert.deepEqual(R.nextNeedsYou(n, { author: { kind: 'user', name: 'me' }, mentions: [] }, 'user'), []) // user replied
  const S = { ...R.DEFAULT_SETTINGS }
  assert.deepEqual(R.parseMentions('hey @user and @a', ['a', S.profile.handle]), ['user', 'a'])
  const p = R.planDelivery({ msg: { author: { kind: 'agent', name: 'b' }, mentions: ['user'] }, room: { hops: 0 }, settings: S, agents: [{ key: 'k', name: 'a' }] })
  assert.deepEqual([p.deliver, p.blocked], [[], []])
  // The view reads queuedFor/notified: @user never shows as queued, it shows as "notified you".
  const m = { author: { kind: 'agent', name: 'b' }, mentions: ['user', 'a'] }
  const q = R.mentionStatus(m, { deliver: ['k'] }, [{ key: 'k', name: 'a' }], 'User')
  assert.deepEqual(q, { queuedFor: ['a'], notified: true })
  assert.equal(R.mentionStatus({ author: { kind: 'user' }, mentions: ['user'] }, { deliver: [] }, [], 'user').notified, false)
})

test('canonicalPane: a stable $HERDR_PANE_ID resolves to the current display id; bad ids and failures are null', async () => {
  const { canonicalPane } = await import('./server.mjs')
  let calls = 0
  const get = async (id) => { calls++; if (id === 'w4:pM') return JSON.stringify({ result: { pane: { pane_id: 'wM:p6' } } }); throw new Error('no such pane') }
  const cache = new Map()
  assert.equal(await canonicalPane('w4:pM', get, cache, 0), 'wM:p6')
  assert.equal(await canonicalPane('w4:pM', get, cache, 1000), 'wM:p6')
  assert.equal(calls, 1) // cached
  assert.equal(await canonicalPane('w4:pM', get, cache, 40_000), 'wM:p6')
  assert.equal(calls, 2) // TTL expired, re-resolved
  assert.equal(await canonicalPane('zz:p9', get, cache, 0), null)
  assert.equal(await canonicalPane('--help', get, cache, 0), null)
})

test('rooms routing: mention > responder > broadcast > nobody', async () => {
  const R = await import('./rooms.mjs')
  const S = { ...R.DEFAULT_SETTINGS }
  const agents = [{ key: 'm/a', name: 'a' }, { key: 'm/b', name: 'b' }, { key: 'm/c', name: 'c' }]
  const user = (mentions) => ({ author: { kind: 'user', name: 'me' }, mentions })
  const plan = (msg, room) => { const p = R.planDelivery({ msg, room: { hops: 0, members: ['a', 'b'], ...room }, settings: S, agents }); return [p.route, p.deliver] }
  // a mention wins over both responder and broadcast
  assert.deepEqual(plan(user(['c']), { responder: 'm/a', broadcast: true }), ['mention', ['m/c']])
  // mentioning only the user's own handle counts as no mention
  assert.deepEqual(plan(user(['user']), { responder: 'm/a' }), ['responder', ['m/a']])
  // broadcast: every agent member; beats the responder
  assert.deepEqual(plan(user([]), { responder: 'm/a', broadcast: true }), ['broadcast', ['m/a', 'm/b']])
  assert.deepEqual(plan(user([]), { responder: 'm/a' }), ['responder', ['m/a']])
  assert.deepEqual(plan(user([]), {}), ['none', []])
  // a responder that is not running is reported, not silently dropped
  const gone = R.planDelivery({ msg: user([]), room: { hops: 0, responder: 'm/zz', members: [] }, settings: S, agents })
  assert.deepEqual([gone.route, gone.blocked[0].reason], ['none', 'responder is not running'])
  // agent messages never fall back to responder/broadcast
  assert.deepEqual(R.planDelivery({ msg: { author: { kind: 'agent', name: 'b' }, mentions: [] }, room: { hops: 0, responder: 'm/a', broadcast: true, members: ['a', 'b'] }, settings: S, agents }).deliver, [])
  assert.match(R.batchPrompt('x', [{ author: { name: 'me' }, text: 'hi' }], true), /Reply only if this is addressed to you/)
  assert.doesNotMatch(R.batchPrompt('x', [{ author: { name: 'me' }, text: 'hi' }]), /Reply only if/)
})

test('rooms index: a room whose jsonl exists is never dropped; writes are atomic', async () => {
  const R = await import('./rooms.mjs')
  const idx = [{ slug: 'a', title: 'A' }]
  assert.deepEqual(R.reconcileIndex(idx, ['a.jsonl', 'b.jsonl', 'x.tmp']).map((r) => [r.slug, Boolean(r.recovered)]), [['a', false], ['b', true]])
  const { mkdtemp, readFile, readdir } = await import('node:fs/promises')
  const dir = await mkdtemp((await import('node:os')).tmpdir() + '/rooms-')
  await R.atomicWrite(dir + '/rooms.json', '[1]')
  assert.equal(await readFile(dir + '/rooms.json', 'utf8'), '[1]')
  assert.deepEqual(await readdir(dir), ['rooms.json']) // no temp left behind
})

test('inbox: transitions map to kinds; actionable items resolve when their condition clears; one item per condition', async () => {
  const I = await import('./inbox.mjs')
  const q = I.itemFromTransition({ type: 'needs_you', key: 'm/p1', name: 'w1', project: 'x', text: 'Pick?', dedupe: 'm|p1|needs_you|Pick?' })
  assert.deepEqual([q.kind, q.title, q.target], ['question', 'w1 (x) asks you', { agent: 'm/p1' }])
  const r = I.itemFromTransition({ type: 'needs_you', key: 'room:ops', name: 'a in #ops', text: '@user ok?', dedupe: 'k' })
  assert.deepEqual([r.kind, r.target], ['mention-user', { room: 'ops' }])
  assert.equal(I.itemFromTransition({ type: 'ci_failed', key: null, name: 'PR #9', dedupe: 'pr' }).kind, 'ci-failed')
  const items = [
    { id: '1', kind: 'question', target: { agent: 'm/p1' } },
    { id: '2', kind: 'mention-user', target: { room: 'ops' } },
    { id: '3', kind: 'room-suggestion', target: { task: 'UMK-1' } },
    { id: '4', kind: 'agent-done', target: { agent: 'm/p1' } },
    { id: '5', kind: 'question', target: { agent: 'm/p2' }, resolvedAt: 't' },
  ]
  assert.deepEqual(I.toResolve(items, new Set(['m/p1', 'room:ops']), new Set(['UMK-1'])), [])
  assert.deepEqual(I.toResolve(items, new Set(), new Set()), ['1', '2', '3'])
  const { mkdtemp } = await import('node:fs/promises')
  const box = new I.Inbox((await mkdtemp((await import('node:os')).tmpdir() + '/inbox-')) + '/n.jsonl')
  assert.ok(await box.add({ kind: 'question', key: 'k', title: 't', body: '', target: { agent: 'a' } }))
  assert.equal(await box.add({ kind: 'question', key: 'k', title: 't', body: '', target: { agent: 'a' } }), null)
  await box.patch([box.items[0].id], { read: true })
  const again = new I.Inbox(box.file); await again.load()
  assert.equal(again.items[0].read, true) // updates survive a reload
  await box.add({ kind: 'agent-done', key: 'd', title: 'd', body: '', target: { agent: 'a' } })
  assert.equal(await box.clear({ allRead: true }), 1) // only the read one
  assert.deepEqual(box.list().map((it) => it.key), ['d'])
  assert.equal(box.open().length, 0) // a cleared question leaves the tray
  await box.clear({ all: true })
  const third = new I.Inbox(box.file); await third.load()
  assert.equal(third.list().length, 0); assert.equal(third.items.length, 2) // kept in the jsonl, not shown
})

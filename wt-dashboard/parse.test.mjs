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

test('session gate: state-changing API calls need the page cookie; only agent room posts and room create are exempt', async () => {
  const { needsSession, hasSession } = await import('./server.mjs')
  assert.equal(needsSession('GET', '/api/overview', {}), false)
  assert.equal(needsSession('POST', '/api/agents/m/p1', {}), true)
  assert.equal(needsSession('POST', '/api/agents/m/p1/stop', {}), true)
  assert.equal(needsSession('POST', '/api/uploads', {}), true)
  assert.equal(needsSession('PATCH', '/api/settings', {}), true)
  assert.equal(needsSession('POST', '/api/rooms/x/messages', {}), true)
  assert.equal(needsSession('POST', '/api/rooms/x/messages', { 'x-herdr-pane': 'w1:p1' }), false)
  assert.equal(needsSession('DELETE', '/api/rooms/x', { 'x-herdr-pane': 'w1:p1' }), true) // agents cannot delete
  assert.equal(needsSession('POST', '/api/rooms', { 'x-herdr-pane': 'w1:p1' }), false) // `room create`: pane identity + the agentsCreateRooms setting gate it
  assert.equal(needsSession('POST', '/api/rooms', {}), true)
  assert.equal(needsSession('PATCH', '/api/rooms/x', { 'x-herdr-pane': 'w1:p1' }), true) // agents cannot archive
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

test('rooms: a "/" message is a command for exactly one agent (mention, else responder), never broadcast', async () => {
  const R = await import('./rooms.mjs')
  const ag = [{ key: 'k1', name: 'p1' }, { key: 'k2', name: 'p2' }]
  const u = (text, mentions = []) => ({ author: { kind: 'user' }, text, mentions })
  assert.equal(R.parseCommand(u('hello /not-a-command'), {}, ag, 'user'), null)
  assert.deepEqual(R.parseCommand(u('@p2 /wt-plan UMK-1', ['p2']), { responder: 'k1' }, ag, 'user'), { text: '/wt-plan UMK-1', target: ag[1] })
  assert.equal(R.parseCommand(u('/wt-plan UMK-1'), { responder: 'k1' }, ag, 'user').target, ag[0]) // responder
  assert.equal(R.parseCommand(u('/wt-plan'), {}, ag, 'user').error, R.ONE_TARGET) // nobody
  assert.equal(R.parseCommand(u('@p1 @p2 /x', ['p1', 'p2']), {}, ag, 'user').error, R.ONE_TARGET) // two
  assert.equal(R.parseCommand(u('@all /x', ['all']), { responder: 'k1' }, ag, 'user').error, R.ONE_TARGET)
  assert.equal(R.parseCommand({ author: { kind: 'agent' }, text: '/x', mentions: [] }, { responder: 'k1' }, ag, 'user'), null) // agents: plain text
})

test('rooms: commands are delivered RAW and alone; attachments ride as paths for local agents, as a note for remote', async () => {
  const R = await import('./rooms.mjs')
  const { mkdtemp } = await import('node:fs/promises')
  const dir = await mkdtemp((await import('node:os')).tmpdir() + '/rooms-cmd-')
  const agents = [{ key: 'L', name: 'loc', status: 'idle', local: true }, { key: 'X', name: 'rem', status: 'idle', local: false }]
  const sent = []
  const rooms = new R.Rooms({ dir, agents: async () => agents, prompt: async (a, t) => { sent.push([a.name, t]) }, log: () => {} })
  await rooms.load()
  await rooms.create({ title: 'r', responder: 'L' })
  const user = { kind: 'user', name: 'me', handle: 'user' }
  const img = [{ path: '/u/a.png', type: 'image/png', size: 1 }]
  await rooms.post('r', { author: user, text: 'plain first' })
  await rooms.post('r', { author: user, text: '/wt-plan UMK-1', attachments: img })
  await rooms.flush() // the plain message goes first, alone (a command is never batched with it)
  await rooms.flush() // then the command, raw, with the image path after its args
  assert.equal(sent[0][1].startsWith('[room #r] 1 new message'), true)
  assert.deepEqual(sent[1], ['loc', '/wt-plan UMK-1\n/u/a.png'])
  const msgs = await rooms.messages('r')
  assert.ok(msgs.some((m) => m.author.kind === 'system' && m.text === 'ran /wt-plan UMK-1 on loc'))
  await assert.rejects(rooms.post('r', { author: user, text: '@loc @rem /x' }), /one agent/)
  // Remote recipient: text + note, and the message records what was not delivered.
  await rooms.post('r', { author: user, text: '@rem look', attachments: img })
  await rooms.flush()
  const last = sent.at(-1)
  assert.equal(last[0], 'rem'); assert.match(last[1], /me: @rem look\n\(1 image not delivered — remote agent\)/); assert.doesNotMatch(last[1], /\/u\/a\.png/)
  assert.deepEqual((await rooms.messages('r')).find((m) => m.text === '@rem look').undelivered, [{ to: 'rem', n: 1 }])
  // "finished" once the agent was seen working and is idle again.
  agents[0].status = 'working'; await rooms.flush(); agents[0].status = 'idle'; await rooms.flush()
  assert.ok((await rooms.messages('r')).some((m) => m.text === 'finished /wt-plan on loc'))
})

test('parsePane: background work from the last turn-status line (shells, tasks), 0 when none', () => {
  const box = '─'.repeat(40)
  const pane = (status) => `⏺ ok\n${status}\n\n${box}\n❯ \n${box}\n  cwd: /x\n`
  assert.equal(parsePane(pane('✻ Cooked for 5s · done 7:08 PM · 1 shell still running')).background, 1)
  assert.equal(parsePane(pane('✻ Cooked for 5s · 2 shells still running · 1 background task')).background, 3)
  assert.equal(parsePane(pane('✻ Cooked for 5s · done 7:08 PM')).background, 0)
})

test('usage: dedupe by message id, incremental offsets, partial lines wait, bucketing and notional cost', async () => {
  const U = await import('./usage.mjs')
  const { mkdtemp, mkdir, writeFile, appendFile } = await import('node:fs/promises')
  const root = await mkdtemp((await import('node:os')).tmpdir() + '/usage-')
  await mkdir(root + '/proj')
  const f = root + '/proj/s1.jsonl'
  const now = Date.parse('2026-09-25T12:00:00Z')
  const line = (id, ts, model, u) => JSON.stringify({ type: 'assistant', sessionId: 's1', cwd: '/r', timestamp: ts, message: { id, model, usage: u } }) + '\n'
  const u1 = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 }
  // the same message written twice (one line per content block) counts once
  await writeFile(f, line('m1', '2026-09-25T10:00:00Z', 'claude-opus-5-5', u1) + line('m1', '2026-09-25T10:00:00Z', 'claude-opus-5-5', u1) + '{"type":"user"}\n')
  const agg = new U.UsageAgg()
  await agg.refresh(root, now)
  let s = agg.summary(0, (r) => r.model)
  assert.equal(s.tokens, 11110)
  assert.equal(+s.cost.toFixed(6), +((10 * 4 + 100 * 20 + 1000 * 5 + 10000 * 0.2) / 1e6).toFixed(6))
  // appended bytes only; a line without its newline yet is not read until it completes
  const half = line('m2', '2026-09-20T10:00:00Z', 'claude-mystery-9', { input_tokens: 1, output_tokens: 1 })
  await appendFile(f, half.slice(0, 20))
  await agg.refresh(root, now)
  assert.equal(agg.summary(0, (r) => r.model).tokens, 11110)
  await appendFile(f, half.slice(20))
  await agg.refresh(root, now)
  s = agg.summary(0, (r) => r.model)
  assert.equal(s.tokens, 11112); assert.equal(s.priced, false) // unknown model: tokens only
  assert.deepEqual(s.groups.map((g) => g.key), ['claude-opus-5-5', 'claude-mystery-9'])
  // bucketing by time: "today" excludes the older message
  assert.equal(agg.summary(Date.parse('2026-09-25T00:00:00Z'), (r) => r.session).tokens, 11110)
})

test('usage: limits never expose tokenHash; missing fields are null; stale after 10 minutes', async () => {
  const U = await import('./usage.mjs')
  const { mkdtemp, writeFile, utimes } = await import('node:fs/promises')
  const f = (await mkdtemp((await import('node:os')).tmpdir() + '/lim-')) + '/usage.json'
  await writeFile(f, JSON.stringify({ sessionUsage: 21, weeklyUsage: 69, tokenHash: 'secret' }))
  const old = new Date(Date.now() - 20 * 60_000); await utimes(f, old, old)
  const l = await U.readLimits(f)
  assert.equal(JSON.stringify(l).includes('secret'), false)
  assert.equal(l.session, 21); assert.equal(l.sessionResetAt, null); assert.equal(l.stale, true)
})

// ---- Integrations & environment (config.mjs) ----
import { Config, isLoopbackRequest, setEnvLine, keychain } from './config.mjs'
import { mkdtempSync, writeFileSync as wfs, readFileSync as rfs, statSync as sfs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pj } from 'node:path'

const KEYVAL = 'lin_api_SECRETsecret1234abcd'
const fakeKc = () => { const m = {}; return { m, get: async (a) => m[a] ?? null, set: async (a, v) => { m[a] = v }, del: async (a) => { delete m[a] } } }
const tmpCfg = (text = '', env = {}, kc = fakeKc()) => {
  const f = pj(mkdtempSync(pj(tmpdir(), 'wtd-cfg-')), 'env'); wfs(f, text)
  return { f, kc, cfg: new Config({ file: f, env, kc, platform: 'darwin' }) }
}

test('config: the secret never appears in the public state, only last4', async () => {
  const { cfg, kc, f } = tmpCfg('LINEAR_API_KEY=lin_api_oldoldoldold\nOTHER=1\n', {})
  await cfg.load()
  assert.equal(await cfg.setSecret('LINEAR_API_KEY', KEYVAL), 'keychain')
  assert.equal(kc.m.LINEAR_API_KEY, KEYVAL)
  assert.equal(rfs(f, 'utf8'), 'OTHER=1\n') // the plaintext copy is gone from the file
  const pub = JSON.stringify(cfg.publicState())
  assert.ok(!pub.includes(KEYVAL) && !pub.includes('SECRETsecret'))
  assert.match(pub, /"last4":"abcd"/)
  assert.equal(cfg.source('LINEAR_API_KEY'), 'keychain')
})

test('config: keychain failure falls back to a 0600 env file', async () => {
  const kc = { get: async () => null, set: async () => { throw new Error('no') }, del: async () => {} }
  const { cfg, f } = tmpCfg('', {}, kc)
  await cfg.load()
  assert.equal(await cfg.setSecret('LINEAR_API_KEY', KEYVAL), 'file')
  assert.equal(sfs(f).mode & 0o777, 0o600)
  assert.equal(cfg.source('LINEAR_API_KEY'), 'file')
  assert.ok(!JSON.stringify(cfg.publicState()).includes(KEYVAL))
})

test('config: precedence env var > keychain > file; an app-injected file value is not an override', async () => {
  const { cfg } = tmpCfg('WT_DASHBOARD_ALLOWED_HOSTS=a.ts.net\n', { WT_DASHBOARD_ALLOWED_HOSTS: 'a.ts.net', LINEAR_API_KEY: 'lin_api_fromtheenv0000' })
  await cfg.load()
  assert.equal(cfg.source('WT_DASHBOARD_ALLOWED_HOSTS'), 'file')
  assert.equal(cfg.override('WT_DASHBOARD_ALLOWED_HOSTS'), null)
  await cfg.setValue('WT_DASHBOARD_ALLOWED_HOSTS', ['B.ts.net', 'c.ts.net'])
  assert.deepEqual(cfg.list('WT_DASHBOARD_ALLOWED_HOSTS'), ['b.ts.net', 'c.ts.net']) // applies at runtime
  await cfg.setSecret('LINEAR_API_KEY', KEYVAL)
  assert.equal(cfg.get('LINEAR_API_KEY'), 'lin_api_fromtheenv0000')
  assert.equal(cfg.source('LINEAR_API_KEY'), 'env')
})

test('config: allowed hosts are exact hostnames only', async () => {
  const { cfg } = tmpCfg()
  for (const bad of [['*.ts.net'], ['https://x.ts.net'], ['x.ts.net:443'], ['a b']])
    await assert.rejects(cfg.setValue('WT_DASHBOARD_ALLOWED_HOSTS', bad), /exact hostnames/)
})

test('config: the keychain writer passes the secret on stdin, never in argv', async () => {
  const calls = []
  const kc = keychain(async (cmd, args, input) => { calls.push({ cmd, args, input }); return '' })
  await kc.set('LINEAR_API_KEY', KEYVAL)
  assert.ok(!calls[0].args.join(' ').includes(KEYVAL))
  assert.ok(calls[0].input.includes(KEYVAL))
  await assert.rejects(kc.set('LINEAR_API_KEY', 'x" ; delete-keychain'), /unexpected/)
})

test('setEnvLine keeps other lines and comments', () => {
  assert.equal(setEnvLine('# c\nA=1\nB=2\n', 'A', '3'), '# c\nB=2\nA=3\n')
  assert.equal(setEnvLine('A=1\n', 'A', null), '')
})

test('isLoopbackRequest: only this machine\'s own 127.0.0.1 page, never a tailnet proxy', () => {
  const r = (addr, headers) => ({ socket: { remoteAddress: addr }, headers })
  assert.equal(isLoopbackRequest(r('127.0.0.1', { host: '127.0.0.1:7777' })), true)
  assert.equal(isLoopbackRequest(r('::1', { host: 'localhost:7777' })), true)
  assert.equal(isLoopbackRequest(r('127.0.0.1', { host: 'mac.tail1234.ts.net' })), false) // tailscale serve
  assert.equal(isLoopbackRequest(r('127.0.0.1', { host: '127.0.0.1:7777', 'x-forwarded-for': '100.64.0.2' })), false)
  assert.equal(isLoopbackRequest(r('127.0.0.1', { host: '127.0.0.1:7777', 'tailscale-user-login': 'a@b' })), false)
  assert.equal(isLoopbackRequest(r('100.64.0.2', { host: '127.0.0.1:7777' })), false)
})

import { restartBurst } from './server.mjs'
test('restartBurst: warns at 3+ starts inside 5 minutes, forgets older ones', () => {
  const now = 10_000_000
  assert.equal(restartBurst([now - 400_000, now - 60_000, now], now).warn, 0)
  assert.deepEqual(restartBurst([now - 400_000, now - 200_000, now - 60_000, now], now), { recent: [now - 200_000, now - 60_000, now], warn: 3 })
})

import { plist, LABEL } from './scripts/service.mjs'
import { execFileSync as xfs } from 'node:child_process'
test('service plist: valid, crash-only KeepAlive, launchd marker, escaped paths', () => {
  const f = pj(mkdtempSync(pj(tmpdir(), 'wtd-pl-')), 'x.plist')
  wfs(f, plist({ node: '/opt/homebrew/bin/node', root: '/a b/wt&d', path: '/usr/bin:/bin', log: '/tmp/l.log' }))
  const j = JSON.parse(xfs('/usr/bin/plutil', ['-convert', 'json', '-o', '-', f], { encoding: 'utf8' }))
  assert.equal(j.Label, LABEL)
  assert.deepEqual(j.ProgramArguments, ['/opt/homebrew/bin/node', '/a b/wt&d/server.mjs'])
  assert.deepEqual(j.KeepAlive, { SuccessfulExit: false })
  assert.equal(j.EnvironmentVariables.WT_DASHBOARD_MANAGED, 'launchd')
  assert.equal(j.EnvironmentVariables.WT_DASHBOARD_APP, undefined) // APP=1 would make it exit when its parent (launchd, pid 1) "dies"
  assert.equal(j.ThrottleInterval, 10)
})

import { herdrKeys, allowedCwd, isShellPane, TerminalSettings } from './terminals.mjs'
test('terminals: key whitelist maps to herdr names and refuses anything else', () => {
  assert.deepEqual(herdrKeys(['C-c', 'Enter', 'Up']), ['ctrl+c', 'enter', 'up'])
  assert.throws(() => herdrKeys(['C-c', 'rm -rf']), /not allowed/)
  assert.throws(() => herdrKeys(['__proto__']), /not allowed/)
  assert.throws(() => herdrKeys([]), /1–32/)
})
test('terminals: a shell starts only in a project, a worktree, $HOME or tmp', () => {
  const pl = { roots: ['/r/umkmall'], worktrees: ['/r/umkmall/.wt/umk-1'], home: '/Users/me', tmp: ['/private/tmp'] }
  for (const ok of ['/r/umkmall', '/r/umkmall/', '/r/umkmall/.wt/umk-1', '/Users/me', '/private/tmp']) assert.ok(allowedCwd(ok, pl), ok)
  for (const bad of ['/', '/etc', '/r/umkmall/src', '/r/umkmall/../x', 'relative', null]) assert.ok(!allowedCwd(bad, pl), String(bad))
})
test('terminals: only agent-less panes in a -shells workspace are shells', () => {
  const ws = new Set(['wS'])
  assert.ok(isShellPane({ workspace_id: 'wS', agent: null }, ws))
  assert.ok(!isShellPane({ workspace_id: 'wS', agent: 'claude' }, ws))
  assert.ok(!isShellPane({ workspace_id: 'wM', agent: null }, ws))
})
test('terminals: off by default; tailnet needs its own switch; audit is appended', async () => {
  const dir = mkdtempSync(pj(tmpdir(), 'wtd-term-'))
  const t = await new TerminalSettings(dir).load()
  assert.match(t.gate({ loopback: true, session: true })[1], /disabled/)
  await t.set({ enabled: true })
  assert.equal(t.gate({ loopback: true, session: true }), null)
  assert.match(t.gate({ loopback: false, session: true })[1], /tailnet/)
  assert.match(t.gate({ loopback: true, session: false })[1], /session/)
  await t.set({ tailnet: true })
  assert.equal(t.gate({ loopback: false, session: true }), null)
  assert.deepEqual((await new TerminalSettings(dir).load()).s, { enabled: true, tailnet: true })
  await t.log({ pane: 'wS:p1', action: 'input', text: 'echo hi⏎' })
  assert.equal((await t.tail())[0].text, 'echo hi⏎')
})

import { parseActivity } from './server.mjs'
test('parseActivity: the spinner line above the input box, not a finished turn', () => {
  const box = `${'─'.repeat(20)}\n❯ \n${'─'.repeat(20)}\n  cwd: /x`
  assert.deepEqual(parseActivity(`⏺ doing\n\n✻ Synthesizing… (10s · ↓ 391 tokens)\n${box}`), { text: 'Synthesizing…', detail: '10s · ↓ 391 tokens' })
  assert.deepEqual(parseActivity(`\x1b[38;5;2m✢\x1b[0m Calling PostHog…\n${box}`), { text: 'Calling PostHog…', detail: null })
  assert.deepEqual(parseActivity(`✻ Waiting for 1 background agent to finish\n${box}`), { text: 'Waiting for 1 background agent to finish', detail: null })
  assert.equal(parseActivity(`✻ Cooked for 1m 2s\n${box}`), null)
  assert.equal(parseActivity(`✻ Old line\nmore\nand more\nlast\n${box}`), null)
})

test('streamTranscript: ids are byte offsets; ?since= and Last-Event-ID resume with only newer lines', async () => {
  const { streamTranscript } = await import('./server.mjs')
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { EventEmitter } = await import('node:events')
  const f = join(mkdtempSync(join(tmpdir(), 'wtd-')), 't.jsonl')
  const line = (u, text) => JSON.stringify({ type: 'user', uuid: u, timestamp: 't', message: { content: text } }) + '\n'
  writeFileSync(f, line('a', 'one') + line('b', 'two'))
  const firstLen = Buffer.byteLength(line('a', 'one'))
  const run = async (headers, qs) => {
    const req = Object.assign(new EventEmitter(), { headers })
    let out = ''
    const res = { writeHead() {}, write(s) { out += s } }
    await streamTranscript(req, res, 's', new URL(`http://x/${qs}`), f)
    req.emit('close')
    const ids = [...out.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
    const texts = [...out.matchAll(/^data: (\[.*\])$/gm)].flatMap((m) => JSON.parse(m[1]).map((x) => x.text))
    return { ids, texts }
  }
  const full = await run({}, '')
  assert.deepEqual(full.texts, ['one', 'two'])
  const end = full.ids.at(-1)
  assert.equal(end, Buffer.byteLength(line('a', 'one') + line('b', 'two')))
  assert.deepEqual((await run({}, `?since=${firstLen}`)).texts, ['two'])
  assert.deepEqual((await run({ 'last-event-id': String(firstLen) }, '?since=1')).texts, ['two']) // the header wins
  const caught = await run({}, `?since=${end}`)
  assert.deepEqual(caught.texts, [])
  assert.deepEqual(caught.ids, [end])
  assert.deepEqual((await run({}, `?since=${end + 999}`)).texts, ['one', 'two']) // a stale cursor (file rewritten) gets the full backlog
})

test('Rooms.createByAgent: off → 403; on → created with creator as responder; idempotent; archived 409; 3/hour; invites never deliver', async () => {
  const { Rooms } = await import('./rooms.mjs')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const list = [{ name: 'repo-planner-01', key: 'm/w:p1', local: true }, { name: 'repo-worker-02', key: 'm/w:p2', local: true }]
  const prompts = []
  const rooms = new Rooms({ dir: mkdtempSync(join(tmpdir(), 'wtd-rooms-')), agents: async () => list, prompt: async (...a) => prompts.push(a), log: () => {} })
  const author = { kind: 'agent', name: 'repo-planner-01', key: 'm/w:p1' }
  const make = (slug, extra = {}) => rooms.createByAgent({ author, slug, title: 'T', agentList: list, ...extra })
  await assert.rejects(make('umk-1'), (e) => e.status === 403 && /Agents can create rooms/.test(e.message))
  await rooms.setSettings({ agentsCreateRooms: true })
  await assert.rejects(make('Bad Slug'), (e) => e.status === 400)
  const a = await make('umk-1', { invite: ['@repo-worker-02', 'nobody'] })
  assert.equal(a.existing, false)
  assert.equal(a.room.responder, 'm/w:p1')
  assert.deepEqual(a.room.members.sort(), ['repo-planner-01', 'repo-worker-02'])
  assert.deepEqual(a.unknown, ['nobody'])
  const msgs = await rooms.messages('umk-1')
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].author.kind, 'system')
  assert.deepEqual(msgs[0].deliveredTo, [])
  assert.equal(prompts.length, 0) // an invite delivers nothing
  assert.equal((await make('umk-1')).existing, true) // idempotent, and not counted
  await make('umk-2'); await make('umk-3')
  await assert.rejects(make('umk-4'), (e) => e.status === 429)
  await rooms.update('umk-2', { archived: true })
  await assert.rejects(make('umk-2'), (e) => e.status === 409)
})

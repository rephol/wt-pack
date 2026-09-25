import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeById, mergeAgentMsgs, acquire, connections } from './streamStore.ts'

test('mergeById: appends new ids in order, dedupes against the array itself, same array when nothing changed', () => {
  const a = [{ id: '1', v: 1 }, { id: '2', v: 2 }]
  assert.equal(mergeById(a, [{ id: '1', v: 9 }]), a) // re-sent backlog: kept, identity preserved
  assert.deepEqual(mergeById(a, [{ id: '2', v: 2 }, { id: '3', v: 3 }]).map((x) => x.id), ['1', '2', '3'])
  assert.deepEqual(mergeById(a, [{ id: '1', v: 9 }], (_o, n) => n)[0], { id: '1', v: 9 })
  assert.deepEqual(mergeById([], [{ id: 'x' }, { id: 'x' }]), [{ id: 'x' }]) // duplicates inside one batch
})

test('mergeAgentMsgs: a question answer updates the question in place, keeping its questions', () => {
  const q = { id: 'q:1', role: 'question', questions: ['Q'], answered: false }
  const out = mergeAgentMsgs([q, { id: 'm', role: 'assistant' }] as never[], [{ id: 'q:1', role: 'question', answered: true } as never])
  assert.deepEqual(out[0], { id: 'q:1', role: 'question', questions: ['Q'], answered: true })
  assert.equal(out.length, 2)
})

test('acquire: one stream per key, kept open through a close/reopen, resumes with the cursor after the grace', async (t) => {
  const made: { url: string; closed: boolean; onmessage?: (e: { data: string; lastEventId: string }) => void; onerror?: () => void }[] = []
  class FakeES { url: string; closed = false; onmessage?: (e: { data: string; lastEventId: string }) => void; onerror?: () => void
    constructor(u: string) { this.url = u; made.push(this) } close() { this.closed = true } addEventListener() {} }
  ;(globalThis as unknown as { EventSource: unknown }).EventSource = FakeES
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const spec = () => ({
    url: (c: string | null) => `/s${c ? `?since=${c}` : ''}`,
    attach: (es: EventSource, apply: (fn: (xs: { id: string }[]) => { id: string }[], c?: string | null) => void) => {
      es.onmessage = (e) => apply((xs) => mergeById(xs, JSON.parse(e.data)), e.lastEventId || undefined)
    },
  })
  const before = connections.opened
  const release1 = acquire('k', spec())
  made[0].onmessage!({ data: JSON.stringify([{ id: 'a' }]), lastEventId: '10' })
  const release2 = acquire('k', spec()) // a second view: same stream
  release1(); release2()
  t.mock.timers.tick(10_000)
  const again = acquire('k', spec()) // reopened inside the grace: no new connection
  assert.equal(connections.opened - before, 1)
  again()
  t.mock.timers.tick(30_000)
  assert.equal(made[0].closed, true)
  const later = acquire('k', spec())
  assert.equal(made[1].url, '/s?since=10') // resumes from the cursor
  later()
})

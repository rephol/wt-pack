import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageAgg } from './usage.mjs'

test('agent-name lines attribute a session; unnamed sessions have no name', () => {
  const a = new UsageAgg()
  const msg = { type: 'assistant', sessionId: 's1', timestamp: new Date().toISOString(), message: { id: 'm1', model: 'x', usage: { input_tokens: 1 } } }
  a.ingest([JSON.stringify({ type: 'agent-name', agentName: 'wt-pack-worker-02', sessionId: 's1' }), JSON.stringify(msg)].join('\n'), 's1', 'session')
  assert.equal(a.names.get('s1'), 'wt-pack-worker-02')
  assert.equal(a.names.get('s2'), undefined)
  assert.equal(a.recs.size, 1)
})

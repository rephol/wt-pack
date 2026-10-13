// Run: node --test keepwarm.test.mjs — WP-318: settings bounds, per-pane arm/off, effective config, what a report does.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keepwarm, clean, DEFAULTS } from './keepwarm.mjs'

test('defaults: off, three roles, 50 min / 50k / 3 h / cap 15', () => {
  assert.deepEqual(clean(), DEFAULTS)
  assert.deepEqual(DEFAULTS, { enabled: false, roles: ['orchestrator', 'tech-lead', 'planner'], minContext: 50000, intervalMin: 50, windowH: 3, dailyCap: 15 })
})

test('clean: every bound (windowH 1..12 whole hours, interval 5..59, cap >= 1)', () => {
  for (const [k, v] of [['windowH', 0], ['windowH', 13], ['windowH', 2.5], ['windowH', '3'], ['intervalMin', 4], ['intervalMin', 60], ['dailyCap', 0], ['minContext', -1], ['enabled', 'yes'], ['roles', ['root']], ['roles', 'worker']])
    assert.throws(() => clean({ [k]: v }), (e) => e.status === 400 && e.message.startsWith(k), `${k}=${JSON.stringify(v)}`)
  assert.equal(clean({ windowH: 1 }).windowH, 1); assert.equal(clean({ windowH: 12 }).windowH, 12)
  assert.equal(clean({ intervalMin: 5 }).intervalMin, 5); assert.equal(clean({ intervalMin: 59 }).intervalMin, 59)
})

test('effective: off by default; on for a listed role when enabled; arm/off override the role', () => {
  const k = new Keepwarm()
  assert.equal(k.effective('p1', 'orchestrator').enabled, false)
  k.patch({ enabled: true })
  assert.equal(k.effective('p1', 'orchestrator').enabled, true)
  assert.equal(k.effective('p2', 'worker').enabled, false)
  k.set('p2', 'arm', 6); assert.deepEqual([k.effective('p2', 'worker').enabled, k.effective('p2', 'worker').windowH], [true, 6])
  k.set('p1', 'off'); assert.equal(k.effective('p1', 'orchestrator').enabled, false)
  assert.throws(() => k.set('p3', 'arm', 13), (e) => e.status === 400)
  assert.throws(() => k.set('p3', 'pause'), (e) => e.status === 400)
})

test('report: pings count against the day and spend tokens; stop makes it cold, off makes it off; a new day resets the count', () => {
  let t = new Date(2026, 9, 11, 12).getTime()
  const k = new Keepwarm({ settings: { enabled: true }, now: () => t })
  assert.equal(k.info('p1', 'planner').state, 'cold') // enabled, nothing reported yet
  k.report('p1', { event: 'ping', usage: { read: 100, write: 10 }, nextAt: t + 3000 })
  k.report('p1', { event: 'ping', usage: { read: 100, write: 10 }, nextAt: t + 6000 })
  assert.deepEqual(k.info('p1', 'planner'), { state: 'warm', nextAt: t + 6000, pingsToday: 2, spentTokens: 220, reason: null })
  assert.equal(k.effective('p1', 'planner').pingsToday, 2)
  k.report('p1', { event: 'stop', reason: 'cache cold' })
  assert.deepEqual([k.info('p1', 'planner').state, k.info('p1', 'planner').reason, k.info('p1', 'planner').nextAt], ['cold', 'cache cold', null])
  t += 86_400_000
  assert.equal(k.effective('p1', 'planner').pingsToday, 0)
  assert.throws(() => k.report('p1', { event: 'nap' }), (e) => e.status === 400)
})

test('info: null when keepwarm does nothing for the pane; off after the user turns it off', () => {
  const k = new Keepwarm()
  assert.equal(k.info('p1', 'worker'), null)
  k.set('p1', 'arm'); assert.equal(k.info('p1', 'worker').state, 'cold')
  k.set('p1', 'off'); assert.equal(k.info('p1', 'worker').state, 'off')
})

test('WP-348: a paused project is never enabled, whatever was armed or globally on', () => {
  const k = new Keepwarm({ settings: { ...DEFAULTS, enabled: true } })
  k.set('a', 'arm')
  assert.equal(k.effective('a', 'worker').enabled, true)
  assert.equal(k.effective('a', 'worker', true).enabled, false)
  assert.equal(k.effective('b', 'planner', true).enabled, false)
  assert.equal(k.info('a', 'worker', true)?.state ?? 'off', 'off')
})

test('WP-358: arming again after Off clears the stale off run (state cold, enabled) and keeps the day\'s pings', () => {
  const k = new Keepwarm()
  k.set('p1', 'arm'); k.report('p1', { event: 'ping', usage: { read: 100, write: 5 }, nextAt: 9 })
  k.set('p1', 'off'); assert.equal(k.info('p1', 'worker').state, 'off'); assert.equal(k.effective('p1', 'worker').enabled, false)
  k.set('p1', 'arm')
  const i = k.info('p1', 'worker')
  assert.equal(i.state, 'cold'); assert.equal(k.effective('p1', 'worker').enabled, true)
  assert.deepEqual([i.nextAt, i.pingsToday, i.spentTokens, i.reason], [null, 1, 105, 'armed, no ping yet'])
})

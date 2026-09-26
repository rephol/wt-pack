import test from 'node:test'
import assert from 'node:assert/strict'
import { fromSchedule, toSchedule } from './routineForm.ts'

test('schedule presets round-trip; anything else is custom', () => {
  for (const s of ['every 15m', 'every 1h', '30 2 * * *', '0 9 * * 1', '*/5 * * * *', 'every 2d']) assert.equal(toSchedule(fromSchedule(s)), s)
  assert.equal(fromSchedule('30 2 * * *').time, '02:30')
  assert.equal(fromSchedule('0 9 * * 1').preset, 'weekly')
  assert.equal(fromSchedule('every 2d').preset, 'custom')
  assert.equal(toSchedule({ ...fromSchedule('every 1h'), preset: 'weekly', time: '07:05', dow: '5' }), '5 7 * * 5')
})

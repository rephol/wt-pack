import test from 'node:test'
import assert from 'node:assert/strict'
import { ticketFromSearch, withTicket } from './ticketParam.ts'

test('?ticket round-trips and keeps other params and the hash', () => {
  assert.equal(ticketFromSearch('?project=a&ticket=WP-9'), 'WP-9')
  assert.equal(ticketFromSearch('?project=a'), null)
  assert.equal(ticketFromSearch('?ticket='), null)
  assert.equal(withTicket('http://x/?project=a#rooms/r', 'WP-9'), '/?project=a&ticket=WP-9#rooms/r')
  assert.equal(withTicket('http://x/?project=a&ticket=WP-9#rooms/r', null), '/?project=a#rooms/r')
})

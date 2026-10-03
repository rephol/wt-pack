import { test, expect } from 'claude-code/testing'
import { split, COMMANDS } from './commands'

test('split honours quotes without a shell', () => {
  expect(split('post dev "hi there" \'a b\' x')).toEqual(['post', 'dev', 'hi there', 'a b', 'x'])
  expect(split('')).toEqual([])
})

test('argv mapping', () => {
  expect(COMMANDS.watch.argv(['foo'], '')).toBe('usage: /watch status')
  expect(COMMANDS.watch.argv([], '')).toEqual(['poller-status'])
  expect(COMMANDS.dnd.argv(['on'], 'w1:p2')).toEqual(['dnd', 'w1:p2', 'on'])
  expect(COMMANDS.room.argv([], '')).toEqual(['list'])
})

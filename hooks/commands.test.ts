import { test, expect } from 'claude-code/testing'
import { split } from './commands'

test('split honours quotes without a shell', () => {
  expect(split('post dev "hi there" \'a b\' x')).toEqual(['post', 'dev', 'hi there', 'a b', 'x'])
  expect(split('')).toEqual([])
})

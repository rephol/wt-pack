// Run: node --test pickerFocus.test.mjs — WP-378 D6: the focused picker tab tracked from plain-text frames (the tab bar is identical on every tab).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PickerFocus } from './pickerFocus.mjs'
import { parsePicker } from './server.mjs'

const pick = (header, question, tabs = ['Color', 'Size', 'Shape']) => ({ review: false, tabs: tabs.map((h) => ({ header: h })), question, header })
const review = (tabs = ['Color', 'Size', 'Shape']) => ({ review: true, tabs: tabs.map((h) => ({ header: h })) })

test('a picker that just appeared is on tab 0; the same question again stays there', () => {
  const f = new PickerFocus()
  assert.equal(f.read('t1', pick('Color', 'Which color?')), 0)
  assert.equal(f.read('t1', pick('Color', 'Which color?')), 0)
})

test('keys move the belief; a stale frame after a key press does not (the screen wins), a new question lands on the next tab', () => {
  const f = new PickerFocus()
  f.read('t1', pick('Color', 'Which color?'))
  f.keys('t1', ['right'])
  assert.equal(f.read('t1', pick('Color', 'Which color?')), 0, 'redraw not landed yet: still the first question')
  assert.equal(f.read('t1', pick('Size', 'Which size?')), 1)
  f.keys('t1', ['right'])
  assert.equal(f.read('t1', pick('Shape', 'Which shape?')), 2)
  f.keys('t1', ['left', 'left'])
  assert.equal(f.read('t1', pick('Color', 'Which color?')), 0, 'a question learned earlier identifies its tab')
})

test('single-select advance (a digit key, no left/right) is followed from the next unseen question', () => {
  const f = new PickerFocus()
  f.read('t1', pick('Color', 'Which color?'))
  f.keys('t1', ['2']) // digit: selects and advances; the dashboard cannot know the redraw yet
  assert.equal(f.read('t1', pick('Size', 'Which size?')), 1)
})

test('the review step is tab n; going back from it resyncs by question text', () => {
  const f = new PickerFocus()
  for (const [h, q] of [['Color', 'Which color?'], ['Size', 'Which size?'], ['Shape', 'Which shape?']]) { f.read('t1', pick(h, q)); f.keys('t1', ['right']) }
  assert.equal(f.read('t1', review()), 3)
  f.keys('t1', ['left'])
  assert.equal(f.read('t1', pick('Shape', 'Which shape?')), 2)
})

test('a different tab bar is a different picker (restarts at 0); no picker clears the state', () => {
  const f = new PickerFocus()
  f.read('t1', pick('Color', 'Which color?')); f.keys('t1', ['right']); f.read('t1', pick('Size', 'Which size?'))
  assert.equal(f.read('t1', pick('A', 'Other?', ['A', 'B'])), 0)
  assert.equal(f.read('t1', null), null)
  assert.equal(f.read('t1', pick('Size', 'Which size?')), 0, 'cleared: a fresh picker starts at tab 0 again')
})

test('panes are independent', () => {
  const f = new PickerFocus()
  f.read('t1', pick('Color', 'Which color?')); f.keys('t1', ['right']); f.read('t1', pick('Size', 'Which size?'))
  assert.equal(f.read('t2', pick('Color', 'Which color?')), 0)
})

const fx = (n) => readFileSync(new URL(`./test-fixtures/${n}.txt`, import.meta.url), 'utf8')
test('parsePicker with a pane: recorded plain-text frames, the focus follows the keys the dashboard pressed', () => {
  const f = new PickerFocus(), o = { focus: f, pane: 't7' }
  const q2 = parsePicker(fx('pair-q2-multiselect'), '', o)
  assert.equal(q2.current, 1, 'Next up is answered: the picker starts at Polish')
  f.keys('t7', ['left'])
  const q1 = parsePicker(fx('pair-back-to-q1'), '', o)
  assert.equal(q1.current, 0, 'the plain parse says 1 (the first unanswered tab) while the screen shows question 1')
  assert.equal(parsePicker(fx('pair-back-to-q1'), '', o).current, 0)
  f.keys('t7', ['right'])
  assert.equal(parsePicker(fx('pair-q2-multiselect'), '', o).current, 1, 'a question seen earlier identifies its tab')
})

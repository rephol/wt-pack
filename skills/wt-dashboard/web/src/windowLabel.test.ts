import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrimaryWindow, windowLabel } from './windowLabel.ts'

const win = (label?: string) => ({ __TAURI_INTERNALS__: { metadata: { currentWindow: { label } } } })

test('isPrimaryWindow: main and a plain browser relay; a project window does not', () => {
  assert.equal(isPrimaryWindow({}), true) // browser: no __TAURI_INTERNALS__
  assert.equal(isPrimaryWindow(win('main')), true)
  assert.equal(isPrimaryWindow(win('p-wt-pack')), false)
  assert.equal(windowLabel(win('p-x')), 'p-x')
})

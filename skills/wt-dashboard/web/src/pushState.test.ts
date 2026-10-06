import test from 'node:test'
import assert from 'node:assert/strict'
import { pushState, deviceLabel, keyBytes, type PushEnv } from './pushState.ts'

const env = (o: Partial<PushEnv> = {}): PushEnv => ({ ios: false, standalone: false, secure: true, supported: true, permission: 'default', subscribed: false, ...o })

test('pushState: iOS must be installed first, then https, then support, then permission, then subscribed', () => {
  assert.equal(pushState(env({ ios: true, secure: false })), 'install') // install hint wins on iOS Safari
  assert.equal(pushState(env({ ios: true, standalone: true, secure: false })), 'insecure')
  assert.equal(pushState(env({ secure: false })), 'insecure')
  assert.equal(pushState(env({ supported: false })), 'unsupported')
  assert.equal(pushState(env({ permission: 'denied', subscribed: true })), 'denied')
  assert.equal(pushState(env()), 'off')
  assert.equal(pushState(env({ permission: 'granted', subscribed: true })), 'on')
  assert.equal(pushState(env({ ios: true, standalone: true, permission: 'granted', subscribed: true })), 'on')
})
test('deviceLabel and keyBytes', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone')
  assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'Mac browser')
  assert.equal(deviceLabel('curl/8'), 'Browser')
  assert.deepEqual([...keyBytes('AQID-_8')], [1, 2, 3, 251, 255])
})

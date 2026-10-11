// Run: node --test userVoice.test.mjs — WP-337: from=user is the dashboard's own voice; a server-token sender may not stamp it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { userVoiceDenied, tokensForTest } from './server.mjs'

const req = (token) => ({ headers: token === undefined ? {} : { 'x-wt-server': token } })
test('a SERVER_TOKEN sender is denied from=user; the relay token (a cookie-authenticated user action) and the cookie caller are not', () => {
  assert.equal(userVoiceDenied(req(tokensForTest.server), 'user'), true)
  assert.equal(userVoiceDenied(req('wrong'), 'user'), true)
  assert.equal(userVoiceDenied(req(tokensForTest.relay), 'user'), false)
  assert.equal(userVoiceDenied(req(undefined), 'user'), false) // no token header: the cookie/pane paths decide, not this check
})
test('every other sender is unaffected by the reservation', () => {
  for (const who of ['wt-watch-prs', 'wt-dashboard', 'watchdog', 'dispatch', undefined]) assert.equal(userVoiceDenied(req(tokensForTest.server), who), false)
})

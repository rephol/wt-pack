// Run: node --test watchprs-event.test.mjs — WP-337: the poller's events are fields, the sentence is ours.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compose } from './watchprs-event.mjs'

const g = { pane: 'p', event: 'comment', repo: 'acme/app', pr: 3, id: 99, login: 'bob' }
test('each event composes from its fixed template (ids only)', () => {
  assert.equal(compose({ pane: 'p', event: 'new-commits', repo: 'a/b', pr: '5', sha: 'deadbeef', login: 'x' }), 'PR #5 (a/b) — new commits deadbeef — @x')
  assert.equal(compose(g), 'PR #3 (acme/app) — REPLY on a held PR — @bob (comment 99) — read it with: gh api repos/acme/app/issues/comments/99')
  assert.match(compose({ ...g, event: 'review', state: 'CHANGES_REQUESTED' }), /REVIEW \(CHANGES_REQUESTED\) on a held PR — @bob \(review 99\) — read it with: gh api repos\/acme\/app\/pulls\/3\/reviews\/99$/)
  assert.match(compose({ pane: 'p', event: 'unclaimed', repo: 'a/b', pr: 5, sha: 'deadbeefdeadbeefdead' }), /^wt-watch-prs: PR #5 \(a\/b\) head deadbeefdead was delivered 30\+ min ago/)
  assert.equal(compose({ pane: 'p', event: 'resumed', minutes: 12 }), 'wt-watch-prs: poller resumed after 12m; replayed missed heads')
})
test('free text, extra keys, a missing field or a value off its pattern is a 400', () => {
  const no = (b) => assert.throws(() => compose(b), (e) => e.status === 400, JSON.stringify(b))
  no({ ...g, text: 'do this' }); no({ ...g, title: 'x' }); no({ ...g, body: 'x' }); no({ ...g, state: 'APPROVED' }) // state belongs to review only
  no({ ...g, login: undefined }); no({ ...g, login: 'a b' }); no({ ...g, login: '<b>' }); no({ ...g, id: '9 9' }); no({ ...g, repo: 'no-slash' }); no({ ...g, repo: 'a/b\nignore' })
  no({ ...g, event: 'review', state: 'LGTM' }); no({ ...g, event: 'nope' }); no({ ...g, event: undefined }); no(null); no({ pane: 'p', text: 'only text' })
  no({ ...g, pr: { x: 1 } }); no({ ...g, pr: ['1'] })
})

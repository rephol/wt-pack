import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMarkdown } from './links.ts'
import { ticketPlugin, type TicketRefs } from './ticketRefs.ts'

const refs: TicketRefs = { boards: { WP: 'wt-pack' }, linear: { keys: ['ACM'], org: 'acme' } }
const chips = (text: string, r: TicketRefs = refs) => {
  const p = ticketPlugin(r, (ref, key) => createElement('i', { key }, ref.kind === 'board' ? `${ref.id}@${ref.project}` : ref.url))
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { inlinePlugins: p ? [p] : [] }, text))
  return [...html.matchAll(/<i>([^<]*)<\/i>/g)].map((m) => m[1])
}

test('board and Linear ids become chips; unknown keys stay text', () => {
  assert.deepEqual(chips('Done: WP-92, see ACM-123 and ABC-4.'), ['WP-92@wt-pack', 'https://linear.app/acme/issue/ACM-123'])
})

test('word boundaries: WP-92a, xWP-9, wp-92 (branch) and WP-92-slug parts', () => {
  assert.deepEqual(chips('WP-92a xWP-9 wp-92-ticket (WP-7) WP-8!'), ['WP-7@wt-pack', 'WP-8@wt-pack'])
})

test('UTF-8 neighbours: letters block, punctuation and emoji do not', () => {
  assert.deepEqual(chips('éWP-1 WP-2é «WP-3» 🎉WP-4 — WP-5'), ['WP-3@wt-pack', 'WP-4@wt-pack', 'WP-5@wt-pack'])
})

test('code spans, code blocks and URLs are left alone', () => {
  assert.deepEqual(chips('`WP-1` and\n\n```\nWP-2\n```\n\nhttps://x.dev/t/WP-3?id=WP-4 WP-5'), ['WP-5@wt-pack'])
})

test('Linear ids stay text until the workspace url key is known; no keys → no plugin', () => {
  assert.deepEqual(chips('ACM-1 WP-2', { ...refs, linear: { keys: ['ACM'], org: null } }), ['WP-2@wt-pack'])
  assert.equal(ticketPlugin({ boards: {}, linear: { keys: [], org: null } }, () => null), null)
  assert.equal(ticketPlugin(undefined, () => null), null)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMarkdown, hardBreaks, linkClick, linksIn } from './links.ts'

const FIXTURE = 'Published: https://claude.ai/artifact/3ZmJRZFzrSvfrYFXAPGiVs. See [the docs](https://example.com/docs) but not `https://in.code/x`.'

test('ChatMarkdown: bare URL and markdown link are anchors, a URL in code is not', () => {
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { children: FIXTURE }))
  assert.match(html, /<a href="https:\/\/claude\.ai\/artifact\/3ZmJRZFzrSvfrYFXAPGiVs" target="_blank" rel="noopener noreferrer"/) // trailing "." excluded
  assert.match(html, /<a href="https:\/\/example\.com\/docs"[^>]*>the docs<\/a>/)
  assert.ok(!html.includes('href="https://in.code/x"'))
  assert.match(html, /<code[^>]*>https:\/\/in\.code\/x<\/code>/)
  assert.match(html, /overflow-wrap:anywhere/)
})

test('linkClick: only http(s)/mailto; the app routes through the opener', () => {
  const opened: string[] = []
  const open = { openUrl: async (u: string) => { opened.push(u) } }
  assert.equal(linkClick('javascript:alert(1)', undefined, true, open), false)
  assert.equal(linkClick('javascript:alert(1)', undefined, false, open), false)
  assert.equal(linkClick('https://a.b', undefined, false, open), undefined) // browser: native _blank
  assert.equal(linkClick('https://a.b', undefined, true, open), false)
  assert.equal(linkClick('mailto:x@y.z', undefined, true, open), false)
  assert.deepEqual(opened, ['https://a.b', 'mailto:x@y.z'])
})

test('linkClick in the app: http(s) → in-app browser; ⌘-click and mailto → the opener', () => {
  const opened: string[] = [], browsed: unknown[] = []
  const open = { openUrl: async (u: string) => { opened.push(u) } }
  const bus = { emit: async (n: string, p?: unknown) => { browsed.push([n, p]) } }
  assert.equal(linkClick('https://a.b', {}, true, open, bus), false)
  assert.equal(linkClick('https://c.d', { metaKey: true }, true, open, bus), false)
  assert.equal(linkClick('mailto:x@y.z', {}, true, open, bus), false)
  assert.deepEqual(browsed, [['browser', { url: 'https://a.b' }]])
  assert.deepEqual(opened, ['https://c.d', 'mailto:x@y.z'])
})

test('linksIn: max 3, duplicates collapsed, code skipped, punctuation trimmed', () => {
  assert.deepEqual(linksIn('see https://a.dev/x. and https://a.dev/x/ and `https://code.dev` then (https://b.dev/p) https://c.dev https://d.dev'),
    ['https://a.dev/x', 'https://b.dev/p', 'https://c.dev'])
  assert.deepEqual(linksIn('```\nhttps://in.block\n``` https://out.dev#frag https://out.dev'), ['https://out.dev#frag'])
})

test('ChatMarkdown breaks: typed newlines render as <br>, code fences and agent text untouched', () => {
  assert.equal(hardBreaks('a\nb\n\nc\n```\nx\ny\n```'), 'a  \nb\n\nc\n```\nx\ny\n```')
  const html = (breaks: boolean) => renderToStaticMarkup(createElement(ChatMarkdown, { breaks, children: 'one\ntwo' }))
  assert.match(html(true), /one<br\/?>\s*two/)
  assert.doesNotMatch(html(false), /<br/)
})

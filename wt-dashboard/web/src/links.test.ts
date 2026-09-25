import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMarkdown, linkClick } from './links.ts'

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

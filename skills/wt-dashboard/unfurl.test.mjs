import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { isBlockedAddress, checkUrl, safeFetch, parseHtml, classifyUrl } from './unfurl.mjs'

test('blocked addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.100.1.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fd7a:115c:a1e0::1'])
    assert.equal(isBlockedAddress(ip), true, ip)
  for (const ip of ['1.1.1.1', '140.82.112.3', '2606:4700::1111']) assert.equal(isBlockedAddress(ip), false, ip)
})

test('checkUrl refuses bad schemes, local names and names resolving to a private address', async () => {
  const pub = async () => [{ address: '93.184.216.34', family: 4 }]
  await assert.rejects(checkUrl('file:///etc/passwd', pub), /only http/)
  await assert.rejects(checkUrl('ftp://example.com', pub), /only http/)
  await assert.rejects(checkUrl('http://localhost:7777/', pub), /local host/)
  await assert.rejects(checkUrl('http://mac.tail1234.ts.net/', pub), /local host/)
  await assert.rejects(checkUrl('http://intranet/', pub), /local host/)
  await assert.rejects(checkUrl('http://127.0.0.1:7777/', pub), /private/)
  await assert.rejects(checkUrl('http://[::1]/', pub), /private/)
  await assert.rejects(checkUrl('http://u:p@example.com/', pub), /credentials/)
  // one private answer among public ones is enough to refuse (rebinding-style multi-answer)
  await assert.rejects(checkUrl('https://evil.example/', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /private/)
  const ok = await checkUrl('https://example.com/x', pub)
  assert.equal(ok.address, '93.184.216.34') // the connection is pinned to this checked address
})

test('safeFetch re-checks every redirect hop (to 127.0.0.1 and to [::1]) and pins the resolved address', async () => {
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits++
    if (req.url === '/v4') { res.writeHead(302, { location: `http://127.0.0.1:${srv.address().port}/secret` }); return res.end() }
    if (req.url === '/v6') { res.writeHead(302, { location: 'http://[::1]/secret' }); return res.end() }
    if (req.url === '/rebind') { res.writeHead(302, { location: 'http://rebind.example/secret' }); return res.end() }
    res.end('<title>ok</title>')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  // Pretend first.example is public but actually lands on our test server.
  const check = (u, resolve) => (new URL(u).hostname === 'first.example' ? { url: new URL(u), address: '127.0.0.1', family: 4 } : checkUrl(u, resolve))
  let calls = 0
  const rebinding = async () => (++calls === 1 ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '1.1.1.1', family: 4 }])
  try {
    await assert.rejects(safeFetch(`http://first.example:${port}/v4`, 'text/html', undefined, check), /private/)
    await assert.rejects(safeFetch(`http://first.example:${port}/v6`, 'text/html', undefined, check), /private/)
    await assert.rejects(safeFetch(`http://first.example:${port}/rebind`, 'text/html', rebinding, check), /private/)
    const r = await safeFetch(`http://first.example:${port}/page`, 'text/html', undefined, check)
    assert.match(r.body.toString(), /ok/)
    assert.equal(hits, 4) // the /secret targets were never requested
  } finally { srv.close() }
})

test('parseHtml: OpenGraph first, then <title>/description, absolute image and icon', () => {
  const html = readFileSync(new URL('./test-fixtures/unfurl-og.html', import.meta.url), 'utf8')
  assert.deepEqual(parseHtml(html, 'https://blog.example.com/post/1'), {
    title: 'Shipping "fast" & safe', description: 'A post about things.', image: 'https://blog.example.com/img/cover.png',
    siteName: 'Example Blog', icon: 'https://blog.example.com/favicon-32.png',
  })
  const bare = parseHtml("<html><head><title> Plain  page </title><meta name='description' content='Desc here'></head></html>", 'https://www.plain.dev/')
  assert.deepEqual(bare, { title: 'Plain page', description: 'Desc here', image: null, siteName: 'plain.dev', icon: 'https://www.plain.dev/favicon.ico' })
  assert.equal(parseHtml('<meta property="og:image" content="javascript:alert(1)">', 'https://x.dev/').image, null)
})

test('classifyUrl: our GitHub repo, Linear issues, Claude artifacts', () => {
  const repo = 'UMKMall/umkmall'
  assert.deepEqual(classifyUrl('https://github.com/umkmall/umkmall/pull/1181', repo), { kind: 'pr', number: 1181 })
  assert.deepEqual(classifyUrl('https://github.com/UMKMall/umkmall/issues/12#x', repo), { kind: 'issue', number: 12 })
  assert.equal(classifyUrl('https://github.com/other/repo/pull/1', repo), null)
  assert.deepEqual(classifyUrl('https://linear.app/umkmall/issue/UMK-1177/fazpass-otp', repo), { kind: 'linear', identifier: 'UMK-1177' })
  assert.deepEqual(classifyUrl('https://claude.ai/code/artifact/abc', repo), { kind: 'artifact' })
  assert.equal(classifyUrl('https://example.com/', repo), null)
})

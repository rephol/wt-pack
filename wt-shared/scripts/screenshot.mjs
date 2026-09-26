#!/usr/bin/env node
// screenshot.mjs — capture the current page of an agent-browser session straight over CDP.
// ponytail: workaround for `agent-browser screenshot` hanging (0.38.1, WP-1); delete once upstream is fixed.
//   node screenshot.mjs --session <name> [--size 1440x900] [--full] [--url <url>] <out.png>
// Navigation stays with agent-browser (`--url` runs `agent-browser open`); only the capture goes over CDP.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (k) => { const i = args.indexOf(k); return i < 0 ? undefined : args.splice(i, 2)[1] }
const flag = (k) => { const i = args.indexOf(k); return i >= 0 && args.splice(i, 1) }
const session = opt('--session'), size = opt('--size'), url = opt('--url'), full = flag('--full')
const out = args[0]
if (!session || !out || (size && !/^\d+x\d+$/.test(size))) {
  console.error('usage: screenshot.mjs --session <name> [--size WxH] [--full] [--url <url>] <out.png>')
  process.exit(2)
}
const ab = (...a) => execFileSync('agent-browser', ['--session', session, ...a], { encoding: 'utf8', timeout: 30_000 }).trim()
if (url) ab('open', url)
const root = ab('get', 'cdp-url').split('\n').at(-1)
const pages = await (await fetch(root.replace(/^ws/, 'http').replace(/\/devtools\/.*$/, '/json'))).json()
const page = pages.find((t) => t.type === 'page')
if (!page) { console.error('no page in this session'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })) })
ws.onmessage = (m) => { const j = JSON.parse(m.data); const p = pending.get(j.id); if (!p) return; pending.delete(j.id); j.error ? p.rej(new Error(j.error.message)) : p.res(j.result) }
setTimeout(() => { console.error('screenshot: CDP timeout'); process.exit(1) }, 20_000).unref()
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')) })

if (size) {
  const [width, height] = size.split('x').map(Number)
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 })
  await new Promise((r) => setTimeout(r, 800)) // let the layout settle at the new width
}
const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(full) })
writeFileSync(out, Buffer.from(data, 'base64'))
console.log(`${out} (${page.url})`)
process.exit(0)

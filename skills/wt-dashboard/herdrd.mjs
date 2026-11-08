// WP-218: after a reboot the dashboard (launchd RunAtLoad) comes up before anyone opens herdr, so there are no agents
// or terminals. Start herdr's own headless server (`herdr server`, detached) when `herdr status server` says it is not
// running. Never a second one: the status check gates it. Never blocks startup: the caller does not await the server.
import { spawn as nodeSpawn, execFile } from 'node:child_process'

const status = () => new Promise((res) => execFile('herdr', ['status', 'server', '--json'], { timeout: 5000 }, (err, out) => {
  if (err && err.code === 'ENOENT') return res('missing')
  try { res(JSON.parse(out).running ? 'running' : 'down') } catch { res('down') }
}))

// → 'running' | 'started' | 'missing' | 'failed: …'
export async function ensureHerdr({ check = status, spawn = nodeSpawn, log = console.log } = {}) {
  const s = await check()
  if (s !== 'down') return s
  try {
    const c = spawn('herdr', ['server'], { detached: true, stdio: 'ignore' })
    c.on('error', (e) => log(`herdr: start failed: ${e.message}`))
    c.unref()
    log(`herdr: server was not running — started it (pid ${c.pid})`)
    return 'started'
  } catch (e) { log(`herdr: start failed: ${e.message}`); return `failed: ${e.message}` }
}

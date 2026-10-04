// WP-227: ccusage's live 5-hour block (tokens, $, burn rate, projection) from local transcripts — no API call.
// `ccusage blocks --active --json --offline` via an installed `ccusage` only (never npx: an unpinned download run
// unattended from launchd). The block window is ccusage's own
// estimate and differs from the plan's real reset, which only ccstatusline's cache knows. Missing/failing → null.
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)

// ccusage `blocks --json` output → the active block's named fields, or null. Nothing unknown leaves this function.
export function parseBlock(text) {
  let d
  try { d = JSON.parse(text) } catch { return null }
  const b = (d?.blocks ?? []).find((x) => x?.isActive && !x.isGap)
  if (!b) return null
  return {
    startTime: iso(b.startTime), endTime: iso(b.endTime), tokens: num(b.totalTokens), costUSD: num(b.costUSD),
    tokensPerMinute: num(b.burnRate?.tokensPerMinute), costPerHour: num(b.burnRate?.costPerHour),
    projTokens: num(b.projection?.totalTokens), projCost: num(b.projection?.totalCost), remainingMinutes: num(b.projection?.remainingMinutes),
    models: Array.isArray(b.models) ? b.models.filter((m) => typeof m === 'string') : [],
  }
}

const ARGS = ['blocks', '--active', '--json', '--offline']
const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 20_000, maxBuffer: 4 << 20 }, (e, out) => ok(e ? null : out)))
// launchd's PATH is thin: also the usual install dirs and node's own bin (npm -g under nvm).
export function findCcusage(dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', dirname(process.execPath)]) {
  for (const d of dirs) {
    if (!d) continue
    try { accessSync(join(d, 'ccusage'), constants.X_OK); return join(d, 'ccusage') } catch {}
  }
  return null
}
const fetchBlock = async () => { const bin = findCcusage(); return bin ? parseBlock((await run(bin, ARGS)) ?? '') : null }

// Never blocks: returns the cached block (null until the first read lands) and refreshes in the background — fresh
// for 60 s, a failure remembered for 10 min. One read at a time; `pending` is exposed for tests.
let cache = { at: 0, ttl: 0, block: null, pending: null }
export function ccBlock(now = Date.now(), fetch = fetchBlock) {
  if (now - cache.at >= cache.ttl && !cache.pending)
    cache.pending = fetch().catch(() => null).then((block) => { cache = { at: Date.now(), ttl: block ? 60_000 : 600_000, block, pending: null } })
  return cache.block
}
export const ccPending = () => cache.pending
export const resetCcBlock = () => { cache = { at: 0, ttl: 0, block: null, pending: null } }

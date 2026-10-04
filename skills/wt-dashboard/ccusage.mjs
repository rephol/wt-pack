// WP-227: ccusage's live 5-hour block (tokens, $, burn rate, projection) from local transcripts — no API call.
// `ccusage blocks --active --json --offline` via `ccusage` on PATH, else npx. The block window is ccusage's own
// estimate and differs from the plan's real reset, which only ccstatusline's cache knows. Missing/failing → null.
import { execFile } from 'node:child_process'

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
const fetchBlock = async () => parseBlock((await run('ccusage', ARGS)) ?? (await run('npx', ['--yes', 'ccusage', ...ARGS])) ?? '')

// One shared read: fresh for 60 s, and a failure is remembered for 10 min so a missing ccusage costs one try.
let cache = { at: 0, ttl: 0, block: null, pending: null }
export async function ccBlock(now = Date.now(), fetch = fetchBlock) {
  if (now - cache.at < cache.ttl) return cache.block
  cache.pending ??= fetch().catch(() => null).then((block) => {
    cache = { at: Date.now(), ttl: block ? 60_000 : 600_000, block, pending: null }
    return block
  })
  return cache.pending
}
export const resetCcBlock = () => { cache = { at: 0, ttl: 0, block: null, pending: null } }

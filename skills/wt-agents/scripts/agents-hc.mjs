#!/usr/bin/env node
// WP-378: agents.sh's reads and the herdr-app side of a spawn, on hc. Every subcommand prints JSON/lines for the shell to use.
//   list <pool> [--json]        the live agents of a pool (label wt.pool): TSV, or one JSON object per agent (+ session, pid)
//   find <name|id>              one terminal (live first, else finished) in the shape respawn reads, or exit 1
//   names                       every terminal name hc still knows (live + finished): numbering must not reuse them
//   live-ids                    ids of live terminals (the pane-key sweep keeps these)
//   pools <repo-prefix> [self]  names of live agents whose pool starts with <prefix> and ends with "s" (respawn --stale)
//   team-count <team> <role>    live agents in a team seat (label team, persona-or-role)
//   space <pool> <folder>       the herdr-app space for a pool: {space[,stray]} (created under a lock), or {} = run hidden
//   next-name <prefix> <taken,csv>  the lowest free <prefix>-NN
//   retire <terminal>           kill+rm a terminal (already gone is fine)
//   label <terminal> k=v...     set labels (k= clears) under the pack's limits (32 / 80 chars)
//   tab-name <terminal> <name> name the herdr-app tab holding the terminal after the agent (best effort, never fails)
//   retire-stray <terminal>     kill+rm the shell herdr-app opened with a new space, only while it is still a plain shell
// Nothing here starts the core: the caller (agents.sh) has already asked `hc.mjs core-up`.
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const hcm = () => import('../../wt-shared/scripts/hc.mjs')
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o))

// pid -> sessionId from claude's own list (best effort; [] when claude is absent): a pid claude does not know is a ghost (WP-324).
function claudeSessions() {
  return new Promise((resolve) => {
    execFile('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(new Map())
      try { resolve(new Map(JSON.parse(stdout).map((a) => [a.pid, a.sessionId]))) } catch { resolve(new Map()) }
    })
  })
}
const dndOf = (v) => (!v ? { on: false, until: null } : v === '1' ? { on: true, until: null } : { on: true, until: v })

async function list(pool, json) {
  const h = await hcm()
  const rows = (await h.list()).filter((t) => t.labels['wt.pool'] === pool && h.isAgent(t))
  const cs = json ? await claudeSessions() : new Map()
  for (const t of rows) {
    const status = t.status ?? 'unknown', pid = t.foreground?.pid ?? null
    if (json) {
      out({ name: t.name, pane: t.id, status, cwd: t.cwd, tokens: t.labels, session: cs.get(pid) ?? null, pid: cs.has(pid) ? pid : null, dnd: dndOf(t.labels.dnd), pair: t.labels.pair ?? null })
    } else {
      const d = t.labels.dnd
      out([t.name, t.id, status, t.cwd, !d ? '-' : d === '1' ? 'dnd' : `dnd until ${d}`, t.labels.pair ?? '-'].join('\t'))
    }
  }
}

async function find(target) {
  const h = await hcm()
  const all = await h.list({ all: true })
  const hit = (pred) => all.find((t) => t.alive && pred(t)) ?? all.find(pred)
  const t = hit((x) => x.id === target) ?? hit((x) => x.name === target)
  if (!t) process.exit(1)
  const cs = await claudeSessions()
  const pid = t.foreground?.pid ?? null
  out({ name: t.name, pane_id: t.id, cwd: t.cwd, agent_status: t.alive ? (t.status ?? 'unknown') : 'exited', alive: t.alive, program: t.program,
    agent_session: { value: cs.get(pid) ?? null }, tokens: t.labels })
}

async function space(pool, folder) {
  const none = (why) => { console.error(`wt-agents: ${why}; the agent will run hidden from herdr-app`); out({}) }
  const app = (args) => new Promise((resolve, reject) => {
    execFile('herdr-app', args, { encoding: 'utf8', timeout: 8000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
  const lock = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'wt-agents', `space-${pool.replace(/[^A-Za-z0-9_.-]/g, '_')}.lock`)
  mkdirSync(join(lock, '..'), { recursive: true })
  let held = false
  for (let i = 0; i < 100 && !held; i++) {
    try { mkdirSync(lock); held = true } catch (e) {
      if (e.code !== 'EEXIST') break
      try { if (Date.now() - statSync(lock).mtimeMs > 60_000) { rmSync(lock, { recursive: true, force: true }); continue } } catch {}
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  if (!held) return none(`could not lock the ${pool} space`)
  try {
    const doc = JSON.parse(await app(['ls']))
    const hits = (doc.spaces ?? []).filter((s) => s.name === pool && !s.machine).map((s) => s.id).sort()
    if (hits.length) return out({ space: hits[0] })
    const made = JSON.parse(await app(['do', 'space.new', '--name', pool, '--folder', folder]))
    if (!made.space) return none('herdr-app made no space')
    out(made.terminal ? { space: made.space, stray: made.terminal } : { space: made.space })
  } catch (e) {
    none(e.code === 'ENOENT' ? 'herdr-app is not installed' : `herdr-app failed (${String(e.message).split('\n')[0].slice(0, 120)})`)
  } finally { rmSync(lock, { recursive: true, force: true }) }
}

async function tabName(term, name) {
  const app = (args) => new Promise((resolve, reject) => {
    execFile('herdr-app', args, { encoding: 'utf8', timeout: 8000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
  try {
    const { spaces } = JSON.parse(await app(['ls']))
    for (const sp of spaces) for (const tb of sp.tabs) {
      if (tb.terminals.length === 1 && tb.terminals[0].terminal === term) { await app(['do', 'tab.rename', '--id', tb.id, '--name', name]); return }
    }
  } catch (e) { console.error(`wt-agents: tab not named (${String(e.message).split('\n')[0].slice(0, 100)})`) }
}

async function main([cmd, a, b, c]) {
  const h = cmd === 'space' ? null : await hcm()
  switch (cmd) {
    case 'list': return list(a, b === '--json')
    case 'find': return find(a)
    case 'names': return (await h.list({ all: true })).forEach((t) => t.name && out(t.name))
    case 'live-ids': return (await h.list()).forEach((t) => out(t.id))
    case 'pools': return (await h.list()).filter((t) => h.isAgent(t) && t.name && t.id !== b && (t.labels['wt.pool'] ?? '').startsWith(a) && t.labels['wt.pool'].endsWith('s')).forEach((t) => out(t.name))
    case 'team-count': return out(String((await h.list()).filter((t) => t.labels.team === a && (t.labels.persona || t.labels.role) === b).length))
    case 'space': return space(a, b)
    case 'next-name': return out(h.nextName(a, (b ?? '').split(',').filter(Boolean)))
    case 'retire': return h.killRm(a)
    case 'label': {
      const want = Object.fromEntries(process.argv.slice(4).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
      const { dropped } = await h.setLabels(a, want)
      return dropped.length ? console.error(`wt-agents: label dropped: ${dropped.join(',')}`) : undefined
    }
    case 'retire-stray': {
      const t = await h.get(a).catch(() => null)
      if (t && h.isShell(t)) await h.killRm(a)
      return
    }
    case 'tab-name': return tabName(a, b)
    default: console.error('usage: agents-hc.mjs list|find|names|live-ids|pools|team-count|space|retire-stray|tab-name …'); process.exit(2)
  }
}
try { await main(process.argv.slice(2)) } catch (e) { console.error(`wt-agents: hc: ${e.message}`); process.exit(1) }

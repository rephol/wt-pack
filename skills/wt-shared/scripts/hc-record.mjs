#!/usr/bin/env node
// WP-378: records real `hc` output into scripts/fixtures/hc/<verb>.json, the files the fake hc (fake-hc.mjs) replays.
//   hc-record.mjs scenario              run the plain-program scenario (no claude, no cost) against the isolated core
//   hc-record.mjs capture <verb> <case> [--rpc <method> '<json params>'] -- <hc args...>
//                                       run one real hc call and store its stdout/stderr/exit as <verb>.json case <case>
// SAFETY: refuses to run unless HC_SESSION names an isolated session (not unset, not `default`) and XDG_STATE_HOME is set,
// so a recording can never touch the user's own core. Terminals it starts are named rec-* and removed again.
// A case is {args, exit, stdout, stderr}; stdout is the raw text hc printed. Fixtures are real output, not normalised
// (pids, timestamps and /tmp paths stay); claude-specific cases (status done/blocked, blocked send) are taken with
// `capture` from a throwaway claude terminal on the same isolated session.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quietEnv, snapshot, verify } from './claude-link-guard.mjs'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hc')
const HC = process.env.HC_BIN || 'hc'
// Throwaway claude terminals must not run the installer (it repointed ~/.local/bin/claude once): quiet env + a link check at exit.
const LINK = snapshot()
process.on('exit', (code) => { const bad = verify(LINK); if (bad) { console.error(`hc-record: ${bad}`); process.exitCode = code || 3 } })

function guard() {
  const s = process.env.HC_SESSION
  if (!s || s === 'default' || !process.env.XDG_STATE_HOME) {
    console.error('hc-record: refusing to run against the default core. Set HC_SESSION=<short isolated name> and scratch XDG_* dirs first.')
    process.exit(2)
  }
}

function run(args, input) {
  const r = spawnSync(HC, args, { encoding: 'utf8', input, timeout: 30_000, env: quietEnv() })
  return { args, exit: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export function store(verb, name, entry) {
  mkdirSync(DIR, { recursive: true })
  const f = join(DIR, `${verb}.json`)
  let doc = { verb, recorded: '', cases: {} }
  try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch {}
  const v = spawnSync(HC, ['-V'], { encoding: 'utf8', env: quietEnv() }).stdout.trim()
  doc.recorded = `${v} ${new Date().toISOString().slice(0, 10)}`
  doc.cases[name] = entry
  // keep real output but not the recorder's username or hostname
  const clean = JSON.stringify(doc, null, 2).split(process.env.HOME).join('/Users/dev').split(hostname()).join('host').split(`${process.env.USER}@Octes-MacBook-Air`).join('dev@host')
  writeFileSync(f, clean + '\n')
}

function capture(verb, name, args) {
  const e = run(args)
  store(verb, name, e)
  console.log(`recorded ${verb}/${name} exit=${e.exit}`)
  return e
}

function rpc(method, params) {
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const e = run(['connect'], line + '\n')
  return { ...e, args: ['connect'], rpc: { method, params } }
}

const addr = (e) => JSON.parse(e.stdout).address

async function scenario() {
  const made = []
  const cap = (verb, name, args) => capture(verb, name, args)
  const start = (name, argv, extra = []) => {
    const e = run(['run', '--bg', '--json', '--name', name, '--cwd', process.cwd(), '--outlive-parent', '--no-notify', ...extra, '--', ...argv])
    if (e.exit === 0) made.push(addr(e))
    return e
  }
  try {
    // run
    const ok = start('rec-a', ['sleep', '300'], ['--label', 'wt.pool=rec-workers', '--label', 'role=worker', '--label', 'model=sonnet'])
    store('run', 'bg', { ...ok, args: ['run', '--bg', '--json', '--name', 'rec-a', '--label', 'wt.pool=rec-workers', '--label', 'role=worker', '--label', 'model=sonnet', '--outlive-parent', '--no-notify', '--', 'sleep', '300'] })
    cap('run', 'name_taken', ['run', '--bg', '--json', '--name', 'rec-a', 'sleep', '5'])
    cap('run', 'bad_name', ['run', '--bg', '--json', '--name', 'Rec-Bad', 'sleep', '5'])
    // get / label / ls on a live terminal
    cap('get', 'live', ['get', '--json', 'rec-a'])
    cap('get', 'not_found', ['get', '--json', 'rec-nope'])
    cap('label', 'set', ['label', '--json', 'rec-a', 'pair=rec-b', 'task=WP-1'])
    cap('label', 'clear', ['label', '--json', 'rec-a', 'pair=', 'task='])
    cap('label', 'too_long_accepted', ['label', '--json', 'rec-a', `long=${'x'.repeat(200)}`])
    run(['label', 'rec-a', 'long='])
    cap('ls', 'live', ['ls', '--json'])
    cap('ls', 'label_match', ['ls', '--json', '--label', 'role=worker'])
    cap('ls', 'label_nomatch', ['ls', '--json', '--label', 'role=nobody'])
    const rows = rpc('terminal.list', { all: true })
    store('connect', 'terminal.list', rows)
    store('connect', 'server.status', rpc('server.status', {}))
    // send / keys / read / wait / interrupt on a plain program
    cap('keys', 'plain', ['keys', '--json', 'rec-a', 'a'])
    cap('read', 'text', ['read', 'rec-a', '--lines', '3'])
    cap('read', 'json', ['read', '--json', 'rec-a'])
    cap('wait', 'timeout', ['wait', '--json', 'rec-a', '--timeout', '1'])
    cap('server-status', 'live', ['server', 'status', '--json'])
    cap('templates', 'empty', ['templates', '--json'])
    // a program that exits: finished rows, exit wait, finished send, rm
    const x = start('rec-x', ['sh', '-c', 'exit 3'])
    await new Promise((r) => setTimeout(r, 1500))
    cap('wait', 'exit', ['wait', '--json', 'rec-x', '--timeout', '5'])
    cap('get', 'finished', ['get', '--json', 'rec-x'])
    cap('ls', 'all_with_finished', ['ls', '--all', '--json'])
    cap('send', 'finished', ['send', '--json', 'rec-x', 'hi'])
    cap('send', 'not_found', ['send', '--json', 'rec-nope', 'hi'])
    store('connect', 'terminal.list_all', rpc('terminal.list', { all: true }))
    cap('rm', 'ok', ['rm', '--json', 'rec-x'])
    made.splice(made.indexOf(addr(x)), 1)
    cap('rm', 'not_found', ['rm', '--json', 'rec-nope'])
    // kill
    cap('kill', 'ok', ['kill', '--json', 'rec-a'])
    cap('kill', 'not_found', ['kill', '--json', 'rec-nope'])
    cap('rm', 'ok_after_kill', ['rm', '--json', 'rec-a'])
    made.length = 0
  } finally {
    for (const t of made) { run(['kill', t]); run(['rm', t]) }
  }
}

guard()
const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'scenario') await scenario()
else if (cmd === 'capture') {
  const dd = rest.indexOf('--')
  const [verb, name] = rest
  const ri = rest.indexOf('--rpc')
  if (ri >= 0 && (dd < 0 || ri < dd)) { store(verb, name, rpc(rest[ri + 1], JSON.parse(rest[ri + 2] || '{}'))); console.log(`recorded ${verb}/${name} (rpc)`) }
  else capture(verb, name, rest.slice(dd + 1))
} else { console.error('usage: hc-record.mjs scenario | capture <verb> <case> [--rpc <method> <json>] -- <hc args...>'); process.exit(1) }

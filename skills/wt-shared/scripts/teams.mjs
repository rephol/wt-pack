#!/usr/bin/env node
// Teams (WP-237): per-repo team files `<settings root>/teams/<name>.md` (the repo's .wt-pack or the user-level folder,
// same lookup as roles). A team is a pod of agents: members (persona x count) and an optional stage→persona map.
//   ---
//   description: One planner, two workers, a reviewer
//   members: [planner, frontend-worker x2, reviewer]
//   stages: [plan=planner, build=frontend-worker, review=reviewer]
//   ---
//   free-form notes
//   teams.mjs list    [--cwd D]       JSON: [{name, description, members:[{persona,count}], stages:[{stage,persona}]}]
//   teams.mjs members <name> [--cwd D] one persona per line, count-expanded (what `agents.sh spawn --team` spawns)
//   teams.mjs check   [--cwd D]       JSON findings; exit 1 on any error
// Pure and synchronous; frontmatter is the same flat `key: value` / `[a, b]` dialect as roles.mjs.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASES, NAME, list as listRoles, mainCheckout, parse, settingsRoot } from './roles.mjs'

export const STAGES = ['plan', 'build', 'review', 'qa'] // the pipeline order; the flowchart and stage routing (WP-238) follow it
export const MAX_COUNT = 8
export const teamsDir = (checkout, where) => join(settingsRoot(checkout, where), 'teams')

export const TEMPLATES = {
  solo: { description: 'One worker plans, builds and reviews', members: ['worker'], stages: ['plan=worker', 'build=worker', 'review=worker'] },
  standard: { description: 'Planner, two workers and a reviewer', members: ['planner', 'worker x2', 'reviewer'], stages: ['plan=planner', 'build=worker', 'review=reviewer'] },
  full: { description: 'Full SDLC: planner, two workers, reviewer, QA auditor', members: ['planner', 'worker x2', 'reviewer', 'auditor'], stages: ['plan=planner', 'build=worker', 'review=reviewer', 'qa=auditor'] },
}
export const templateText = (name, t) => `---\ndescription: ${t.description}\nmembers: [${t.members.join(', ')}]\nstages: [${t.stages.join(', ')}]\n---\nNotes for ${name} (free-form; not injected into agents).\n`

const arr = (v) => (Array.isArray(v) ? v : v ? [v] : [])
// "frontend-worker x2" | "frontend-worker" → {persona, count}; a bad shape keeps count NaN so check() can name it.
export const member = (s) => {
  const m = /^(\S+?)(?:\s*[x×]\s*(\d+))?$/.exec(String(s).trim())
  return m ? { persona: m[1], count: m[2] ? Number(m[2]) : 1 } : { persona: String(s).trim(), count: NaN }
}
export const stage = (s) => {
  const i = String(s).indexOf('=')
  return i < 0 ? { stage: String(s).trim(), persona: '' } : { stage: s.slice(0, i).trim(), persona: s.slice(i + 1).trim() }
}

export function list(checkout) {
  let names = []
  try { names = readdirSync(teamsDir(checkout)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() } catch {}
  const out = []
  for (const name of names) {
    let text
    try { text = readFileSync(join(teamsDir(checkout), `${name}.md`), 'utf8').slice(0, 24 * 1024) } catch { continue }
    const { meta, body } = parse(text)
    out.push({ name, description: String(meta.description ?? ''), members: arr(meta.members).map(member), stages: arr(meta.stages).map(stage), body, meta })
  }
  return out
}
export const get = (checkout, name) => (NAME.test(name ?? '') ? list(checkout).find((t) => t.name === name) ?? null : null)
// Count-expanded persona names: [planner, worker, worker, reviewer].
export const expand = (team) => team.members.flatMap((m) => Array(m.count).fill(m.persona))

// A member is valid when it is a base role or a persona file in the same settings root.
export function check(checkout) {
  const f = []
  const warn = (name, msg, level = 'warn') => f.push({ name, level, msg })
  const personas = new Set(listRoles(checkout).filter((r) => !r.override).map((r) => r.name))
  for (const t of list(checkout)) {
    if (!NAME.test(t.name)) warn(t.name, `name must match ${NAME}`, 'error')
    for (const k of Object.keys(t.meta)) if (!['description', 'members', 'stages'].includes(k)) warn(t.name, `unknown key \`${k}\``)
    if (!t.members.length) warn(t.name, 'no members', 'error')
    const known = (p) => BASES.includes(p) || personas.has(p)
    for (const m of t.members) {
      if (!NAME.test(m.persona)) warn(t.name, `member \`${m.persona}\` is not a role or persona name`, 'error')
      else if (!known(m.persona)) warn(t.name, `member \`${m.persona}\` has no role file (wt-roles list)`, 'error')
      if (!(m.count >= 1 && m.count <= MAX_COUNT)) warn(t.name, `member \`${m.persona}\`: count must be 1-${MAX_COUNT} (\`persona x2\`)`, 'error')
    }
    if (new Set(t.members.map((m) => m.persona)).size < t.members.length) warn(t.name, 'a persona is listed twice; use `persona xN`', 'error')
    const have = new Set(t.members.map((m) => m.persona))
    const seen = new Set()
    for (const s of t.stages) {
      if (!STAGES.includes(s.stage)) warn(t.name, `unknown stage \`${s.stage}\` (${STAGES.join(', ')})`, 'error')
      else if (seen.has(s.stage)) warn(t.name, `stage \`${s.stage}\` is mapped twice`, 'error')
      seen.add(s.stage)
      if (!s.persona) warn(t.name, `stage \`${s.stage}\` needs \`=persona\``, 'error')
      else if (!have.has(s.persona)) warn(t.name, `stage \`${s.stage}\` → \`${s.persona}\` is not a member`, 'error')
    }
  }
  return f
}

// Mermaid flowchart of a team's workflow: each stage → its persona (with member count) → a gate, review/qa looping
// back to building. Ids are fixed words, labels come from validated names only, so nothing user-typed is a directive.
export function flowchart(team, active = []) {
  const count = new Map(team.members.map((m) => [m.persona, m.count]))
  const stages = STAGES.map((s) => team.stages.find((x) => x.stage === s)).filter(Boolean)
  const lab = (s) => `${s.stage}\\n${s.persona}${count.get(s.persona) > 1 ? ` ×${count.get(s.persona)}` : ''}`
  if (!stages.length) return 'flowchart LR\n  none["no stages mapped"]'
  const L = ['flowchart LR']
  stages.forEach((s, i) => {
    L.push(`  ${s.stage}["${lab(s)}"]`)
    const next = stages[i + 1]
    L.push(`  ${s.stage} --> ${s.stage}_gate{{"gate"}}`)
    L.push(next ? `  ${s.stage}_gate --> ${next.stage}` : `  ${s.stage}_gate --> done(["done"])`)
  })
  const build = stages.find((s) => s.stage === 'build')
  if (build) for (const s of stages) if (s.stage === 'review' || s.stage === 'qa') L.push(`  ${s.stage}_gate -. changes requested .-> build`)
  const on = stages.map((s) => s.stage).filter((s) => active.includes(s))
  if (on.length) L.push('  classDef active fill:#3b82f6,stroke:#1d4ed8,color:#fff', `  class ${on.join(',')} active`)
  return L.join('\n')
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  const i = rest.indexOf('--cwd')
  const cwd = i >= 0 ? rest.splice(i, 2)[1] : process.cwd()
  const checkout = mainCheckout(cwd, 5000)
  if (!checkout) { console.error('not in a git repo'); process.exit(2) }
  if (cmd === 'list') console.log(JSON.stringify(list(checkout).map(({ name, description, members, stages }) => ({ name, description, members, stages }))))
  else if (cmd === 'members') {
    const t = get(checkout, rest[0])
    if (!t) { console.error(`no team ${rest[0]}`); process.exit(1) }
    const bad = check(checkout).filter((x) => x.name === t.name && x.level === 'error')
    if (bad.length) { console.error(bad.map((x) => x.msg).join('; ')); process.exit(1) }
    console.log(expand(t).join('\n'))
  } else if (cmd === 'check') {
    const f = check(checkout)
    console.log(JSON.stringify(f))
    if (f.some((x) => x.level === 'error')) process.exit(1)
  } else { console.error('usage: teams.mjs list|members <name>|check [--cwd D]'); process.exit(2) }
}

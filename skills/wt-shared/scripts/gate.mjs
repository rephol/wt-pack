// WP-332: the destructive-action gate's policy, as two pure functions. `classify` names the outward or irreversible action a Bash
// command performs (null = ordinary); `allowed` says whether this turn's origin may do it without asking the user.
// Loose parsing on purpose, like wt-mods' guards.ts: it stops accidents and injected text, not a determined obfuscator
// (`sh -c "$(…)"`, a script that pushes internally). ponytail: pattern list, not a shell parser — extend it when a bypass shows up.
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const words = (seg) => [...seg.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0].replace(/^["']|["']$/g, ''))
// Scratch space is the agent's own: deleting there is not "outside the task".
const TEMP = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()]
const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
const SECRET_VAR = /\$\{?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\}?/

// WP-361: every hit names its rule id (`rule`) and the segment that matched (`segment`: whitespace-collapsed, ≤120 chars), so a deny says
// what to split out of a compound command. Rule ids: push, merge, branch-delete, worktree-remove, gh-pr, rm-outside, upload, secret-var, raw-socket; WP-378 hc: hc-forged-send, hc-core, hc-kill, hc-keys (and upload for hc put / file write / --on).
export const SEGMENT_MAX = 120
const clip = (seg) => { const t = seg.replace(/\s+/g, ' ').trim(); return t.length > SEGMENT_MAX ? t.slice(0, SEGMENT_MAX - 1) + '…' : t }

// WP-361 localhost exemption: curl (not wget: it follows redirects and re-sends headers by default) whose every URL host is literally 127.0.0.1, localhost or [::1] reach only this machine, so a
// pane-key header or token in it is not "sent off the machine". Strict on purpose: any proxy / connection-rewriting flag, any redirect
// follow (-L: the target is unknowable), any config/input file, any non-http(s) scheme, any glob or userinfo trick, and no URL at all
// all fall back to the normal rules; uploads are never exempt. nc/scp/rsync never are.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const CURL_VALUE = new Set('HXdoumAebcwFTDEKQrtyYzC'.split('')) // curl short options that consume the next word
const CURL_VALUE_LONG = /^--(header|request|data|data-raw|data-binary|data-urlencode|output|user|max-time|connect-timeout|retry|retry-delay|user-agent|referer|cookie|cookie-jar|write-out|json|form|url|oauth2-bearer|range|limit-rate)$/
const NO_EXEMPT = /^(--proxy\S*|--preproxy|--socks\S*|--haproxy\S*|--connect-to|--resolve|--unix-socket|--abstract-unix-socket|--location\S*|--config|--next|--input-file|--execute|--base|--force-html|--ftp-proxy)(=|$)/
const localOnly = (name, raw, env) => {
  if (name !== 'curl' || env.some((e) => /proxy=/i.test(e))) return false
  const urls = []
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k]
    if (t.startsWith('--')) {
      if (NO_EXEMPT.test(t)) return false
      if (t.startsWith('--url=')) urls.push(t.slice(6))
      else if (t === '--url') urls.push(raw[++k] ?? '')
      else if (!t.includes('=') && CURL_VALUE_LONG.test(t)) k++
    } else if (t.startsWith('-') && t.length > 1) {
      if (/^-[a-zA-Z]*[xLK]/.test(t)) return false
      if (CURL_VALUE.has(t[t.length - 1]) && !t.includes('=')) k++
    } else urls.push(t)
  }
  if (!urls.length) return false
  return urls.every((u) => {
    if (/[{}\\\s`]|\$\(/.test(u)) return false
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:[^/?#@]*@)?(\[[^\]/]*\]|[^/?#:\[\]]*)(?::\d*)?(?:[/?#]|$)/i.exec(u)
    return !!m && (!m[1] || /^https?$/i.test(m[1])) && LOCAL_HOSTS.has(m[2].toLowerCase())
  })
}

// WP-361: the shell expands $VAR inside double quotes but not inside single quotes, so the secret-var test reads a segment with its
// single-quoted strings blanked (and double-quoted ones intact). Quote state is tracked left to right: `"it's $K"` stays whole.
const blankSingle = (seg) => {
  let out = '', q = ''
  for (const ch of seg) {
    if (q === "'") { if (ch === "'") { q = ''; out += ch } continue }
    if (!q && ch === "'") { q = ch; out += ch; continue }
    if (ch === '"') q = q === '"' ? '' : q || '"'
    out += ch
  }
  return out
}

// WP-378: the hc terminal runner. Pack scripts call `env -u HC_TERMINAL_ID hc send` INSIDE their own process (D5: the tag-free route), which this
// never sees; a Bash command that does it itself is an agent forging an untagged message. `hcCall` finds the `hc` command of a segment (after
// VAR=val / env / sudo wrappers and their flags) → { verb, sub, args, wrap } or null.
const ID_UNSET = /(?:-u\s*HC_TERMINAL_ID\b|\bunset\s+[^;&|\n]*\bHC_TERMINAL_ID\b|\bHC_TERMINAL_ID=(?:""|'')?(?=[\s;&|]|$))/
// Wrappers that run their next word as a command, and the flags of each that take a VALUE as the next word (`-uNAME` attached needs none).
const WRAP_VAL = { env: ['-u', '-C', '-S'], sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'], command: [], nohup: [], time: ['-f', '-o'], exec: ['-a'],
  timeout: ['-s', '-k', '--signal', '--kill-after'], nice: ['-n', '--adjustment'], xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a', '-J'] }
const DURATION = /^\d+(\.\d+)?[smhd]?$/
const lead = (t) => t.replace(/^(?:\$\(|[({`])+/, '') // `(hc`, `{`, `$(hc`: a group or substitution opening before the command
// hc's own global flags that take a value before the verb: `--session x`, `-s x` (`--session=x` needs none).
const HC_GLOBAL_VAL = new Set(['--session', '-s'])
function hcCall(w) {
  const pre = []
  let k = 0
  while (k < w.length) {
    const t = lead(w[k])
    if (t === '') { k++; continue }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { pre.push(t); k++; continue }
    const base = t.split('/').pop()
    if (base === 'hc') {
      const rest = w.slice(k + 1)
      const kept = []
      let a = 0
      while (a < rest.length && rest[a].startsWith('-')) { if (HC_GLOBAL_VAL.has(rest[a])) a += 2; else kept.push(rest[a++]) }
      const nonFlag = rest.slice(a).filter((x) => !x.startsWith('-'))
      return { verb: nonFlag[0], sub: nonFlag[1], args: [...kept, ...rest.slice(a)], wrap: pre }
    }
    if (!(base in WRAP_VAL)) return null
    pre.push(base); k++
    const takes = WRAP_VAL[base]
    while (k < w.length && w[k].startsWith('-') && w[k] !== '-') {
      pre.push(w[k])
      if (takes.includes(w[k]) && k + 1 < w.length) { k++; pre.push(w[k]) }
      k++
    }
    if (base === 'timeout' && k < w.length && DURATION.test(w[k])) { pre.push(w[k]); k++ }
  }
  return null
}

// → null | { action, rule, segment }. `ctx`: { cwd, root } — the session's cwd and its worktree/checkout root (for the rm-outside test).
export function classify(cmd, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd(), root = ctx.root ?? cwd
  for (const seg of String(cmd).split(/&&|\|\||[;\n|]/)) {
    const hit = (action, rule) => ({ action, rule, segment: clip(seg) })
    const bare = seg.replace(/"[^"]*"|'[^']*'/g, '""') // words inside a message are not subcommands
    const w = words(bare)
    // strip leading VAR=val and env/sudo/command wrappers
    let i = 0
    while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['env', 'sudo', 'command', 'nohup', 'time'].includes(w[i]))) i++
    const [c, ...rest] = w.slice(i)
    if (!c) continue
    const hc = hcCall(w)
    if (hc) {
      const { verb, sub, args } = hc
      const cleared = hc.wrap.includes('-i') || ID_UNSET.test(String(cmd))
      if ((verb === 'send' || verb === 'keys') && cleared) return hit('send into another terminal as an untagged (forged) message', 'hc-forged-send')
      if (verb === 'server' && ['stop', 'restart'].includes(sub) || verb === 'update') return hit('stop, restart or update the hc core', 'hc-core')
      if (verb === 'kill' || verb === 'rm') return hit('end or remove another terminal', 'hc-kill')
      if (verb === 'keys' || (verb === 'send' && args.includes('--force'))) return hit('press keys in another terminal (answer its dialog)', 'hc-keys')
      if (verb === 'put' || (verb === 'file' && sub === 'write') || args.some((a) => a === '--on' || a.startsWith('--on='))) return hit('send files or secrets off the machine', 'upload')
      continue
    }
    const name = c.split('/').pop()
    if (name === 'git') {
      let j = 0
      while (j < rest.length && rest[j].startsWith('-')) j += /^-[cC]$/.test(rest[j]) ? 2 : 1 // git -C dir / -c k=v
      const sub = rest[j], args = rest.slice(j + 1)
      if (sub === 'push' && !args.includes('--dry-run') && !args.includes('-n')) return args.some((a) => a === '--delete' || a === '-d' || /^:\S/.test(a)) ? hit('delete a remote branch', 'branch-delete') : hit('git push', 'push')
      if (sub === 'merge' && !args.some((a) => ['--abort', '--help', '-h', '--quit'].includes(a))) return hit('git merge', 'merge')
      if (sub === 'branch' && args.some((a) => /^(-D|-d|--delete)$/.test(a))) return hit('delete a branch', 'branch-delete')
      if (sub === 'worktree' && ['remove', 'prune'].includes(args[0])) return hit('remove a worktree', 'worktree-remove')
    } else if (name === 'gh') {
      if (rest[0] === 'pr' && ['approve', 'merge', 'close'].includes(rest[1])) return hit(`gh pr ${rest[1]}`, 'gh-pr')
    } else if (name === 'rm' || name === 'rmdir') {
      for (const t of rest.filter((x) => !x.startsWith('-'))) {
        const p = resolve(cwd, t.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
        if (/[*?$]/.test(t) && !/^[\w./-]*\*?[\w./-]*$/.test(t)) return hit('delete files outside the worktree', 'rm-outside') // $VAR / globbing we cannot place
        if (!inside(p, root) && !TEMP.some((d) => inside(p, d))) return hit('delete files outside the worktree', 'rm-outside')
      }
    } else if (['curl', 'wget', 'scp', 'rsync', 'nc', 'ncat'].includes(name)) {
      const text = rest.join(' '), rawText = words(seg).slice(i + 1).join(' ')
      const CURL_UP = /(^|\s)(-T|--upload-file)(\s|=)|(^|\s)(-d|--data(?:-binary|-raw|-urlencode)?|-F|--form)(\s|=)\S*@|\s-d\s+@|--data\S*\s+@/
      const upload = name === 'curl' ? CURL_UP.test(' ' + text) || CURL_UP.test(' ' + rawText) // rawText: a quoted `-d "@f"` is an upload too
        : name === 'wget' ? /--post-file|--body-file/.test(rawText)
        : name === 'scp' ? rest.some((a) => /^[^-\s/][^\s/]*:/.test(a) && !a.startsWith('http')) && rest.filter((a) => !a.startsWith('-')).length >= 2
        : name === 'rsync' ? rest.some((a) => /^[^-\s/][^\s/]*:/.test(a))
        : true
      const OUT = 'send files or secrets off the machine'
      if (name === 'nc' || name === 'ncat') return hit(OUT, 'raw-socket')
      if (upload) return hit(OUT, 'upload')
      if (localOnly(name, words(seg).slice(i + 1), w.slice(0, i))) continue
      if (SECRET_VAR.test(blankSingle(seg.slice(seg.search(/\b(curl|wget|scp|rsync)\b/))))) return hit(OUT, 'secret-var')
    }
  }
  return null
}

export const ALLOWED_KINDS = ['handoff', 'dispatch', 'routine']
// `turn`: the record inject.mjs writes per prompt: { trust: 'user'|'peer'|'verified'|'unverified', kind, sender, senderRole }.
// A missing/stale record is the caller's `unverified`. mode 'off' = the setting WT_GATE=off.
export const allowed = (turn, mode = 'ask') => {
  if (mode === 'off') return true
  if (turn?.trust === 'peer') return false // WP-357: another Claude session's message (SendMessage) is never the user's word; WT_GATE=off above stays the user's explicit choice
  if (turn?.trust === 'user') return true
  if (turn?.trust !== 'verified') return false
  if (turn.kind === 'reply') return turn.replyAllowed === true // the server checked: current assignee's report on a ticket this orchestrator handed off
  return ALLOWED_KINDS.includes(turn.kind) && (turn.senderRole === 'orchestrator' || turn.senderRole === 'server')
}

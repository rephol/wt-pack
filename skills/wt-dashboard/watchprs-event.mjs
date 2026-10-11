// WP-337: what the wt-watch-prs poller may tell an agent. The poller is no pane and holds no credential, so the dashboard
// does NOT take its text: it takes a few fields, checks each against a strict pattern, and writes the sentence itself from a
// fixed template (ids only, WP-331 — PR titles and comment bodies are outsider-written and never travel). Any other key is a 400,
// so a caller cannot smuggle instructions into a message that is delivered as VERIFIED kind=system from wt-watch-prs.
const bad = (m) => Object.assign(new Error(m), { status: 400 })
const RE = {
  repo: /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, sha: /^[0-9a-f]{7,40}$/, login: /^[A-Za-z0-9-]{1,39}$/, id: /^[0-9]{1,15}$/,
  pr: /^[0-9]{1,9}$/, minutes: /^[0-9]{1,6}$/, state: /^(APPROVED|CHANGES_REQUESTED|COMMENTED|DISMISSED|PENDING)$/,
}
// event → [required fields, optional fields]
const EVENTS = {
  'new-commits': [['repo', 'pr', 'sha', 'login'], []],
  comment: [['repo', 'pr', 'id', 'login'], []],
  review: [['repo', 'pr', 'id', 'login'], ['state']],
  unclaimed: [['repo', 'pr', 'sha'], []],
  resumed: [['minutes'], []],
}

// body: { pane, event, …fields } → the sentence. Throws a 400 for an unknown event, a missing/extra field or a field off its pattern.
export function compose(body) {
  const { pane, event, ...f } = body ?? {}
  const spec = Object.hasOwn(EVENTS, event) ? EVENTS[event] : null
  if (!spec) throw bad(`event: one of ${Object.keys(EVENTS).join(', ')}`)
  const [need, opt] = spec
  for (const k of Object.keys(f)) if (![...need, ...opt].includes(k)) throw bad(`${k}: not a field of ${event} (free text is not accepted)`)
  for (const k of need) if (f[k] === undefined) throw bad(`${k}: required for ${event}`)
  for (const [k, v] of Object.entries(f)) if (typeof v !== 'string' && typeof v !== 'number' || !RE[k].test(String(v))) throw bad(`${k}: does not match ${RE[k]}`)
  const s = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)]))
  switch (event) {
    case 'new-commits': return `PR #${s.pr} (${s.repo}) — new commits ${s.sha} — @${s.login}`
    case 'comment': return `PR #${s.pr} (${s.repo}) — REPLY on a held PR — @${s.login} (comment ${s.id}) — read it with: gh api repos/${s.repo}/issues/comments/${s.id}`
    case 'review': return `PR #${s.pr} (${s.repo}) — REVIEW${s.state ? ` (${s.state})` : ''} on a held PR — @${s.login} (review ${s.id}) — read it with: gh api repos/${s.repo}/pulls/${s.pr}/reviews/${s.id}`
    case 'unclaimed': return `wt-watch-prs: PR #${s.pr} (${s.repo}) head ${s.sha.slice(0, 12)} was delivered 30+ min ago and is still unclaimed — claim it now (watch-prs.sh claim ${s.pr} <session>); if it is waiting on CI, claim first and wait on the gate.`
    case 'resumed': return `wt-watch-prs: poller resumed after ${s.minutes}m; replayed missed heads`
  }
}

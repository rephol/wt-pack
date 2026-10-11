// WP-104: the tag wt-pack wraps around everything it sends into an agent's pane (the sibling of rooms'
// <room-message>), so an agent tells pack traffic from its user and answers through the channel the tag names.
// Pure (no main-guard: the sidecar bundle rewrites import.meta.url); the CLI is wt-message-cli.mjs.
import { randomBytes } from 'node:crypto'

export const KINDS = ['handoff', 'dispatch', 'routine', 'reply', 'system']
export const nonce = () => randomBytes(6).toString('hex')
// Attribute values: no quotes, brackets, ampersands or newlines.
export const attr = (t) => String(t ?? '').replace(/["<>&\n]/g, '')
// Bodies: neither tag can be opened or closed from inside one (a zero-width space breaks the name).
export const unTag = (t) => String(t ?? '').replace(/<(\/?)(room-message|wt-message)/gi, '<$1$2​')

export function wrap({ kind, from = '', ticket = null, pr = null, sha = null, id = nonce() }, body) {
  if (!KINDS.includes(kind)) throw new Error(`wt-message: bad kind ${JSON.stringify(kind)}`)
  const t = (typeof ticket === 'string' && /^[A-Z]+-\d+$/.test(ticket) ? ` ticket=${ticket}` : '')
    // WP-121: a PR dispatch names its PR and head; values that fail the check are dropped.
    + (/^\d{1,9}$/.test(String(pr ?? '')) ? ` pr=${pr}` : '') + (/^[0-9a-f]{7,40}$/.test(String(sha ?? '')) ? ` sha=${sha}` : '')
  // A slash command stays first (`/wt-audit …` must still run as one): `/cmd <wt-message …>rest</wt-message>`.
  const slash = String(body ?? '').match(/^(\/[^\s<]+)(?:\s+|$)/)
  const rest = slash ? String(body).slice(slash[0].length) : body
  return `${slash ? `${slash[1]} ` : ''}<wt-message id=${id} kind=${kind} from="${attr(from)}"${t}>${unTag(rest)}</wt-message>`
}

// WP-329: the ONE parser of a `<wt-message …>` envelope, for the classifier (inject.mjs) and the store (messages.mjs).
// Anchored at the start (leading `/cmd ` tokens allowed, as wrap() hoists them); `kind` must be a known one, so
// `kind=bogus` and a peer wrapper ("Another Claude session sent a message: …") are null. → {slash, id, kind, sender, ticket}.
export function parseEnvelope(text) {
  const m = String(text ?? '').match(/^((?:\/\S+ )*)<wt-message id=([\w-]+) kind=(\w+) from="([^"]*)"(?: ticket=([A-Z]+-\d+))?/)
  return m && KINDS.includes(m[3]) ? { slash: m[1].trim(), id: m[2], kind: m[3], sender: m[4], ticket: m[5] ?? null } : null
}

// WP-331: third-party text (a card or PR title) that rides in a pack message at all is data: one line, tags defused, no quotes,
// at most 120 chars, returned already quoted. Everything longer or richer is read by the agent as a tool result, not sent.
export const quoteTitle = (t) => {
  const one = unTag(String(t ?? '').replace(/\s+/g, ' ').replace(/["<>]/g, '').trim())
  return `"${one.length > 120 ? `${one.slice(0, 120)}…` : one}"`
}

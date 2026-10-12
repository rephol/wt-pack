// WP-104: the tag wt-pack wraps around everything it sends into an agent's pane (the sibling of rooms'
// <room-message>), so an agent tells pack traffic from its user and answers through the channel the tag names.
// Pure (no main-guard: the sidecar bundle rewrites import.meta.url); the CLI is wt-message-cli.mjs.
import { randomBytes, createHash } from 'node:crypto'

export const KINDS = ['handoff', 'dispatch', 'routine', 'reply', 'system']
export const nonce = () => randomBytes(6).toString('hex')
// WP-333: attribute values are an allowlist (word chars, space . @ # : -), at most 40 chars: no quotes, brackets, CR/LS/PS, anything.
export const attr = (t) => String(t ?? '').replace(/[^\w .@#:-]/g, '').slice(0, 40)
// Bodies: neither tag can be opened or closed from inside one. WP-333: lookalikes too (whitespace after `<`, fullwidth `＜`, zero-width
// chars inside the name); the `<` becomes U+2039, so no variant parses as a tag.
const ZW = '[\\s\u200b-\u200d\u2060\ufeff]*'
const TAG = new RegExp(`[<\uff1c]${ZW}\\/?${ZW}(?:room|wt)${ZW}-${ZW}message`, 'gi')
export const unTag = (t) => String(t ?? '').replace(TAG, (m) => `\u2039${m.slice(1)}`)

export function wrap({ kind, from = '', ticket = null, pr = null, sha = null, id = nonce(), hoist = false }, body) {
  if (!KINDS.includes(kind)) throw new Error(`wt-message: bad kind ${JSON.stringify(kind)}`)
  const t = (typeof ticket === 'string' && /^[A-Z]+-\d+$/.test(ticket) ? ` ticket=${ticket}` : '')
    // WP-121: a PR dispatch names its PR and head; values that fail the check are dropped.
    + (/^\d{1,9}$/.test(String(pr ?? '')) ? ` pr=${pr}` : '') + (/^[0-9a-f]{7,40}$/.test(String(sha ?? '')) ? ` sha=${sha}` : '')
  // WP-333: with `hoist`, only `/goal` and `/wt-*` stay first (`/wt-audit …` must still run as one): `/cmd <wt-message …>rest</wt-message>`.
  // Any other leading `/x` stays in the body behind a zero-width space, so the receiver's harness does not run it.
  const text = String(body ?? '')
  const slash = hoist ? text.match(/^(\/(?:goal|wt-[a-z0-9-]+))(?:\s+|$)/) : null
  const rest = slash ? text.slice(slash[0].length) : /^\/\S/.test(text) ? `\u200b${text}` : text
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

// WP-352: when the target's delivery mod is not live, a message is TYPED into its pane as this short pointer, never as the
// full text (a long typed prompt is collapsed into a pasted block, or turned into an untagged "Do the task in <file>" line, and
// the receiving hook then cannot classify it). The pointer carries the recorded id; the agent reads the body with `wt-message show`.
export const pointerLine = (id) => `Read it with: wt-message show ${id}, do what it asks, then report as it says`
// The exact pointer text for a recorded envelope (same id/kind/sender/ticket), keeping a hoisted leading `/goal` or `/wt-*`.
// Not an envelope → null (the caller types the text as it is).
export function pointerOf(text) {
  const e = parseEnvelope(text)
  return e && `${e.slash ? `${e.slash} ` : ''}${wrap({ kind: e.kind, from: e.sender, ticket: e.ticket, id: e.id }, pointerLine(e.id))}`
}
// True only when the envelope body is byte-for-byte the pointer for its own id: any extra text makes it a different message.
export const isPointer = (text) => { const p = pointerOf(text); return p !== null && String(text) === p }
// sha256 of what sits between the opening tag and the closing `</wt-message>` — the body `/verify` compares with the record.
export function bodyHash(text) {
  const t = String(text ?? '').trimEnd(), i = t.indexOf('<wt-message '), open = i < 0 ? -1 : t.indexOf('>', i)
  if (open < 0 || !t.endsWith('</wt-message>')) return null
  return createHash('sha256').update(t.slice(open + 1, -'</wt-message>'.length)).digest('hex')
}

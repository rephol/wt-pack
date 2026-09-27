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

export function wrap({ kind, from = '', ticket = null, id = nonce() }, body) {
  if (!KINDS.includes(kind)) throw new Error(`wt-message: bad kind ${JSON.stringify(kind)}`)
  const t = typeof ticket === 'string' && /^[A-Z]+-\d+$/.test(ticket) ? ` ticket=${ticket}` : ''
  // A slash command stays first (`/wt-audit …` must still run as one): `/cmd <wt-message …>rest</wt-message>`.
  const slash = String(body ?? '').match(/^(\/[^\s<]+)(?:\s+|$)/)
  const rest = slash ? String(body).slice(slash[0].length) : body
  return `${slash ? `${slash[1]} ` : ''}<wt-message id=${id} kind=${kind} from="${attr(from)}"${t}>${unTag(rest)}</wt-message>`
}

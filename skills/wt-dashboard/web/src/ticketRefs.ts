// WP-93 ticket id chips: which <KEY>-<N> in rendered chat text become chips. Pure (the chip itself is injected), so
// the matcher is tested through the real Markdown renderer. Markdown hands inline plugins text nodes only, so code
// spans and blocks are never matched; a URL is skipped by the character before the id (/ = ? # . …).
import type { ReactNode } from 'react'
import type { MarkdownInlinePlugin } from '@astryxdesign/core/Markdown'

// GET /api/tickets/refs: local board key → project; Linear team keys and the workspace url key (null = unknown).
export interface TicketRefs { boards: Record<string, string>; linear: { keys: string[]; org: string | null } }
export type Ref = { id: string; kind: 'board'; project: string } | { id: string; kind: 'linear'; url: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BEFORE = /[\p{L}\p{N}_\-/=?#&.@:]/u // part of a word, a path or a URL
const AFTER = /[\p{L}\p{N}_]/u // WP-92a is not WP-92

export function refOf(refs: TicketRefs, key: string, n: string): Ref | null {
  const id = `${key}-${n}`
  if (refs.boards[key]) return { id, kind: 'board', project: refs.boards[key] }
  if (refs.linear.org && refs.linear.keys.includes(key)) return { id, kind: 'linear', url: `https://linear.app/${refs.linear.org}/issue/${id}` }
  return null
}

export function ticketPlugin(refs: TicketRefs | undefined, render: (ref: Ref, key: string) => ReactNode): MarkdownInlinePlugin | null {
  const keys = refs ? [...Object.keys(refs.boards), ...(refs.linear.org ? refs.linear.keys : [])] : []
  if (!refs || !keys.length) return null
  return {
    pattern: new RegExp(`(${keys.map(esc).join('|')})-(\\d+)`, 'g'),
    getEndIndex: (text, m) => {
      const end = m.index! + m[0].length
      return (m.index! > 0 && BEFORE.test(text[m.index! - 1])) || (end < text.length && AFTER.test(text[end])) ? false : end
    },
    render: (m, key) => render(refOf(refs, m[1], m[2])!, key),
  }
}

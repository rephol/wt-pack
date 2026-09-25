// Markdown for agent/room text: bare URLs become links (Astryx's GFM autolink literals; code spans/blocks are
// skipped), only http(s)/mailto open, and in the desktop app they go through the opener plugin, because the
// webview ignores target=_blank. Long URLs wrap anywhere instead of overflowing the bubble.
import { createElement, type ComponentType, type MouseEvent, type ReactNode } from 'react'
import { Markdown } from '@astryxdesign/core/Markdown'

type Opener = { openUrl: (u: string) => Promise<void> }
const opener = () => (globalThis as unknown as { __TAURI__?: { opener?: Opener } }).__TAURI__?.opener
const isApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href.trim())

// Returns false to cancel the anchor's default navigation.
export function linkClick(href: string, e?: MouseEvent<HTMLAnchorElement>, app = isApp(), open = opener()): void | false {
  if (!safeHref(href)) return false
  if (!app) return // browser: the anchor's own target=_blank rel="noopener noreferrer"
  if (!open) { console.error('opener plugin unavailable; cannot open', href); return false }
  e?.preventDefault()
  open.openUrl(href).catch((err) => console.error('openUrl failed', href, err))
  return false
}

export function ChatMarkdown({ children, density = 'compact' }: { children: string; density?: 'default' | 'compact' }): ReactNode {
  return createElement(Markdown as unknown as ComponentType<Record<string, unknown>>, { density, autolink: 'gfm', onLinkClick: (h: string, e: MouseEvent<HTMLAnchorElement>) => linkClick(h, e), style: { overflowWrap: 'anywhere' } }, children)
}

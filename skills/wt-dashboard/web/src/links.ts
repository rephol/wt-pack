// Markdown for agent/room text: bare URLs become links (Astryx's GFM autolink literals; code spans/blocks are
// skipped), only http(s)/mailto open, and in the desktop app they go through the opener plugin, because the
// webview ignores target=_blank. Long URLs wrap anywhere instead of overflowing the bubble.
import { createElement, type ComponentType, type ReactNode } from 'react'
import { Markdown, type MarkdownInlinePlugin } from '@astryxdesign/core/Markdown'
import { useChatDensity, markdownDensity } from './density.ts'

type Opener = { openUrl: (u: string) => Promise<void> }
const opener = () => (globalThis as unknown as { __TAURI__?: { opener?: Opener } }).__TAURI__?.opener
const isApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href.trim())

// Returns false to cancel the anchor's default navigation. In the desktop app an http(s) link opens in the in-app
// browser window (the native side owns it; asked over the event bus, no IPC for the page itself); ⌘/Ctrl-click
// and mailto go to the system browser/mail app through the opener. A plain browser keeps target=_blank.
type Bus = { emit: (n: string, p?: unknown) => Promise<void> }
const bus = () => (globalThis as unknown as { __TAURI__?: { event?: Bus } }).__TAURI__?.event
export function linkClick(href: string, e?: { metaKey?: boolean; ctrlKey?: boolean; preventDefault?: () => void }, app = isApp(), open = opener(), browse = bus()): void | false {
  if (!safeHref(href)) return false
  if (!app) return
  e?.preventDefault?.()
  if (/^https?:/i.test(href) && browse && !(e?.metaKey || e?.ctrlKey)) {
    browse.emit('browser', { url: href }).catch((err) => console.error('in-app browser failed', href, err))
    return false
  }
  if (!open) { console.error('opener plugin unavailable; cannot open', href); return false }
  open.openUrl(href).catch((err) => console.error('openUrl failed', href, err))
  return false
}

// http(s) URLs in a message, for preview cards: outside code spans/blocks, trailing punctuation trimmed,
// duplicates collapsed (ignoring a trailing slash and #fragment), at most `max`.
export function linksIn(text: string, max = 3): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const out: string[] = [], seen = new Set<string>()
  for (const m of plain.matchAll(/https?:\/\/[^\s<>()\[\]"'`]+/gi)) {
    const u = m[0].replace(/[.,;:!?*_~]+$/, '')
    const key = u.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key); out.push(u)
    if (out.length === max) break
  }
  return out
}

export function ChatMarkdown({ children, density, inlinePlugins }: { children: string; density?: 'default' | 'compact'; inlinePlugins?: MarkdownInlinePlugin[] }): ReactNode {
  const chat = useChatDensity()
  density ??= markdownDensity(chat)
  return createElement(Markdown as unknown as ComponentType<Record<string, unknown>>, { density, inlinePlugins, autolink: 'gfm', onLinkClick: (h: string, e: { metaKey?: boolean; ctrlKey?: boolean; preventDefault?: () => void }) => linkClick(h, e), style: { overflowWrap: 'anywhere' } }, children)
}

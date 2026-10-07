// WP-274: the one message row both chats render (agent Conversation in App.tsx, rooms in rooms.tsx).
// Differences come in as props/slots; the actions row (time · info · reply · copy) is MessageActions, so a new
// action (WP-273 pin/bookmark) is one more prop + one more IconButton there.
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Text } from '@astryxdesign/core/Text'
import { useToast } from '@astryxdesign/core/Toast'
import { ChatMarkdown } from './links'
import { LinkPreviews } from './previews'
import { fmtWhen } from './turns'
import { MsgActions } from './pins'
import type { ChatRef, MsgRef } from './pinState'

export const ReplyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 17 4 12l5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" />
  </svg>
)

// "Show message details" (conversation ⋯ menu): expands every details line; remembered per browser.
let showAllDetails = (() => { try { return localStorage.getItem('msg-details') === '1' } catch { return false } })()
const detailSubs = new Set<() => void>()
const subDetails = (f: () => void) => { detailSubs.add(f); return () => { detailSubs.delete(f) } }
export function setShowAllDetails(v: boolean) {
  showAllDetails = v
  try { localStorage.setItem('msg-details', v ? '1' : '0') } catch { /* private mode */ }
  detailSubs.forEach((f) => f())
}
export const useShowAllDetails = () => useSyncExternalStore(subDetails, () => showAllDetails)

export interface MessageActionsProps {
  ts?: string // the time; relative, hover shows the absolute time, a tap toggles it (phones)
  details?: string[] // behind the info icon; none = no icon
  badge?: string // e.g. an abnormal stop reason
  copyText?: string
  onReply?: () => void
  pin?: { chat: ChatRef; m: MsgRef } // Pin + Bookmark toggles (WP-273's MsgActions)
}
export function MessageActions({ ts, details = [], badge, copyText, onReply, pin }: MessageActionsProps) {
  const [abs, setAbs] = useState(false)
  const all = useShowAllDetails()
  const [own, setOwn] = useState<boolean | null>(null) // per message; null follows the global toggle
  const open = own ?? all
  const toast = useToast()
  if (!ts && !copyText) return null
  const when = ts ? new Date(ts) : null
  const copy = () => navigator.clipboard.writeText(copyText!).then(() => toast({ body: 'Copied', type: 'info' }), (e) => toast({ body: `Copy failed: ${e}`, type: 'error' }))
  return (
    <div data-msg-meta style={{ marginTop: 8, maxWidth: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, minWidth: 0 }}>
        {when && <Text type="supporting" size="sm"><span role="button" tabIndex={0} title={when.toLocaleString()} onClick={() => setAbs((v) => !v)} onKeyDown={(e) => e.key === 'Enter' && setAbs((v) => !v)}>{abs ? when.toLocaleString() : fmtWhen(ts!)}</span></Text>}
        {badge && <Badge label={badge} variant="error" />}
        {details.length > 0 && <span data-copy style={{ flexShrink: 0 }}><IconButton label="Message details" icon={<Icon icon="info" size="sm" />} variant="ghost" size="sm" aria-expanded={open} onClick={() => setOwn(!open)} /></span>}
        {onReply && <span data-copy style={{ flexShrink: 0 }}><IconButton label="Reply" icon={<ReplyIcon />} variant="ghost" size="sm" onClick={onReply} /></span>}
        {pin && pin.m.text && <MsgActions chat={pin.chat} m={pin.m} />}
        {copyText && <span data-copy style={{ flexShrink: 0 }}><IconButton label="Copy message" icon={<Icon icon="copy" size="sm" />} variant="ghost" size="sm" onClick={copy} /></span>}
      </div>
      {open && details.length > 0 && <Text type="supporting" size="sm">{details.join(' · ')}</Text>}
    </div>
  )
}

// WP-105: chat text after the turn's room post, behind a toggle — the room has the answer.
function Collapsed({ lines, children }: { lines: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return open ? <>{children}</> : <Button label={`show ${lines} more line${lines === 1 ? '' : 's'}`} variant="ghost" size="sm" onClick={() => setOpen(true)} />
}

export interface ChatMessageRowProps {
  sender: 'user' | 'assistant'
  avatar?: ReactNode
  name?: ReactNode
  anchorId?: string // scroll target (rooms jump to a quoted message)
  actions?: MessageActionsProps
  header?: ReactNode // above the text (a reply quote)
  text?: string
  plain?: boolean // text is plain pre-wrap, not markdown
  plugins?: Parameters<typeof ChatMarkdown>[0]['inlinePlugins'] // markdown inline plugins (mentions, ticket chips)
  breaks?: boolean // markdown: newlines are line breaks
  ghost?: boolean // the text bubble has no fill
  previews?: boolean // link preview cards under the text
  collapsed?: number // hide the text behind "show N more lines"
  grouped?: boolean // text, previews and media share ONE full-width ghost bubble (an agent's reply)
  media?: ReactNode // images / attachments / file cards
  custom?: ReactNode // replaces the text and media entirely (a room prompt card)
}
export function ChatMessageRow({ sender, avatar, name, anchorId, actions, header, text, plain, plugins, breaks, ghost, previews, collapsed, grouped, media, custom }: ChatMessageRowProps) {
  const body = text ? plain ? <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span> : <ChatMarkdown inlinePlugins={plugins} breaks={breaks}>{text}</ChatMarkdown> : null
  const cards = text && previews ? <LinkPreviews text={text} /> : null
  return (
    <ChatMessage sender={sender} avatar={avatar} name={name} metadata={actions && <MessageActions {...actions} />}>
      {anchorId && <span id={anchorId} />}
      {header}
      {custom ?? (grouped ? (
        <ChatMessageBubble variant="ghost" width="100%">
          {body && (collapsed != null ? <Collapsed lines={collapsed}>{body}{cards}</Collapsed> : <>{body}{cards}</>)}
          {media}
        </ChatMessageBubble>
      ) : (
        <>
          {body && <ChatMessageBubble variant={ghost ? 'ghost' : undefined}>{body}</ChatMessageBubble>}
          {cards}
          {media && <ChatMessageBubble variant="ghost">{media}</ChatMessageBubble>}
        </>
      ))}
    </ChatMessage>
  )
}

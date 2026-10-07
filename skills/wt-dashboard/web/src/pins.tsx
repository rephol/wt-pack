// WP-273: Pin (shared, per chat → the pinned bar) and Bookmark (personal, global → the Saved panel) on messages in room
// chats and agent Conversation tabs. State lives in wt.db behind /api/pins and /api/bookmarks; /api/changes refreshes
// every open client. A pin is data shown to people: it is never sent to an agent as a prompt.
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Heading } from '@astryxdesign/core/Heading'
import { TextInput } from '@astryxdesign/core/TextInput'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { SideNavItem } from '@astryxdesign/core/SideNav'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { POLL_FALLBACK_MS } from './changes'
import { groupSaved, oneLine, requestJump, takeJump, type ChatRef, type MsgRef, type Pin, type Saved } from './pinState'

const sv = { width: 16, height: 16, viewBox: '0 0 24 24', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, stroke: 'currentColor', 'aria-hidden': true }
const PinIcon = ({ on }: { on?: boolean }) => <svg {...sv} fill={on ? 'currentColor' : 'none'}><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z" /></svg>
const MarkIcon = ({ on }: { on?: boolean }) => <svg {...sv} fill={on ? 'currentColor' : 'none'}><path d="M6 3h12v18l-6-4-6 4V3z" /></svg>
const CloseIcon = () => <svg {...sv} fill="none"><path d="M18 6 6 18M6 6l12 12" /></svg>

const enc = encodeURIComponent
export const usePins = (chat: string | null) =>
  useQuery({ queryKey: ['pins', chat], enabled: Boolean(chat), queryFn: () => api<Pin[]>(`/api/pins?chat=${enc(chat!)}`), refetchInterval: POLL_FALLBACK_MS })
export const useSaved = (q = '') =>
  useQuery({ queryKey: ['bookmarks', q], queryFn: () => api<{ saved: Saved[] }>(`/api/bookmarks?q=${enc(q)}`), refetchInterval: POLL_FALLBACK_MS })

// Pin and Bookmark toggles for one message; icons show state. The caller passes the chat and the message's text snapshot.
export function MsgActions({ chat, m }: { chat: ChatRef; m: MsgRef }) {
  const qc = useQueryClient()
  const toast = useToast()
  const pinned = usePins(chat.chat).data?.some((p) => p.msg === m.msg) ?? false
  const saved = useSaved().data?.saved.some((s) => s.chat === chat.chat && s.msg === m.msg) ?? false
  const body = { chat: chat.chat, msg: m.msg, author: m.author, text: m.text, label: chat.label, open: chat.open }
  const toggle = (kind: 'pins' | 'bookmarks', on: boolean) => api(on ? `/api/${kind}` : `/api/${kind}?chat=${enc(chat.chat)}&msg=${enc(m.msg)}`, on ? { method: 'POST', body: JSON.stringify(body) } : { method: 'DELETE' })
  const mut = useMutation({
    mutationFn: ({ kind, on }: { kind: 'pins' | 'bookmarks'; on: boolean }) => toggle(kind, on),
    onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: [v.kind] }),
    onError: (e) => toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  return (
    <>
      <span data-copy style={{ flexShrink: 0 }}><IconButton label={pinned ? 'Unpin message' : 'Pin message'} icon={<PinIcon on={pinned} />} variant="ghost" size="sm" aria-pressed={pinned} onClick={() => mut.mutate({ kind: 'pins', on: !pinned })} /></span>
      <span data-copy style={{ flexShrink: 0 }}><IconButton label={saved ? 'Remove bookmark' : 'Bookmark message'} icon={<MarkIcon on={saved} />} variant="ghost" size="sm" aria-pressed={saved} onClick={() => mut.mutate({ kind: 'bookmarks', on: !saved })} /></span>
    </>
  )
}

// The pinned bar at the top of a chat: newest first, collapsible, a tap jumps to the message in the thread.
export function PinnedBar({ chat, onJump }: { chat: ChatRef; onJump: (msg: string) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const pins = usePins(chat.chat).data ?? []
  const unpin = useMutation({
    mutationFn: (msg: string) => api(`/api/pins?chat=${enc(chat.chat)}&msg=${enc(msg)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pins'] }), onError: (e) => toast({ body: String(e), type: 'error' }),
  })
  if (!pins.length) return null
  const shown = open ? pins : pins.slice(0, 1)
  return (
    <div className="hd-pinbar" role="region" aria-label="Pinned messages">
      <button type="button" className="hd-pinbar-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <PinIcon on /> <span>{`${pins.length} pinned`}</span><span aria-hidden style={{ marginLeft: 'auto' }}>{open ? '▴' : '▾'}</span>
      </button>
      {shown.map((p) => (
        <div key={p.msg} className="hd-pinrow">
          <button type="button" className="hd-pintext" onClick={() => onJump(p.msg)} title="Jump to the message">
            <b>{p.author}</b> {oneLine(p.text)}
          </button>
          {open && <IconButton label="Unpin" icon={<CloseIcon />} variant="ghost" size="sm" onClick={() => unpin.mutate(p.msg)} />}
        </div>
      ))}
    </div>
  )
}

// Open `chat` at `msg`: the chat takes the jump when it shows (see useJumpRequest).
export function openSaved(row: Saved) {
  requestJump(row.chat, row.msg)
  const h = `#${row.open}`
  if (location.hash === h) dispatchEvent(new Event('jump-msg')); else location.hash = row.open
}
// A chat calls this with its key and a jump function; a Saved tap (or a hashchange that mounts the chat) triggers it.
export function useJumpRequest(chat: string | null, jump: (msg: string) => void) {
  const run = useRef(jump)
  run.current = jump
  useEffect(() => {
    if (!chat) return
    const go = () => { const m = takeJump(chat); if (m) setTimeout(() => run.current(m), 400) } // the thread may still be loading
    go()
    addEventListener('jump-msg', go)
    return () => removeEventListener('jump-msg', go)
  }, [chat])
}

export const openSavedPanel = () => dispatchEvent(new Event('open-saved'))
export function SavedButton() {
  const n = useSaved().data?.saved.length
  return <SideNavItem label="Saved" onClick={openSavedPanel} icon={<MarkIcon />} endContent={n ? <Text type="supporting" size="sm">{String(n)}</Text> : undefined} />
}

export function SavedHost() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = () => setOpen(true)
    addEventListener('open-saved', on)
    return () => removeEventListener('open-saved', on)
  }, [])
  return open ? <SavedPanel onClose={() => setOpen(false)} /> : null
}

function SavedPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [q, setQ] = useState('')
  const saved = useSaved(q)
  const remove = useMutation({
    mutationFn: (r: Saved) => api(`/api/bookmarks?chat=${enc(r.chat)}&msg=${enc(r.msg)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bookmarks'] }), onError: (e) => toast({ body: String(e), type: 'error' }),
  })
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', key, true)
    addEventListener('hashchange', onClose)
    return () => { removeEventListener('keydown', key, true); removeEventListener('hashchange', onClose) }
  }, [onClose])
  const groups = groupSaved(saved.data?.saved ?? [])
  const go = (r: Saved) => { onClose(); if (r.open) openSaved(r); else toast({ body: 'This chat cannot be opened any more', type: 'info' }) }
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width={420} maxHeight="100dvh" padding={0} position={{ top: 0, end: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', minWidth: 0 }}>
        <VStack gap={2} padding={3}>
          <HStack justify="between" align="center">
            <Heading level={3}>Saved</Heading>
            <IconButton label="Close" icon={<CloseIcon />} size="sm" variant="ghost" onClick={onClose} />
          </HStack>
          <TextInput label="Search saved messages" isLabelHidden placeholder="Search saved" width="100%" value={q} onChange={setQ} />
        </VStack>
        <div role="region" aria-label="Saved messages" tabIndex={0} className="hd-inbox-list" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {saved.data && !groups.length && <EmptyState isCompact title={q ? 'No match' : 'Nothing saved'} description={q ? undefined : 'Bookmark a message in a room or an agent chat to keep it here.'} />}
          {groups.map((g) => (
            <div key={g.chat}>
              <div className="hd-sub">{g.label}</div>
              {g.rows.map((r) => (
                <div key={r.msg} className="hd-inbox-row" role="button" tabIndex={0} aria-label={`${r.author}: ${oneLine(r.text, 80)}`} onClick={() => go(r)} onKeyDown={(e) => e.key === 'Enter' && go(r)}>
                  <span className="hd-main">
                    <span className="hd-title"><span className="hd-trunc">{r.author}</span></span>
                    <span className="hd-body" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{oneLine(r.text, 220)}</span>
                  </span>
                  <IconButton label="Remove bookmark" icon={<CloseIcon />} size="sm" variant="ghost" onClick={(e: React.MouseEvent) => { e.stopPropagation(); remove.mutate(r) }} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

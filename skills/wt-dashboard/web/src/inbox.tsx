// Notifications inbox: a right-side panel over the feed at /api/notifications. "Needs you" (unresolved
// actionables) pinned on top, then "Recent". Opened from the sidebar bell or openInbox(kind).
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { SideNavItem } from '@astryxdesign/core/SideNav'
import { Badge } from '@astryxdesign/core/Badge'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Heading } from '@astryxdesign/core/Heading'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { useToast } from '@astryxdesign/core/Toast'
import { collapseRepeats, needsYou, groupInbox, shortAgo, type InboxGroup, type InboxItem, type InboxRow, type Kind } from './notifyGate'
import { loadPrefs } from './desktop'
import { api } from './rooms'
import { Delayed, LoadError, Rows } from './skeletons'

export const openInbox = (filter: 'all' | Kind = 'all') => dispatchEvent(new CustomEvent('open-inbox', { detail: filter }))
const LABEL: Record<Kind, string> = {
  question: 'Question', 'mention-user': '@you', 'needs-you': 'Needs you', 'room-suggestion': 'Suggestion',
  'agent-done': 'Done', 'agent-stalled': 'Stalled', 'ci-failed': 'CI', server: 'Server', usage: 'Usage', 'room-created': 'New room', memory: 'Memory', 'memory-proposal': 'Proposal', watchdog: 'Watchdog',
}

export function useInbox() {
  const q = useQuery({ queryKey: ['inbox'], queryFn: () => api<{ items: InboxItem[] }>('/api/notifications'), refetchInterval: 5000, refetchIntervalInBackground: true })
  const prefs = loadPrefs()
  const items = (q.data?.items ?? []).filter((it) => prefs.inbox[it.kind] !== false)
  return { items, loaded: Boolean(q.data), error: q.isError ? q.error : null, retry: () => q.refetch(), open: items.filter(needsYou) }
}

// Sidebar footer row: bell + needs-you count (a dot on the icon when the nav is collapsed).
export function InboxButton({ collapsed }: { collapsed: boolean }) {
  const n = useInbox().open.length
  return (
    <SideNavItem label="Inbox" onClick={() => openInbox()}
      icon={<span style={{ position: 'relative', display: 'inline-flex' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {collapsed && n > 0 && <span style={{ position: 'absolute', top: -3, right: -3 }}><StatusDot variant="error" label={`${n} need you`} /></span>}
      </span>}
      endContent={n > 0 ? <Badge variant="error" label={String(n)} /> : undefined} />
  )
}

export function InboxHost({ onOpenAgent }: { onOpenAgent: (key: string) => void }) {
  const [filter, setFilter] = useState<'all' | Kind | null>(null)
  useEffect(() => {
    const on = (e: Event) => setFilter((e as CustomEvent<'all' | Kind>).detail)
    addEventListener('open-inbox', on)
    return () => removeEventListener('open-inbox', on)
  }, [])
  if (!filter) return null
  return <InboxPanel filter={filter} setFilter={setFilter} onClose={() => setFilter(null)} onOpenAgent={onOpenAgent} />
}

const HOVER = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches
const tip = (t: string) => (HOVER ? t : undefined) // no hover tooltips on touch: they stick open after a tap
const COLOR: Record<Kind, string> = {
  question: 'var(--hd-red)', 'mention-user': 'var(--hd-red)', 'needs-you': 'var(--hd-red)', 'room-suggestion': 'var(--hd-blue)',
  'agent-done': 'var(--hd-green)', 'agent-stalled': 'var(--hd-amber)', 'ci-failed': 'var(--hd-red)', server: 'var(--hd-muted)', usage: 'var(--hd-amber)', 'room-created': 'var(--hd-blue)', memory: 'var(--hd-muted)', 'memory-proposal': 'var(--hd-blue)', watchdog: 'var(--hd-amber)',
}
const sv = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const I = {
  check: <svg {...sv}><path d="M20 6 9 17l-5-5" /></svg>,
  checkAll: <svg {...sv}><path d="M18 6 7 17l-5-5M22 10l-7.5 7.5L13 16" /></svg>,
  x: <svg {...sv}><path d="M18 6 6 18M6 6l12 12" /></svg>,
  undo: <svg {...sv}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>,
  plus: <svg {...sv}><path d="M12 5v14M5 12h14" /></svg>,
  trash: <svg {...sv}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>,
  q: <svg {...sv}><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" /></svg>,
  at: <svg {...sv}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></svg>,
  bulb: <svg {...sv}><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" /></svg>,
  clock: <svg {...sv}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>,
  server: <svg {...sv}><rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" /><path d="M6 7h.01M6 17h.01" /></svg>,
}
const ICON: Record<Kind, React.ReactNode> = {
  question: I.q, 'mention-user': I.at, 'needs-you': I.q, 'room-suggestion': I.bulb, 'agent-done': I.check,
  'agent-stalled': I.clock, 'ci-failed': I.x, server: I.server, usage: I.clock, 'room-created': I.plus, memory: I.bulb, 'memory-proposal': I.bulb, watchdog: I.server,
}

function InboxPanel({ filter, setFilter, onClose, onOpenAgent }: { filter: 'all' | Kind; setFilter: (f: 'all' | Kind) => void; onClose: () => void; onOpenAgent: (key: string) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { items, loaded, error, retry } = useInbox()
  const [confirmAll, setConfirmAll] = useState(false)
  // WP-87: the drawer closes on Escape (a real Escape never reaches the Dialog's own handler) and on page navigation,
  // so it never covers the page you went to. The clear-all confirm keeps its own Escape. Subscribed once, reading refs:
  // re-subscribing per render dropped the hashchange, because React re-renders between a real event's listeners.
  const live = useRef({ onClose, confirmAll })
  live.current = { onClose, confirmAll }
  useEffect(() => {
    const close = () => live.current.onClose()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !live.current.confirmAll) close() }
    addEventListener('keydown', key, true)
    addEventListener('hashchange', close)
    return () => { removeEventListener('keydown', key, true); removeEventListener('hashchange', close) }
  }, [])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['inbox'] }); qc.invalidateQueries({ queryKey: ['rooms'] }) }
  const post = (path: string) => (b: object) => api(`/api/notifications/${path}`, { method: 'POST', body: JSON.stringify(b) })
  const read = useMutation({ mutationFn: post('read'), onSuccess: refresh, onError: (e) => toast({ body: `Could not mark read: ${e}`, type: 'error' }) })
  const clear = useMutation({ mutationFn: post('clear'), onSuccess: refresh, onError: (e) => toast({ body: `Could not clear: ${e}`, type: 'error' }) })
  const archiveRoom = useMutation({
    mutationFn: async ({ slug, ids }: { slug: string; ids: string[] }) => { await api(`/api/rooms/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) }); await post('clear')({ ids }) },
    onSuccess: () => { refresh(); toast({ body: 'Room archived' }) },
    onError: (e) => toast({ body: `Could not archive: ${e}`, type: 'error' }),
  })
  const createRoom = useMutation({
    mutationFn: (ticket: string) => api<{ slug: string }>('/api/rooms', { method: 'POST', body: JSON.stringify({ ticket }) }),
    onSuccess: (r) => { refresh(); onClose(); location.hash = `rooms/${encodeURIComponent(r.slug)}` },
    onError: (e) => toast({ body: `Could not create the room: ${e}`, type: 'error' }),
  })
  // wt-memory entries: Undo (forget) an agent's note, Accept/Reject a global proposal. The notice is cleared after.
  const memory = useMutation({
    mutationFn: async ({ id, op, ids }: { id: string; op: 'forget' | 'accept' | 'reject'; ids: string[] }) => { await api(`/api/memory/entries/${id}/${op}`, { method: 'POST' }); await post('clear')({ ids }); return op },
    onSuccess: (op) => { refresh(); qc.invalidateQueries({ queryKey: ['memory'] }); toast({ body: op === 'forget' ? 'Forgotten' : op === 'accept' ? 'Added to global preferences' : 'Proposal rejected' }) },
    onError: (e) => toast({ body: `Memory: ${e}`, type: 'error' }),
  })
  // Watchdog `exited` (WP-109): restart the remembered session in its pane; the server refuses when that is unsafe.
  const resume = useMutation({
    mutationFn: (key: string) => api<{ message: string }>('/api/watchdog/resume', { method: 'POST', body: JSON.stringify({ key }) }),
    onSuccess: (r) => { refresh(); toast({ body: r.message }) }, onError: (e) => toast({ body: `Could not resume: ${e}`, type: 'error' }),
  })
  const dismiss = useMutation({
    mutationFn: (ticket: string) => api('/api/rooms/dismiss', { method: 'POST', body: JSON.stringify({ ticket }) }),
    onSuccess: refresh, onError: (e) => toast({ body: String(e), type: 'error' }),
  })
  const shown = items.filter((it) => filter === 'all' || it.kind === filter)
  const pinned = collapseRepeats(shown.filter(needsYou))
  const recent = groupInbox(collapseRepeats(shown.filter((it) => !needsYou(it))).slice(0, 150))
  const go = (it: InboxRow) => {
    if (it.anyUnread) read.mutate({ ids: it.ids })
    if ((it.kind === 'room-suggestion' || it.kind === 'memory-proposal') && !it.resolvedAt) return
    onClose()
    if (it.target.room) location.hash = `rooms/${encodeURIComponent(it.target.room)}`
    else if (it.target.agent) onOpenAgent(it.target.agent)
    else if (it.target.url) window.open(it.target.url, '_blank', 'noopener')
  }
  const act = (label: string, icon: React.ReactNode, f: () => void) => (
    <IconButton label={label} tooltip={tip(label)} icon={icon} size="sm" variant="ghost" onClick={(e: React.MouseEvent) => { e.stopPropagation(); f() }} />
  )
  // Inside a group the group's name is already on the header: show the event (its body, else the title without the name).
  const row = (it: InboxRow, group?: string) => {
    const own = group && it.title.startsWith(group) ? it.title.slice(group.length).replace(/^\s*\([^)]*\)/, '').trim() : null
    const title = own != null ? (it.body || own || it.title) : it.title
    const body = own != null && it.body ? null : it.body
    return (
    <div key={it.id} className={`hd-inbox-row${group ? ' hd-in-group' : ''}`} role="button" tabIndex={0} onClick={() => go(it)} onKeyDown={(e) => e.key === 'Enter' && go(it)}
      aria-label={`${LABEL[it.kind]}: ${title}${it.count > 1 ? `, ${it.count} times` : ''}${it.anyUnread ? ', unread' : ''}`}>
      <span className="hd-kind" style={{ color: COLOR[it.kind] }}>{ICON[it.kind]}</span>
      <span className="hd-main">
        <span className={`hd-title${it.anyUnread ? ' unread' : ''}`}>
          {it.anyUnread && <span className="hd-dot" />}<span className="hd-trunc">{title}</span>
          {it.count > 1 && <span className="hd-count">{`×${it.count}`}</span>}
          {it.resolvedAt && <span className="hd-count">resolved</span>}
        </span>
        {body && <span className="hd-body hd-trunc">{body}</span>}
      </span>
      <span className="hd-side">
        <span className="hd-time">{shortAgo(it.ts)}</span>
        <span className="hd-acts">
          {it.kind === 'room-suggestion' && !it.resolvedAt && act('Create room', I.plus, () => createRoom.mutate(it.target.task!))}
          {it.kind === 'room-suggestion' && !it.resolvedAt && act('Dismiss suggestion', I.x, () => dismiss.mutate(it.target.task!))}
          {it.kind === 'room-created' && it.target.room && act('Archive room', I.x, () => archiveRoom.mutate({ slug: it.target.room!, ids: it.ids }))}
          {it.kind === 'watchdog' && it.target.check === 'exited' && !it.resolvedAt && act('Resume session', I.undo, () => resume.mutate(it.target.watchdog!))}
          {it.kind === 'memory' && it.target.memory && act('Undo', I.undo, () => memory.mutate({ id: it.target.memory!, op: 'forget', ids: it.ids }))}
          {it.kind === 'memory-proposal' && !it.resolvedAt && act('Accept', I.check, () => memory.mutate({ id: it.target.memory!, op: 'accept', ids: it.ids }))}
          {it.kind === 'memory-proposal' && !it.resolvedAt && act('Reject', I.x, () => memory.mutate({ id: it.target.memory!, op: 'reject', ids: it.ids }))}
          {it.anyUnread && act('Mark read', I.check, () => read.mutate({ ids: it.ids }))}
          {!((it.kind === 'room-suggestion' || it.kind === 'memory-proposal') && !it.resolvedAt) && act('Clear', I.x, () => clear.mutate({ ids: it.ids }))}
        </span>
      </span>
    </div>
  )}
  // Several rows from one agent/room/task/memory: one header row that expands; its actions cover every row.
  const group = (g: InboxGroup) => {
    if (g.rows.length === 1) return row(g.rows[0])
    const isOpen = open.has(g.key)
    const latest = g.rows[0]
    const n = g.rows.reduce((a, r) => a + r.count, 0)
    return (
      <div key={g.key}>
        <div className="hd-inbox-row hd-group" role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => toggle(g.key)} onKeyDown={(e) => e.key === 'Enter' && toggle(g.key)}
          aria-label={`${g.label}: ${n} updates${g.unread ? `, ${g.unread} unread` : ''}`}>
          <span className="hd-kind hd-chev" data-open={isOpen} aria-hidden><svg {...sv}><path d="m9 18 6-6-6-6" /></svg></span>
          <span className="hd-main">
            <span className={`hd-title${g.unread ? ' unread' : ''}`}>
              {g.unread > 0 && <span className="hd-dot" />}<span className="hd-trunc">{g.label}</span><span className="hd-count">{`${n} updates`}</span>
            </span>
            <span className="hd-body hd-trunc">latest: {latest.title}</span>
          </span>
          <span className="hd-side">
            <span className="hd-time">{shortAgo(latest.ts)}</span>
            <span className="hd-acts">
              {g.unread > 0 && act('Mark all read', I.checkAll, () => read.mutate({ ids: g.ids }))}
              {act('Clear all', I.x, () => clear.mutate({ ids: g.ids }))}
            </span>
          </span>
        </div>
        {isOpen && g.rows.map((r) => row(r, g.label))}
      </div>
    )
  }
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width={420} maxHeight="100dvh" padding={0} position={{ top: 0, end: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', minWidth: 0 }}>
        <VStack gap={2} padding={3}>
          <HStack justify="between" align="center">
            <Heading level={3}>Inbox</Heading>
            <HStack gap={0.5}>
              <IconButton label="Mark all read" tooltip={tip('Mark all read')} icon={I.checkAll} size="sm" variant="ghost" onClick={() => read.mutate({ all: true })} />
              <DropdownMenu button={{ label: 'Clear', icon: I.trash, isIconOnly: true, size: 'sm', variant: 'ghost' }} hasChevron={false} alignment="end" items={[
                { label: 'Clear all read', onClick: () => clear.mutate({ allRead: true }) },
                { label: 'Clear all…', onClick: () => setConfirmAll(true) },
              ]} />
              <IconButton label="Close" tooltip={tip('Close (Esc)')} icon={I.x} size="sm" variant="ghost" onClick={onClose} />
            </HStack>
          </HStack>
          <div className="hd-filter" style={{ overflowX: 'auto', margin: '0 -4px', padding: '0 4px' }}>
            <SegmentedControl label="Filter" value={filter} onChange={(v) => setFilter(v as 'all' | Kind)} size="sm">
              <SegmentedControlItem value="all" label="All" />
              <SegmentedControlItem value="question" label="Questions" />
              <SegmentedControlItem value="mention-user" label="@you" />
              <SegmentedControlItem value="room-suggestion" label="Suggestions" />
              <SegmentedControlItem value="agent-done" label="Done" />
              <SegmentedControlItem value="ci-failed" label="CI" />
            </SegmentedControl>
          </div>
        </VStack>
        {/* ponytail: native scroller — ScrollableArea measured the list as fitting and stayed overflow:clip, so it never scrolled */}
        <div role="region" aria-label="Notifications" tabIndex={0} className="hd-inbox-list" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {!loaded && (error ? <LoadError what="the inbox" error={error} retry={retry} /> : <Delayed><Rows n={6} avatar={24} lines={2} height={60} /></Delayed>)}
          {loaded && !shown.length && <EmptyState isCompact title="Nothing here" description="Questions, @mentions and agent updates land here." />}
          {pinned.length > 0 && <div className="hd-sub">Needs you</div>}
          {pinned.map((r) => row(r))}
          {recent.length > 0 && <div className="hd-sub">Recent</div>}
          {recent.map(group)}
        </div>
      </div>
      <AlertDialog isOpen={confirmAll} onOpenChange={setConfirmAll} title="Clear the whole inbox?"
        description="Every item leaves the list, including ones that still need you. They stay in the log file." actionLabel="Clear all" actionVariant="destructive"
        onAction={() => { setConfirmAll(false); clear.mutate({ all: true }) }} />
    </Dialog>
  )
}

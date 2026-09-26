// The local ticket board (#board). Built on Astryx's kanban-board page template (toolbar header, muted column
// cards with a StatusDot header, pointer drag with a floating clone and a landing ghost) and its work-item-detail
// template for the ticket (breadcrumb header with inline selectors, description + activity, details rail).
// Phone (<768px): the toolbar gets a column Selector and one column fills the width; cards move from the menu or
// the ticket. API: docs/plans/local-kanban-plan.md.
// ponytail: plain CSS classes (hd-kb-*) instead of the templates' StyleX xstyle — this app has no StyleX compiler.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Layout, LayoutContent, LayoutHeader, LayoutPanel, HStack, VStack, StackItem, Card, Section } from '@astryxdesign/core/Layout'
import { Avatar } from '@astryxdesign/core/Avatar'
import { Switch } from '@astryxdesign/core/Switch'
import { Badge, type BadgeVariant } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { Divider } from '@astryxdesign/core/Divider'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Heading } from '@astryxdesign/core/Heading'
import { Link } from '@astryxdesign/core/Link'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { MoreMenu } from '@astryxdesign/core/MoreMenu'
import { Selector } from '@astryxdesign/core/Selector'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Toolbar } from '@astryxdesign/core/Toolbar'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { api } from './rooms'
import { COLUMNS, PRIORITY, SIZES, TYPES, columnLabel, group, jevChip, moveTicket, type Board as BoardT, type Column, type Ticket } from './boardData'

const send = <T,>(url: string, method: string, body: object) => api<T>(url, { method, body: JSON.stringify(body) })
const tUrl = (id: string) => `/api/tickets/${encodeURIComponent(id)}`

type Dot = 'neutral' | 'accent' | 'warning' | 'success' | 'error'
const COLUMN_META: Record<Column, { variant: Dot; tooltip: string; empty: string }> = {
  backlog: { variant: 'neutral', tooltip: 'Proposals. Not scheduled until moved to Ready.', empty: 'Filed tickets appear here.' },
  ready: { variant: 'accent', tooltip: 'Do this next: orchestrators only schedule Ready tickets.', empty: 'Move a ticket here to schedule it.' },
  planning: { variant: 'accent', tooltip: 'Claimed; a planner is writing the plan.', empty: 'Tickets being planned appear here.' },
  building: { variant: 'accent', tooltip: 'A worker is implementing it.', empty: 'Tickets being built appear here.' },
  review: { variant: 'warning', tooltip: 'Implemented; under review.', empty: 'Tickets in review appear here.' },
  done: { variant: 'success', tooltip: 'Merged and shipped.', empty: 'Finished tickets appear here.' },
  blocked: { variant: 'error', tooltip: 'Stuck; the history says why.', empty: 'Nothing is blocked.' },
}
const statusOptions = COLUMNS.map((c) => ({ value: c, label: columnLabel(c), icon: <StatusDot variant={COLUMN_META[c].variant} label={columnLabel(c)} /> }))
// Linear's scale: 1 urgent … 4 low, 0 none.
const PRIORITY_BADGE: BadgeVariant[] = ['neutral', 'error', 'warning', 'info', 'neutral']
const PriorityBadge = ({ p }: { p?: number | null }) => <Badge label={PRIORITY[p ?? 0]} variant={PRIORITY_BADGE[p ?? 0]} />

// Pointer travel (px) before a press becomes a drag, so a click still opens the ticket.
const DRAG_THRESHOLD = 5
interface DropTarget { column: Column; index: number }
interface DragState { id: string; width: number; height: number; offsetX: number; offsetY: number; pointerX: number; pointerY: number; target: DropTarget | null }

// ============= BOARD =============

export function Board({ project, phone }: { project: string; phone: boolean }) {
  const qc = useQueryClient()
  const key = ['tickets', project]
  const q = useQuery({ queryKey: key, queryFn: () => api<BoardT>(`/api/tickets?project=${encodeURIComponent(project)}`), refetchInterval: 4000, enabled: project !== 'all' })
  const [openId, setOpenId] = useState<string | null>(null) // ticket id, or 'new'
  const [blockAsk, setBlockAsk] = useState(false) // opened by a drop on Blocked: the note is required
  const [col, setCol] = useState<Column>('ready')
  const [drag, setDrag] = useState<DragState | null>(null)
  const columnEls = useRef(new Map<Column, HTMLElement>())
  const cardEls = useRef(new Map<string, HTMLElement>())
  const teardownRef = useRef<(() => void) | null>(null)
  const justDragged = useRef(false)
  // Board 'Auto' (WP-39): Jev may promote Backlog → Ready; 'Run now' triages the whole Backlog.
  const setAuto = useMutation({ mutationFn: (auto: boolean) => send('/api/tickets/board', 'PUT', { project, auto }), onSuccess: () => qc.invalidateQueries({ queryKey: key }) })
  const runNow = useMutation({ mutationFn: () => send<{ queued: number }>('/api/tickets/board/run', 'POST', { project }) })
  const move = useMutation({
    mutationFn: ({ id, to }: { id: string; to: Column }) => send(tUrl(id), 'PATCH', { column: to }),
    onMutate: async ({ id, to }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<BoardT>(key)
      if (prev) qc.setQueryData(key, moveTicket(prev, id, to))
      return { prev }
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(key, ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
  const cols = useMemo(() => group(q.data?.tickets ?? []), [q.data])
  const isDragging = drag !== null
  useEffect(() => {
    if (!isDragging) return
    const prev = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => { document.body.style.userSelect = prev }
  }, [isDragging])
  useEffect(() => () => teardownRef.current?.(), [])
  // #board/<ID> (quick switcher, links) opens that ticket; closing it drops the id so the same link works again.
  useEffect(() => {
    const on = () => { const id = decodeURIComponent(location.hash.match(/^#board\/(.+)$/)?.[1] ?? ''); if (id) { setBlockAsk(false); setOpenId(id) } }
    on()
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  if (project === 'all') return <EmptyState title="Pick a project" description="The board is per project: choose one in the sidebar." />
  if (q.isError) return <Banner status="error" title={`Board: ${q.error.message}`} />
  if (!q.data) return <Text type="supporting">Loading board…</Text>
  const tickets = q.data.tickets

  const open = (id: string) => { setBlockAsk(false); setOpenId(id) }
  const moveTo = (id: string, to: Column) => {
    if (tickets.find((t) => t.id === id)?.column === to) return
    if (to === 'blocked') { setBlockAsk(true); setOpenId(id); return } // blocked needs a reason
    move.mutate({ id, to })
  }

  // Pointer position → column + insertion index, measured without the dragged card.
  const computeTarget = (px: number, py: number, draggedId: string): DropTarget | null => {
    for (const [c, el] of columnEls.current) {
      const r = el.getBoundingClientRect()
      if (px < r.left || px > r.right || py < r.top || py > r.bottom) continue
      const ids = cols[c].filter((t) => t.id !== draggedId).map((t) => t.id)
      let index = ids.length
      for (let i = 0; i < ids.length; i++) {
        const cr = cardEls.current.get(ids[i])?.getBoundingClientRect()
        if (cr && py < cr.top + cr.height / 2) { index = i; break }
      }
      return { column: c, index }
    }
    return null
  }
  const onCardPointerDown = (e: ReactPointerEvent, id: string) => {
    if (phone || e.button !== 0 || (e.target as HTMLElement).closest('button, [role="menuitem"], [role="menu"]')) return
    const el = cardEls.current.get(id)
    if (!el) return
    const rect = el.getBoundingClientRect()
    const startX = e.clientX, startY = e.clientY
    let started = false
    let target: DropTarget | null = null
    const onMove = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return
      started = true
      target = computeTarget(ev.clientX, ev.clientY, id)
      setDrag({ id, width: rect.width, height: rect.height, offsetX: startX - rect.left, offsetY: startY - rect.top, pointerX: ev.clientX, pointerY: ev.clientY, target })
    }
    const onUp = (ev: PointerEvent) => {
      teardownRef.current?.()
      if (started) { justDragged.current = true; setTimeout(() => { justDragged.current = false }) }
      if (started && target && ev.type === 'pointerup') moveTo(id, target.column) // a cancelled pointer drops nothing
      setDrag(null)
    }
    teardownRef.current = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      teardownRef.current = null
    }
    // Capture phase: something in the page stops pointerup from bubbling to window.
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  // ponytail: the ghost shows where the pointer is; within a column the server still orders by priority, then id.
  const renderColumnCards = (c: Column): ReactNode => {
    const visible = drag ? cols[c].filter((t) => t.id !== drag.id) : cols[c]
    const ghost = drag?.target?.column === c ? drag : null
    if (!visible.length && !ghost) return null
    const nodes: ReactNode[] = visible.map((t) => (
      <BoardCard key={t.id} t={t} draggable={!phone}
        cardRef={(el) => { if (el) cardEls.current.set(t.id, el); else cardEls.current.delete(t.id) }}
        onPointerDown={onCardPointerDown} onOpen={() => { if (!justDragged.current) open(t.id) }} onMove={moveTo} />
    ))
    if (ghost?.target) nodes.splice(Math.min(ghost.target.index, nodes.length), 0, <div key="drag-ghost" className="hd-kb-ghost" style={{ height: ghost.height }} />)
    return <VStack gap={2}>{nodes}</VStack>
  }

  const dragged = drag ? tickets.find((t) => t.id === drag.id) : undefined
  const opened = openId && openId !== 'new' ? tickets.find((t) => t.id === openId) ?? null : null
  const shown = phone ? [col] : COLUMNS

  return (
    <Section className="hd-kb-page">
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={phone ? 3 : 4}>
            <Toolbar label="Board actions" gap={2} className="hd-kb-toolbar"
              startContent={phone
                ? <Selector label="Column" isLabelHidden width={200} value={col} onChange={(v: string) => setCol(v as Column)}
                    options={COLUMNS.map((c) => ({ ...statusOptions.find((o) => o.value === c)!, label: `${columnLabel(c)} (${cols[c].length})` }))} />
                : <><Heading level={3}>{project}</Heading><Badge label={String(tickets.length)} variant="neutral" /></>}
              endContent={<HStack gap={2} vAlign="center" className="hd-kb-toolbar-end">
                <Switch label="Auto" value={!!q.data.auto} isDisabled={setAuto.isPending} onChange={(on: boolean) => setAuto.mutate(on)} />
                {q.data.auto && <Button label={runNow.data ? `Queued ${runNow.data.queued}` : 'Run now'} variant="secondary" size={phone ? 'sm' : 'md'} isLoading={runNow.isPending} onClick={() => runNow.mutate()} />}
                <Button label="New ticket" variant="primary" size={phone ? 'sm' : 'md'} onClick={() => setOpenId('new')} />
              </HStack>} />
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={0}>
            {move.error && <Banner status="error" title={`Move failed: ${move.error.message}`} />}
            <HStack gap={phone ? 0 : 4} className={phone ? 'hd-kb-cols hd-kb-cols-phone' : 'hd-kb-cols'}>
              {shown.map((c) => (
                <BoardColumn key={c} c={c} count={cols[c].length}
                  contentRef={(el) => { if (el) columnEls.current.set(c, el); else columnEls.current.delete(c) }}>
                  {renderColumnCards(c)}
                </BoardColumn>
              ))}
            </HStack>
          </LayoutContent>
        }
      />
      {drag && dragged && (
        <Card padding={3} className="hd-kb-floating" style={{ width: drag.width, transform: `translate(${drag.pointerX - drag.offsetX}px, ${drag.pointerY - drag.offsetY}px)` }}>
          <BoardCardBody t={dragged} onMove={() => {}} />
        </Card>
      )}
      {openId && (
        <TicketDetail phone={phone} project={project} ticket={opened} isNew={openId === 'new'} blockAsk={blockAsk}
          onClose={() => { setOpenId(null); setBlockAsk(false); if (location.hash.startsWith('#board/')) history.replaceState(null, '', '#board') }} onCreated={(id) => setOpenId(id)} />
      )}
    </Section>
  )
}

// ============= CARD =============

// Shared by the column card and the floating drag clone so the two stay identical.
function BoardCardBody({ t, onMove }: { t: Ticket; onMove: (id: string, to: Column) => void }) {
  return (
    <VStack gap={2}>
      <HStack hAlign="between" vAlign="start">
        <HStack gap={1} vAlign="center" wrap="wrap">
          <Badge label={t.id} variant="neutral" />
          {t.priority ? <PriorityBadge p={t.priority} /> : null}
          {t.type && <Badge label={t.type} variant="neutral" />}
          {t.size && <Badge label={t.size} variant="neutral" />}
          {jevChip(t) && <Badge label="Jev" variant="info" />}
        </HStack>
        <MoreMenu label={`Actions for ${t.id}`} size="sm" alignment="end" presentation="adaptive"
          items={COLUMNS.filter((c) => c !== t.column).map((c) => ({ label: `Move to ${columnLabel(c)}`, onClick: () => onMove(t.id, c) }))} />
      </HStack>
      <VStack gap={1}>
        <Heading level={4} maxLines={3}>{t.title}</Heading>
        {t.body && <Text type="supporting" color="secondary" maxLines={2}>{t.body}</Text>}
      </VStack>
      <Text type="supporting" color="secondary">
        {t.updated ? <>Edited <Timestamp value={t.updated} format="relative" /></> : null}
        {t.updated && t.assignee ? ' · ' : ''}{t.assignee ? `@${t.assignee.name}` : ''}
      </Text>
    </VStack>
  )
}

function BoardCard({ t, draggable, cardRef, onPointerDown, onOpen, onMove }: {
  t: Ticket; draggable: boolean; cardRef: (el: HTMLDivElement | null) => void
  onPointerDown: (e: ReactPointerEvent, id: string) => void; onOpen: () => void; onMove: (id: string, to: Column) => void
}) {
  return (
    <Card ref={cardRef} padding={3} className={draggable ? 'hd-kb-card hd-kb-drag' : 'hd-kb-card'} role="button" tabIndex={0} aria-label={`${t.id}: ${t.title}`}
      onPointerDown={(e) => onPointerDown(e, t.id)} onClick={(e) => { if (!(e.target as HTMLElement).closest('button, [role="menuitem"], [role="menu"]')) onOpen() }}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}>
      <BoardCardBody t={t} onMove={onMove} />
    </Card>
  )
}

// ============= COLUMN =============

function BoardColumn({ c, count, contentRef, children }: { c: Column; count: number; contentRef: (el: HTMLDivElement | null) => void; children: ReactNode }) {
  const meta = COLUMN_META[c]
  return (
    <Card variant="muted" padding={0} className="hd-kb-col">
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={3}>
            <HStack hAlign="between" vAlign="center">
              <HStack gap={2} vAlign="center">
                <StatusDot variant={meta.variant} label={`${columnLabel(c)} status`} />
                <Tooltip content={meta.tooltip}><Heading level={4}>{columnLabel(c)}</Heading></Tooltip>
              </HStack>
              <Text type="supporting" color="secondary" hasTabularNumbers>{count}</Text>
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent ref={contentRef} padding={2}>
            {children ?? <EmptyState isCompact className="hd-kb-empty" title={`${columnLabel(c)} is empty`} description={meta.empty} />}
          </LayoutContent>
        }
      />
    </Card>
  )
}

// ============= TICKET DETAIL (work-item-detail) =============

const opts = (xs: readonly string[]) => [{ value: '', label: '—' }, ...xs.map((x) => ({ value: x, label: x }))]
const priorityOptions = PRIORITY.map((l, i) => ({ value: String(i), label: l }))

function TicketDetail({ phone, project, ticket, isNew, blockAsk, onClose, onCreated }: {
  phone: boolean; project: string; ticket: Ticket | null; isNew: boolean; blockAsk: boolean; onClose: () => void; onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['tickets', project] })
  const [editing, setEditing] = useState(isNew)
  const [draft, setDraft] = useState({ title: ticket?.title ?? '', body: ticket?.body ?? '', type: '', size: '', priority: '0' })
  const [blockTo, setBlockTo] = useState(blockAsk) // Status set to Blocked: waiting for the reason
  const [note, setNote] = useState('')
  const [comment, setComment] = useState('')
  const [railOpen, setRailOpen] = useState(true)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setDraft((d) => ({ ...d, title: ticket?.title ?? '', body: ticket?.body ?? '' })) }, [ticket?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ponytail: unset type/size are omitted (the API rejects null), so they cannot be cleared once set.
  const patch = useMutation({ mutationFn: (body: object) => send<Ticket>(tUrl(ticket!.id), 'PATCH', body), onSuccess: () => { done(); setEditing(false) } })
  const undo = useMutation({ mutationFn: (field: string) => send<Ticket>(`${tUrl(ticket!.id)}/jev-undo`, 'POST', { field }), onSuccess: done })
  const create = useMutation({
    mutationFn: () => send<Ticket>('/api/tickets', 'POST', {
      project, column: 'backlog', title: draft.title.trim(), body: draft.body, priority: Number(draft.priority),
      ...(draft.type && { type: draft.type }), ...(draft.size && { size: draft.size }),
    }),
    onSuccess: (t) => {
      // Seed the cache so the new ticket opens at once instead of flashing "not found" until the refetch.
      if (t?.id) qc.setQueryData<BoardT>(['tickets', project], (b) => (b ? { ...b, tickets: [...b.tickets, t] } : b))
      done(); if (t?.id) { setEditing(false); onCreated(t.id) } },
  })
  const block = useMutation({ mutationFn: () => send(tUrl(ticket!.id), 'PATCH', { column: 'blocked', note: note.trim() }), onSuccess: () => { setNote(''); setBlockTo(false); done() } })
  const say = useMutation({ mutationFn: () => send(`${tUrl(ticket!.id)}/comments`, 'POST', { text: comment.trim() }), onSuccess: () => { setComment(''); done() } })
  const err = patch.error ?? create.error ?? block.error ?? say.error
  const setStatus = (v: string) => { if (v === 'blocked') setBlockTo(true); else { setBlockTo(false); if (v !== ticket!.column) patch.mutate({ column: v }) } }
  const label = isNew ? 'New ticket' : ticket?.id ?? 'Ticket'

  const header = (
    <LayoutHeader padding={phone ? 4 : 6} hasDivider>
      <VStack gap={4}>
        <HStack gap={4} vAlign="start" hAlign="between">
          <VStack gap={2}>
            <HStack gap={4} vAlign="center" wrap="wrap">
              <Link href="#board" type="supporting" color="secondary" onClick={(e: React.MouseEvent) => { e.preventDefault(); onClose() }}>← Board</Link>
              <Divider orientation="vertical" className="hd-kb-rule" />
              <Text type="supporting" color="secondary">{label}</Text>
              <Divider orientation="vertical" className="hd-kb-rule" />
              <Text type="supporting" color="secondary">{project}</Text>
            </HStack>
            {editing
              ? <TextInput label="Title" isLabelHidden placeholder="Title" width="100%" value={draft.title} onChange={(v: string) => setDraft({ ...draft, title: v })} />
              : <Heading level={1} maxLines={2}>{ticket ? ticket.title : 'Ticket not found'}</Heading>}
          </VStack>
          <HStack gap={1}>
            {ticket && !phone && <Button label={railOpen ? 'Hide details' : 'Show details'} variant="secondary" size="sm" onClick={() => setRailOpen(!railOpen)} />}
            <Button label="Close" variant="ghost" size="sm" onClick={onClose} />
          </HStack>
        </HStack>
        {ticket && <HStack gap={1} vAlign="center" wrap="wrap">
          <Selector label="Status" isLabelHidden value={blockTo ? 'blocked' : ticket.column} onChange={setStatus} options={statusOptions} />
          <Selector label="Priority" isLabelHidden value={String(ticket.priority ?? 0)} onChange={(v: string) => patch.mutate({ priority: Number(v) })}
            options={priorityOptions} renderValue={(o) => <PriorityBadge p={Number(o.value)} />} />
          <Selector label="Type" isLabelHidden value={ticket.type ?? ''} onChange={(v: string) => v && patch.mutate({ type: v })} options={opts(TYPES)} />
          <Selector label="Size" isLabelHidden value={ticket.size ?? ''} onChange={(v: string) => v && patch.mutate({ size: v })} options={opts(SIZES)} />
        </HStack>}
        {ticket && blockTo && ticket.column !== 'blocked' && <HStack gap={2} vAlign="end">
          <StackItem size="fill"><TextInput label="Why is it blocked?" width="100%" value={note} onChange={setNote} placeholder="Required" /></StackItem>
          <Button label="Block" variant="primary" size="sm" isDisabled={!note.trim()} isLoading={block.isPending} onClick={() => block.mutate()} />
        </HStack>}
        {err && <Banner status="error" title={err.message} />}
      </VStack>
    </LayoutHeader>
  )

  const description = (
    <Section padding={6}>
      <VStack gap={4}>
        <HStack gap={2} vAlign="center" hAlign="between" wrap="wrap">
          <Heading level={2}>Description</Heading>
          {ticket && !editing && <Button label="Edit" onClick={() => setEditing(true)} />}
        </HStack>
        {editing ? <>
          <TextArea label="Description" isLabelHidden width="100%" rows={6} value={draft.body} onChange={(v: string) => setDraft({ ...draft, body: v })} />
          {isNew && <HStack gap={2} wrap="wrap">
            <Selector label="Type" value={draft.type} options={opts(TYPES)} onChange={(v: string) => setDraft({ ...draft, type: v })} />
            <Selector label="Size" value={draft.size} options={opts(SIZES)} onChange={(v: string) => setDraft({ ...draft, size: v })} />
            <Selector label="Priority" value={draft.priority} options={priorityOptions} onChange={(v: string) => setDraft({ ...draft, priority: v })} />
          </HStack>}
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={() => (isNew ? onClose() : setEditing(false))} />
            <Button label={isNew ? 'Create' : 'Save'} variant="primary" isDisabled={!draft.title.trim()} isLoading={patch.isPending || create.isPending}
              onClick={() => (isNew ? create.mutate() : patch.mutate({ title: draft.title.trim(), body: draft.body }))} />
          </HStack>
        </> : <Text type="body" style={{ whiteSpace: 'pre-wrap' }}>{ticket?.body || <Text type="supporting" color="secondary">No description.</Text>}</Text>}
      </VStack>
    </Section>
  )

  const activity = ticket && (
    <Section padding={6}>
      <VStack gap={phone ? 6 : 10}>
        <HStack gap={2} vAlign="center" hAlign="between" wrap="wrap">
          <Heading level={2}>Comments and activity</Heading>
          <Button label="Add comment" onClick={() => { commentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); commentRef.current?.focus({ preventScroll: true }) }} />
        </HStack>
        <VStack gap={6}>
          {(ticket.history ?? []).map((h, i) => {
            const isComment = h.kind === 'comment'
            const what = h.kind === 'move' ? `moved ${h.from ?? ''} → ${h.to ?? ''}` : h.kind === 'create' ? 'created this ticket' : h.kind === 'assign' ? `assigned ${h.to ?? 'nobody'}` : 'edited'
            return (
              <HStack key={i} gap={3} vAlign="start">
                <Avatar name={h.author} size="sm" />
                <StackItem size="fill">
                  <VStack gap={1}>
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <Text type="body" weight="semibold">{h.author}</Text>
                      {!isComment && <Text type="supporting" color="secondary">{what}</Text>}
                      <StackItem size="fill" />
                      <Timestamp value={h.at} format="relative" type="supporting" color="secondary" />
                    </HStack>
                    {h.text && <Card variant="muted" padding={3}><Text type="body" style={{ whiteSpace: 'pre-wrap' }}>{h.text}</Text></Card>}
                  </VStack>
                </StackItem>
              </HStack>
            )
          })}
        </VStack>
        <VStack gap={2} hAlign="stretch">
          <TextArea ref={commentRef} width="100%" label="Add a comment" isLabelHidden placeholder="Write a comment…" value={comment} onChange={setComment} rows={phone ? 3 : 5} />
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" isDisabled={!comment} onClick={() => setComment('')} />
            <Button label="Comment" variant="primary" isDisabled={!comment.trim()} isLoading={say.isPending} onClick={() => say.mutate()} />
          </HStack>
        </VStack>
      </VStack>
    </Section>
  )

  const details = ticket && (
    <VStack gap={4}>
      <Heading level={3}>Details</Heading>
      <MetadataList>
        <MetadataListItem label="Status">
          <HStack gap={2} vAlign="center"><StatusDot variant={COLUMN_META[ticket.column].variant} label={columnLabel(ticket.column)} /><Text type="body">{columnLabel(ticket.column)}</Text></HStack>
        </MetadataListItem>
        <MetadataListItem label="Priority"><PriorityBadge p={ticket.priority} /></MetadataListItem>
        <MetadataListItem label="Assignee">
          {ticket.assignee ? <HStack gap={2} vAlign="center"><Avatar name={ticket.assignee.name} size="xsm" /><Text type="body">{ticket.assignee.name}</Text></HStack> : <Text type="body" color="secondary">None</Text>}
        </MetadataListItem>
        <MetadataListItem label="Type"><Text type="body">{ticket.type ?? '—'}</Text></MetadataListItem>
        <MetadataListItem label="Size"><Text type="body">{ticket.size ?? '—'}</Text></MetadataListItem>
        {ticket.created && <MetadataListItem label="Created"><Timestamp value={ticket.created} format="date" type="body" color="primary" /></MetadataListItem>}
        {ticket.updated && <MetadataListItem label="Updated"><Timestamp value={ticket.updated} format="relative" type="body" color="primary" /></MetadataListItem>}
        {!!ticket.labels?.length && <MetadataListItem label="Labels"><HStack gap={1} wrap="wrap">{ticket.labels.map((l) => <Badge key={l} label={l} variant="neutral" />)}</HStack></MetadataListItem>}
        {ticket.jev && (jevChip(ticket) || ticket.jev.owner) && <MetadataListItem label="Jev">
          <VStack gap={1}>
            {Object.entries(ticket.jev.applied).map(([f, a]) => (
              <HStack key={f} gap={2} vAlign="center">
                <Text type="body">{f === 'column' ? 'Jev auto-promoted to Ready' : `Jev suggested ${f} ${f === 'priority' ? PRIORITY[Number(a.to)] : String(a.to)}`}</Text>
                <Button label="Undo" variant="ghost" size="sm" isLoading={undo.isPending && undo.variables === f} onClick={() => undo.mutate(f)} />
              </HStack>
            ))}
            {ticket.jev.owner && <Text type="body" color="secondary">{ticket.jev.owner === 'planner' ? 'Jev: needs a plan' : 'Jev: worker-ready'}</Text>}
            {ticket.jev.dupes.map((d) => <Link key={d} href="#" onClick={(e: React.MouseEvent) => { e.preventDefault(); onCreated(d) }}>Possible duplicate of {d}</Link>)}
          </VStack>
        </MetadataListItem>}
        {!!ticket.links?.length && <MetadataListItem label="Links"><VStack gap={1}>{ticket.links.map((l) => <Link key={l} href={l} target="_blank">{l}</Link>)}</VStack></MetadataListItem>}
      </MetadataList>
    </VStack>
  )

  const page = (
    <Layout
      height="fill"
      header={header}
      content={
        <LayoutContent padding={phone ? 4 : 6} role="main">
          <VStack gap={6}>
            {description}
            {/* ponytail: on a phone the details sit inline instead of in a second fullscreen dialog. */}
            {phone && details && <><Divider /><Section padding={6}>{details}</Section></>}
            {activity && <><Divider />{activity}</>}
          </VStack>
        </LayoutContent>
      }
      end={!phone && ticket && railOpen ? <LayoutPanel width={300} padding={6} role="complementary" hasDivider>{details}</LayoutPanel> : undefined}
    />
  )
  return phone
    ? <Dialog isOpen onOpenChange={(o: boolean) => !o && onClose()} variant="fullscreen" padding={0} aria-label={label}><div className="hd-kb-detail hd-kb-detail-phone">{page}</div></Dialog>
    : <Dialog isOpen onOpenChange={(o: boolean) => !o && onClose()} width={1080} padding={0} aria-label={label}><div className="hd-kb-detail">{page}</div></Dialog>
}

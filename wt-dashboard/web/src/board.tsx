// The local ticket board on Tasks (#tasks/board). Desktop: 7 columns, native HTML5 drag and drop.
// Phone (<768px): a column switcher and one list; cards move from the fullscreen drawer. API: docs/plans/local-kanban-plan.md.
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack } from '@astryxdesign/core/HStack'
import { Heading } from '@astryxdesign/core/Heading'
import { Selector } from '@astryxdesign/core/Selector'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { VStack } from '@astryxdesign/core/VStack'
import { api } from './rooms'
import { COLUMNS, PRIORITY, SIZES, TYPES, columnLabel, group, moveTicket, type Board as BoardT, type Column, type Ticket } from './boardData'

const send = <T,>(url: string, method: string, body: object) => api<T>(url, { method, body: JSON.stringify(body) })
const tUrl = (id: string) => `/api/tickets/${encodeURIComponent(id)}`

export function Board({ project, phone }: { project: string; phone: boolean }) {
  const qc = useQueryClient()
  const key = ['tickets', project]
  const q = useQuery({ queryKey: key, queryFn: () => api<BoardT>(`/api/tickets?project=${encodeURIComponent(project)}`), refetchInterval: 4000, enabled: project !== 'all' })
  const [openId, setOpenId] = useState<string | null>(null) // ticket id, or 'new'
  const [blockAsk, setBlockAsk] = useState(false) // opened by a drop on Blocked: the note is required
  const [col, setCol] = useState<Column>('ready')
  const [over, setOver] = useState<Column | null>(null)
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

  if (project === 'all') return <EmptyState title="Pick a project" description="The board is per project: choose one in the sidebar." />
  if (q.isError) return <Banner status="error" title={`Board: ${q.error.message}`} />
  if (!q.data) return <Text type="supporting">Loading board…</Text>
  const cols = group(q.data.tickets)
  const drop = (to: Column, id: string) => {
    setOver(null)
    if (!id || q.data!.tickets.find((t) => t.id === id)?.column === to) return
    if (to === 'blocked') { setBlockAsk(true); setOpenId(id); return } // blocked needs a reason
    move.mutate({ id, to })
  }
  const card = (t: Ticket) => <Card key={t.id} t={t} draggable={!phone} onOpen={() => { setBlockAsk(false); setOpenId(t.id) }} />
  const newBtn = <Button label="New ticket" size="sm" variant="ghost" onClick={() => setOpenId('new')} />
  const opened = openId && openId !== 'new' ? q.data.tickets.find((t) => t.id === openId) ?? null : null

  return (
    <VStack gap={3}>
      {move.error && <Banner status="error" title={`Move failed: ${move.error.message}`} />}
      {phone ? (
        <>
          <HStack gap={2} align="end">
            <div style={{ flex: 1, minWidth: 0 }}>
              <Selector label="Column" width="100%" value={col} onChange={(v: string) => setCol(v as Column)}
                options={COLUMNS.map((c) => ({ value: c, label: `${columnLabel(c)} (${cols[c].length})` }))} />
            </div>
            {newBtn}
          </HStack>
          <div className="hd-kb-list">{cols[col].length ? cols[col].map(card) : <Text type="supporting" size="sm">No tickets in {columnLabel(col)}.</Text>}</div>
        </>
      ) : (
        <div className="hd-kb">
          {COLUMNS.map((c) => (
            <section key={c} className={`hd-kb-col${over === c ? ' hd-kb-over' : ''}`} aria-label={columnLabel(c)}
              onDragOver={(e) => { e.preventDefault(); if (over !== c) setOver(c) }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) }}
              onDrop={(e) => { e.preventDefault(); drop(c, e.dataTransfer.getData('text/plain')) }}>
              <HStack justify="between" align="center" gap={1}>
                <Heading level={4}>{columnLabel(c)} <Text type="supporting" size="sm">{cols[c].length}</Text></Heading>
                {c === 'backlog' && newBtn}
              </HStack>
              <div className="hd-kb-cards">{cols[c].map(card)}</div>
            </section>
          ))}
        </div>
      )}
      {openId && (
        <Drawer phone={phone} project={project} ticket={opened} isNew={openId === 'new'} blockAsk={blockAsk}
          onClose={() => { setOpenId(null); setBlockAsk(false) }} onCreated={(id) => setOpenId(id)} />
      )}
    </VStack>
  )
}

function Card({ t, draggable, onOpen }: { t: Ticket; draggable: boolean; onOpen: () => void }) {
  return (
    <button type="button" className="hd-kb-card" draggable={draggable} onClick={onOpen}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move' }}>
      <Text type="supporting" size="sm">{t.id}</Text>
      <Text weight="semibold" maxLines={3}>{t.title}</Text>
      <span className="hd-kb-meta">
        {t.type && <Badge label={t.type} />}
        {t.size && <Badge label={t.size} />}
        {t.priority ? <Badge label={`P${t.priority}`} variant={t.priority <= 2 ? 'warning' : undefined} /> : null}
        {t.assignee && <Text type="supporting" size="sm">@{t.assignee.name}</Text>}
      </span>
    </button>
  )
}

const opts = (xs: readonly string[]) => [{ value: '', label: '—' }, ...xs.map((x) => ({ value: x, label: x }))]

function Drawer({ phone, project, ticket, isNew, blockAsk, onClose, onCreated }: {
  phone: boolean; project: string; ticket: Ticket | null; isNew: boolean; blockAsk: boolean; onClose: () => void; onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  const blank = { title: '', body: '', type: '', size: '', priority: '0' }
  const fromT = (t: Ticket) => ({ title: t.title, body: t.body ?? '', type: t.type ?? '', size: t.size ?? '', priority: String(t.priority ?? 0) })
  const [f, setF] = useState(ticket ? fromT(ticket) : blank)
  const [to, setTo] = useState<string>(blockAsk ? 'blocked' : ticket?.column ?? 'backlog')
  const [note, setNote] = useState('')
  const [comment, setComment] = useState('')
  useEffect(() => { if (ticket) setF(fromT(ticket)) }, [ticket?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => qc.invalidateQueries({ queryKey: ['tickets', project] })
  // ponytail: unset type/size are omitted (the API rejects null), so the drawer cannot clear them once set.
  const fields = () => ({ title: f.title.trim(), body: f.body, priority: Number(f.priority), ...(f.type && { type: f.type }), ...(f.size && { size: f.size }) })
  const save = useMutation({
    mutationFn: () => isNew
      ? send<Ticket>('/api/tickets', 'POST', { project, ...fields(), column: 'backlog' })
      : send<Ticket>(tUrl(ticket!.id), 'PATCH', fields()),
    onSuccess: (t) => { done(); if (isNew && t?.id) onCreated(t.id) },
  })
  const move = useMutation({ mutationFn: () => send(tUrl(ticket!.id), 'PATCH', { column: to, ...(note.trim() ? { note: note.trim() } : {}) }), onSuccess: () => { setNote(''); done() } })
  const say = useMutation({ mutationFn: () => send(`${tUrl(ticket!.id)}/comments`, 'POST', { text: comment.trim() }), onSuccess: () => { setComment(''); done() } })
  const dirty = ticket ? JSON.stringify(f) !== JSON.stringify(fromT(ticket)) : f.title.trim() !== ''
  const err = save.error ?? move.error ?? say.error

  const body = (
    <VStack gap={3} className="hd-kb-drawer">
      <HStack justify="between" align="center" gap={2}>
        <Heading level={3}>{isNew ? 'New ticket' : ticket ? ticket.id : 'Ticket not found'}</Heading>
        <Button label="Close" size="sm" variant="ghost" onClick={onClose} />
      </HStack>
      {err && <Banner status="error" title={err.message} />}
      {(isNew || ticket) && <>
        <TextInput label="Title" value={f.title} onChange={(v: string) => setF({ ...f, title: v })} />
        <TextArea label="Description" rows={4} value={f.body} onChange={(v: string) => setF({ ...f, body: v })} />
        <div className="hd-kb-fields">
          <Selector label="Type" width="100%" value={f.type} options={opts(TYPES)} onChange={(v: string) => setF({ ...f, type: v })} />
          <Selector label="Size" width="100%" value={f.size} options={opts(SIZES)} onChange={(v: string) => setF({ ...f, size: v })} />
          <Selector label="Priority" width="100%" value={f.priority} options={PRIORITY.map((l, i) => ({ value: String(i), label: l }))} onChange={(v: string) => setF({ ...f, priority: v })} />
        </div>
        <HStack justify="end"><Button label={isNew ? 'Create' : 'Save'} size="sm" variant="primary" isDisabled={!dirty || !f.title.trim()} isLoading={save.isPending} onClick={() => save.mutate()} /></HStack>
      </>}
      {ticket && <>
        <Text size="sm" type="supporting">Assignee: {ticket.assignee ? ticket.assignee.name : 'none'}</Text>
        <HStack gap={2} align="end">
          <div style={{ flex: 1, minWidth: 0 }}>
            <Selector label="Move to" width="100%" value={to} onChange={setTo} options={COLUMNS.map((c) => ({ value: c, label: columnLabel(c) }))} />
          </div>
          <Button label="Move" size="sm" variant="primary" isLoading={move.isPending}
            isDisabled={to === ticket.column || (to === 'blocked' && !note.trim())} onClick={() => move.mutate()} />
        </HStack>
        {to === 'blocked' && to !== ticket.column && <TextInput label="Why is it blocked?" value={note} onChange={setNote} placeholder="Required" />}
        <Heading level={4}>History</Heading>
        <VStack gap={2}>
          {(ticket.history ?? []).slice().reverse().map((h, i) => (
            <div key={i} className="hd-kb-hist">
              <Text size="sm"><b>{h.author}</b> {h.kind === 'move' ? `moved ${h.from ?? ''} → ${h.to ?? ''}` : h.kind === 'comment' ? '' : h.kind}
                {' '}<Text type="supporting" size="sm"><Timestamp value={h.at} format="relative" /></Text></Text>
              {h.text && <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{h.text}</Text>}
            </div>
          ))}
        </VStack>
        <TextArea label="Comment" rows={2} value={comment} onChange={setComment} placeholder="Add a comment…" />
        <HStack justify="end"><Button label="Comment" size="sm" isDisabled={!comment.trim()} isLoading={say.isPending} onClick={() => say.mutate()} /></HStack>
      </>}
    </VStack>
  )
  const label = isNew ? 'New ticket' : ticket?.id ?? 'Ticket'
  // Phone: fullscreen Dialog, like Settings — a Selector popover does not open inside a BottomSheet.
  return phone
    ? <Dialog isOpen onOpenChange={(o: boolean) => !o && onClose()} variant="fullscreen" aria-label={label}><div className="hd-kb-sheet">{body}</div></Dialog>
    : <Dialog isOpen onOpenChange={(o: boolean) => !o && onClose()} width={640} aria-label={label}>{body}</Dialog>
}

// WP-93: ticket id chips in rooms and agent chat (rendered view only; the stored text stays plain). A board id is
// fetched lazily and cached per id; unknown or still loading stays plain text. Tap opens it on the Board (App
// listens for wt:open-ticket, which switches the project); hover or long-press shows the title.
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Token } from '@astryxdesign/core/Token'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import type { MarkdownInlinePlugin } from '@astryxdesign/core/Markdown'
import { api } from './rooms'
import { COLUMN_META } from './board'
import { columnLabel, type Ticket } from './boardData'
import { linkClick } from './links'
import { ticketPlugin, type Ref, type TicketRefs } from './ticketRefs'

function BoardChip({ id, project }: { id: string; project: string }) {
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api<Ticket>(`/api/tickets/${encodeURIComponent(id)}`), staleTime: 60_000, retry: false })
  const t = q.data
  if (!t?.id) return <>{id}</>
  const open = () => dispatchEvent(new CustomEvent('wt:open-ticket', { detail: { project, id } }))
  return (
    <Tooltip content={t.title}>
      <Token size="sm" label={`${id} · ${t.column}`} icon={<StatusDot variant={COLUMN_META[t.column]?.variant ?? 'neutral'} label={columnLabel(t.column)} />} onClick={open} />
    </Tooltip>
  )
}

const chip = (ref: Ref, key: string) => ref.kind === 'board'
  ? <BoardChip key={key} id={ref.id} project={ref.project} />
  : <Token key={key} size="sm" label={ref.id} href={ref.url} onClick={(e) => { e.preventDefault(); if (linkClick(ref.url, e) !== false) window.open(ref.url, '_blank', 'noopener') }} />

export function useTicketPlugins(): MarkdownInlinePlugin[] {
  const q = useQuery({ queryKey: ['ticket-refs'], queryFn: () => api<TicketRefs>('/api/tickets/refs'), staleTime: 5 * 60_000 })
  return useMemo(() => { const p = ticketPlugin(q.data, chip); return p ? [p] : [] }, [q.data])
}

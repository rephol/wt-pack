// WP-230: a ticket chip, the quick switcher or a task row opens the ticket as a modal over the current page (any
// project, full actions) instead of navigating to Board. State is ?ticket=<ID>: opening pushes it, Back (or
// Close) drops it, and a shared link opens the modal on load.
import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './rooms'
import { TicketDetail } from './board'
import type { Ticket } from './boardData'
import { ticketFromSearch, withTicket } from './ticketParam'
import type { TicketRefs } from './ticketRefs'

export function TicketModal({ phone }: { phone: boolean }) {
  const [id, setId] = useState(() => ticketFromSearch(location.search))
  useEffect(() => {
    const sync = () => setId(ticketFromSearch(location.search))
    const open = (e: Event) => {
      const next = (e as CustomEvent<{ id: string }>).detail.id
      history.pushState({ wtTicket: true }, '', withTicket(location.href, next))
      setId(next)
    }
    addEventListener('popstate', sync)
    addEventListener('wt:open-ticket', open)
    return () => { removeEventListener('popstate', sync); removeEventListener('wt:open-ticket', open) }
  }, [])
  // Back when we pushed the entry (so forward reopens it); a deep link has nothing to go back to.
  const close = useCallback(() => {
    if (history.state?.wtTicket) history.back()
    else { history.replaceState(history.state, '', withTicket(location.href, null)); setId(null) }
  }, [])

  const refs = useQuery({ queryKey: ['ticket-refs'], queryFn: () => api<TicketRefs>('/api/tickets/refs'), staleTime: 5 * 60_000, enabled: Boolean(id) })
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api<Ticket>(`/api/tickets/${encodeURIComponent(id!)}`), enabled: Boolean(id), refetchInterval: 4000, retry: false })
  if (!id) return null
  const project = refs.data?.boards[id.replace(/-\d+$/, '')] ?? ''
  if (!q.data && q.isLoading) return null
  return <TicketDetail phone={phone} project={project} ticket={q.data?.id ? q.data : null} isNew={false} blockAsk={false} backLabel="Close" onClose={close} onCreated={() => {}} />
}

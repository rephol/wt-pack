// WP-230: the open ticket modal lives in the URL as ?ticket=<ID>, so it is shareable and Back closes it.
export const ticketFromSearch = (search: string): string | null => new URLSearchParams(search).get('ticket') || null

// The URL with ?ticket set (or dropped); other params and the hash are kept.
export function withTicket(href: string, id: string | null): string {
  const u = new URL(href)
  if (id) u.searchParams.set('ticket', id); else u.searchParams.delete('ticket')
  return u.pathname + u.search + u.hash
}

// What a chip, the switcher or a task row calls: App's TicketModal listens (no navigation, whatever the page).
export const openTicket = (id: string, project?: string) => dispatchEvent(new CustomEvent('wt:open-ticket', { detail: { id, project } }))

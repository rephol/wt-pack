// WP-253: one EventSource on /api/changes per window. An event says what changed (tickets | inbox | rooms); the page
// refetches it through the existing queries. The browser reconnects by itself and sends Last-Event-ID, so the server
// replays exactly what was missed, or sends `reset` (a restart or a long gap): refetch all three. The polling intervals
// stay as a slow fallback (POLL_FALLBACK_MS) for a stream that never connects.
import { useEffect } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

export const POLL_FALLBACK_MS = 60_000
const KEYS: Record<string, string[][]> = { tickets: [['tickets'], ['ticket']], inbox: [['inbox']], rooms: [['rooms']] }

export function invalidateFor(qc: QueryClient, topic: string | null) {
  for (const k of topic ? (KEYS[topic] ?? []) : Object.values(KEYS).flat()) void qc.invalidateQueries({ queryKey: k })
}

export function useChangeStream() {
  const qc = useQueryClient()
  useEffect(() => {
    let es: EventSource | null = null
    const open = () => {
      es?.close()
      es = new EventSource('/api/changes')
      es.addEventListener('change', (m) => { try { invalidateFor(qc, (JSON.parse((m as MessageEvent).data) as { topic?: string }).topic ?? null) } catch { invalidateFor(qc, null) } })
      es.addEventListener('reset', () => invalidateFor(qc, null))
    }
    // iOS Safari kills an EventSource in the background and does not retry it: recreate a CLOSED one on return.
    const visible = () => { if (document.visibilityState === 'visible' && (!es || es.readyState === EventSource.CLOSED)) open() }
    open()
    document.addEventListener('visibilitychange', visible)
    return () => { document.removeEventListener('visibilitychange', visible); es?.close() }
  }, [qc])
}

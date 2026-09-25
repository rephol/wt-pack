// Desktop (Tauri) glue: relays the server's /api/events stream to the native side (tray + notifications)
// and opens an agent when the tray or a notification asks. No-op in a plain browser.
import { useEffect, useRef } from 'react'
import { gate, DEFAULT_PREFS, type Prefs, type InboxItem } from './notifyGate'

type TauriEvent = { emit: (n: string, p?: unknown) => Promise<void>; listen: (n: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> }
const tauri = (window as unknown as { __TAURI__?: { event: TauriEvent } }).__TAURI__
export const isDesktop = Boolean(tauri)

export const PREFS_KEY = 'notify-prefs-v2'
export const loadPrefs = (): Prefs => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return { inbox: { ...DEFAULT_PREFS.inbox, ...p.inbox }, native: { ...DEFAULT_PREFS.native, ...p.native } }
  } catch { return structuredClone(DEFAULT_PREFS) }
}

export function useDesktop(openKey: string | null, open: (key: string) => void) {
  const ref = useRef({ openKey, open })
  ref.current = { openKey, open }
  useEffect(() => {
    if (!tauri) return
    const seen = new Set<string>()
    const lastAt = new Map<string, number>()
    // macOS can't report a notification click to us; clicking one activates the app, so a focus
    // shortly after a notification posted while we were in the background opens that agent.
    let pending: { key: string; at: number } | null = null
    const es = new EventSource('/api/events')
    es.addEventListener('tray', (m) => { tauri.event.emit('tray', JSON.parse((m as MessageEvent).data)) })
    let build: number | null = null
    es.addEventListener('build', (m) => {
      const b = JSON.parse((m as MessageEvent).data) as number
      if (build !== null && b !== build) location.reload()
      build = b
    })
    es.addEventListener('notification', (m) => {
      const e = JSON.parse((m as MessageEvent).data) as InboxItem
      const focused = document.hasFocus()
      if (!gate(e, { prefs: loadPrefs(), focused, openKey: ref.current.openKey, seen, lastAt, now: Date.now() })) return
      tauri.event.emit('notify', { title: e.title, body: (e.body ?? '').slice(0, 200) || ' ' })
      const target = e.target.agent ?? (e.target.room ? `room:${e.target.room}` : null)
      if (target && !focused) pending = { key: target, at: Date.now() }
    })
    const onFocus = () => { if (pending && Date.now() - pending.at < 60_000) ref.current.open(pending.key); pending = null }
    addEventListener('focus', onFocus)
    const un = tauri.event.listen('open-agent', (e) => { pending = null; ref.current.open(String(e.payload)) })
    return () => { es.close(); removeEventListener('focus', onFocus); un.then((f) => f()) }
  }, [])
}


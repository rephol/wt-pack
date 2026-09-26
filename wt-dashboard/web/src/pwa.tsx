// Installable web app: registers /sw.js, keeps the browser's install prompt for an "Install app" button, shows
// UpdateBanner when a new build's worker takes over, and a one-time install hint on phones
// (iOS Safari has no prompt: it gets Share → Add to Home Screen instead). Not in the desktop app.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'

type Prompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: Prompt | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
const isApp = '__TAURI_INTERNALS__' in window
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window)

export function registerPwa() {
  if (isApp || !('serviceWorker' in navigator) || !isSecureContext) return
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as Prompt; emit() })
  addEventListener('appinstalled', () => { deferred = null; emit() })
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.error('service worker', e))
}

export function useInstall() {
  const prompt = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => deferred)
  const install = async () => {
    if (!deferred) return
    await deferred.prompt()
    await deferred.userChoice.catch(() => null)
    deferred = null; emit()
  }
  return { canInstall: Boolean(prompt) && !isStandalone(), install, installed: isStandalone(), ios: isIOS() && !isStandalone() }
}

// A new web build (desktop: /api/events build id; browser: new service worker) never reloads under the user: it
// applies itself while the window is hidden (drafts are kept in sessionStorage), else UpdateBanner offers Reload
// with the commit subjects since the loaded build, until reloaded or dismissed (per build) — WP-55.
type Update = { build: number | null; changes: string[] }
let loaded: number | null = null
let update: Update | null = null
const usubs = new Set<() => void>()
const DISMISS_KEY = 'hd-update-dismissed'
const tauriEmit = (window as unknown as { __TAURI__?: { event: { emit: (n: string, p?: unknown) => Promise<void> } } }).__TAURI__?.event.emit
const setUpdate = (u: Update | null) => { update = u; usubs.forEach((f) => f()); tauriEmit?.('update', Boolean(u)).catch(() => {}) }
const getBuild = (since?: number | null) => fetch(`/api/build${since ? `?since=${since}` : ''}`).then((r) => r.json() as Promise<Update>)
getBuild().then((b) => { loaded = b.build }, () => {})
tauriEmit?.('update', false).catch(() => {}) // a fresh page clears the Dock/tray dot

// Mounted once in App: update detection, and the "Needs you" shortcut (#inbox opens the inbox on Overview).
export function PwaHost({ openInbox }: { openInbox: () => void }) {
  useEffect(() => {
    if (location.hash === '#inbox') { history.replaceState(null, '', '#overview'); dispatchEvent(new HashChangeEvent('hashchange')); openInbox() }
    let pending = false
    const hidden = () => { if (pending && document.hidden) location.reload() }
    const onUpdate = async () => {
      pending = true
      if (document.hidden) return location.reload()
      // Every build refetches: the banner shows the newest build and all changes since the loaded one.
      const u = await getBuild(loaded).catch(() => ({ build: null, changes: [] }))
      let dismissed = null
      try { dismissed = localStorage.getItem(DISMISS_KEY) } catch { /* private mode */ }
      if (u.build === null || dismissed !== String(u.build)) setUpdate(u)
    }
    document.addEventListener('visibilitychange', hidden)
    addEventListener('hd-update', onUpdate)
    const sw = !isApp && 'serviceWorker' in navigator ? navigator.serviceWorker : null
    const had = Boolean(sw?.controller)
    const on = () => { if (had) onUpdate() }
    sw?.addEventListener('controllerchange', on)
    return () => { document.removeEventListener('visibilitychange', hidden); removeEventListener('hd-update', onUpdate); sw?.removeEventListener('controllerchange', on) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

// Under the header on every page.
export function UpdateBanner() {
  const u = useSyncExternalStore((f) => { usubs.add(f); return () => usubs.delete(f) }, () => update)
  if (!u) return null
  const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, String(u.build)) } catch { /* private mode */ } setUpdate(null) }
  const changes = u.changes.map((c) => c.replace(/^wt-dashboard: /, ''))
  return (
    <Banner status="info" title="New version available" isDismissable onDismiss={dismiss}
      description={changes.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{changes.map((c, i) => <li key={i}>{c}</li>)}</ul> : undefined}
      endContent={<Button label="Reload" size="sm" variant="primary" onClick={() => location.reload()} />} />
  )
}

const HINT_KEY = 'pwa-hint-dismissed'
export function InstallHint({ phone }: { phone: boolean }) {
  const { canInstall, install, ios } = useInstall()
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HINT_KEY) === '1' } catch { return true } })
  if (!phone || hidden || isApp || (!canInstall && !ios)) return null
  const dismiss = () => { setHidden(true); try { localStorage.setItem(HINT_KEY, '1') } catch { /* private mode */ } }
  return (
    <Banner status="info" title="Install wt-dashboard" isDismissable onDismiss={dismiss}
      description={ios ? 'Tap Share, then “Add to Home Screen”.' : 'Open it from your home screen, full screen, like an app.'}
      endContent={canInstall ? <Button label="Install" size="sm" variant="primary" onClick={() => install().then(dismiss)} /> : undefined} />
  )
}

// Settings › About
export function InstallRow() {
  const { canInstall, install, installed, ios } = useInstall()
  if (isApp) return null
  if (installed) return <Text type="supporting" size="sm">Running as an installed app.</Text>
  if (canInstall) return <Button label="Install app" size="sm" onClick={install} />
  if (ios) return <Text type="supporting" size="sm">To install: Share → Add to Home Screen.</Text>
  return <Text type="supporting" size="sm">{isSecureContext ? 'Install: use the browser menu (⋮ → Install app / Add to Home screen).' : 'Install needs https (the tailnet URL) or 127.0.0.1.'}</Text>
}

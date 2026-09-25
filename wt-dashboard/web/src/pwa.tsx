// Installable web app: registers /sw.js, keeps the browser's install prompt for an "Install app" button, shows
// "Update available — reload" when a new build's worker takes over, and a one-time install hint on phones
// (iOS Safari has no prompt: it gets Share → Add to Home Screen instead). Not in the desktop app.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import { useToast } from '@astryxdesign/core/Toast'

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

// Mounted once in App: the update toast, and the "Needs you" shortcut (#inbox opens the inbox on Overview).
export function PwaHost({ openInbox }: { openInbox: () => void }) {
  const toast = useToast()
  useEffect(() => {
    if (location.hash === '#inbox') { history.replaceState(null, '', '#overview'); dispatchEvent(new HashChangeEvent('hashchange')); openInbox() }
    if (isApp || !('serviceWorker' in navigator)) return
    const had = Boolean(navigator.serviceWorker.controller)
    const on = () => { if (had) toast({ body: 'Update available — reload to use the new version', type: 'info' }) }
    navigator.serviceWorker.addEventListener('controllerchange', on)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', on)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
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

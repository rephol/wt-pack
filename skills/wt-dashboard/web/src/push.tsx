// WP-268 Web Push, the browser side: this device's subscription (permission asked on click only), the per-kind
// "Phone" switches (stored on the server per device, push.mjs) and the device list. Not in the desktop app (native).
import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { api } from './rooms'
import { isIOS, isStandalone } from './pwa'
import { isDesktop } from './desktop'
import { SettingsCard, SettingsRow } from './settingsRows'
import { shortAgo, type Kind } from './notifyGate'
import { pushState, PUSH_HINT, deviceLabel, keyBytes } from './pushState'

export interface PushDevice { id: string; label: string; kinds: Record<Kind, boolean>; created: string; lastOk: string | null }
const ID_KEY = 'push-device-id' // which server row is this browser's (per-browser, so localStorage is the right place)
const readId = () => { try { return localStorage.getItem(ID_KEY) } catch { return null } }
const writeId = (id: string | null) => { try { if (id) localStorage.setItem(ID_KEY, id); else localStorage.removeItem(ID_KEY) } catch { /* private mode: the device shows as not enabled next load */ } }
const same = (a: ArrayBuffer | null, b: Uint8Array) => a !== null && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i])

export function usePush() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['push'], queryFn: () => api<{ publicKey: string; devices: PushDevice[] }>('/api/push'), enabled: !isDesktop })
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const [permission, setPermission] = useState<NotificationPermission | 'none'>('Notification' in window ? Notification.permission : 'none')
  const [browserSub, setBrowserSub] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refreshSub = useCallback(async () => {
    if (!supported) return
    try { setBrowserSub(Boolean(await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription())) } catch { setBrowserSub(false) }
  }, [supported])
  useEffect(() => { void refreshSub() }, [refreshSub])

  const mine = q.data?.devices.find((d) => d.id === readId()) ?? null
  const state = pushState({ ios: isIOS(), standalone: isStandalone(), secure: isSecureContext, supported, permission, subscribed: Boolean(mine) && browserSub })
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally {
      if ('Notification' in window) setPermission(Notification.permission)
      await Promise.all([qc.invalidateQueries({ queryKey: ['push'] }), refreshSub()])
      setBusy(false)
    }
  }
  const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })
  return {
    state, mine, busy, error, devices: q.data?.devices ?? [],
    enable: () => run(async () => {
      if (!q.data) throw new Error('server not reachable')
      const reg = await navigator.serviceWorker.ready
      const perm = await Notification.requestPermission() // only here, on the click
      if (perm !== 'granted') return
      const key = keyBytes(q.data.publicKey)
      let sub = await reg.pushManager.getSubscription()
      if (sub && !same(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null } // made for another VAPID key
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource })
      writeId((await api<{ id: string }>('/api/push/subscription', json('POST', { subscription: sub.toJSON(), label: deviceLabel(navigator.userAgent) }))).id)
    }),
    disable: () => run(async () => {
      if (mine) await api(`/api/push/subscription/${mine.id}`, json('DELETE'))
      await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription().then((s) => s?.unsubscribe())
      writeId(null)
    }),
    test: () => run(() => api('/api/push/test', json('POST', { id: mine?.id }))),
    setKind: (k: Kind, v: boolean) => run(() => api(`/api/push/subscription/${mine?.id}`, json('PATCH', { kinds: { ...mine?.kinds, [k]: v } }))),
    remove: (id: string) => run(() => api(`/api/push/subscription/${id}`, json('DELETE'))),
  }
}

export function PhoneCard({ p }: { p: ReturnType<typeof usePush> }) {
  if (isDesktop) return null
  const others = p.devices.filter((d) => d.id !== p.mine?.id)
  return (
    <SettingsCard title="Phone and browser push">
      <SettingsRow title="This device" description={PUSH_HINT[p.state]}
        control={<HStack gap={2}>
          {p.state === 'off' && <Button label="Enable on this device" size="sm" isDisabled={p.busy} onClick={p.enable} />}
          {p.state === 'on' && <Button label="Send test" size="sm" isDisabled={p.busy} onClick={p.test} />}
          {p.state === 'on' && <Button label="Turn off" size="sm" isDisabled={p.busy} onClick={p.disable} />}
        </HStack>} />
      {p.error && <SettingsRow title={<Text type="supporting" size="sm">{p.error}</Text>} />}
      {others.map((d) => (
        <SettingsRow key={d.id} title={d.label} description={`Added ${shortAgo(d.created)} ago · ${d.lastOk ? `last delivered ${shortAgo(d.lastOk)} ago` : 'nothing delivered yet'}. Its switches are set from that device.`}
          control={<Button label="Remove" size="sm" isDisabled={p.busy} onClick={() => p.remove(d.id)} />} />
      ))}
    </SettingsCard>
  )
}

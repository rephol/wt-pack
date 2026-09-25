// Server status bar + "server is down" state. Health comes from /api/health; control (app only)
// goes to the native side as a `server-control` event, which answers with `server-control-result`.
import { SideNavItem } from '@astryxdesign/core/SideNav'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Heading } from '@astryxdesign/core/Heading'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { useToast } from '@astryxdesign/core/Toast'

type Source = { ok: boolean | null; lastOkAt: string | null; lastError: { at: string; message: string } | null; enabled?: boolean; online?: number; total?: number }
interface Health {
  pid: number; startedAt: string; managedBy: 'app' | 'launchd' | 'external'; webBuiltAt: string | null
  runtime?: { kind: string; path: string }
  sources: Record<'herdr' | 'git' | 'gh' | 'linear' | 'machines', Source>
}
type TauriEvent = { emit: (n: string, p?: unknown) => Promise<void>; listen: (n: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> }
const tauri = (window as unknown as { __TAURI__?: { event: TauriEvent } }).__TAURI__
const isApp = '__TAURI_INTERNALS__' in window

const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 86400)}d`
}
const dot = (s: Source) => (s.enabled === false ? 'neutral' : s.ok === null ? 'neutral' : s.ok ? 'success' : 'error') as 'neutral' | 'success' | 'error'

export function useServerControl() {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    if (!tauri) return
    const un = tauri.event.listen('server-control-result', (e) => {
      const r = e.payload as { action: string; ok: boolean; error: string | null }
      setBusy(null)
      if (!r.ok) { console.error('server control failed', r); toast({ body: `${r.action} failed: ${r.error}`, type: 'error' }) }
      else toast({ body: `Server ${r.action === 'start' ? 'started' : r.action === 'takeover' ? 'taken over' : r.action === 'install' ? 'installed as a service' : 'restarted'}` })
    })
    return () => { un.then((f) => f()) }
  }, [toast])
  const run = (action: 'restart' | 'takeover' | 'install' | 'start') => {
    setBusy(action)
    tauri?.event.emit('server-control', { action }).catch((e) => { setBusy(null); console.error(e); toast({ body: `${action} failed: ${e}`, type: 'error' }) })
  }
  return { busy, run }
}

// One health poll shared by the nav item and the Settings › Server section.
let misses = 0
function useHealth() {
  const q = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        misses = 0
        return (await r.json()) as Health
      } catch (e) { misses++; throw e }
    },
    refetchInterval: 5000, refetchIntervalInBackground: true, retry: false,
  })
  const h = q.data
  const down = q.isError && misses >= 2
  const failing = h ? Object.entries(h.sources).filter(([, s]) => s.ok === false && s.enabled !== false) : []
  const state = down ? 'down' : !h ? 'checking' : failing.length ? 'degraded' : 'healthy'
  const variant = (down ? 'error' : failing.length ? 'warning' : h ? 'success' : 'neutral') as 'error' | 'warning' | 'success' | 'neutral'
  return { h, down, state, variant }
}

// Sidebar item: status dot (+ "Server"); opens Settings on the Server section. Also owns the down screen.
export function ServerStatus({ collapsed = false, onOpen }: { collapsed?: boolean; onOpen: () => void }) {
  const { down, state, variant } = useHealth()
  const ctl = useServerControl()
  return (
    <>
      {down && <DownState ctl={ctl} />}
      <SideNavItem label="Server" onClick={onOpen} icon={<span style={{ width: 16, display: "inline-flex", justifyContent: "center" }}><StatusDot variant={variant} label={`Server ${state}`} /></span>}
        endContent={collapsed ? undefined : <Text size="sm" type="supporting">{state}</Text>} />
    </>
  )
}

export function ServerPanel() {
  const { h, state } = useHealth()
  const ctl = useServerControl()
  if (!h) return <Text type="supporting">{`Server ${state}.`}</Text>
  return <Details h={h} ctl={ctl} state={state} />
}

const MANAGED = {
  app: ['App-managed', 'Managed by the app'],
  launchd: ['launchd', 'launchd service (npm run service:restart / service:status; log ~/Library/Logs/wt-dashboard/server.log)'],
  external: ['External', 'External (e.g. npm start in a terminal)'],
} as const

function Details({ h, ctl, state }: { h: Health; ctl: ReturnType<typeof useServerControl>; state: string }) {
  return (
    <VStack gap={2}>
      <Text weight="semibold">{`Dashboard server — ${state}`}</Text>
      <Text size="sm" type="supporting">{`${MANAGED[h.managedBy][0]} · pid ${h.pid} · up ${ago(h.startedAt)} · web built ${ago(h.webBuiltAt)} ago`}</Text>
      <Text size="sm">{`${MANAGED[h.managedBy][1]} · pid ${h.pid}`}</Text>
      <Text size="sm" type="supporting" style={{ overflowWrap: 'anywhere' }}>{`Started ${new Date(h.startedAt).toLocaleString()} · ${h.runtime?.kind ?? ''} ${h.runtime?.path ?? ''}`}</Text>
      <Text size="sm" type="supporting">{`web/dist built ${h.webBuiltAt ? new Date(h.webBuiltAt).toLocaleString() : 'unknown'}`}</Text>
      {Object.entries(h.sources).map(([k, s]) => (
        <VStack key={k} gap={0}>
          <HStack gap={2} align="center"><StatusDot variant={dot(s)} label={k} /><Text size="sm" weight="medium">{k}</Text>
            <Text size="sm" type="supporting">{s.enabled === false ? 'off (no LINEAR_API_KEY)' : `last ok ${ago(s.lastOkAt)} ago`}{k === 'machines' ? ` · ${s.online}/${s.total} online` : ''}</Text></HStack>
          {s.lastError && <Text size="sm" type="supporting" style={{ overflowWrap: 'anywhere' }}>{`last error ${ago(s.lastError.at)} ago: ${s.lastError.message}`}</Text>}
        </VStack>
      ))}
      {isApp && (
        <HStack gap={2}>
          {h.managedBy !== 'external'
            ? <Button label="Restart server" size="sm" isLoading={ctl.busy === 'restart'} onClick={() => ctl.run('restart')} />
            : <Button label="Install as service" size="sm" tooltip="Stop the external server on :7777 and run it as a launchd service (starts at login, restarts after a crash, survives quitting the app)" isLoading={ctl.busy === 'install'} onClick={() => ctl.run('install')} />}
        </HStack>
      )}
    </VStack>
  )
}

function DownState({ ctl }: { ctl: ReturnType<typeof useServerControl> }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', background: 'var(--color-background-page, Canvas)' }}>
      <Card padding={6} style={{ maxWidth: 480 }}>
        <VStack gap={3}>
          <HStack gap={2} align="center"><StatusDot variant="error" label="Server down" /><Heading level={2}>Server is down</Heading></HStack>
          <Text type="supporting">The dashboard server on 127.0.0.1:7777 is not answering.</Text>
          {isApp
            ? <Button label="Start server" variant="primary" isLoading={ctl.busy === 'start'} onClick={() => ctl.run('start')} />
            : (<><Text>Start it from a terminal:</Text><CodeBlock code="cd ~/.claude/skills/wt-dashboard && npm start" /></>)}
        </VStack>
      </Card>
    </div>
  )
}

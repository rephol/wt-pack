// Terminals: shells herdr owns, mirrored here (the server streams `pane read --format ansi`; xterm.js draws it — a
// mirror, not a pty) and typed into (printable text → send-text, whitelisted keys → send-keys). Off by default;
// Settings › Terminals turns it on, only from http://127.0.0.1 on this machine.
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { Heading } from '@astryxdesign/core/Heading'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { Switch } from '@astryxdesign/core/Switch'
import { Banner } from '@astryxdesign/core/Banner'
import { Dialog } from '@astryxdesign/core/Dialog'
import { Selector } from '@astryxdesign/core/Selector'
import { TextInput } from '@astryxdesign/core/TextInput'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Card } from '@astryxdesign/core/Card'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { termInput } from './termKeys'

export interface TermSettings { enabled: boolean; tailnet: boolean; loopback: boolean; audit: { ts: string; pane?: string; action: string; text?: string; remoteAddr?: string; host?: string }[] }
export interface Shell { pane: string; name: string; cwd: string; workspace: string; title: string | null; lastLine: string; rows: number | null }

export const useTermSettings = () => useQuery({ queryKey: ['terminal-settings'], queryFn: () => api<TermSettings>('/api/terminal-settings'), refetchInterval: 30_000 })
const paneUrl = (pane: string) => `/api/terminals/${encodeURIComponent(pane)}`
const sendInput = (pane: string, body: object) => api(`${paneUrl(pane)}/input`, { method: 'POST', body: JSON.stringify(body) })

// Close = `herdr pane close` on the server (a running process is ended; herdr drops an emptied -shells
// workspace itself). Confirmed with an in-page AlertDialog: window.confirm() returns false in the desktop app's
// WKWebView without a UI delegate, which silently cancelled every close.
function useCloseShell(onClosed?: () => void) {
  const qc = useQueryClient()
  const toast = useToast()
  const [target, setTarget] = useState<Shell | { pane: string; name: string } | null>(null)
  const close = useMutation({
    mutationFn: (pane: string) => api(paneUrl(pane), { method: 'DELETE' }),
    onSuccess: () => { setTarget(null); qc.invalidateQueries({ queryKey: ['terminals'] }); onClosed?.() },
    onError: (e) => { console.error('close shell failed', e); toast({ body: `Could not close the shell: ${e instanceof Error ? e.message : e}`, type: 'error' }) },
  })
  const dialog = (
    <AlertDialog isOpen={!!target} onOpenChange={(o) => !o && setTarget(null)} title={`Close ${target?.name ?? 'shell'}?`}
      description="The shell and whatever runs in it are ended." actionLabel="Close shell" actionVariant="destructive"
      isActionLoading={close.isPending} onAction={() => target && close.mutate(target.pane)} />
  )
  return { ask: setTarget, dialog }
}

// ---------- list ----------
export function TerminalsPage({ onOpen, phone }: { onOpen: (pane: string) => void; phone: boolean }) {
  const q = useQuery({ queryKey: ['terminals'], queryFn: () => api<Shell[]>('/api/terminals'), refetchInterval: 5000 })
  const [creating, setCreating] = useState(false)
  const closer = useCloseShell()
  return (
    <VStack gap={3}>
      <HStack justify="between" align="center">
        <Text type="supporting" size="sm">Shells in herdr&apos;s &lt;project&gt;-shells workspaces. Everything typed is audited (Settings › Terminals).</Text>
        <Button label="New terminal" size="sm" variant="primary" onClick={() => setCreating(true)} />
      </HStack>
      {q.isError && <Banner status="error" title="Terminals unavailable" description={String(q.error)} />}
      {q.data && !q.data.length && <EmptyState isCompact title="No terminals" description="New terminal starts a shell in a project, a worktree, your home or /private/tmp." />}
      <VStack gap={2}>
        {q.data?.map((t) => (
          <Card key={t.pane} padding={3} style={{ cursor: 'pointer' }} onClick={() => onOpen(t.pane)}>
            <VStack gap={0.5}>
              <HStack gap={2} align="center"><Text weight="semibold" maxLines={1}>{t.name}</Text><Text type="supporting" size="sm" maxLines={1}>{t.cwd}</Text>
                <span style={{ marginInlineStart: 'auto' }} onClick={(e) => e.stopPropagation()}>
                  <IconButton label={`Close ${t.name}`} icon={<Icon icon="close" />} size="sm" variant="ghost" tooltip="Close shell" onClick={() => closer.ask(t)} />
                </span></HStack>
              <Text type="code" size="sm" maxLines={1}>{t.lastLine || ' '}</Text>
              {!phone && <Text type="supporting" size="sm">{`${t.workspace} · ${t.pane}`}</Text>}
            </VStack>
          </Card>
        ))}
      </VStack>
      {closer.dialog}
      {creating && <NewTerminal onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); onOpen(p) }} />}
    </VStack>
  )
}

function NewTerminal({ onClose, onCreated }: { onClose: () => void; onCreated: (pane: string) => void }) {
  const qc = useQueryClient()
  const places = useQuery({ queryKey: ['terminal-places'], queryFn: () => api<{ projects: { name: string; root: string }[]; worktrees: string[]; home: string; tmp: string }>('/api/terminals/places') })
  const [cwd, setCwd] = useState('')
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => api<{ pane: string }>('/api/terminals', { method: 'POST', body: JSON.stringify({ cwd, name: name.trim() || undefined }) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['terminals'] }); onCreated(r.pane) },
  })
  const p = places.data
  const options = p ? [
    ...p.projects.map((x) => ({ value: x.root, label: x.name, description: x.root })),
    ...p.worktrees.map((w) => ({ value: w, label: w.split('/').at(-1) ?? w, description: w })),
    { value: p.home, label: 'Home', description: p.home }, { value: p.tmp, label: 'Temp', description: p.tmp },
  ] : []
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width={480}>
      <VStack gap={3}>
        <Heading level={3}>New terminal</Heading>
        <Selector label="Start in" width="100%" value={cwd} placeholder="Project, worktree, home or temp" isLoading={places.isLoading} options={options} onChange={setCwd} />
        <TextInput label="Name (optional)" value={name} onChange={setName} placeholder="defaults to the folder name" />
        {create.isError && <Banner status="error" title="Could not start the shell" description={String(create.error)} />}
        <HStack gap={2} justify="end">
          <Button label="Cancel" variant="ghost" onClick={onClose} />
          <Button label="Start shell" variant="primary" isDisabled={!cwd} isLoading={create.isPending} onClick={() => create.mutate()} />
        </HStack>
      </VStack>
    </Dialog>
  )
}

// ---------- one terminal ----------
const STRIP: [string, string][] = [['C-c', 'Ctrl+C'], ['Tab', 'Tab'], ['Up', '↑'], ['Down', '↓'], ['Esc', 'Esc'], ['C-d', 'Ctrl+D'], ['C-l', 'Ctrl+L']]

export function TerminalView({ pane, onClose, onBack, phone }: { pane: string; onClose?: () => void; onBack?: () => void; phone: boolean }) {
  const toast = useToast()
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ reset: () => void; write: (s: string) => void; resize: (c: number, r: number) => void; dispose: () => void } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [line, setLine] = useState('')
  const list = useQuery({ queryKey: ['terminals'], queryFn: () => api<Shell[]>('/api/terminals'), refetchInterval: 10_000 })
  const me = list.data?.find((t) => t.pane === pane)
  const fail = (e: unknown) => { console.error('terminal', e); toast({ body: `Terminal: ${e instanceof Error ? e.message : e}`, type: 'error' }) }

  useEffect(() => {
    let cancelled = false
    let es: EventSource | null = null
    ;(async () => {
      const [{ Terminal }] = await Promise.all([import('@xterm/xterm'), import('@xterm/xterm/css/xterm.css')])
      if (cancelled || !host.current) return
      const t = new Terminal({ fontSize: phone ? 11 : 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', cursorBlink: false, disableStdin: phone, convertEol: true, scrollback: 0, cols: 100, rows: 30 })
      t.open(host.current)
      t.onData((d) => { const i = termInput(d); if (i) sendInput(pane, i).catch(fail) })
      termRef.current = t
      es = new EventSource(`${paneUrl(pane)}/stream`)
      es.addEventListener('screen', (e) => {
        const screen: string = JSON.parse((e as MessageEvent).data)
        const lines = screen.replace(/\r/g, '').split('\n')
        // eslint-disable-next-line no-control-regex
        const width = Math.max(40, ...lines.map((l) => l.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').length))
        t.resize(Math.min(width, 400), Math.max(5, lines.length))
        t.reset(); t.write(screen)
        setErr(null)
      })
      es.addEventListener('gone', (e) => setErr(JSON.parse((e as MessageEvent).data)))
      es.onerror = () => setErr('stream disconnected — retrying')
    })().catch(fail)
    return () => { cancelled = true; es?.close(); termRef.current?.dispose(); termRef.current = null }
  }, [pane, phone]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => { if (!line) return sendInput(pane, { submit: true }).catch(fail); sendInput(pane, { text: line, submit: true }).then(() => setLine(''), fail) }
  const closer = useCloseShell(() => (onClose ?? onBack)?.())
  return (
    <VStack gap={2} height="100%" padding={phone ? 2 : 4} style={{ minHeight: 0 }}>
      <HStack gap={2} align="center" style={{ minWidth: 0 }}>
        {onBack && <IconButton label="Back" icon={<span aria-hidden>←</span>} size={phone ? 'md' : 'sm'} variant="ghost" onClick={onBack} />}
        <VStack gap={0} style={{ minWidth: 0, flex: 1 }}>
          <Text weight="semibold" maxLines={1}>{me?.name ?? pane}</Text>
          <Text type="supporting" size="sm" maxLines={1}>{me ? `${me.cwd}${me.rows ? ` · ${me.rows} rows` : ''}` : pane}</Text>
        </VStack>
        <Button label="Close shell" size="sm" variant="ghost" onClick={() => closer.ask({ pane, name: me?.name ?? pane })} />
        {onClose && <IconButton label="Close panel" icon={<Icon icon="close" />} size="sm" variant="ghost" onClick={onClose} />}
      </HStack>
      {closer.dialog}
      {err && <Banner status="warning" title={err} />}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#111', borderRadius: 8, padding: 6 }} onClick={() => !phone && host.current?.querySelector('textarea')?.focus()}>
        <div ref={host} />
      </div>
      <HStack gap={1} wrap="wrap">
        {STRIP.map(([k, label]) => <Button key={k} label={label} size="sm" variant="secondary" onClick={() => sendInput(pane, { keys: [k] }).catch(fail)} />)}
      </HStack>
      {/* Enter SENDS here, on a phone too: a terminal command bar is a line of input, not a message draft. */}
      <HStack gap={2} align="end">
        <div style={{ flex: 1 }}>
          <TextInput label="Command" isLabelHidden placeholder="Type a command, Enter runs it" value={line} onChange={setLine}
            autoComplete="off" onKeyDown={(e: import('react').KeyboardEvent) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
        </div>
        <Button label="Run" size="sm" variant="primary" onClick={submit} />
      </HStack>
    </VStack>
  )
}

// ---------- Settings › Terminals ----------
export function TerminalsSection() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useTermSettings()
  const set = useMutation({
    mutationFn: (p: Partial<TermSettings>) => api<TermSettings>('/api/terminal-settings', { method: 'PUT', body: JSON.stringify(p) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['terminal-settings'] }),
    onError: (e) => toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  const s = q.data
  if (!s) return <Text type="supporting">…</Text>
  return (
    <VStack gap={4}>
      <Heading level={3}>Terminals</Heading>
      <Banner status="warning" title="A terminal is a shell as you" description="Anyone who can open this dashboard with terminals on can run any command on this machine. Everything typed is logged below." />
      {!s.loopback && <Text size="sm">These switches can be changed only from http://127.0.0.1:7777 on this machine.</Text>}
      <Switch label="Enable terminals" description="Shells in herdr's <project>-shells workspaces, mirrored and typed into from here." value={s.enabled} isDisabled={!s.loopback} onChange={(v) => set.mutate({ enabled: v })} />
      <Switch label="Allow terminals over the tailnet" description="Off: only a browser on this machine (127.0.0.1) can use them." value={s.tailnet} isDisabled={!s.loopback || !s.enabled} onChange={(v) => set.mutate({ tailnet: v })} />
      <VStack gap={1}>
        <Text weight="semibold">Audit log</Text>
        <Text type="supporting" size="sm">~/.local/share/wt-dashboard/data/terminal-audit.jsonl — newest first, last 100.</Text>
        {!s.audit.length && <Text type="supporting" size="sm">Nothing yet.</Text>}
        {s.audit.map((a, i) => (
          <Text key={i} type="code" size="sm" style={{ overflowWrap: 'anywhere' }}>{`${a.ts.slice(0, 19).replace('T', ' ')}  ${a.action.padEnd(8)} ${a.pane ?? ''}  ${a.text ?? ''}  (${a.host ?? '?'})`}</Text>
        ))}
      </VStack>
    </VStack>
  )
}

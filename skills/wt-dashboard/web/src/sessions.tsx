// Sessions (#sessions, WP-228): Claude Code sessions on this Mac — search, pin (shared with `ccsessions freeze`), resume into a pane.
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { Switch } from '@astryxdesign/core/Switch'
import { Selector } from '@astryxdesign/core/Selector'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { SettingsCard, SettingsRow } from './settingsRows'
import { inProject } from './switcherData'

type Row = { id: string; cwd: string | null; proj: string; tldr: string; doing?: string; mtime: number; live: boolean; frozen: boolean; closed?: boolean; agent: string | null; ago?: string; note?: string }
type List = { source: 'ccsessions' | 'builtin'; rows: Row[] }

const ROLES = ['worker', 'planner', 'reviewer', 'auditor', 'orchestrator'].map((r) => ({ value: r, label: r }))
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
// `<repo>-<role>-NN` → role (same rule as sessions.mjs roleFromAgent)
const roleOf = (agent: string | null) => agent?.match(/^[a-z0-9_]+(?:-[a-z0-9_]+)*-([a-z][a-z0-9]*)-\d+$/)?.[1] ?? 'worker'
const ago = (mtime: number) => {
  const m = Math.max(0, Math.round((Date.now() / 1000 - mtime) / 60))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

export function SessionsPage({ phone, project }: { phone: boolean; project: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api<List>('/api/sessions'), refetchInterval: 30_000 })
  const [search, setSearch] = useState('')
  const [closed, setClosed] = useState(false)
  const [resuming, setResuming] = useState<{ id: string; role: string } | null>(null)
  const done = () => { qc.invalidateQueries({ queryKey: ['sessions'] }); qc.invalidateQueries({ queryKey: ['agents'] }) }
  const fail = (what: string) => (e: unknown) => toast({ body: `${what}: ${errText(e)}`, type: 'error' })
  const pin = useMutation({
    mutationFn: (r: Row) => api(`/api/sessions/${r.id}/pin`, { method: r.frozen ? 'DELETE' : 'POST', body: r.frozen ? undefined : '{}' }),
    onSuccess: done, onError: fail('Could not pin'),
  })
  const resume = useMutation({
    mutationFn: (v: { id: string; role: string }) => api<{ name: string }>(`/api/sessions/${v.id}/resume`, { method: 'POST', body: JSON.stringify({ role: v.role }) }),
    onSuccess: (r) => { setResuming(null); done(); toast({ body: `Resumed as ${r.name}` }) }, onError: fail('Resume failed'),
  })
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase()
    return (q.data?.rows ?? [])
      .filter((r) => (closed || !r.closed) && inProject({ project: r.proj }, project))
      .filter((r) => !s || [r.proj, r.tldr, r.doing ?? '', r.id].some((f) => f.toLowerCase().includes(s)))
  }, [q.data, search, closed, project])
  if (q.isError) return <Text type="supporting">Could not load sessions: {errText(q.error)}</Text>
  if (!q.data) return <Text type="supporting">Loading sessions…</Text>
  return (
    <VStack gap={3}>
      <HStack gap={2} align="end" wrap="wrap">
        <TextInput label="Search" value={search} onChange={setSearch} placeholder="project, text or id" />
        <Switch label="Show closed" value={closed} onChange={setClosed} />
        <Text type="supporting" size="sm">{rows.length} sessions · {q.data.source}</Text>
      </HStack>
      <SettingsCard>
        {rows.length === 0 && <SettingsRow title="No sessions" description="Nothing matches." />}
        {rows.slice(0, 200).map((r) => {
          const open = resuming?.id === r.id
          const controls = <HStack gap={1} align="center" wrap="wrap">
            <Button label={r.frozen ? 'Unpin' : 'Pin'} size="sm" variant="ghost" isLoading={pin.isPending && pin.variables?.id === r.id} onClick={() => pin.mutate(r)} />
            {!r.live && !open && <Button label="Resume" size="sm" onClick={() => setResuming({ id: r.id, role: roleOf(r.agent) })} />}
            {open && <>
              <Selector label="Role" width={140} value={resuming.role} options={ROLES} onChange={(v: string) => setResuming({ id: r.id, role: v })} />
              <Button label="Confirm" size="sm" variant="primary" isLoading={resume.isPending} onClick={() => resume.mutate(resuming)} />
              <Button label="Cancel" size="sm" variant="ghost" onClick={() => setResuming(null)} />
            </>}
          </HStack>
          return <SettingsRow key={r.id}
            title={<>{r.live ? '● ' : ''}{r.frozen ? '📌 ' : ''}{r.proj || '—'} · {r.ago ?? ago(r.mtime)} · {r.id.slice(0, 8)}</>}
            description={r.note ? `${r.tldr} — ${r.note}` : r.tldr || r.doing}
            control={phone ? undefined : controls} detail={phone ? controls : undefined} />
        })}
      </SettingsCard>
    </VStack>
  )
}

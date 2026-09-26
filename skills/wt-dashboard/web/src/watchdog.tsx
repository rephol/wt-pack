// Settings › Observability › Watchdog (WP-70): per-check switch and threshold, open findings with Investigate
// (hands the finding to a worker or auditor through wt-handoff — only on this click), and what resolved lately.
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { Switch } from '@astryxdesign/core/Switch'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { SettingsCard, SettingsRow } from './settingsRows'

type Check = { id: string; label: string; unit: string; threshold: number; severe?: boolean }
type Finding = { check: string; key: string; severity: 'severe' | 'warn'; title: string; body: string; since: string; resolvedAt?: string }
type Draft = Record<string, { on: boolean; threshold: string }>
type State = { checks: Check[]; settings: Record<string, { on: boolean; threshold: number }>; open: Record<string, Finding>; resolved: Finding[]; lastRun: string | null }

const when = (iso: string) => new Date(iso).toLocaleString()
const err = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function WatchdogSection() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['watchdog'], queryFn: () => api<State>('/api/watchdog'), refetchInterval: 30_000 })
  // Thresholds stay text while typed: an empty or non-numeric field blocks Save instead of saving 0.
  const [draft, setDraft] = useState<Draft>({})
  useEffect(() => { if (q.data) setDraft(Object.fromEntries(Object.entries(q.data.settings).map(([k, v]) => [k, { on: v.on, threshold: String(v.threshold) }]))) }, [q.data?.settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => qc.invalidateQueries({ queryKey: ['watchdog'] })
  const save = useMutation({
    mutationFn: () => api('/api/watchdog', { method: 'PUT', body: JSON.stringify(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, { on: v.on, threshold: Number(v.threshold) }]))) }),
    onSuccess: () => { done(); toast({ body: 'Saved' }) },
    onError: (e) => toast({ body: `Could not save: ${err(e)}`, type: 'error' }),
  })
  const run = useMutation({ mutationFn: () => api('/api/watchdog/run', { method: 'POST' }), onSuccess: done, onError: (e) => toast({ body: `Watchdog failed: ${err(e)}`, type: 'error' }) })
  const investigate = useMutation({
    mutationFn: (b: { key: string; role: 'worker' | 'auditor' }) => api<{ message: string }>('/api/watchdog/investigate', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: (r) => toast({ body: r.message || 'Handed off' }),
    onError: (e) => toast({ body: `Could not hand off: ${err(e)}`, type: 'error' }),
  })
  if (!q.data) return null
  const { checks, settings, open, resolved, lastRun } = q.data
  const findings = Object.values(open)
  const valid = Object.values(draft).every((v) => v.threshold.trim() !== '' && Number.isFinite(Number(v.threshold)) && Number(v.threshold) >= 0)
  const dirty = Object.entries(draft).some(([k, v]) => v.on !== settings[k]?.on || Number(v.threshold) !== settings[k]?.threshold || v.threshold.trim() === '')
  const set = (id: string, patch: Partial<Draft[string]>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  return (
    <VStack gap={3}>
      <SettingsCard title="Watchdog">
        <SettingsRow title="Checks every minute" description={lastRun ? `Last run ${when(lastRun)} · ${findings.length} open` : 'First run 90 seconds after the server starts.'} />
        {findings.map((f) => (
          <SettingsRow key={f.key} title={<HStack gap={2} vAlign="center"><StatusDot variant={f.severity === 'severe' ? 'error' : 'warning'} label={f.severity} /><span>{f.title}</span></HStack>}
            description={`${f.body ? `${f.body} · ` : ''}since ${when(f.since)}`}
            control={<HStack gap={1}>
              <Button label="Investigate" size="sm" isLoading={investigate.isPending && investigate.variables?.key === f.key} onClick={() => investigate.mutate({ key: f.key, role: 'worker' })} tooltip="Hand it to a free worker (wt-handoff)" />
              <Button label="Ask auditor" size="sm" variant="ghost" onClick={() => investigate.mutate({ key: f.key, role: 'auditor' })} tooltip="Hand it to an auditor instead" />
            </HStack>} />
        ))}
      </SettingsCard>
      <SettingsCard title="Watchdog checks">
        {checks.map((c) => {
          const v = draft[c.id] ?? { on: settings[c.id].on, threshold: String(settings[c.id].threshold) }
          return (
            <SettingsRow key={c.id} title={`${c.label}${c.severe ? ' · notifies' : ''}`} description={`Threshold in ${c.unit} (default ${c.threshold})`}
              control={<HStack gap={2} vAlign="center">
                <TextInput label={`${c.label} threshold`} isLabelHidden size="sm" width={72} value={v.threshold} isDisabled={!v.on}
                  onChange={(t: string) => set(c.id, { threshold: t })} />
                <Switch label={`${c.label} on`} isLabelHidden value={v.on} onChange={(on: boolean) => set(c.id, { on })} />
              </HStack>} />
          )
        })}
      </SettingsCard>
      <HStack gap={2}>
        <Button label="Save" size="sm" variant="primary" isDisabled={!dirty || !valid} isLoading={save.isPending} onClick={() => save.mutate()} />
        <Button label="Run now" size="sm" isLoading={run.isPending} onClick={() => run.mutate()} />
      </HStack>
      {resolved.length > 0 && <Text size="sm" type="supporting">Recently resolved: {resolved.slice(0, 5).map((f) => `${f.title} (${when(f.resolvedAt ?? f.since)})`).join(' · ')}</Text>}
    </VStack>
  )
}

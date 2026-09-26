// Settings › Observability › Housekeeping: retention settings, Run now, the last run's summary and the server's memory.
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { SettingsCard, SettingsRow } from './settingsRows'

type Settings = { uploadsDays: number; resolvedDays: number; rotateMB: number; rotateKeep: number; cacheDays: number }
type Run = { at: string; files: number; bytes: number; actions: string[]; errors: string[] }
type State = { settings: Settings; defaults: Settings; lastRun: Run | null; memory: { rss: number; heapUsed: number; heapTotal: number } }

const FIELDS: [keyof Settings, string][] = [
  ['uploadsDays', 'Delete uploads after (days, unless a live room uses them)'],
  ['resolvedDays', 'Drop resolved inbox items after (days)'],
  ['rotateMB', 'Rotate logs at (MB)'],
  ['rotateKeep', 'Rotated logs to keep'],
  ['cacheDays', 'Delete caches of gone agents after (days)'],
]
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
const size = (n: number) => (n >= 1024 * 1024 ? mb(n) : `${Math.round(n / 1024)} KB`)

export function HousekeepingSection() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['housekeeping'], queryFn: () => api<State>('/api/housekeeping'), refetchInterval: 30_000 })
  const [draft, setDraft] = useState<Record<string, string>>({})
  useEffect(() => { if (q.data) setDraft(Object.fromEntries(Object.entries(q.data.settings).map(([k, v]) => [k, String(v)]))) }, [q.data?.settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api('/api/housekeeping', { method: 'PUT', body: JSON.stringify(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)]))) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['housekeeping'] }); toast({ body: 'Saved' }) },
    onError: (e) => toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  const run = useMutation({
    mutationFn: () => api<Run>('/api/housekeeping/run', { method: 'POST' }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['housekeeping'] }); toast({ body: `Freed ${r.files} files, ${size(r.bytes)}` }) },
    onError: (e) => toast({ body: `Housekeeping failed: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  if (!q.data) return null
  const { lastRun: last, memory: m } = q.data
  const dirty = Object.entries(q.data.settings).some(([k, v]) => draft[k] !== String(v))
  return (
    <VStack gap={3}>
      <SettingsCard title="Housekeeping">
        <SettingsRow title="Runs hourly" description={`Server memory: RSS ${mb(m.rss)} · heap ${mb(m.heapUsed)} of ${mb(m.heapTotal)}`} />
        {FIELDS.map(([k, label]) => (
          <SettingsRow key={k} title={label}
            control={<TextInput label={label} isLabelHidden size="sm" width={88} value={draft[k] ?? ''} onChange={(v: string) => setDraft((d) => ({ ...d, [k]: v }))} placeholder={String(q.data.defaults[k])} />} />
        ))}
      </SettingsCard>
      <HStack gap={2}>
        <Button label="Save" size="sm" variant="primary" isDisabled={!dirty} isLoading={save.isPending} onClick={() => save.mutate()} />
        <Button label="Run now" size="sm" isLoading={run.isPending} onClick={() => run.mutate()} />
      </HStack>
      <Text size="sm" type="supporting">
        {last ? `Last run ${new Date(last.at).toLocaleString()}: ${last.files} files, ${size(last.bytes)} freed${last.errors.length ? ` · ${last.errors.length} errors` : ''}` : 'Not run yet (first run a minute after the server starts).'}
      </Text>
      {last?.errors.map((e) => <Text key={e} size="sm" type="supporting" style={{ overflowWrap: 'anywhere' }}>{e}</Text>)}
    </VStack>
  )
}

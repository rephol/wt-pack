// Routines (#routines, WP-48): recurring agent work the server runs on a schedule. List with pause/Run now/edit/delete,
// a create/edit dialog, and Settings › Observability › Routines history. API: docs/plans/wp-48-routines-plan.md.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Heading } from '@astryxdesign/core/Heading'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import { Dialog } from '@astryxdesign/core/Dialog'
import { Switch } from '@astryxdesign/core/Switch'
import { Selector } from '@astryxdesign/core/Selector'
import { TextInput } from '@astryxdesign/core/TextInput'
import { TextArea } from '@astryxdesign/core/TextArea'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { SettingsCard, SettingsRow } from './settingsRows'
import { inProject, routineProject } from './switcherData'

type Scope = { project: string; agents: { name: string; project?: string | null }[] }

type Target =
  | { kind: 'prompt'; agent?: string; role?: string; project?: string; text: string }
  | { kind: 'spawn'; role: string; project: string; prompt: string }
  | { kind: 'action'; action: 'jev-run' | 'housekeeping'; project?: string }
type Last = { status: string; reason: string | null; started: number; ended: number | null }
type Routine = { id: string; name: string; schedule: string; target: Target; timeout_min: number; enabled: boolean; next_run: number; last: Last | null }
type Run = { id: number; routine_id: string; name: string | null; started: number; ended: number | null; status: string; reason: string | null; agent: string | null }
type List = { routines: Routine[]; settings: { maxWorking: number } }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export const targetText = (t: Target) =>
  t.kind === 'action' ? (t.action === 'jev-run' ? `Jev Run now · ${t.project}` : 'Housekeeping')
  : t.kind === 'spawn' ? `spawn ${t.role} in ${t.project}`
  : `prompt ${t.agent ?? `${t.role} in ${t.project}`}`
const lastText = (l: Last | null) => (l ? `${l.status}${l.reason ? ` (${l.reason})` : ''} · ${when(l.started)}` : 'never run')

function useRoutineMutations() {
  const qc = useQueryClient()
  const toast = useToast()
  const done = () => { qc.invalidateQueries({ queryKey: ['routines'] }); qc.invalidateQueries({ queryKey: ['routine-runs'] }) }
  const fail = (what: string) => (e: unknown) => toast({ body: `${what}: ${errText(e)}`, type: 'error' })
  return {
    toggle: useMutation({ mutationFn: (r: Routine) => api(`/api/routines/${r.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !r.enabled }) }), onSuccess: done, onError: fail('Could not save') }),
    run: useMutation({
      mutationFn: (r: Routine) => api<Run>(`/api/routines/${r.id}/run`, { method: 'POST' }),
      onSuccess: (u) => { done(); toast({ body: u.status === 'running' ? 'Started' : `${u.status}${u.reason ? `: ${u.reason}` : ''}` }) },
      onError: fail('Run failed'),
    }),
    remove: useMutation({ mutationFn: (r: Routine) => api(`/api/routines/${r.id}`, { method: 'DELETE' }), onSuccess: done, onError: fail('Could not delete') }),
    save: useMutation({
      mutationFn: ({ id, body }: { id?: string; body: object }) => api(id ? `/api/routines/${id}` : '/api/routines', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }),
      onSuccess: done,
    }),
  }
}

export function RoutinesPage({ phone, project, agents }: { phone: boolean } & Scope) {
  const q = useQuery({ queryKey: ['routines'], queryFn: () => api<List>('/api/routines'), refetchInterval: 15_000 })
  const m = useRoutineMutations()
  const [editing, setEditing] = useState<Routine | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Routine | null>(null)
  if (q.isError) return <Text type="supporting">Could not load routines: {errText(q.error)}</Text>
  if (!q.data) return null
  const routines = q.data.routines.filter((r) => inProject({ project: routineProject(r.target, agents) }, project))
  return (
    <VStack gap={3}>
      <HStack justify="between" align="center" wrap="wrap" gap={2}>
        <Text type="supporting" size="sm">Checked every 30s by the server. A run missed while the Mac slept fires once on wake. Skipped when {q.data.settings.maxWorking} agents are working, memory pressure is critical, or the last run is still going.</Text>
        <Button label="New routine" variant="primary" size={phone ? 'sm' : 'md'} onClick={() => setEditing('new')} />
      </HStack>
      <SettingsCard>
        {routines.length === 0 && <SettingsRow title="No routines" description={project === 'all' ? 'Create one with New routine.' : `None in ${project}. Create one with New routine, or pick All projects.`} />}
        {routines.map((r) => {
          const controls = <HStack gap={1} align="center" wrap="wrap">
            <Switch label={r.enabled ? 'On' : 'Off'} value={r.enabled} isDisabled={m.toggle.isPending} onChange={() => m.toggle.mutate(r)} />
            <Button label="Run now" size="sm" isLoading={m.run.isPending && m.run.variables?.id === r.id} onClick={() => m.run.mutate(r)} />
            <Button label="Edit" size="sm" variant="ghost" onClick={() => setEditing(r)} />
            <Button label="Delete" size="sm" variant="ghost" onClick={() => setDeleting(r)} />
          </HStack>
          // Phone: the controls go under the text, which otherwise gets squeezed to one word per line.
          return <SettingsRow key={r.id} title={r.name}
            description={<>{r.schedule} · {targetText(r.target)}<br />{r.enabled ? `next ${when(r.next_run)}` : 'paused'} · last: {lastText(r.last)}</>}
            control={phone ? undefined : controls} detail={phone ? controls : undefined} />
        })}
      </SettingsCard>
      {editing && <RoutineDialog routine={editing === 'new' ? null : editing} phone={phone} onClose={() => setEditing(null)} />}
      {deleting && (
        <Dialog isOpen onOpenChange={(o: boolean) => !o && setDeleting(null)} width={400}>
          <VStack gap={3}>
            <Heading level={3}>Delete {deleting.name}?</Heading>
            <Text type="supporting" size="sm">Its run history stays in Observability.</Text>
            <HStack justify="end" gap={2}>
              <Button label="Cancel" variant="ghost" onClick={() => setDeleting(null)} />
              <Button label="Delete" variant="destructive" isLoading={m.remove.isPending} onClick={() => m.remove.mutate(deleting, { onSuccess: () => setDeleting(null) })} />
            </HStack>
          </VStack>
        </Dialog>
      )}
    </VStack>
  )
}

const KIND_OPTIONS = [{ value: 'prompt', label: 'Prompt an agent' }, { value: 'spawn', label: 'Spawn an agent, remove it after' }, { value: 'action', label: 'Local action' }]
const ACTION_OPTIONS = [{ value: 'jev-run', label: 'Jev Run now (board)' }, { value: 'housekeeping', label: 'Housekeeping' }]

function RoutineDialog({ routine, phone, onClose }: { routine: Routine | null; phone: boolean; onClose: () => void }) {
  const t = routine?.target
  const [d, setD] = useState({
    name: routine?.name ?? '', schedule: routine?.schedule ?? 'every 1h', timeout: String(routine?.timeout_min ?? 60),
    kind: t?.kind ?? 'prompt', agent: t?.kind === 'prompt' ? t.agent ?? '' : '',
    role: t && t.kind !== 'action' ? t.role ?? '' : 'orchestrator', project: t?.project ?? 'wt-pack',
    text: t?.kind === 'prompt' ? t.text : t?.kind === 'spawn' ? t.prompt : '', action: t?.kind === 'action' ? t.action : 'jev-run',
  })
  const [error, setError] = useState('')
  const { save } = useRoutineMutations()
  const set = (k: keyof typeof d) => (v: string) => setD((x) => ({ ...x, [k]: v }))
  const target = d.kind === 'action' ? { kind: 'action', action: d.action, project: d.project }
    : d.kind === 'spawn' ? { kind: 'spawn', role: d.role, project: d.project, prompt: d.text }
    : d.agent ? { kind: 'prompt', agent: d.agent, text: d.text } : { kind: 'prompt', role: d.role, project: d.project, text: d.text }
  const submit = () => save.mutate({ id: routine?.id, body: { name: d.name, schedule: d.schedule, timeout_min: Number(d.timeout), target } },
    { onSuccess: onClose, onError: (e) => setError(errText(e)) })
  return (
    <Dialog isOpen onOpenChange={(o: boolean) => !o && onClose()} width={phone ? undefined : 520} variant={phone ? 'fullscreen' : undefined}>
      <VStack gap={3}>
        <Heading level={3}>{routine ? `Edit ${routine.name}` : 'New routine'}</Heading>
        <TextInput label="Name" value={d.name} onChange={set('name')} />
        <TextInput label="Schedule" value={d.schedule} onChange={set('schedule')} placeholder="every 30m · 0 2 * * *"
          description="every <N>m|h|d, or cron m h dom mon dow in local time" />
        <Selector label="Target" width="100%" value={d.kind} options={KIND_OPTIONS} onChange={set('kind')} />
        {d.kind === 'action' && <Selector label="Action" width="100%" value={d.action} options={ACTION_OPTIONS} onChange={set('action')} />}
        {d.kind === 'prompt' && <TextInput label="Agent name (optional)" value={d.agent} onChange={set('agent')} description="Blank: the idle agent of this role in the project" />}
        {(d.kind === 'spawn' || (d.kind === 'prompt' && !d.agent)) && <TextInput label="Role" value={d.role} onChange={set('role')} placeholder="orchestrator" />}
        {(d.kind !== 'action' ? d.kind === 'spawn' || !d.agent : d.action === 'jev-run') && <TextInput label="Project" value={d.project} onChange={set('project')} />}
        {d.kind !== 'action' && <TextArea label={d.kind === 'spawn' ? 'First prompt' : 'Prompt'} value={d.text} onChange={set('text')} rows={4} />}
        <TextInput label="Timeout (minutes)" width={160} value={d.timeout} onChange={set('timeout')} />
        {error && <Banner status="error" title={error} />}
        <HStack justify="end" gap={2}>
          <Button label="Cancel" variant="ghost" onClick={onClose} />
          <Button label={routine ? 'Save' : 'Create (paused)'} variant="primary" isLoading={save.isPending} onClick={submit} />
        </HStack>
      </VStack>
    </Dialog>
  )
}

// Settings › Observability › Routines history.
// A run of a deleted routine has no known project, so it shows under All only.
export function RoutinesHistorySection({ project, agents }: Scope) {
  const q = useQuery({ queryKey: ['routine-runs'], queryFn: () => api<Run[]>('/api/routines/runs?limit=50'), refetchInterval: 15_000 })
  const rq = useQuery({ queryKey: ['routines'], queryFn: () => api<List>('/api/routines'), refetchInterval: 15_000 })
  if (!q.data || !rq.data) return null
  const byId = new Map(rq.data.routines.map((r) => [r.id, routineProject(r.target, agents)]))
  const runs = q.data.filter((u) => inProject({ project: byId.get(u.routine_id) ?? null }, project))
  return (
    <SettingsCard title="Routines history">
      {runs.length === 0 && <SettingsRow title="No runs yet" description={project === 'all' ? 'Runs of the last 30 days show here.' : `No runs in ${project} in the last 30 days.`} />}
      {runs.map((u) => (
        <SettingsRow key={u.id} title={`${u.name ?? `${u.routine_id} (deleted)`} — ${u.status}`}
          description={`${when(u.started)}${u.ended ? ` · ${Math.max(0, Math.round((u.ended - u.started) / 1000))}s` : ''}${u.reason ? ` · ${u.reason}` : ''}${u.agent ? ` · ${u.agent}` : ''}`} />
      ))}
    </SettingsCard>
  )
}

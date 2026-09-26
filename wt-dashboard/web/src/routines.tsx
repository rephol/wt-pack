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
import { TimeInput, type ISOTimeString } from '@astryxdesign/core/TimeInput'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { useToast } from '@astryxdesign/core/Toast'
import { api, useRoomsList } from './rooms'
import type { Role } from './roles'
import { fromSchedule, toSchedule } from './routineForm'
import { SettingsCard, SettingsRow } from './settingsRows'
import { inProject, routineProject } from './switcherData'

type Scope = { project: string; agents: { name: string; project?: string | null }[] }

type Deliver = { to: 'self' | 'none' } | { to: 'room'; room: string }
type Target = { deliver?: Deliver } & (
  | { kind: 'prompt'; agent?: string; role?: string; project?: string; text: string }
  | { kind: 'spawn'; role: string; project: string; prompt: string }
  | { kind: 'action'; action: 'jev-run' | 'housekeeping'; project?: string })
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
const deliverText = (d?: Deliver) => (d?.to === 'room' ? ` → #${d.room}` : d?.to === 'self' ? ' → Inbox' : '')
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

export function RoutinesPage({ phone, project, agents, projects }: { phone: boolean; projects: string[] } & Scope) {
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
            description={<>{r.schedule} · {targetText(r.target)}{deliverText(r.target.deliver)}<br />{r.enabled ? `next ${when(r.next_run)}` : 'paused'} · last: {lastText(r.last)}</>}
            control={phone ? undefined : controls} detail={phone ? controls : undefined} />
        })}
      </SettingsCard>
      {editing && <RoutineDialog routine={editing === 'new' ? null : editing} phone={phone} project={project} projects={projects} agents={agents} onClose={() => setEditing(null)} />}
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

const KIND_ITEMS = [['prompt', 'Prompt agent'], ['spawn', 'Spawn agent'], ['action', 'Local action']]
const ACTION_OPTIONS = [{ value: 'jev-run', label: 'Jev Run now (board triage)' }, { value: 'housekeeping', label: 'Housekeeping' }]
const PRESETS = [{ value: 'every 15m', label: 'Every 15 minutes' }, { value: 'every 30m', label: 'Every 30 minutes' }, { value: 'every 1h', label: 'Every hour' },
  { value: 'daily', label: 'Daily at…' }, { value: 'weekly', label: 'Weekly on…' }, { value: 'custom', label: 'Custom cron' }]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((label, i) => ({ value: String(i), label }))
const TIMEOUTS = [15, 30, 60, 120, 240, 480]
const opt = (v: string, label = v) => ({ value: v, label })

// Next 3 runs from the server's own parser, so the preview cannot disagree with the scheduler.
function SchedulePreview({ schedule }: { schedule: string }) {
  const q = useQuery({ queryKey: ['routine-preview', schedule], queryFn: () => api<{ next: number[] }>(`/api/routines/preview?schedule=${encodeURIComponent(schedule)}`), retry: false, enabled: !!schedule })
  if (q.isError) return <Text type="supporting" size="sm">Invalid: {errText(q.error)}</Text>
  return <Text type="supporting" size="sm">{q.data ? `Next: ${q.data.next.map(when).join(' · ')}` : ' '}</Text>
}

function RoutineDialog({ routine, phone, project, projects, agents, onClose }: { routine: Routine | null; phone: boolean; project: string; projects: string[]; agents: Scope['agents']; onClose: () => void }) {
  const t = routine?.target
  const [d, setD] = useState({
    name: routine?.name ?? '', ...fromSchedule(routine?.schedule ?? 'every 1h'), timeout: String(routine?.timeout_min ?? 60),
    kind: t?.kind ?? 'prompt', agent: t?.kind === 'prompt' ? t.agent ?? '' : '',
    role: t && t.kind !== 'action' ? t.role ?? 'orchestrator' : 'orchestrator', project: t?.project ?? (project === 'all' ? projects[0] ?? 'wt-pack' : project),
    text: t?.kind === 'prompt' ? t.text : t?.kind === 'spawn' ? t.prompt : '', action: t?.kind === 'action' ? t.action : 'jev-run',
    deliver: t?.deliver?.to ?? (t?.kind === 'action' ? 'none' : 'self'), room: t?.deliver?.to === 'room' ? t.deliver.room : '',
  })
  const [error, setError] = useState('')
  const { save } = useRoutineMutations()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ roles: Role[] }>('/api/roles'), staleTime: 30_000 }).data?.roles ?? []
  const rooms = (useRoomsList().data?.rooms ?? []).filter((x) => !x.archived)
  const set = (k: keyof typeof d) => (v: string) => setD((x) => ({ ...x, [k]: v }))
  const schedule = toSchedule(d)
  // Keep a saved value selectable even when it is no longer offered (agent gone, role not spawnable, odd timeout).
  const keep = (list: { value: string; label: string }[], v: string) => (v && !list.some((o) => o.value === v) ? [...list, opt(v)] : list)
  const roleOpts = keep(roles.filter((r) => d.kind !== 'spawn' || r.spawn).map((r) => opt(r.id, r.name)), d.role)
  const agentOpts = keep([opt('', 'Any idle agent of a role'), ...agents.map((a) => opt(a.name, a.project ? `${a.name} · ${a.project}` : a.name))], d.agent)
  const projectOpts = keep(projects.map((p) => opt(p)), d.project)
  const roomOpts = keep(rooms.map((x) => opt(x.slug, `#${x.slug}`)), d.room)
  const timeoutOpts = keep(TIMEOUTS.map((m) => opt(String(m), m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`)), d.timeout)
  const deliver = d.deliver === 'room' ? { to: 'room', room: d.room } : { to: d.deliver }
  const target = d.kind === 'action' ? { kind: 'action', action: d.action, project: d.project, deliver }
    : d.kind === 'spawn' ? { kind: 'spawn', role: d.role, project: d.project, prompt: d.text, deliver }
    : d.agent ? { kind: 'prompt', agent: d.agent, text: d.text, deliver } : { kind: 'prompt', role: d.role, project: d.project, text: d.text, deliver }
  const submit = () => save.mutate({ id: routine?.id, body: { name: d.name, schedule, timeout_min: Number(d.timeout), target } },
    { onSuccess: onClose, onError: (e) => setError(errText(e)) })
  const seg = (label: string, k: 'kind' | 'deliver', items: string[][]) => (
    <SegmentedControl label={label} value={d[k]} onChange={set(k)} layout={phone ? 'fill' : undefined}>
      {items.map(([v, l]) => <SegmentedControlItem key={v} value={v} label={l} />)}
    </SegmentedControl>
  )
  return (
    <Dialog isOpen onOpenChange={(o: boolean) => !o && onClose()} width={phone ? undefined : 560} variant={phone ? 'fullscreen' : undefined}>
      <VStack gap={3}>
        <Heading level={3}>{routine ? `Edit ${routine.name}` : 'New routine'}</Heading>
        <TextInput label="Name" value={d.name} onChange={set('name')} />
        <VStack gap={1}>
          <HStack gap={2} wrap="wrap" align="end">
            <Selector label="Schedule" width={phone ? '100%' : 200} value={d.preset} options={PRESETS} onChange={set('preset')} />
            {d.preset === 'weekly' && <Selector label="Day" width={160} value={d.dow} options={DAYS} onChange={set('dow')} />}
            {(d.preset === 'daily' || d.preset === 'weekly') && <TimeInput label="At" width={130} value={d.time as ISOTimeString} onChange={(v) => v && set('time')(v)} />}
          </HStack>
          {d.preset === 'custom' && <TextInput label="Cron" value={d.cron} onChange={set('cron')} placeholder="0 2 * * *"
            description="m h dom mon dow in local time, or every <N>m|h|d" />}
          <SchedulePreview schedule={schedule} />
        </VStack>
        {seg('Target', 'kind', KIND_ITEMS)}
        {d.kind === 'action' && <Selector label="Action" width="100%" value={d.action} options={ACTION_OPTIONS} onChange={set('action')} />}
        {d.kind === 'prompt' && <Selector label="Agent" width="100%" value={d.agent} options={agentOpts} onChange={set('agent')} hasSearch />}
        {(d.kind === 'spawn' || (d.kind === 'prompt' && !d.agent)) && <Selector label="Role" width="100%" value={d.role} options={roleOpts} onChange={set('role')} />}
        {(d.kind !== 'action' ? d.kind === 'spawn' || !d.agent : d.action === 'jev-run') && <Selector label="Project" width="100%" value={d.project} options={projectOpts} onChange={set('project')} />}
        {d.kind !== 'action' && <TextArea label={d.kind === 'spawn' ? 'First prompt' : 'Prompt'} value={d.text} onChange={set('text')} rows={4} />}
        {seg('Deliver result to', 'deliver', [['self', 'Inbox'], ['room', 'Room'], ['none', 'None']])}
        {d.deliver === 'room' && <Selector label="Room" width="100%" value={d.room} options={roomOpts} onChange={set('room')} hasSearch placeholder="Pick a room" />}
        <Text type="supporting" size="sm">One message per run with its status. Failures always go to the Inbox.</Text>
        <Selector label="Timeout" width={phone ? '100%' : 200} value={d.timeout} options={timeoutOpts} onChange={set('timeout')} />
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

// Board Dispatch + reconcile history (WP-52): dispatches, failures, merges → done, returns, stalls. 30 days.
interface BoardEvent { id: number; project: string; at: number; kind: string; ticket: string | null; text: string | null }
export function BoardHistorySection() {
  const q = useQuery({ queryKey: ['board-events'], queryFn: () => api<BoardEvent[]>('/api/board/events?limit=50'), refetchInterval: 15_000 })
  if (!q.data) return null
  return (
    <SettingsCard title="Board history">
      {q.data.length === 0 && <SettingsRow title="No board events yet" description="Dispatches and reconcile moves of the last 30 days show here." />}
      {q.data.length > 0 && <div className="hd-obs-box" style={{ maxHeight: 320, overflow: 'auto' }}>
        {q.data.map((e) => <SettingsRow key={e.id} title={`${e.ticket ?? e.project} — ${e.kind}`} description={`${when(e.at)} · ${e.project}${e.text ? ` · ${e.text}` : ''}`} />)}
      </div>}
    </SettingsCard>
  )
}

// Settings › Memory: the wt-memory preference files (global, per role, per project) every agent is started with.
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { Selector } from '@astryxdesign/core/Selector'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { useRoles } from './roles'
import { Delayed, LoadError, FieldsSkeleton } from './skeletons'

type Memory = { dir: string; cli: string | null; plugin: { installed: boolean; enabled: boolean; version: string | null }
  global: string; roles: Record<string, string>; projects: Record<string, string>; entries: Entry[] }
type Entry = { id: string; scope: 'global' | 'role' | 'project'; name: string | null; by: string; at: string; text: string; pending?: boolean }
type AgentLite = { key: string; name: string; pool: string; project: string | null; tags?: Record<string, string> }
type Tab = 'global' | 'roles' | 'projects'

export function MemorySection() {
  const q = useQuery({ queryKey: ['memory'], queryFn: () => api<Memory>('/api/memory') })
  const [tab, setTab] = useState<Tab>('global')
  const { byId } = useRoles()
  if (q.error) return <LoadError what="memory" error={q.error} retry={() => q.refetch()} />
  if (!q.data) return <Delayed><FieldsSkeleton /></Delayed>
  const m = q.data
  return (
    <VStack gap={3}>
      <Text type="supporting" size="sm">Standing preferences every agent receives at session start (global → role → project), and again when they change. Stored as markdown in {m.dir}.</Text>
      {m.plugin.installed && m.plugin.enabled
        ? <Text size="sm">Claude Code plugin: installed{m.plugin.version ? ` (v${m.plugin.version})` : ''}, enabled.</Text>
        : <Banner status="warning" title={m.plugin.installed ? 'The wt-memory Claude Code plugin is disabled' : 'The wt-memory Claude Code plugin is not installed'}
            description="claude plugin marketplace add ~/Work/projects/wt-pack && claude plugin install wt-memory@wt-pack" />}
      <Entries entries={m.entries ?? []} />
      <SegmentedControl label="Scope" value={tab} onChange={(v) => setTab(v as Tab)} size="sm">
        <SegmentedControlItem value="global" label="Global" />
        <SegmentedControlItem value="roles" label="Roles" />
        <SegmentedControlItem value="projects" label="Projects" />
      </SegmentedControl>
      {tab === 'global' && <Editor path="global" label="Every agent" initial={m.global} />}
      {tab === 'roles' && Object.entries(m.roles).map(([id, t]) => <Editor key={id} path={`roles/${id}`} label={`${byId(id).name} (${id})`} initial={t} />)}
      {tab === 'projects' && Object.entries(m.projects).map(([n, t]) => <Editor key={n} path={`projects/${n}`} label={n} initial={t} />)}
      <Preview />
    </VStack>
  )
}

// Agent-written entries (wt-memory remember) with author/date, and global proposals awaiting approval.
function Entries({ entries }: { entries: Entry[] }) {
  const qc = useQueryClient()
  const toast = useToast()
  const op = useMutation({
    mutationFn: ({ id, op }: { id: string; op: 'forget' | 'accept' | 'reject' }) => api(`/api/memory/entries/${id}/${op}`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['memory'] }); qc.invalidateQueries({ queryKey: ['inbox'] }) },
    onError: (e) => toast({ body: `Memory: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  const row = (e: Entry, acts: React.ReactNode) => (
    <HStack key={e.id} justify="between" align="center" gap={2}>
      <VStack gap={0}>
        <Text size="sm">{e.text}</Text>
        <Text type="supporting" size="sm">{`${e.pending ? 'global' : e.name ? `${e.scope} ${e.name}` : e.scope} · ${e.by} · ${e.at}`}</Text>
      </VStack>
      <HStack gap={1}>{acts}</HStack>
    </HStack>
  )
  const pending = entries.filter((e) => e.pending)
  const saved = entries.filter((e) => !e.pending)
  return (
    <VStack gap={2}>
      {pending.length > 0 && <Text weight="semibold" size="sm">Proposed global preferences</Text>}
      {pending.map((e) => row(e, <>
        <Button label="Accept" size="sm" variant="primary" onClick={() => op.mutate({ id: e.id, op: 'accept' })} />
        <Button label="Reject" size="sm" onClick={() => op.mutate({ id: e.id, op: 'reject' })} />
      </>))}
      <Text weight="semibold" size="sm">Remembered by agents</Text>
      {!saved.length && <Text type="supporting" size="sm">None yet. Agents add entries with wt-memory remember.</Text>}
      {saved.map((e) => row(e, <Button label="Remove" size="sm" variant="destructive" onClick={() => op.mutate({ id: e.id, op: 'forget' })} />))}
    </VStack>
  )
}

// Agent entries (lines with a `<!-- wtm:… -->` trailer) are listed above, so the editor hides them and puts them back on save.
const AGENT_LINE = /<!-- wtm:/
function Editor({ path, label, initial: raw }: { path: string; label: string; initial: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const lines = raw.split('\n')
  const initial = lines.filter((l) => !AGENT_LINE.test(l)).join('\n').trim()
  const agentLines = lines.filter((l) => AGENT_LINE.test(l)).join('\n')
  const [text, setText] = useState(initial)
  useEffect(() => setText(initial), [initial])
  const save = useMutation({
    mutationFn: () => api(`/api/memory/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body: JSON.stringify({ text: [text.trim(), agentLines].filter(Boolean).join('\n') }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['memory'] }); toast({ body: `Saved ${label}`, type: 'info' }) },
    onError: (e) => toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  return (
    <VStack gap={1}>
      <TextArea label={label} value={text} onChange={setText} rows={6} placeholder="Markdown, e.g. - Answer in English." />
      <HStack justify="end"><Button label="Save" size="sm" variant="primary" isDisabled={text === initial} isLoading={save.isPending} onClick={() => save.mutate()} /></HStack>
    </VStack>
  )
}

function Preview() {
  const agents = useQuery({ queryKey: ['memory-agents'], queryFn: () => api<AgentLite[]>('/api/agents') })
  const [key, setKey] = useState('')
  const a = agents.data?.find((x) => x.key === key)
  const role = a && a.pool !== 'other' ? a.pool : ''
  const project = a?.tags?.project ?? a?.project ?? ''
  const preview = useQuery({
    queryKey: ['memory-preview', role, project],
    enabled: !!a,
    queryFn: () => api<{ text: string }>(`/api/memory/preview?${new URLSearchParams({ role, project })}`),
  })
  return (
    <VStack gap={2}>
      <Selector label="Preview for agent…" width="100%" value={key} placeholder="Choose an agent" isLoading={agents.isLoading}
        options={(agents.data ?? []).map((x) => ({ value: x.key, label: x.name, description: [x.pool, x.tags?.project ?? x.project].filter(Boolean).join(' · ') }))} onChange={setKey} />
      {a && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0, padding: 8, borderRadius: 6, background: 'var(--color-background-secondary, rgba(127,127,127,.1))' }}>
        {preview.isLoading ? 'Loading…' : preview.data?.text || '(nothing: every scope is empty for this agent)'}
      </pre>}
    </VStack>
  )
}

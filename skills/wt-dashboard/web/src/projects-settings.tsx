// Settings › Projects (WP-107): per-project overrides over the global settings (project-settings.mjs on the server).
// Each row shows where its value comes from — overridden here, inherited from global/default, or locked by a server
// env var — and resets to the inherited value. Board automation lives on the board's own row (tickets board settings).
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Selector } from '@astryxdesign/core/Selector'
import { Switch } from '@astryxdesign/core/Switch'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { openSettings } from './settings'
import { SettingsCard, SettingsRow, CONTROL_WIDTH } from './settingsRows'
import { Delayed, LoadError, FieldsSkeleton } from './skeletons'

type Source = 'env' | 'project' | 'global' | 'default'
type Item = { key: string; label: string; scope: 'project' | 'overridable'; value: string | null; source: Source; project: string | null; inherited: { value: string | null; source: Source } }
const ABOUT: Record<string, string> = {
  githubAccount: 'gh and git push in agents spawned for this project act as this account (GH_TOKEN from gh\'s keyring). The account must be logged in: gh auth login. Takes effect for new agents; respawn existing ones.',
  baseBranch: 'The integration branch dispatch reconciles merges against, and the PR list checks for shipped.',
  WT_AGENTS_MCP: 'full: every agent gets claude\'s normal MCP set; lean: its role\'s set only.',
  maxWorking: 'Dispatch hands out work only while fewer agents than this are working.',
  WT_JEV_TICKET_TRIAGE: 'Jev suggests type, size, priority and role for new tickets on this board.',
}
const CHOICES: Record<string, string[]> = { WT_AGENTS_MCP: ['full', 'lean'], WT_JEV_TICKET_TRIAGE: ['on', 'off'] }

// The project Settings › Projects shows; set by openProjectSettings and by the picker.
let wanted: string | null = null
export const openProjectSettings = (project: string) => { wanted = project; openSettings('projects') }

export function ProjectsSection() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ name: string }[]>('/api/projects') })
  const names = (projects.data ?? []).map((p) => p.name)
  const [project, setP] = useState<string | null>(wanted)
  const setProject = (p: string) => { wanted = p; setP(p) } // survives the dialog remounting (desktop ⇄ phone shell)
  const current = project ?? names[0] ?? null
  if (!projects.data) return projects.isError ? <LoadError what="projects" error={projects.error} retry={() => projects.refetch()} /> : <Delayed><FieldsSkeleton n={5} /></Delayed>
  if (!current) return <Text type="supporting">No projects yet: add a repo under Settings › Integrations.</Text>
  return (
    <VStack gap={5}>
      <Selector label="Project" width={CONTROL_WIDTH} value={current} onChange={setProject}
        options={[...new Set([current, ...names])].map((n) => ({ value: n, label: n }))} />
      <Text type="supporting" size="sm">Order: server env var › this project › global (Settings) › default. Reset returns a key to what it inherits.</Text>
      <ProjectKeys project={current} />
      <BoardAutomation project={current} />
    </VStack>
  )
}

function ProjectKeys({ project }: { project: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const key = ['project-settings', project]
  const q = useQuery({ queryKey: key, queryFn: () => api<{ items: Item[] }>(`/api/projects/${encodeURIComponent(project)}/settings`) })
  const save = useMutation({
    mutationFn: ({ k, value }: { k: string; value?: string }) => api<{ items: Item[] }>(`/api/projects/${encodeURIComponent(project)}/settings/${k}`,
      { method: value == null ? 'DELETE' : 'PUT', body: JSON.stringify({ value }) }),
    onSuccess: (s) => { qc.setQueryData(key, s); toast({ body: 'Saved' }) },
    onError: (e) => toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  if (!q.data) return q.isError ? <LoadError what="project settings" error={q.error} retry={() => q.refetch()} /> : <Delayed><FieldsSkeleton n={5} /></Delayed>
  return (
    <SettingsCard title={project}>
      {q.data.items.map((it) => <KeyRow key={it.key} it={it} busy={save.isPending} put={(value) => save.mutateAsync({ k: it.key, value }).then(() => true, () => false)} />)}
    </SettingsCard>
  )
}

function Where({ it }: { it: Item }) {
  if (it.source === 'env') return <Badge variant="warning" label={`locked by env var${it.project ? ` (project value ${it.project} inactive)` : ''}`} />
  if (it.source === 'project') return <Badge variant="info" label="overridden" />
  return <Badge label={`inherited from ${it.source}`} />
}

function KeyRow({ it, busy, put }: { it: Item; busy: boolean; put: (v?: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(it.project ?? '')
  useEffect(() => setDraft(it.project ?? ''), [it.project])
  const locked = it.source === 'env'
  const choices = CHOICES[it.key]
  const control = choices
    ? <Selector label={it.label} isLabelHidden width={CONTROL_WIDTH} isDisabled={locked || busy} value={it.project ?? ''}
        onChange={(v: string) => void put(v || undefined)}
        options={[{ value: '', label: `Inherit (${it.inherited.value ?? 'unset'})` }, ...choices.map((c) => ({ value: c, label: c }))]} />
    : <HStack gap={1}>
        <TextInput label={it.label} isLabelHidden width={CONTROL_WIDTH - 64} isReadOnly={locked} value={draft} onChange={setDraft}
          placeholder={it.inherited.value ?? (it.key === 'githubAccount' ? 'gh active account' : '')}
          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' && draft.trim()) void put(draft.trim()) }} />
        <Button label="Save" size="sm" variant="secondary" isDisabled={locked || busy || !draft.trim() || draft.trim() === it.project} onClick={() => void put(draft.trim())} />
      </HStack>
  return (
    <SettingsRow title={it.label} description={ABOUT[it.key]} control={control}
      detail={<HStack gap={2} vAlign="center" wrap="wrap">
        <Where it={it} />
        <Text type="supporting" size="sm" color="secondary">now: {it.value ?? (it.key === 'githubAccount' ? 'gh active account' : 'unset')}</Text>
        {it.project != null && <Button label="Reset" size="sm" variant="ghost" isDisabled={busy} onClick={() => void put(undefined)} />}
      </HStack>} />
  )
}

type Board = { auto?: boolean; dispatch?: boolean }
function BoardAutomation({ project }: { project: string }) {
  const qc = useQueryClient()
  const key = ['tickets', project]
  const q = useQuery({ queryKey: key, queryFn: () => api<Board>(`/api/tickets?project=${encodeURIComponent(project)}`), retry: false })
  const set = useMutation({ mutationFn: (b: Board) => api('/api/tickets/board', { method: 'PUT', body: JSON.stringify({ project, ...b }) }), onSuccess: () => qc.invalidateQueries({ queryKey: key }) })
  if (!q.data) return null // no board for this project yet
  return (
    <SettingsCard title="Board automation">
      <SettingsRow title="Auto" description="Jev promotes Backlog tickets to Ready." control={<Switch label="Auto" isLabelHidden value={!!q.data.auto} isDisabled={set.isPending} onChange={(v: boolean) => set.mutate({ auto: v })} />} />
      <SettingsRow title="Dispatch" description="Hand Ready tickets to free agents. Minimum priority, stall minutes and Report to: the board's Automation menu."
        control={<Switch label="Dispatch" isLabelHidden value={!!q.data.dispatch} isDisabled={set.isPending} onChange={(v: boolean) => set.mutate({ dispatch: v })} />} />
    </SettingsCard>
  )
}

// Teams (#teams, WP-237): each project's team files (.wt-pack/teams/<name>.md) with the agents filling them, their load,
// and the team's workflow as a Mermaid flowchart (stages → persona → gate, review/QA looping back to build) with the
// stage of each current ticket highlighted. WP-241: New team (template), Edit (members, stage map, live preview), Delete
// and Spawn team (`agents.sh spawn --team <name>`) from the page; the server confines every write (project-teams.mjs).
import { useEffect, useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { Selector } from '@astryxdesign/core/Selector'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useToast } from '@astryxdesign/core/Toast'
import { Banner } from '@astryxdesign/core/Banner'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { api } from './rooms'
import { LoadError } from './skeletons'

type Agent = { name: string; status: string; ticket: string | null; stage: string | null }
type Team = { stages: { stage: string; persona: string }[]; name: string; project: string; description: string; where: string; errors: string[]; flowchart: string
  members: { persona: string; count: number; agents: Agent[] }[]
  load: { agents: number; of: number; working: number; tickets: number }; tickets: { id: string; stage: string }[]; active: string[] }

// mermaid is bundled (no CDN) and loaded on first use: the page itself stays small. securityLevel strict sanitises its SVG.
function Flow({ source }: { source: string }) {
  const id = `flow-${useId().replace(/[^\w]/g, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' })
      const out = await mermaid.render(id, source)
      if (live) setSvg(out.svg)
    }).catch(() => live && setFailed(true))
    return () => { live = false }
  }, [id, source])
  if (failed) return <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{source}</pre>
  if (!svg) return <Text type="supporting" size="sm">Drawing workflow…</Text>
  return <div role="img" aria-label="Team workflow" style={{ overflowX: 'auto', maxWidth: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} />
}

const STAGES = ['plan', 'build', 'review', 'qa']
type Draft = { description: string; members: { persona: string; count: number }[]; stages: { stage: string; persona: string }[] }
const url = (project: string, name?: string, more = '') => `/api/teams/${encodeURIComponent(project)}${name ? `/${encodeURIComponent(name)}` : ''}${more}`
// Every save/delete/spawn refreshes the page; errors from the server (validation, confinement) surface as a toast.
function useTeamAction(done: string) {
  const qc = useQueryClient(), toast = useToast()
  return (fn: () => Promise<unknown>, after?: () => void) => fn().then((r) => {
    qc.invalidateQueries({ queryKey: ['teams'] }); qc.invalidateQueries({ queryKey: ['overview'] }); after?.()
    const errs = (r as { errors?: string[] } | undefined)?.errors
    toast({ body: errs?.length ? `${done}, but: ${errs.join('; ')}` : done })
  }, (e) => toast({ body: `Failed: ${e instanceof Error ? e.message : e}`, type: 'error' }))
}

function NewTeam({ projects, onClose, onBlank }: { projects: string[]; onClose: () => void; onBlank: (project: string, name: string) => void }) {
  const [project, setProject] = useState(projects[0] ?? ''), [name, setName] = useState(''), [template, setTemplate] = useState('blank')
  const act = useTeamAction('Team created')
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width={420}>
      <VStack gap={3}>
      <Heading level={3}>New team</Heading>
        <VStack gap={2}>
          <Selector label="Project" width="100%" value={project} options={projects.map((p) => ({ value: p, label: p }))} onChange={setProject} />
          <TextInput label="Name" value={name} onChange={(v) => setName(v.toLowerCase())} placeholder="web" />
          <Selector label="Template" width="100%" value={template} onChange={setTemplate}
            options={[{ value: 'blank', label: 'blank — start empty, add members and stages' }, { value: 'solo', label: 'solo — one worker' }, { value: 'standard', label: 'standard — planner, 2 workers, reviewer' }, { value: 'full', label: 'full — plus QA auditor' }]} />
          <Text type="supporting" size="sm">Saved to the project's .wt-pack/teams (or the user-level folder, as set for the project). Not committed.</Text>
        </VStack>
      
      <HStack justify="end" gap={2}>
        <Button label="Cancel" variant="ghost" onClick={onClose} />
        <Button label={template === 'blank' ? 'Next' : 'Create'} variant="primary" isDisabled={!project || !name} onClick={() => template === 'blank' ? (onBlank(project, name), onClose()) : act(() => api(url(project), { method: 'POST', body: JSON.stringify({ name, template }) }), onClose)} />
      </HStack>
      </VStack>
    </Dialog>
  )
}

// `create`: a blank new team — Save POSTs it (name + this body) instead of PUTting over an existing file.
function EditTeam({ t, onClose, create }: { t: Team; onClose: () => void; create?: boolean }) {
  const [d, setD] = useState<Draft>({ description: t.description, members: t.members.map((m) => ({ persona: m.persona, count: m.count })), stages: t.stages.map((x) => ({ ...x })) })
  const [flow, setFlow] = useState(t.flowchart)
  const act = useTeamAction(create ? 'Team created' : 'Team saved')
  useEffect(() => {
    const h = setTimeout(() => api<{ flowchart: string }>('/api/teams/preview', { method: 'POST', body: JSON.stringify(d) }).then((r) => setFlow(r.flowchart), () => {}), 300)
    return () => clearTimeout(h)
  }, [d])
  const setM = (i: number, m: Partial<Draft['members'][0]>) => setD({ ...d, members: d.members.map((x, j) => (j === i ? { ...x, ...m } : x)) })
  const setS = (i: number, s: Partial<Draft['stages'][0]>) => setD({ ...d, stages: d.stages.map((x, j) => (j === i ? { ...x, ...s } : x)) })
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width={560}>
      <VStack gap={3}>
      <Heading level={3}>{`${create ? 'New' : 'Edit'} ${t.name}`}</Heading>
        <VStack gap={2}>
          <TextInput label="Description" value={d.description} onChange={(description) => setD({ ...d, description })} />
          <Text weight="semibold" size="sm">Members (role or persona × count)</Text>
          {d.members.map((m, i) => (
            <HStack key={i} gap={2} align="end">
              <TextInput label="Persona" value={m.persona} onChange={(persona) => setM(i, { persona: persona.toLowerCase() })} />
              <TextInput label="Count" value={String(m.count)} onChange={(v) => setM(i, { count: Number(v) || 0 })} />
              <Button label="Remove" variant="ghost" onClick={() => setD({ ...d, members: d.members.filter((_, j) => j !== i) })} />
            </HStack>
          ))}
          <Button label="Add member" variant="ghost" onClick={() => setD({ ...d, members: [...d.members, { persona: 'worker', count: 1 }] })} />
          <Text weight="semibold" size="sm">Stage → persona</Text>
          {d.stages.map((s, i) => (
            <HStack key={i} gap={2} align="end">
              <Selector label="Stage" value={s.stage} options={STAGES.map((x) => ({ value: x, label: x }))} onChange={(stage) => setS(i, { stage })} />
              <Selector label="Persona" value={s.persona} options={[...new Set([s.persona, ...d.members.map((m) => m.persona)])].map((x) => ({ value: x, label: x }))} onChange={(persona) => setS(i, { persona })} />
              <Button label="Remove" variant="ghost" onClick={() => setD({ ...d, stages: d.stages.filter((_, j) => j !== i) })} />
            </HStack>
          ))}
          <Button label="Add stage" variant="ghost" onClick={() => setD({ ...d, stages: [...d.stages, { stage: STAGES.find((x) => !d.stages.some((s) => s.stage === x)) ?? 'build', persona: d.members[0]?.persona ?? 'worker' }] })} />
          <Flow source={flow} />
        </VStack>
      
      <HStack justify="end" gap={2}>
        <Button label="Cancel" variant="ghost" onClick={onClose} />
        <Button label="Save" variant="primary" onClick={() => act(() => create ? api(url(t.project), { method: 'POST', body: JSON.stringify({ name: t.name, ...d }) }) : api(url(t.project, t.name), { method: 'PUT', body: JSON.stringify(d) }), onClose)} />
      </HStack>
      </VStack>
    </Dialog>
  )
}

function DeleteTeam({ t, onClose }: { t: Team; onClose: () => void }) {
  const act = useTeamAction('Team deleted')
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width={400}>
      <VStack gap={3}>
      <Heading level={3}>{`Delete ${t.name}?`}</Heading><Text size="sm">Removes {t.where}/{t.name}.md. Running agents keep running; they just stop being a team.</Text>
      <HStack justify="end" gap={2}>
        <Button label="Cancel" variant="ghost" onClick={onClose} />
        <Button label="Delete" variant="primary" onClick={() => act(() => api(url(t.project, t.name), { method: 'DELETE' }), onClose)} />
      </HStack>
      </VStack>
    </Dialog>
  )
}

function TeamCard({ t, showProject }: { t: Team; showProject: boolean }) {
  const [dlg, setDlg] = useState<'edit' | 'delete' | null>(null)
  const spawn = useTeamAction('Team spawned')
  const [busy, setBusy] = useState(false)
  return (
    <VStack gap={2} style={{ padding: 12, border: '1px solid var(--color-border-primary, rgba(127,127,127,.3))', borderRadius: 8 }}>
      <HStack justify="between" align="center" wrap="wrap" gap={2}>
        <Heading level={3}>{t.name}{showProject ? ` · ${t.project}` : ''}</Heading>
        <Text type="supporting" size="sm">{`${t.load.agents}/${t.load.of} up · ${t.load.working} working · ${t.load.tickets} ticket${t.load.tickets === 1 ? '' : 's'}`}</Text>
      </HStack>
      {t.description && <Text size="sm">{t.description}</Text>}
      {t.errors.length > 0 && <Banner status="warning" title="Team file has problems" description={`${t.errors.join('; ')} (wt-roles team check)`} />}
      <VStack gap={1}>
        {t.members.map((m) => (
          <HStack key={m.persona} gap={2} wrap="wrap" align="start">
            <Text weight="semibold" size="sm">{m.persona}{m.count > 1 ? ` ×${m.count}` : ''}</Text>
            {m.agents.length === 0
              ? <Text type="supporting" size="sm">not started</Text>
              : <Text size="sm">{m.agents.map((a) => `${a.name} (${a.status}${a.ticket ? ` · ${a.ticket}${a.stage ? ` ${a.stage}` : ''}` : ''})`).join(', ')}</Text>}
          </HStack>
        ))}
      </VStack>
      <Flow source={t.flowchart} />
      <HStack gap={2} wrap="wrap">
        <Button label="Spawn team" variant="primary" isLoading={busy} isDisabled={t.errors.length > 0} onClick={() => { setBusy(true); spawn(() => api(url(t.project, t.name, '/spawn'), { method: 'POST' })).finally(() => setBusy(false)) }} />
        <Button label="Edit" variant="ghost" onClick={() => setDlg('edit')} />
        <Button label="Delete" variant="ghost" onClick={() => setDlg('delete')} />
      </HStack>
      {dlg === 'edit' && <EditTeam t={t} onClose={() => setDlg(null)} />}
      {dlg === 'delete' && <DeleteTeam t={t} onClose={() => setDlg(null)} />}
    </VStack>
  )
}

export function TeamsPage({ project, projectNames }: { project: string; projectNames?: string[] }) {
  const [newOpen, setNewOpen] = useState(false), [blank, setBlank] = useState<Team | null>(null)
  const q = useQuery({ queryKey: ['teams'], queryFn: () => api<{ teams: Team[]; projects?: string[] }>('/api/teams'), refetchInterval: 15_000 })
  if (q.error) return <LoadError what="teams" error={q.error} retry={() => q.refetch()} />
  if (!q.data) return null
  const teams = q.data.teams.filter((t) => project === 'all' || t.project === project)
  const projects = project === 'all' ? (q.data.projects ?? projectNames ?? []) : [project]
  return (
    <VStack gap={3}>
      <HStack justify="end"><Button label="New team" variant="primary" isDisabled={!projects.length} onClick={() => setNewOpen(true)} /></HStack>
      {newOpen && <NewTeam projects={projects} onClose={() => setNewOpen(false)} onBlank={(project, name) => setBlank({ project, name, description: '', where: '', errors: [], flowchart: '', stages: [], members: [], load: { agents: 0, of: 0, working: 0, tickets: 0 }, tickets: [], active: [] })} />}
      {blank && <EditTeam create t={blank} onClose={() => setBlank(null)} />}
      <Text type="supporting" size="sm">A team is a pod of agents defined in .wt-pack/teams/&lt;name&gt;.md (or the user-level folder): members as persona × count, and which persona takes each stage.</Text>
      {teams.length === 0 && <Text type="supporting" size="sm">No teams yet. Use New team above (or wt-roles team new &lt;name&gt; [--template solo|standard|full])</Text>}
      {teams.map((t) => <TeamCard key={`${t.project}/${t.name}`} t={t} showProject={project === 'all'} />)}
    </VStack>
  )
}

// Teams (#teams, WP-237): each project's team files (.wt-pack/teams/<name>.md) with the agents filling them, their load,
// and the team's workflow as a Mermaid flowchart (stages → persona → gate, review/QA looping back to build) with the
// stage of each current ticket highlighted. Read-only: spawn with `agents.sh spawn --team <name>`.
import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Banner } from '@astryxdesign/core/Banner'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { api } from './rooms'
import { LoadError } from './skeletons'

type Agent = { name: string; status: string; ticket: string | null; stage: string | null }
type Team = { name: string; project: string; description: string; where: string; errors: string[]; flowchart: string
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

function TeamCard({ t, showProject }: { t: Team; showProject: boolean }) {
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
      <Text type="supporting" size="sm">{`Bring it up: agents.sh spawn --team ${t.name}`}</Text>
    </VStack>
  )
}

export function TeamsPage({ project }: { project: string }) {
  const q = useQuery({ queryKey: ['teams'], queryFn: () => api<{ teams: Team[] }>('/api/teams'), refetchInterval: 15_000 })
  if (q.error) return <LoadError what="teams" error={q.error} retry={() => q.refetch()} />
  if (!q.data) return null
  const teams = q.data.teams.filter((t) => project === 'all' || t.project === project)
  return (
    <VStack gap={3}>
      <Text type="supporting" size="sm">A team is a pod of agents defined in .wt-pack/teams/&lt;name&gt;.md (or the user-level folder): members as persona × count, and which persona takes each stage.</Text>
      {teams.length === 0 && <Text type="supporting" size="sm">No teams yet. Create one with: wt-roles team new &lt;name&gt; --template solo|standard|full</Text>}
      {teams.map((t) => <TeamCard key={`${t.project}/${t.name}`} t={t} showProject={project === 'all'} />)}
    </VStack>
  )
}

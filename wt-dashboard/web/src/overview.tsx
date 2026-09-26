// Overview: health at a glance, no lists. Every tile links to the page that owns the detail.
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from '@astryxdesign/core/Card'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { Grid } from '@astryxdesign/core/Grid'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { api, useRoomsList } from './rooms'
import { useHealth } from './status'
import { openSettings } from './settings'
import { UsageBars } from './usage'
import { shortAgo } from './notifyGate'
import { agentsByProject, recentRooms } from './overviewData'

// ponytail: orchestrator rule "max 2 workers"; make it a setting if it ever changes.
const WORKER_CAP = 2
type Dot = 'success' | 'warning' | 'error' | 'accent' | 'neutral'
const MACHINE_DOT: Record<string, Dot> = { online: 'success', stale: 'warning', offline: 'error' }
const PRESSURE_DOT: Record<string, Dot> = { normal: 'success', warn: 'warning', critical: 'error' }

export interface OverviewData {
  agents: { project: string | null; status: string; pool: string }[]
  machines: { label: string; status: string }[]
  counts: { needsYou: number; stalled: number; inReview: number; today?: { prsOpened: number; prsMerged: number; shipped: number } }
  host?: { memUsedPct: number; pressure: string | null }
}
type ObsStats = { stats: Record<'24h', { calls: number; errorRate: number }[]> }

function Tile({ label, value, loud, href }: { label: string; value: number; loud?: 'red' | 'orange'; href: string }) {
  return (
    <ClickableCard label={`${label}: ${value}`} variant={loud && value > 0 ? loud : 'default'} href={href} padding={3}>
      <VStack gap={1}>
        <Text type="supporting">{label}</Text>
        <Text type="display-2" weight="bold">{String(value)}</Text>
      </VStack>
    </ClickableCard>
  )
}

// A row with a link target is one ClickableCard; one holding its own links (Agents, Rooms) stays a plain Card.
function Row({ title, href, onClick, children }: { title: string; href?: string; onClick?: () => void; children: ReactNode }) {
  const body = <VStack gap={2}><Text weight="semibold">{title}</Text>{children}</VStack>
  return href || onClick
    ? <ClickableCard label={title} href={href} onClick={onClick} padding={3}>{body}</ClickableCard>
    : <Card padding={3}>{body}</Card>
}

const Line = ({ children }: { children: ReactNode }) => <HStack gap={3} align="center" wrap="wrap">{children}</HStack>
const Dotted = ({ v, label }: { v: Dot; label: string }) => <HStack gap={1} align="center"><StatusDot variant={v} label={label} /><Text size="sm">{label}</Text></HStack>

export function OverviewPage({ data, onProject }: { data: OverviewData; onProject: (p: string) => void }) {
  const c = data.counts
  const { h } = useHealth()
  const obs = useQuery({ queryKey: ['observability', ''], queryFn: () => api<ObsStats>('/api/observability'), refetchInterval: 60_000 })
  const jevErrors = (obs.data?.stats['24h'] ?? []).reduce((n, s) => n + Math.round(s.calls * s.errorRate), 0)
  const rooms = recentRooms(useRoomsList().data?.rooms ?? [])
  const workers = data.agents.filter((a) => a.pool === 'worker' && a.status === 'working').length
  const t = c.today
  return (
    <VStack gap={4}>
      <Grid columns={{ minWidth: 100 }} gap={3}>
        <Tile label="Needs you" value={c.needsYou} loud="red" href="#tasks" />
        <Tile label="Stalled" value={c.stalled} loud="orange" href="#tasks" />
        <Tile label="In review" value={c.inReview} href="#tasks" />
      </Grid>
      <Grid columns={{ minWidth: 380 }} gap={3}>
        <Row title="Agents">
          {agentsByProject(data.agents).map((g) => (
            <ClickableCard key={g.project} label={`${g.project} agents`} padding={2} variant="muted" onClick={() => { onProject(g.project === 'other' ? 'all' : g.project); location.hash = 'agents' }}>
              <Line>
                <Text size="sm" weight="semibold" style={{ minWidth: 120 }}>{g.project}</Text>
                <Dotted v="accent" label={`${g.working} working`} />
                <Dotted v="neutral" label={`${g.idle} idle`} />
                {g.blocked > 0 && <Dotted v="error" label={`${g.blocked} blocked`} />}
              </Line>
            </ClickableCard>
          ))}
          {!data.agents.length && <Text type="supporting" size="sm">No agents.</Text>}
        </Row>
        <Row title="Today" href="#tasks">
          <Text size="sm">{t ? `PRs ${t.prsOpened} opened · ${t.prsMerged} merged · ${t.shipped} shipped` : '—'}</Text>
        </Row>
        <Row title="Machine" href="#agents">
          <Line>
            {data.host && <Dotted v={PRESSURE_DOT[data.host.pressure ?? ''] ?? 'neutral'} label={`RAM ${data.host.memUsedPct}%${data.host.pressure ? ` (${data.host.pressure})` : ''}`} />}
            <Text size="sm">{`workers ${workers}/${WORKER_CAP}`}</Text>
          </Line>
          <Line>{data.machines.map((m) => <Dotted key={m.label} v={MACHINE_DOT[m.status] ?? 'neutral'} label={m.label} />)}</Line>
        </Row>
        <Row title="Health" onClick={() => openSettings('observability')}>
          <Line>
            {h ? Object.entries(h.sources).filter(([, s]) => s.enabled !== false).map(([k, s]) => (
              <Dotted key={k} v={s.ok === false ? 'error' : s.ok ? 'success' : 'neutral'} label={k} />
            )) : <Text type="supporting" size="sm">checking…</Text>}
            {h?.jev && <Dotted v={h.jev.state !== 'up' ? 'error' : jevErrors ? 'warning' : 'success'} label={`Jev${jevErrors ? ` · ${jevErrors} errors/24h` : ''}`} />}
          </Line>
        </Row>
        <Row title="Rooms">
          {rooms.map((r) => (
            <ClickableCard key={r.slug} label={`#${r.slug}`} padding={2} variant="muted" href={`#rooms/${encodeURIComponent(r.slug)}`}>
              <VStack gap={0.5}>
                <HStack gap={2} justify="between"><Text size="sm" weight="semibold" maxLines={1}>{`#${r.slug}`}</Text><Text size="sm" type="supporting" style={{ flexShrink: 0 }}>{shortAgo(r.lastAt!)}</Text></HStack>
                <Text size="sm" type="supporting" maxLines={1}>{`${r.lastFrom}: ${r.lastText}`}</Text>
              </VStack>
            </ClickableCard>
          ))}
          {!rooms.length && <Text type="supporting" size="sm">No room activity.</Text>}
        </Row>
        <Row title="Usage" onClick={() => openSettings('usage')}>
          <UsageBars />
        </Row>
      </Grid>
    </VStack>
  )
}

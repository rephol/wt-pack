// Overview: Claude plan limits (ccstatusline's cache) and notional spend from Claude Code transcripts.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { api } from './rooms'

interface Limits {
  session: number | null; sessionResetAt: string | null; weekly: number | null; weeklyResetAt: string | null
  extraUsage: boolean; ageSec: number; stale: boolean
}
interface Summary { tokens: number; cost: number; priced: boolean; groups: { key: string; tokens: number; cost: number }[] }
type By = 'agent' | 'project' | 'model'
interface Usage { limits: Limits | null; today: Record<By, Summary>; week: Record<By, Summary> }

const fmtTok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const fmtUsd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)}`
const until = (iso: string | null) => {
  if (!iso) return null
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000))
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
const ago = (s: number) => (s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`)

function Gauge({ label, pct, resetAt }: { label: string; pct: number | null; resetAt: string | null }) {
  const v = pct ?? 0
  return (
    <Card padding={3} style={{ alignSelf: 'start' }}>
      <VStack gap={2}>
        <HStack justify="between" align="center">
          <Text weight="semibold">{label}</Text>
          <Text size="lg" weight="semibold">{pct == null ? '—' : `${pct}%`}</Text>
        </HStack>
        <ProgressBar label={`${label} usage`} isLabelHidden value={v} max={100} variant={v >= 90 ? 'error' : v >= 70 ? 'warning' : 'accent'} />
        <Text type="supporting" size="sm">{resetAt ? `resets in ${until(resetAt)}` : 'reset time unknown'}</Text>
      </VStack>
    </Card>
  )
}

export function UsagePanel() {
  const q = useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/api/usage'), refetchInterval: 30_000, refetchIntervalInBackground: true })
  const [range, setRange] = useState<'today' | 'week'>('today')
  const [by, setBy] = useState<By>('agent')
  if (!q.data) return null
  const l = q.data.limits
  const s = q.data[range][by]
  return (
    <VStack gap={2}>
      <HStack gap={2} align="center" wrap="wrap">
        <Text weight="semibold">Claude usage</Text>
        {l && (l.stale
          ? <Badge variant="warning" label={`stale — updated ${ago(l.ageSec)}; no Claude Code session refreshing it`} />
          : <Text type="supporting" size="sm">{`updated ${ago(l.ageSec)}`}</Text>)}
        {l?.extraUsage && <Badge label="extra usage on" />}
        {!l && <Text type="supporting" size="sm">No plan limits file (~/.cache/ccstatusline/usage.json)</Text>}
      </HStack>
      <Grid columns={{ minWidth: 220 }} gap={3}>
        {l && <Gauge label="5-hour" pct={l.session} resetAt={l.sessionResetAt} />}
        {l && <Gauge label="Weekly" pct={l.weekly} resetAt={l.weeklyResetAt} />}
        <Card padding={3}>
          <VStack gap={2}>
            <HStack justify="between" align="center" wrap="wrap" gap={2}>
              <SegmentedControl label="Range" value={range} onChange={(v) => setRange(v as 'today' | 'week')} size="sm">
                <SegmentedControlItem value="today" label="Today" />
                <SegmentedControlItem value="week" label="7 days" />
              </SegmentedControl>
              <SegmentedControl label="Group by" value={by} onChange={(v) => setBy(v as By)} size="sm">
                <SegmentedControlItem value="agent" label="Agent" />
                <SegmentedControlItem value="project" label="Project" />
                <SegmentedControlItem value="model" label="Model" />
              </SegmentedControl>
            </HStack>
            <HStack gap={2} align="end" wrap="wrap">
              <Text size="lg" weight="semibold">{`${fmtTok(s.tokens)} tokens`}</Text>
              <Text type="supporting" size="sm">{`${fmtUsd(s.cost)} notional${s.priced ? '' : ' (some models unpriced)'}`}</Text>
            </HStack>
            {s.groups.slice(0, 5).map((g) => {
              const pct = s.tokens ? Math.round((g.tokens / s.tokens) * 100) : 0
              return (
                <VStack key={g.key} gap={0.5}>
                  <HStack justify="between" gap={2}>
                    <Text size="sm" maxLines={1}>{g.key}</Text>
                    <Text size="sm" type="supporting" style={{ flexShrink: 0 }}>{`${fmtTok(g.tokens)} · ${pct}%`}</Text>
                  </HStack>
                  <ProgressBar label={g.key} isLabelHidden value={pct} max={100} />
                </VStack>
              )
            })}
            {!s.groups.length && <Text type="supporting" size="sm">No Claude Code activity in this range.</Text>}
          </VStack>
        </Card>
      </Grid>
    </VStack>
  )
}

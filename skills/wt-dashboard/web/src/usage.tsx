// Claude plan limits (ccstatusline's cache) → Overview tile; notional spend from Claude Code transcripts → Settings › Usage.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { isDesktop } from './desktop'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { api } from './rooms'
import { Delayed, LoadError } from './skeletons'
import { Skeleton } from '@astryxdesign/core/Skeleton'

interface Limits {
  session: number | null; sessionResetAt: string | null; weekly: number | null; weeklyResetAt: string | null
  extraUsage: boolean; ageSec: number; stale: boolean
}
interface Summary { tokens: number; cost: number; priced: boolean; groups: { key: string; tokens: number; cost: number }[] }
type By = 'agent' | 'project' | 'model'
type Range = 'today' | 'week' | 'month'
interface Block { startTime: string | null; endTime: string | null; tokens: number | null; costUSD: number | null; tokensPerMinute: number | null; costPerHour: number | null; projTokens: number | null; projCost: number | null; remainingMinutes: number | null }
interface Usage { limits: Limits | null; block: Block | null; today: Record<By, Summary>; week: Record<By, Summary>; month: Record<By, Summary> }

export const fmtTok = (n: number) => `${n < 0 ? '-' : ''}${Math.abs(n) >= 1e9 ? `${(Math.abs(n) / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `${(Math.abs(n) / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${Math.round(Math.abs(n) / 1e3)}k` : String(Math.abs(n))}`
export const fmtUsd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n) >= 100 ? Math.round(Math.abs(n)).toLocaleString() : Math.abs(n).toFixed(2)}`
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

// WP-146: the app window keeps polling forever while hidden if this stays true for the desktop app; a stale
// value while hidden is harmless, and the browser/PWA tab pause is unaffected.
const useUsage = () => useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/api/usage'), refetchInterval: 30_000, refetchIntervalInBackground: !isDesktop })
// the first transcript scan takes ~1.6s
const Loading = ({ h }: { h: number }) => <Delayed><VStack gap={2}><Skeleton width={120} height={16} radius={1} /><Skeleton width="100%" height={h} radius={2} /></VStack></Delayed>

// WP-227: ccusage's live block. Its window is an estimate (ccusage's own, not the plan's reset), so it is labelled so.
const BlockLine = ({ b }: { b: Block | null }) => b && b.tokens != null && b.costUSD != null
  ? <Text size="sm" type="supporting">{`Block (est.): ${fmtTok(b.tokens)} · ${fmtUsd(b.costUSD)}${b.tokensPerMinute != null ? ` · ${fmtTok(Math.round(b.tokensPerMinute))}/min` : ''}`}</Text>
  : null

// Overview: just the 5-hour and weekly bars.
export function UsageBars() {
  const q = useUsage()
  // No Retry button here: this renders inside a clickable Overview card.
  if (!q.data) return q.isError ? <Text type="supporting" size="sm">Claude usage unavailable</Text> : <Loading h={40} />
  const l = q.data.limits
  if (!l) return <Text type="supporting" size="sm">No plan limits file (~/.cache/ccstatusline/usage.json)</Text>
  return (
    <VStack gap={2}>
      {([['5-hour', l.session, l.sessionResetAt], ['Weekly', l.weekly, l.weeklyResetAt]] as const).map(([label, pct, at]) => (
        <VStack key={label} gap={0.5}>
          <HStack justify="between" gap={2}>
            <Text size="sm">{label}</Text>
            <Text size="sm" type="supporting">{`${pct == null ? '—' : `${pct}%`}${at ? ` · resets in ${until(at)}` : ''}`}</Text>
          </HStack>
          <ProgressBar label={`${label} usage`} isLabelHidden value={pct ?? 0} max={100} variant={(pct ?? 0) >= 90 ? 'error' : (pct ?? 0) >= 70 ? 'warning' : 'accent'} />
        </VStack>
      ))}
      {l.stale && <Badge variant="warning" label={`stale — updated ${ago(l.ageSec)}`} />}
      <BlockLine b={q.data.block} />
    </VStack>
  )
}

// Settings › Usage: limits with reset times, plus the Agent/Project/Model token breakdown.
export function UsageBreakdown() {
  const q = useUsage()
  const [range, setRange] = useState<Range>('today')
  const [by, setBy] = useState<By>('agent')
  if (!q.data) return q.isError ? <LoadError what="Claude usage" error={q.error} retry={() => q.refetch()} /> : <Loading h={120} />
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
      </Grid>
      {q.data.block && (
        <Card padding={3}>
          <VStack gap={1}>
            <HStack gap={2} align="center" wrap="wrap">
              <Text weight="semibold">Current block</Text>
              <Badge label="ccusage estimate" />
            </HStack>
            <BlockLine b={q.data.block} />
            {q.data.block.costPerHour != null && <Text size="sm" type="supporting">{`Burn ${fmtUsd(q.data.block.costPerHour)}/h`}</Text>}
            {q.data.block.projTokens != null && q.data.block.projCost != null && (
              <Text size="sm" type="supporting">{`Projected by block end: ${fmtTok(q.data.block.projTokens)} · ${fmtUsd(q.data.block.projCost)}${q.data.block.remainingMinutes != null ? ` (${q.data.block.remainingMinutes} min left)` : ''}`}</Text>
            )}
            <Text size="sm" type="supporting">The block window is ccusage's own estimate and can differ from the plan's real reset above.</Text>
          </VStack>
        </Card>
      )}
      <Card padding={3}>
          <VStack gap={2}>
            <HStack justify="between" align="center" wrap="wrap" gap={2}>
              <SegmentedControl label="Range" value={range} onChange={(v) => setRange(v as Range)} size="sm">
                <SegmentedControlItem value="today" label="Today" />
                <SegmentedControlItem value="week" label="7 days" />
                <SegmentedControlItem value="month" label="30 days" />
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
    </VStack>
  )
}

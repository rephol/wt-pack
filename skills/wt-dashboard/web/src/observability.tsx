// Settings › Observability: what the Jev integrations actually did (from jev-calls.jsonl, written by every
// judge() call — CLIs and server alike), the dashboard's source health, and a read-only tail of the server log.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Selector } from '@astryxdesign/core/Selector'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { api } from './rooms'
import { useConfig, JevSwitch } from './integrations'
import { Delayed, LoadError, FieldsSkeleton } from './skeletons'
import { fmtTok, fmtUsd } from './usage'

type Stat = { feature: string; calls: number; cacheHits: number; failOpen: number; picked: number; errorRate: number; timeoutRate: number; p50ms: number | null; p95ms: number | null }
type Call = { ts: string; feature: string; outcome: 'picked' | 'not' | 'failopen'; p: number | null; ms: number; cache: boolean; err: string | null; in: string; snippet?: string }
type Source = { ok: boolean | null; lastOkAt: string | null; lastError: { at: string; message: string } | null }
type Route = { skill: string; tier: string; picks: number; applied: number; sendBack: number; returned: number; escalated: number; ok: number }
type Savings = { tokens: number; cost: number; priced: boolean; n: number }
interface Obs { stats: Record<'24h' | '7d', Stat[]>; recent: Call[]; features: string[]; sources: Record<string, Source>; routing?: Route[]; routingSavings?: Savings }

const ALL = ''
const opts = (xs: string[], all: string) => [{ value: ALL, label: all }, ...xs.map((x) => ({ value: x, label: x }))]
const pct = (n: number) => `${Math.round(n * 100)}%`
const time = (ts: string) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
// Native tables in a native scroller: they stay readable at 390px by scrolling sideways inside the box, not the page.
const box = { overflowX: 'auto', maxWidth: '100%' } as const
const STAT_COLS = ['Feature', 'Calls', 'Cache', 'Fail-open', 'Picked', 'Errors', 'Timeouts', 'p50', 'p95']
const RECENT_COLS = ['Time', 'Feature', 'Outcome', 'p', 'ms', 'Error', 'Input']
const ROUTE_COLS = ['Skill', 'Tier', 'Picks', 'Applied', 'Send-backs', 'Returns', 'Escalations', 'Merged']
const cell = { padding: '4px 8px', textAlign: 'start', whiteSpace: 'nowrap', fontSize: 13 } as const

export function ObservabilitySection() {
  return (
    <VStack gap={6}>
      <Integrations />
      <ServerLogs />
    </VStack>
  )
}

function Integrations() {
  const [range, setRange] = useState<'24h' | '7d'>('24h')
  const [f, setF] = useState({ feature: ALL, outcome: ALL, err: ALL })
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString()
  const q = useQuery({ queryKey: ['observability', qs], queryFn: () => api<Obs>(`/api/observability${qs ? `?${qs}` : ''}`), refetchInterval: 15_000, placeholderData: (p) => p })
  const cfg = useConfig()
  if (!q.data) return q.isError ? <LoadError what="observability" error={q.error} retry={() => q.refetch()} /> : <Delayed><FieldsSkeleton n={4} /></Delayed>
  const stats = q.data.stats[range]
  return (
    <VStack gap={4}>
      <HStack gap={2} align="center" justify="between" wrap="wrap">
        <Heading level={4}>Jev calls by feature</Heading>
        <SegmentedControl label="Range" value={range} onChange={(v) => setRange(v as '24h' | '7d')} size="sm">
          <SegmentedControlItem value="24h" label="24h" />
          <SegmentedControlItem value="7d" label="7 days" />
        </SegmentedControl>
      </HStack>
      {stats.length === 0 ? <Text type="supporting" size="sm">No Jev calls in this range.</Text> : (
        <div className="hd-obs-box" style={{ ...box, maxHeight: 320, overflowY: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{STAT_COLS.map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
            <tbody>{stats.map((s) => (
              <tr key={s.feature}>
                <td style={cell}><code>{s.feature}</code></td><td style={cell}>{s.calls}</td><td style={cell}>{s.cacheHits}</td>
                <td style={cell}>{s.failOpen}</td><td style={cell}>{s.picked}</td><td style={cell}>{pct(s.errorRate)}</td><td style={cell}>{pct(s.timeoutRate)}</td>
                <td style={cell}>{s.p50ms == null ? '—' : `${s.p50ms} ms`}</td><td style={cell}>{s.p95ms == null ? '—' : `${s.p95ms} ms`}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      <Heading level={4}>Model routing (7 days)</Heading>
      {!q.data.routing?.length ? <Text type="supporting" size="sm">No routing decisions yet. Shadow mode logs them without applying.</Text> : (
        <VStack gap={2}>
          {q.data.routingSavings && q.data.routingSavings.n > 0 && (
            <Text type="supporting" size="sm">
              {`Estimated savings vs sonnet: ${fmtTok(q.data.routingSavings.tokens)} tokens`}
              {q.data.routingSavings.priced ? `, ${fmtUsd(q.data.routingSavings.cost)} notional` : ''}
              {` over ${q.data.routingSavings.n} applied decision${q.data.routingSavings.n === 1 ? '' : 's'}`}
            </Text>
          )}
          <div className="hd-obs-box" style={{ ...box, maxHeight: 320, overflowY: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>{ROUTE_COLS.map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
              <tbody>{q.data.routing.map((r) => (
                <tr key={`${r.skill}|${r.tier}`}>
                  <td style={cell}><code>{r.skill}</code></td><td style={cell}>{r.tier}</td><td style={cell}>{r.picks}</td><td style={cell}>{r.applied}</td>
                  <td style={cell}>{r.sendBack}</td><td style={cell}>{r.returned}</td><td style={cell}>{r.escalated}</td><td style={cell}>{r.ok}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </VStack>
      )}

      <Heading level={4}>Recent calls</Heading>
      <HStack gap={2} wrap="wrap">
        <div style={{ flex: '1 1 150px' }}><Selector label="Feature" width="100%" value={f.feature} options={opts(q.data.features, 'All features')} onChange={(v: string) => setF({ ...f, feature: v })} /></div>
        <div style={{ flex: '1 1 150px' }}><Selector label="Outcome" width="100%" value={f.outcome} options={opts(['picked', 'not', 'failopen'], 'All outcomes')} onChange={(v: string) => setF({ ...f, outcome: v })} /></div>
        <div style={{ flex: '1 1 150px' }}><Selector label="Error" width="100%" value={f.err} options={opts(['none', 'timeout', 'nokey', 'parse', 'http_401', 'http_429', 'http_500', 'http_0'], 'Any')} onChange={(v: string) => setF({ ...f, err: v })} /></div>
      </HStack>
      {q.data.recent.length === 0 ? <Text type="supporting" size="sm">No calls match.</Text> : (
        <div className="hd-obs-box" style={{ ...box, maxHeight: 320, overflowY: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{RECENT_COLS.map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
            <tbody>{q.data.recent.map((c, i) => (
              <tr key={`${c.ts}-${i}`}>
                <td style={cell}>{time(c.ts)}</td><td style={cell}><code>{c.feature}</code></td>
                <td style={cell}>{c.outcome}{c.cache ? ' (cache)' : ''}</td><td style={cell}>{c.p ?? '—'}</td><td style={cell}>{c.ms}</td>
                <td style={cell}>{c.err ?? '—'}</td><td style={cell} title={c.snippet}><code>{c.in}</code></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <JevSwitch it={cfg.by.WT_JEV_LOG_SNIPPETS} put={cfg.put} description="Also log the first 120 characters of each judged input (off: only a hash). The API key is never logged." />

      <Heading level={4}>Sources</Heading>
      <VStack gap={1}>
        {Object.entries(q.data.sources).map(([name, s]) => (
          <HStack key={name} gap={2} align="center" wrap="wrap">
            <StatusDot variant={s.ok == null ? 'neutral' : s.ok ? 'success' : 'error'} label={`${name} ${s.ok == null ? 'unused' : s.ok ? 'ok' : 'failing'}`} />
            <Text size="sm" weight="medium">{name}</Text>
            <Text size="sm" type="supporting">{s.ok === false && s.lastError ? `${time(s.lastError.at)}: ${s.lastError.message}` : s.lastOkAt ? `ok ${time(s.lastOkAt)}` : 'not used yet'}</Text>
          </HStack>
        ))}
      </VStack>
    </VStack>
  )
}

function ServerLogs() {
  const [filter, setFilter] = useState('')
  const q = useQuery({ queryKey: ['server-log'], queryFn: () => api<{ path: string; lines: string[] }>('/api/logs/server?lines=500') })
  const lines = (q.data?.lines ?? []).filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()))
  return (
    <VStack gap={3}>
      <HStack gap={2} align="center" justify="between" wrap="wrap">
        <Heading level={4}>Server logs</Heading>
        <Button label="Refresh" size="sm" isLoading={q.isFetching} onClick={() => q.refetch()} />
      </HStack>
      <Text type="supporting" size="sm">{`Last 500 lines of ${q.data?.path ?? 'the server log'}, read-only.`}</Text>
      <TextInput label="Filter" isLabelHidden placeholder="Filter lines" value={filter} onChange={setFilter} />
      {q.isError ? <LoadError what="server log" error={q.error} retry={() => q.refetch()} /> : (
        <pre role="region" aria-label="Server log" tabIndex={0} style={{ margin: 0, maxHeight: 360, overflow: 'auto', fontSize: 12, lineHeight: 1.45, padding: 8, borderRadius: 6, background: 'var(--color-background-muted, rgba(128,128,128,.1))' }}>
          {lines.length ? lines.join('\n') : q.isLoading ? 'Loading…' : 'No lines.'}
        </pre>
      )}
    </VStack>
  )
}

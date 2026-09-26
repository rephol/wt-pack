// Shape-matched loading placeholders (Astryx Skeleton, which already drops its shimmer under
// prefers-reduced-motion). Shown only after 150ms so a fast load never flashes; an error replaces them with an
// inline retry; "empty" is decided only once data has loaded, never while loading.
import { useEffect, useState, type ReactNode } from 'react'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { useChatDensity } from './density.ts'

export function Delayed({ children, ms = 150 }: { children: ReactNode; ms?: number }) {
  const [show, setShow] = useState(false)
  useEffect(() => { const t = setTimeout(() => setShow(true), ms); return () => clearTimeout(t) }, [ms])
  return show ? <div aria-busy="true" aria-label="Loading" data-skeleton="">{children}</div> : null
}

export function LoadError({ what, error, retry }: { what: string; error: unknown; retry: () => void }) {
  return <Banner status="error" title={`Could not load ${what}`} description={String(error instanceof Error ? error.message : error)}
    endContent={<Button label="Retry" size="sm" onClick={retry} />} />
}

const Line = ({ w, h = 12, i }: { w: number | string; h?: number; i?: number }) => <Skeleton width={w} height={h} radius={1} index={i} />

// A row: optional avatar, a title line and (optionally) a second line; `height` keeps the real row's height.
export function Rows({ n = 5, height = 44, avatar = 0, lines = 1 }: { n?: number; height?: number; avatar?: number; lines?: 1 | 2 }) {
  return (
    <VStack gap={0}>
      {Array.from({ length: n }, (_, i) => (
        <HStack key={i} gap={3} align="center" style={{ height, padding: '0 12px' }}>
          {avatar > 0 && <Skeleton width={avatar} height={avatar} radius="rounded" index={i} />}
          <VStack gap={1} style={{ flex: 1, minWidth: 0 }}>
            <Line w={`${55 + ((i * 17) % 35)}%`} i={i} />
            {lines === 2 && <Line w={`${30 + ((i * 23) % 40)}%`} h={10} i={i} />}
          </VStack>
          {avatar === 0 && <Line w={56} h={10} i={i} />}
        </HStack>
      ))}
    </VStack>
  )
}

export function OverviewSkeleton() {
  return (
    <VStack gap={4}>
      <HStack gap={3} wrap="wrap">{[0, 1, 2].map((i) => <Skeleton key={i} width={160} height={72} radius={2} index={i} />)}</HStack>
      <HStack gap={3} wrap="wrap">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} width="100%" height={96} radius={2} index={i} />)}</HStack>
    </VStack>
  )
}

export function GroupedRows({ phone }: { phone: boolean }) {
  return (
    <VStack gap={4}>
      {[4, 3].map((n, g) => <VStack key={g} gap={1}><Line w={110} h={14} /><Rows n={n} avatar={28} lines={phone ? 2 : 1} height={phone ? 56 : 44} /></VStack>)}
    </VStack>
  )
}

// Chat bubbles, alternating sides; used only when nothing is cached.
export function ChatSkeleton() {
  const density = useChatDensity()
  const gap = density === 'compact' ? 8 : density === 'spacious' ? 20 : 12
  return (
    <VStack gap={0} style={{ padding: '12px 0', gap }}>
      {[['end', 180, 36], ['start', '80%', 88], ['start', '60%', 44], ['end', 240, 36], ['start', '75%', 120]].map(([side, w, h], i) => (
        <HStack key={i} justify={side === 'end' ? 'end' : 'start'}><Skeleton width={w} height={h as number} radius={3} index={i} /></HStack>
      ))}
    </VStack>
  )
}

export function FieldsSkeleton({ n = 3 }: { n?: number }) {
  return <VStack gap={4}>{Array.from({ length: n }, (_, i) => <VStack key={i} gap={2}><Line w={140} i={i} /><Skeleton width="100%" height={36} radius={2} index={i} /></VStack>)}</VStack>
}

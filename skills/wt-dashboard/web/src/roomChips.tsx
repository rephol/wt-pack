// The chip row above a room's ChatComposer (WP-164 U4, decision 5): one chip per open item, either a wt-ask
// in this room or a mirrored native picker ('B') from an agent that is a member of this room. Sideways-
// scrolling, oldest first; on a phone more than 3 chips collapse into one "N questions" chip with a list.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Token } from '@astryxdesign/core/Token'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Popover } from '@astryxdesign/core/Popover'
import { Text } from '@astryxdesign/core/Text'
import { api } from './rooms'
import type { Ask } from './questionPopup'
import type { Picker, PickerAgent } from './pickerCard'

// Only the fields this row needs off the live agent list — the full Agent (App.tsx) satisfies this structurally.
interface ChipAgent extends PickerAgent { name: string }
interface ChipTarget { id: string; ts: number; label: string; agent: string; open: () => void }

function seenKey(id: string) { return `wt-ask-seen:${id}` }
// Persisted per viewer (localStorage), never read back by the server: only stops a chip's pulse once shown.
function markSeen(id: string) { try { localStorage.setItem(seenKey(id), '1') } catch { /* private mode */ } }
function wasSeen(id: string) { try { return localStorage.getItem(seenKey(id)) === '1' } catch { return false } }

export function useRoomChips(roomSlug: string, members: string[], onOpen: (target: { kind: 'ask'; ask: Ask } | { kind: 'picker'; agent: PickerAgent; picker: Picker }) => void): ChipTarget[] {
  const asksQ = useQuery({
    queryKey: ['asks', roomSlug],
    queryFn: () => api<Ask[]>(`/api/asks?room=${encodeURIComponent(roomSlug)}&open=1`),
    refetchInterval: 5000, refetchIntervalInBackground: true,
  })
  // Shares the same query ['overview'] App.tsx already polls at 4s — this just adds an observer, not a new fetch cadence.
  const overviewQ = useQuery({
    queryKey: ['overview'],
    queryFn: () => api<{ agents: ChipAgent[] }>('/api/overview'),
    refetchInterval: 4000,
  })
  const asks = asksQ.data ?? []
  const pickers = (overviewQ.data?.agents ?? []).filter((a) => a.picker && members.includes(a.name))
  const items: ChipTarget[] = [
    ...asks.map((a) => ({
      id: `ask:${a.id}`, ts: Date.parse(a.created ?? '') || 0, agent: a.agent,
      label: `${a.agent} · ${a.questions[0]?.header ?? a.ticket ?? 'question'}`,
      open: () => { markSeen(`ask:${a.id}`); onOpen({ kind: 'ask', ask: a }) },
    })),
    ...pickers.map((a) => ({
      id: `picker:${a.key}`, ts: 0, agent: a.name,
      label: `${a.name} · ${a.picker?.review ? 'Review' : a.picker?.question?.slice(0, 40) ?? 'Question'}`,
      open: () => { markSeen(`picker:${a.key}`); onOpen({ kind: 'picker', agent: a, picker: a.picker! }) },
    })),
  ]
  return items.sort((x, y) => x.ts - y.ts)
}

function Chip({ item }: { item: ChipTarget }) {
  return <Token size="sm" label={`? ${item.label}`} icon={<StatusDot variant="warning" label="Needs an answer" isPulsing={!wasSeen(item.id)} />} onClick={item.open} />
}

export function RoomChips({ items, phone }: { items: ChipTarget[]; phone: boolean }) {
  const [listOpen, setListOpen] = useState(false)
  if (!items.length) return null
  const collapsed = phone && items.length > 3
  if (!collapsed) return <HStack gap={2} style={{ overflowX: 'auto', flexShrink: 0 }}>{items.map((it) => <Chip key={it.id} item={it} />)}</HStack>
  const list = (
    <VStack gap={1} padding={2}>
      {items.map((it) => (
        <Text key={it.id} size="sm" style={{ cursor: 'pointer' }} onClick={() => { setListOpen(false); it.open() }}>{`? ${it.label}`}</Text>
      ))}
    </VStack>
  )
  return (
    <HStack style={{ flexShrink: 0 }}>
      <Popover placement="above" alignment="start" content={list} isOpen={listOpen} onOpenChange={setListOpen}>
        <Token size="sm" label={`${items.length} questions`} icon={<StatusDot variant="warning" label="Needs an answer" isPulsing={items.some((it) => !wasSeen(it.id))} />} onClick={() => setListOpen(true)} />
      </Popover>
    </HStack>
  )
}

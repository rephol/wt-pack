// Quick switcher: a floating button (bottom-right) and ⌘K / Ctrl+K open one list of agent conversations and rooms
// that need you. Phone: a BottomSheet. Desktop: a Popover anchored to the button (kept mounted, just invisible,
// while hidden, so ⌘K still has an anchor). Picking an agent opens its panel, which focuses the composer.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Popover } from '@astryxdesign/core/Popover'
import { BottomSheet } from '@astryxdesign/core/BottomSheet'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { shortAgo } from './notifyGate'
import { activityOf } from './agentSort'

export interface SwAgent { key: string; name: string; status: 'working' | 'idle' | 'blocked' | 'done' | 'unknown'; asks: boolean; statusSince: number; lastActivity?: number; recap: string | null; question: string | null }
export interface SwRoom { slug: string; title: string; needsYou?: { agent: string; text: string }[] }

const RECENT_KEY = 'recent-agents'
export const loadRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] } }
export function rememberRecent(key: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...loadRecent().filter((k) => k !== key)].slice(0, 5))) } catch { /* private mode */ }
}
const needs = (a: SwAgent) => a.asks && a.status !== 'working'
const DOT = { working: 'accent', idle: 'neutral', blocked: 'error', done: 'success', unknown: 'neutral' } as const

// A dialog other than our own sheet/popover is open (settings, inbox drawer, agent panel on a phone, …).
function useOtherDialogOpen(mine: boolean) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const check = () => setOpen([...document.querySelectorAll('[role="dialog"], dialog[open]')].some((d) => !d.closest('[data-switcher]')))
    const mo = new MutationObserver(check)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'role'] })
    check()
    return () => mo.disconnect()
  }, [mine])
  return open
}

export function QuickSwitcher({ agents, rooms, phone, hidden, onOpenAgent, onOpenRoom }: {
  agents: SwAgent[]; rooms: SwRoom[]; phone: boolean; hidden: boolean
  onOpenAgent: (key: string) => void; onOpenRoom: (slug: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const otherDialog = useOtherDialogOpen(open)
  const show = !hidden && (!otherDialog || open)
  const needCount = agents.filter(needs).length

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o) }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [])
  useEffect(() => { if (!open) setQ('') }, [open])

  const pick = (fn: () => void) => { setOpen(false); fn() }
  const body = <SwitcherList agents={agents} rooms={rooms} q={q} setQ={setQ} autoFocus={!phone}
    onAgent={(k) => pick(() => onOpenAgent(k))} onRoom={(s) => pick(() => onOpenRoom(s))} />

  const fab = (props: Record<string, unknown> = {}) => (
    <button type="button" aria-label={`Agent conversations${needCount ? ` (${needCount} need you)` : ''} (⌘K)`} {...props}
      onClick={() => setOpen((o) => !o)}
      style={{
        position: 'fixed', right: 16, bottom: 'calc(16px + env(safe-area-inset-bottom))', zIndex: 40, width: 56, height: 56, borderRadius: 28,
        border: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center',
        background: 'var(--color-background-accent, #3b82f6)', color: 'var(--color-text-on-accent, #fff)', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
        visibility: show ? 'visible' : 'hidden', pointerEvents: show ? 'auto' : 'none',
      }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {needCount > 0 && (
        <span aria-hidden style={{ position: 'absolute', top: -2, right: -2, minWidth: 20, height: 20, padding: '0 5px', borderRadius: 10, fontSize: 12, fontWeight: 700, lineHeight: '20px', background: 'var(--color-background-error, #dc2626)', color: '#fff' }}>{needCount}</span>
      )}
    </button>
  )

  if (phone) return (
    <>
      {fab()}
      <div data-switcher>
        <BottomSheet label="Agent conversations" isOpen={open} onOpenChange={setOpen} height="large"><div style={{ paddingTop: 16 }}>{body}</div></BottomSheet>
      </div>
    </>
  )
  return (
    <Popover isOpen={open} onOpenChange={setOpen} placement="above" alignment="end" width={380} label="Agent conversations"
      content={<div data-switcher style={{ maxHeight: 'min(70vh, 560px)', overflowY: 'auto', padding: 4 }}>{body}</div>}>
      {(p) => fab({ ref: p.ref })}
    </Popover>
  )
}

function Row({ dot, pulse, title, age, line, onClick }: { dot: keyof typeof DOT | 'needs'; pulse?: boolean; title: string; age?: string; line?: string | null; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="hd-switch-row"
      style={{ all: 'unset', boxSizing: 'border-box', display: 'block', width: '100%', padding: '8px 10px', borderRadius: 8, cursor: 'pointer' }}>
      <HStack gap={2} align="center">
        <StatusDot variant={dot === 'needs' ? 'error' : DOT[dot]} label={dot} isPulsing={pulse} />
        <Text weight="medium" maxLines={1}>{title}</Text>
        {age && <Text type="supporting" size="sm" style={{ marginInlineStart: 'auto', flexShrink: 0 }}>{age}</Text>}
      </HStack>
      {line && <Text type="supporting" size="sm" maxLines={1} hasTruncateTooltip={false}>{line}</Text>}
    </button>
  )
}

function SwitcherList({ agents, rooms, q, setQ, autoFocus, onAgent, onRoom }: {
  agents: SwAgent[]; rooms: SwRoom[]; q: string; setQ: (s: string) => void; autoFocus: boolean
  onAgent: (key: string) => void; onRoom: (slug: string) => void
}) {
  const input = useRef<HTMLDivElement>(null)
  useEffect(() => { if (autoFocus) setTimeout(() => input.current?.querySelector('input')?.focus(), 30) }, [autoFocus])
  const sections = useMemo(() => {
    const m = q.trim().toLowerCase()
    const hit = (s: string | null | undefined) => !m || (s ?? '').toLowerCase().includes(m)
    const list = agents.filter((a) => hit(a.name) || hit(a.recap) || hit(a.question))
    const byActivity = [...list].sort((x, y) => activityOf(y) - activityOf(x))
    const byKey = new Map(list.map((a) => [a.key, a]))
    const rs = rooms.filter((r) => r.needsYou?.length && (hit(r.title) || hit(r.slug)))
    return [
      { title: 'Needs you', agents: byActivity.filter(needs) },
      { title: 'Recent', agents: loadRecent().map((k) => byKey.get(k)).filter((a): a is SwAgent => Boolean(a)) },
      { title: 'Working', agents: byActivity.filter((a) => a.status === 'working') },
      { title: 'All agents', agents: byActivity },
      { title: 'Rooms', rooms: rs },
    ]
  }, [agents, rooms, q])
  const empty = sections.every((s) => !(s.agents?.length || s.rooms?.length))
  return (
    <VStack gap={2}>
      <div ref={input}><TextInput label="Search agents and rooms" isLabelHidden placeholder="Search agents and rooms" value={q} onChange={setQ} /></div>
      {empty && <Text type="supporting" size="sm">Nothing matches.</Text>}
      {sections.map((s) => (s.agents?.length || s.rooms?.length) ? (
        <VStack key={s.title} gap={0}>
          <Text type="supporting" size="sm" weight="semibold" style={{ padding: '4px 10px' }}>{s.title}</Text>
          {s.agents?.map((a) => (
            <Row key={a.key} dot={needs(a) ? 'needs' : a.status} pulse={a.status === 'working'} title={a.name}
              age={shortAgo(new Date(activityOf(a)).toISOString())} line={needs(a) ? a.question : a.recap} onClick={() => onAgent(a.key)} />
          ))}
          {s.rooms?.map((r) => (
            <Row key={r.slug} dot="needs" title={`# ${r.title}`} line={r.needsYou?.[0] ? `${r.needsYou[0].agent}: ${r.needsYou[0].text}` : null} onClick={() => onRoom(r.slug)} />
          ))}
        </VStack>
      ) : null)}
    </VStack>
  )
}

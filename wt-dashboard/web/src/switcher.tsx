// Quick switcher: a floating button (bottom-right) and ⌘K / Ctrl+K open Astryx's CommandPalette over agent
// conversations and rooms (grouping, keyboard ↑/↓/Enter/Esc and the active row are the palette's).
// Desktop: the palette's own centered dialog. Phone: the same palette inline in a full-height BottomSheet.
import { useEffect, useMemo, useRef, useState } from 'react'
import { CommandPalette } from '@astryxdesign/core/CommandPalette'
import { BottomSheet } from '@astryxdesign/core/BottomSheet'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { HStack } from '@astryxdesign/core/HStack'
import { shortAgo } from './notifyGate'
import { switcherItems, needsYou, agentInitials, type SwAgent, type SwItem, type SwRoom } from './switcherData'
import { Delayed, Rows } from './skeletons'
import { useRoles } from './roles'

export type { SwAgent, SwRoom }
const RECENT_KEY = 'recent-agents'
export const loadRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] } }
export function rememberRecent(key: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...loadRecent().filter((k) => k !== key)].slice(0, 5))) } catch { /* private mode */ }
}
const DOT = { working: 'accent', idle: 'neutral', blocked: 'error', done: 'success', unknown: 'neutral' } as const

// A dialog other than our own palette/sheet is open (settings, inbox drawer, agent panel on a phone, …).
function useOtherDialogOpen(mine: boolean) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const check = () => setOpen([...document.querySelectorAll('[role="dialog"], dialog[open]')].some((d) => !d.closest('[data-switcher]') && !d.querySelector('[data-switcher]')))
    const mo = new MutationObserver(check)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'role'] })
    check()
    return () => mo.disconnect()
  }, [mine])
  return open
}

function Row({ it, phone }: { it: SwItem; phone: boolean }) {
  const { byId } = useRoles()
  const d = it.auxiliaryData!
  const a = d.kind === 'agent' ? d.agent : null
  // No question and no recap: a single-line row (the old "idle · no recent summary" line was noise); same height.
  const line = a && !a.recap && !(needsYou(a) && a.question) ? null : d.line
  const av = phone ? 32 : 28
  return (
    <div data-switcher style={{ display: 'flex', alignItems: 'center', gap: phone ? 10 : 12, minHeight: phone ? 44 : 52, padding: '0 4px', minWidth: 0, width: '100%' }}>
      <div style={{ position: 'relative', flex: `0 0 ${av}px`, width: av, height: av, borderRadius: av / 2, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 600, background: 'var(--color-background-secondary, rgba(128,128,128,.18))' }}>
        {a ? agentInitials(a.name, a.local ? byId(a.pool).letter : undefined) : '#'}
        {(a || line) && <span style={{ position: 'absolute', right: -2, bottom: -2, lineHeight: 0 }}>
          <StatusDot variant={!a || needsYou(a) ? 'error' : DOT[a.status]} label={a ? (needsYou(a) ? 'needs you' : a.status) : 'waiting on you'} isPulsing={a?.status === 'working'} />
        </span>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text weight="medium" maxLines={1} hasTruncateTooltip={false}>{it.label}</Text>
        {line && <Text type="supporting" size="sm" maxLines={1} hasTruncateTooltip={false}>{line}</Text>}
      </div>
      {a && (
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Text type="supporting" size="sm">{shortAgo(new Date(a.lastActivity || a.statusSince).toISOString())}</Text>
          {!phone && <Badge label={a.local ? byId(a.pool).name : a.machine} />}
        </div>
      )}
    </div>
  )
}

export function QuickSwitcher({ agents, rooms, phone, hidden, loading = false, onOpenAgent, onOpenRoom }: {
  agents: SwAgent[]; rooms: SwRoom[]; phone: boolean; hidden: boolean; loading?: boolean
  onOpenAgent: (key: string, full?: boolean) => void; onOpenRoom: (slug: string) => void
}) {
  const [open, setOpen] = useState(false)
  // ⌘Enter / Ctrl+Enter on a row opens the agent as a full page (the palette reports only which row).
  const fullPick = useRef(false)
  useEffect(() => {
    if (!open) return
    const on = (e: KeyboardEvent) => { if (e.key === 'Enter') fullPick.current = e.metaKey || e.ctrlKey }
    addEventListener('keydown', on, true)
    return () => removeEventListener('keydown', on, true)
  }, [open])
  const otherDialog = useOtherDialogOpen(open)
  const show = !hidden && !open && !otherDialog
  const needCount = agents.filter(needsYou).length

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o) }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [])

  // A fresh snapshot per open, so Recent reflects the last pick.
  const source = useMemo(() => {
    const recent = loadRecent()
    return { bootstrap: () => switcherItems(agents, rooms, recent), search: (q: string) => switcherItems(agents, rooms, recent, q) }
  }, [agents, rooms, open]) // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (id: string) => {
    setOpen(false)
    const full = fullPick.current
    fullPick.current = false
    if (id.startsWith('agent:')) onOpenAgent(id.slice(6), full)
    else if (id.startsWith('room:')) onOpenRoom(id.slice(5))
  }
  const palette = (inline: boolean) => (
    <CommandPalette<SwItem> isOpen={open} onOpenChange={setOpen} searchSource={source} label="Agent conversations"
      value="" onValueChange={pick} renderItem={(it) => <Row it={it} phone={phone} />}
      footer={phone ? false : <div style={{ padding: '8px 12px' }}><Text type="supporting" size="sm">↑↓ navigate · ↩ open · ⌘↩ full page · esc close</Text></div>}
      emptySearchText="No agent or room matches" emptyBootstrapText={loading ? <Delayed><Rows n={6} avatar={phone ? 32 : 28} height={phone ? 48 : 52} /></Delayed> : 'No agents yet'}
      isInline={inline} width={inline ? '100%' : 640} maxHeight={inline ? '100%' : 'min(560px, 80vh)'} />
  )

  return (
    <>
      <button type="button" aria-label={`Agent conversations${needCount ? ` (${needCount} need you)` : ''} (⌘K)`}
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed', right: 16, bottom: 'calc(16px + env(safe-area-inset-bottom))', zIndex: 40, width: 56, height: 56, borderRadius: 28,
          border: 'none', cursor: 'pointer', display: show ? 'grid' : 'none', placeItems: 'center',
          background: 'var(--color-background-accent, #3b82f6)', color: 'var(--color-text-on-accent, #fff)', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
        }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {needCount > 0 && (
          <span aria-hidden style={{ position: 'absolute', top: -2, right: -2, minWidth: 20, height: 20, padding: '0 5px', borderRadius: 10, fontSize: 12, fontWeight: 700, lineHeight: '20px', background: 'var(--color-background-error, #dc2626)', color: '#fff' }}>{needCount}</span>
        )}
      </button>
      {phone
        ? <BottomSheet label="Agent conversations" isOpen={open} onOpenChange={setOpen} height="85dvh">
            <div data-switcher data-switcher-phone style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, paddingBottom: 'env(safe-area-inset-bottom)' }}>
              <HStack justify="end" style={{ flexShrink: 0, marginTop: -4 }}>
                <IconButton label="Close" icon={<Icon icon="close" />} variant="ghost" onClick={() => setOpen(false)} style={{ minWidth: 44, minHeight: 44 }} />
              </HStack>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{open && palette(true)}</div>
            </div>
          </BottomSheet>
        : <div data-switcher>{palette(false)}</div>}
    </>
  )
}

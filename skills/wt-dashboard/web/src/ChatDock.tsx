// WP-112 chat dock (desktop): a full-width footer bar holding a tab per open agent or room chat; an open chat's
// window pops up above its tab (at most MAX_WINDOWS). A minimised tab renders no chat body, so after the stream's
// 30s grace it fetches nothing; its dot and unread marker come from the overview and rooms polls App already runs.
// While the bar shows, <html> carries hd-has-dock: the app shell, toasts and the ⌘K button make room for it.
import { useEffect, type ReactNode } from 'react'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Text } from '@astryxdesign/core/Text'
import type { DockAction, DockState } from './dock'

export type DockMeta = { name: string; dot: 'error' | 'success' | 'warning' | 'neutral' | 'accent'; label: string; pulsing?: boolean }

export function Dock({ state, dispatch, meta, unread, body, onExpand }: {
  state: DockState; dispatch: (a: DockAction) => void; meta: (key: string) => DockMeta; unread: Record<string, 'dot' | '!'>
  body: (key: string) => ReactNode; onExpand: (key: string) => void
}) {
  const shown = state.items.length > 0
  useEffect(() => {
    document.documentElement.classList.toggle('hd-has-dock', shown)
    return () => document.documentElement.classList.remove('hd-has-dock')
  }, [shown])
  if (!shown) return null
  const act = (type: DockAction['type'], key: string) => dispatch({ type, key, now: Date.now() })
  // ⌘K is the switcher's own shortcut; the bar's button presses it (the floating button is hidden while the bar shows).
  const switcher = () => dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: !/Mac/.test(navigator.platform) }))
  return (
    <div className="hd-dock" role="toolbar" aria-label="Chat dock">
      <div className="hd-dock-slots">{state.items.map((i) => {
        const m = meta(i.key), u = unread[i.key]
        return (
          <div key={i.key} className="hd-dock-slot" data-open={i.min ? undefined : ''} data-unread={u ?? undefined}>
            <button type="button" className="hd-dock-tab" title={i.min ? `Open ${m.name}` : `Minimise ${m.name}`} aria-expanded={!i.min} onClick={() => act(i.min ? 'open' : 'minimise', i.key)}>
              <StatusDot variant={m.dot} label={m.label} isPulsing={m.pulsing} />
              <Text size="sm" weight={u || !i.min ? 'semibold' : undefined} maxLines={1}>{m.name}</Text>
              {u && <span className="hd-dock-unread" aria-label={u === '!' ? 'needs you' : 'unread'}>{u === '!' ? '!' : ''}</span>}
            </button>
            <IconButton label={`Close ${m.name}`} icon={<Icon icon="close" size="sm" />} size="sm" variant="ghost" onClick={() => act('close', i.key)} />
            {!i.min && (
              <section className="hd-dock-win" aria-label={`Chat ${m.name}`}
                onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented && !(e.target as HTMLElement).closest('dialog')) act('minimise', i.key) }}>
                <header className="hd-dock-win-head">
                  <StatusDot variant={m.dot} label={m.label} isPulsing={m.pulsing} />
                  <Text size="sm" weight="semibold" maxLines={1}>{m.name}</Text>
                  <span style={{ flex: 1 }} />
                  <IconButton label="Minimise" tooltip="Minimise (Esc)" icon={<span aria-hidden style={{ fontWeight: 700 }}>–</span>} size="sm" variant="ghost" onClick={() => act('minimise', i.key)} />
                  <IconButton label="Expand" tooltip={i.kind === 'agent' ? 'Open in the side panel' : 'Open the room page'} icon={<ExpandIcon />} size="sm" variant="ghost" onClick={() => { act('close', i.key); onExpand(i.key) }} />
                  <IconButton label="Close" tooltip="Close" icon={<Icon icon="close" size="sm" />} size="sm" variant="ghost" onClick={() => act('close', i.key)} />
                </header>
                <div className="hd-dock-win-body">{body(i.key)}</div>
              </section>
            )}
          </div>
        )
      })}</div>
      {/* WP-113: right to left — the button far right, the newest chat just left of it (DOM order = visual = Tab order) */}
      <button type="button" className="hd-dock-chats" title="Open a chat (⌘K)" onClick={switcher}><ChatIcon /><Text size="sm">Chats</Text></button>
    </div>
  )
}

const ExpandIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
)
const ChatIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

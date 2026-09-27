// WP-112 chat dock (desktop): open agent and room chats along the bottom right, each a compact window (at most
// MAX_WINDOWS) or a minimised tab. A tab renders no chat body, so after the stream's 30s grace it fetches nothing;
// its dot and unread marker come from the overview and rooms polls App already runs.
import type { ReactNode } from 'react'
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
  if (!state.items.length) return null
  const act = (type: DockAction['type'], key: string) => dispatch({ type, key, now: Date.now() })
  const wins = state.items.filter((i) => !i.min).sort((a, b) => a.openedAt - b.openedAt)
  const tabs = state.items.filter((i) => i.min)
  return (
    <div className="hd-dock" aria-label="Chat dock">
      {tabs.length > 0 && <div className="hd-dock-tabs">{tabs.map((i) => {
        const m = meta(i.key), u = unread[i.key]
        return (
          <div key={i.key} className="hd-dock-tab" data-unread={u ?? undefined}>
            <button type="button" className="hd-dock-tab-open" title={`Open ${m.name}`} onClick={() => act('open', i.key)}>
              <StatusDot variant={m.dot} label={m.label} isPulsing={m.pulsing} />
              <Text size="sm" weight={u ? 'semibold' : undefined} maxLines={1}>{m.name}</Text>
              {u && <span className="hd-dock-unread" aria-label={u === '!' ? 'needs you' : 'unread'}>{u === '!' ? '!' : ''}</span>}
            </button>
            <IconButton label={`Close ${m.name}`} icon={<Icon icon="close" size="sm" />} size="sm" variant="ghost" onClick={() => act('close', i.key)} />
          </div>
        )
      })}</div>}
      {wins.map((i) => {
        const m = meta(i.key)
        return (
          <section key={i.key} className="hd-dock-win" aria-label={`Chat ${m.name}`}>
            <header className="hd-dock-win-head">
              <StatusDot variant={m.dot} label={m.label} isPulsing={m.pulsing} />
              <button type="button" className="hd-dock-win-title" title="Minimise" onClick={() => act('minimise', i.key)}><Text size="sm" weight="semibold" maxLines={1}>{m.name}</Text></button>
              <IconButton label="Minimise" tooltip="Minimise" icon={<span aria-hidden style={{ fontWeight: 700 }}>–</span>} size="sm" variant="ghost" onClick={() => act('minimise', i.key)} />
              <IconButton label="Expand" tooltip={i.kind === 'agent' ? 'Open in the side panel' : 'Open the room page'} icon={<ExpandIcon />} size="sm" variant="ghost" onClick={() => { act('close', i.key); onExpand(i.key) }} />
              <IconButton label="Close" tooltip="Close" icon={<Icon icon="close" size="sm" />} size="sm" variant="ghost" onClick={() => act('close', i.key)} />
            </header>
            <div className="hd-dock-win-body">{body(i.key)}</div>
          </section>
        )
      })}
    </div>
  )
}

const ExpandIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
)

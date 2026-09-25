// Settings › Conversation "Chat density", applied to agent conversations and rooms; remembered per browser.
// Astryx's ChatMessageList density is inherited by its messages; Markdown has only default/compact.
import { useSyncExternalStore } from 'react'

export type ChatDensity = 'compact' | 'balanced' | 'spacious'
const KEY = 'chat-density'
const read = (): ChatDensity => { try { const v = localStorage.getItem(KEY); return v === 'compact' || v === 'spacious' ? v : 'balanced' } catch { return 'balanced' } }
let current = read()
const subs = new Set<() => void>()
export function setChatDensity(d: ChatDensity) {
  current = d
  try { localStorage.setItem(KEY, d) } catch { /* private mode */ }
  subs.forEach((f) => f())
}
export const useChatDensity = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => current, () => current)
export const markdownDensity = (d: ChatDensity) => (d === 'compact' ? 'compact' : 'default')

// Enter in the chat composers. Desktop: Enter sends, Shift+Enter is a newline. Touch keyboards have no
// Shift, so there Enter is a newline and only the Send button (or ⌘/Ctrl+Enter) sends.
// IME: an Enter that commits a composition (isComposing / keyCode 229, e.g. Android keyboards,
// Indonesian/CJK input) is left alone; Astryx never submits on it either.
import type { KeyboardEvent } from 'react'

export const TOUCH = typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches)

export function composerEnter(e: KeyboardEvent<Element>) {
  if (!TOUCH || e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey) return
  if (e.nativeEvent.isComposing || e.keyCode === 229) return
  e.preventDefault() // suppresses Astryx's submit, and the browser's own line insertion with it
  document.execCommand('insertLineBreak') // fires input → the composer's onChange
}

// The keyboard's return key label: "send" where Enter sends, "enter" where it makes a newline.
export function installEnterKeyHint() {
  addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement
    if (el?.getAttribute?.('aria-label') === 'Message input') el.setAttribute('enterkeyhint', TOUCH ? 'enter' : 'send')
  })
}

// Astryx's @ and / menus open only after a ' ' or newline, but a composer chip is followed by an NBSP — so typing @
// straight after a mention chip never opened the menu (one mention per message, in practice). Before a trigger
// character lands after an NBSP, swap it for a plain space (the composer is white-space: pre-wrap).
export function installChipTriggerFix() {
  addEventListener('beforeinput', (e) => {
    const el = e.target as HTMLElement
    if ((e.data !== '@' && e.data !== '/') || el?.getAttribute?.('aria-label') !== 'Message input') return
    const sel = getSelection()
    if (!sel?.rangeCount || !sel.isCollapsed) return
    let node: Node | null = sel.anchorNode
    let off = sel.anchorOffset
    if (node && node.nodeType !== Node.TEXT_NODE) { node = node.childNodes[off - 1] ?? null; off = node?.textContent?.length ?? 0 }
    if (node?.nodeType !== Node.TEXT_NODE || off < 1 || (node as Text).data[off - 1] !== ' ') return
    ;(node as Text).replaceData(off - 1, 1, ' ')
    sel.collapse(node, off)
  }, true)
}

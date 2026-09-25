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

// WP-181: astryx's ChatComposerInput '/' and '@' trigger menu (useTriggerMenu) positions its popover with CSS
// anchor positioning (position-anchor/position-area) against a zero-size span it plants at the cursor. In this
// browser that computation misfires for it: the popover's resolved inset falls back to its containing block's
// own edges instead of the anchor's, so the menu renders detached and nearly page-wide — reproduced in the
// dock, the side panel and the full-page composer alike (all three share this one component). The anchor
// span's own getBoundingClientRect() is correct (astryx keeps it in the DOM as
// `[data-astryx-trigger-anchor]` for exactly this purpose) — only the CSS engine loses it — so this recomputes
// the box from that instead of trusting position-area, and applies it with `!important` inline styles that
// beat both the UA popover default and astryx's own inline anchor styles (same specificity, later write wins).
import { useEffect } from 'react'

export interface Rect { left: number; top: number; bottom: number }
export interface Viewport { width: number; height: number }
export interface MenuBox { left: number; top: number; width: number; maxHeight: number }

export function menuWidth(vp: Viewport, margin = 8, maxWidth = 320): number {
  return Math.max(120, Math.min(maxWidth, vp.width - margin * 2))
}

// Prefers opening above the anchor (composers are bottom-anchored inputs); falls back below when there isn't
// room. Clamped so the menu never leaves the viewport regardless of where the composer sits.
export function fitMenu(anchor: Rect, menuHeight: number, vp: Viewport, width: number, gap = 4, margin = 8): MenuBox {
  const left = Math.max(margin, Math.min(anchor.left, vp.width - width - margin))
  const above = anchor.top - menuHeight - gap >= margin
  const top = above ? Math.max(margin, anchor.top - menuHeight - gap) : Math.min(anchor.bottom + gap, vp.height - margin)
  const maxHeight = Math.max(80, above ? anchor.top - gap - margin : vp.height - top - margin)
  return { left, top, width, maxHeight }
}

// Mount once per composer; redundant across several simultaneously-open composers (dock windows) is harmless
// — each recomputes the same box for whichever menu is actually open, last write wins.
export function useFixTriggerMenuPosition() {
  useEffect(() => {
    const reposition = () => {
      document.querySelectorAll<HTMLElement>('.astryx-trigger-menu').forEach((menu) => {
        const host = menu.closest<HTMLElement>('[popover]')
        if (!host || !host.matches(':popover-open')) return
        const anchor = document.querySelector<HTMLElement>('[data-astryx-trigger-anchor]')
        if (!anchor) return
        const a = anchor.getBoundingClientRect()
        const vp = { width: window.innerWidth, height: window.innerHeight }
        const width = menuWidth(vp)
        host.style.setProperty('width', `${width}px`, 'important')
        // Height depends on width (item descriptions wrap), so measure AFTER the width above takes effect.
        const box = fitMenu(a, menu.offsetHeight || host.offsetHeight, vp, width)
        host.style.setProperty('position-area', 'none', 'important')
        host.style.setProperty('position-anchor', 'none', 'important')
        host.style.setProperty('inset', 'auto', 'important')
        host.style.setProperty('left', `${box.left}px`, 'important')
        host.style.setProperty('top', `${box.top}px`, 'important')
        host.style.setProperty('max-height', `${box.maxHeight}px`, 'important')
      })
    }
    const mo = new MutationObserver(reposition)
    mo.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', reposition)
    return () => { mo.disconnect(); window.removeEventListener('resize', reposition) }
  }, [])
}

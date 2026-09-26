// WP-94: the image preview (Astryx Lightbox) zooms itself: pinch, trackpad pinch (ctrl+wheel) and wheel scale about
// the pointer, drag pans, double-tap/double-click toggles 1x/2x; it resets on a new image and on close. The stage is
// touch-action:none and iOS gesture* events are cancelled, so the page never zooms while the preview is open.
// The Lightbox's own zoom (hasZoom) stays off: it only knows double-click and would fight this for the transform.
import { useEffect, type RefObject } from 'react'

export interface Zoom { s: number; x: number; y: number }
export const MIN = 1, MAX = 5

// Scale by `f` about point (px, py), measured from the image's untransformed centre; 1x always recentres.
export function zoomAt(z: Zoom, f: number, px: number, py: number): Zoom {
  const s = Math.min(MAX, Math.max(MIN, z.s * f))
  if (s === 1) return { s: 1, x: 0, y: 0 }
  const k = s / z.s
  return { s, x: px - (px - z.x) * k, y: py - (py - z.y) * k }
}

export function usePinchZoom(ref: RefObject<HTMLElement | null>, active: boolean, key: unknown) {
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    let z: Zoom = { s: 1, x: 0, y: 0 }
    const img = () => el.querySelector('img')
    const apply = () => { const i = img(); if (i) i.style.transform = z.s === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})` }
    const centre = (cx: number, cy: number) => { // pointer relative to the image's untransformed centre
      const r = img()?.parentElement?.getBoundingClientRect()
      return r ? [cx - (r.left + r.width / 2), cy - (r.top + r.height / 2)] : [0, 0]
    }
    const onImage = (t: EventTarget | null) => t instanceof Element && !!img()?.parentElement?.contains(t)
    const stage = img()?.parentElement
    el.style.touchAction = 'none'
    if (stage) stage.style.touchAction = 'none'

    const pts = new Map<number, { x: number; y: number }>()
    let moved = false, lastTap = { t: 0, x: 0, y: 0 }, down = { x: 0, y: 0 }
    const spread = () => { const [a, b] = [...pts.values()]; return [Math.hypot(a.x - b.x, a.y - b.y), (a.x + b.x) / 2, (a.y + b.y) / 2] }
    const pdown = (e: PointerEvent) => {
      if (!onImage(e.target)) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size === 1) { moved = false; down = { x: e.clientX, y: e.clientY } }
      el.setPointerCapture?.(e.pointerId)
    }
    const pmove = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      if (!p) return
      if (pts.size >= 2) {
        const [d0, mx0, my0] = spread()
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const [d1, mx1, my1] = spread()
        const [px, py] = centre(mx1, my1)
        z = zoomAt(z, d0 ? d1 / d0 : 1, px, py)
        if (z.s > 1) z = { ...z, x: z.x + mx1 - mx0, y: z.y + my1 - my0 }
        moved = true
      } else {
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) moved = true
        if (z.s > 1) z = { ...z, x: z.x + e.clientX - p.x, y: z.y + e.clientY - p.y }
      }
      apply()
    }
    const pup = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return
      if (pts.size || moved) { if (moved) swallowClick(); return }
      const now = e.timeStamp
      if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        const [px, py] = centre(e.clientX, e.clientY)
        z = z.s > 1 ? { s: 1, x: 0, y: 0 } : zoomAt(z, 2, px, py)
        apply(); lastTap = { t: 0, x: 0, y: 0 }
      } else lastTap = { t: now, x: e.clientX, y: e.clientY }
    }
    // A drag or pinch that ends over the backdrop must not close the preview.
    const swallowClick = () => {
      const stop = (e: Event) => { e.stopPropagation(); e.preventDefault() }
      el.addEventListener('click', stop, { capture: true, once: true })
      setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 0)
    }
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault() // ctrl+wheel is the trackpad pinch: without this the page zooms, even over the backdrop
      if (!onImage(e.target)) return
      e.preventDefault()
      const [px, py] = centre(e.clientX, e.clientY)
      z = zoomAt(z, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), px, py)
      apply()
    }
    const gesture = (e: Event) => e.preventDefault() // iOS Safari pinch
    el.addEventListener('pointerdown', pdown)
    el.addEventListener('pointermove', pmove)
    el.addEventListener('pointerup', pup)
    el.addEventListener('pointercancel', pup)
    el.addEventListener('wheel', wheel, { passive: false })
    for (const g of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(g, gesture)
    return () => {
      el.removeEventListener('pointerdown', pdown)
      el.removeEventListener('pointermove', pmove)
      el.removeEventListener('pointerup', pup)
      el.removeEventListener('pointercancel', pup)
      el.removeEventListener('wheel', wheel)
      for (const g of ['gesturestart', 'gesturechange', 'gestureend']) document.removeEventListener(g, gesture)
      const i = img(); if (i) i.style.transform = ''
    }
  }, [ref, active, key])
}

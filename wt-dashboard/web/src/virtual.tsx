// Long chat lists (agent conversation, room messages): above THRESHOLD items only the rows near the viewport are
// mounted. Rows are measured as they render (Markdown and images vary), and the scroll element is ChatLayout's
// own root, so its stick-to-bottom (a ResizeObserver on the content re-scrolls while "locked") and its
// scroll-to-bottom button keep working unchanged. A row above the viewport that changes height (an image
// finishing) shifts the scroll offset by the same amount — react-virtual's default — so the view does not jump.
import { useEffect, useReducer, type ReactNode, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

export const THRESHOLD = 150

export function VirtualRows<T>({ items, keyOf, render, scrollRef, gap = 12, estimate = 140 }: {
  items: T[]; keyOf: (t: T) => string; render: (t: T) => ReactNode
  scrollRef: RefObject<HTMLElement | null>; gap?: number; estimate?: number
}) {
  if (items.length <= THRESHOLD) return <>{items.map(render)}</>
  return <Virtual items={items} keyOf={keyOf} render={render} scrollRef={scrollRef} gap={gap} estimate={estimate} />
}

function Virtual<T>({ items, keyOf, render, scrollRef, gap, estimate }: {
  items: T[]; keyOf: (t: T) => string; render: (t: T) => ReactNode; scrollRef: RefObject<HTMLElement | null>; gap: number; estimate: number
}) {
  // The scroll element is an ANCESTOR (ChatLayout's root), and React attaches an ancestor's ref only after its
  // descendants' layout effects ran — so on a remount with the data already there (switching back to the
  // Conversation tab) the virtualizer's first look finds no scroll element, lays out zero rows, and nothing else
  // re-renders it: an empty conversation that never recovers. One render after mount, when the ref is attached.
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => { rerender() }, [])
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimate,
    getItemKey: (i) => keyOf(items[i]),
    overscan: 6,
    initialOffset: () => Number.MAX_SAFE_INTEGER, // open at the newest message, like the unvirtualized list
  })
  return (
    <div style={{ position: 'relative', width: '100%', height: v.getTotalSize() }}>
      {v.getVirtualItems().map((it) => (
        <div key={it.key} data-index={it.index} ref={v.measureElement}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${it.start}px)`, paddingBottom: gap }}>
          {render(items[it.index])}
        </div>
      ))}
    </div>
  )
}

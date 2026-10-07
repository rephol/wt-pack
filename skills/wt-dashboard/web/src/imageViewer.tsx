// WP-275: the image preview. Astryx's Lightbox cannot host a custom image, so this is its own native <dialog> (same
// look: dark backdrop, close top-right, prev/next, "n / total") around react-zoom-pan-pinch, which does wheel and
// pinch zoom, drag-pan and double-click/tap zoom. Keyed by the image, so prev/next resets the zoom; closing unmounts it.
import { useEffect, useRef } from 'react'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import { Icon } from '@astryxdesign/core/Icon'
import { IconButton } from '@astryxdesign/core/IconButton'

const ctl = { position: 'absolute', zIndex: 1, color: 'var(--color-on-dark, #fff)' } as const

export function ImageViewer({ srcs, at, onAt, onClose }: { srcs: string[]; at: number; onAt: (i: number) => void; onClose: () => void }) {
  const box = useRef<HTMLDialogElement>(null)
  useEffect(() => { const d = box.current; if (d && !d.open) d.showModal() }, [])
  const go = (i: number) => { if (i >= 0 && i < srcs.length) onAt(i) }
  return (
    <dialog ref={box} data-image-viewer aria-label={`Image ${at + 1}`} onCancel={(e) => { e.preventDefault(); onClose() }}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') go(at - 1); else if (e.key === 'ArrowRight') go(at + 1) }}
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh', maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 0, border: 'none', background: 'transparent', overflow: 'hidden', outline: 'none' }}>
      <IconButton label="Close" icon={<Icon icon="close" size="sm" color="inherit" />} variant="ghost" onClick={onClose} style={{ ...ctl, top: 12, right: 12 }} />
      {srcs.length > 1 && <>
        <IconButton label="Previous" icon={<Icon icon="chevronLeft" size="sm" color="inherit" />} variant="ghost" isDisabled={at === 0} onClick={() => go(at - 1)} style={{ ...ctl, top: '50%', left: 12, translate: '0 -50%' }} />
        <IconButton label="Next" icon={<Icon icon="chevronRight" size="sm" color="inherit" />} variant="ghost" isDisabled={at === srcs.length - 1} onClick={() => go(at + 1)} style={{ ...ctl, top: '50%', right: 12, translate: '0 -50%' }} />
        <div style={{ ...ctl, top: 12, left: 12, pointerEvents: 'none' }}>{at + 1} / {srcs.length}</div>
      </>}
      <TransformWrapper key={at} minScale={1} maxScale={5} centerOnInit doubleClick={{ mode: 'toggle', step: 0.7 }}>
        <TransformComponent wrapperStyle={{ width: '100vw', height: '100dvh' }} contentStyle={{ width: '100vw', height: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img src={srcs[at]} alt={`Image ${at + 1}`} draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </TransformComponent>
      </TransformWrapper>
    </dialog>
  )
}

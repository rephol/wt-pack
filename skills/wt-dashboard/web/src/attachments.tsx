// What an agent shows or sends: inline images (click → ImageViewer) and file cards for SendUserFile.
import { useEffect, useState } from 'react'
import { Dialog } from '@astryxdesign/core/Dialog'
import { useToast } from '@astryxdesign/core/Toast'
import { Thumbnail } from '@astryxdesign/core/Thumbnail'
import { ImageViewer } from './imageViewer'
import { Card } from '@astryxdesign/core/Card'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { Markdown } from '@astryxdesign/core/Markdown'
import { Delayed, Rows } from './skeletons'

export interface SharedFile { path: string; name: string; size: number | null }

type Opener = { openUrl: (u: string) => Promise<void>; revealItemInDir: (p: string) => Promise<void> }
type TauriGlobal = { opener?: Opener; webviewWindow?: { WebviewWindow: new (label: string, o: { url: string; title: string; width: number; height: number }) => { once: (e: string, cb: (x: { payload: unknown }) => void) => void } } }
const isApp = '__TAURI_INTERNALS__' in window
const tauri = () => (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__

export const fileUrl = (path: string, download = false) => `/api/files?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`
const ext = (n: string) => n.split('.').pop()?.toLowerCase() ?? ''
const isImage = (n: string) => ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext(n))
const isHtml = (n: string) => ['html', 'htm'].includes(ext(n))
const isText = (n: string) => ['md', 'txt', 'json', 'csv', 'log'].includes(ext(n))
const fmtSize = (b: number | null) => (b === null ? 'missing' : b < 1024 ? `${b} B` : b < 1 << 20 ? `${(b / 1024).toFixed(0)} KB` : `${(b / (1 << 20)).toFixed(1)} MB`)
const abs = (u: string) => new URL(u, location.href).href
const need = <T,>(x: T | undefined, what: string): T => {
  if (!x) throw new Error(`${what} is not available in this build of the app — rebuild it`)
  return x
}

// One action list for both environments; failures are logged and toasted, never silent.
function useFileActions(f: SharedFile) {
  const toast = useToast()
  const run = (label: string, fn: () => unknown) => async () => {
    try { await fn() } catch (e) {
      console.error(`${label} failed for ${f.path}`, e)
      toast({ body: `${label} failed: ${e instanceof Error ? e.message : String(e)}`, type: 'error' })
    }
  }
  const url = fileUrl(f.path)
  if (isApp) return [
    { label: 'Open in browser', onClick: run('Open in browser', () => need(tauri()?.opener, 'The opener').openUrl(abs(url))) },
    { label: 'Open in new window', onClick: run('Open in new window', () => new Promise<void>((ok, fail) => {
      const W = need(tauri()?.webviewWindow, 'Opening windows').WebviewWindow
      const w = new W(`file-${Date.now()}`, { url: abs(url), title: f.name, width: 1100, height: 800 })
      w.once('tauri://created', () => ok())
      w.once('tauri://error', (e) => fail(new Error(String(e.payload))))
    })) },
    { label: 'Show in Finder', onClick: run('Show in Finder', () => need(tauri()?.opener, 'The opener').revealItemInDir(f.path)) },
  ]
  return [
    { label: 'Open in browser', onClick: run('Open in browser', () => { if (!window.open(url, '_blank', 'noopener')) throw new Error('popup blocked') }) },
    { label: 'Download', onClick: run('Download', async () => {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const href = URL.createObjectURL(await r.blob())
      const a = Object.assign(document.createElement('a'), { href, download: f.name })
      document.body.append(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(href), 10_000)
    }) },
  ]
}

function FilePreview({ f, onClose }: { f: SharedFile; onClose: () => void }) {
  const url = fileUrl(f.path)
  const actions = useFileActions(f)
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (isText(f.name)) fetch(url).then((r) => (r.ok ? r.text() : `(${r.status})`)).then(setText, (e) => setText(String(e)))
  }, [url, f.name])
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="90vw" maxHeight="85vh" padding={0}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '85vh', width: '100%' }}>
        <HStack gap={2} align="center" justify="between" wrap="wrap" padding={3}>
          <VStack gap={0}>
            <Text weight="semibold" maxLines={1}>{f.name}</Text>
            <Text type="supporting" size="sm">{fmtSize(f.size)}</Text>
          </VStack>
          <HStack gap={1}>
            {actions.map((a) => <Button key={a.label} label={a.label} size="sm" variant="ghost" onClick={a.onClick} />)}
            <Button label="Close" size="sm" variant="secondary" onClick={onClose} />
          </HStack>
        </HStack>
        {/* ponytail: native scroller (themed by the shared rule) — the iframe/img need height:100%, which ScrollableArea's content box does not give */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: isHtml(f.name) ? 0 : 16 }}>
          {isHtml(f.name) && <iframe src={url} sandbox="allow-scripts" title={f.name} style={{ width: '100%', height: '100%', border: 0, background: 'white' }} />}
          {isImage(f.name) && <img src={url} alt={f.name} style={{ display: 'block', margin: 'auto', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
          {isText(f.name) && (text === null ? <Delayed><Rows n={10} height={20} /></Delayed>
            : ext(f.name) === 'md' ? <Markdown>{text}</Markdown> : <CodeBlock code={text.slice(0, 200_000)} />)}
          {!isHtml(f.name) && !isImage(f.name) && !isText(f.name) && <Text type="supporting">No preview for this file type — use the actions above.</Text>}
        </div>
      </div>
    </Dialog>
  )
}

export function ImageRow({ srcs }: { srcs: string[] }) {
  const [at, setAt] = useState<number | null>(null)
  return (
    <HStack gap={2} wrap="wrap">
      {srcs.map((src, i) => (
        <div key={i}>
          <Thumbnail src={src} alt={`Image ${i + 1}`} style={{ width: 320, maxWidth: "100%", height: 200 }} onClick={() => setAt(i)} />
        </div>
      ))}
      {at !== null && <ImageViewer srcs={srcs} at={at} onAt={setAt} onClose={() => setAt(null)} />}
    </HStack>
  )
}

function FileCard({ f }: { f: SharedFile }) {
  const [open, setOpen] = useState(false)
  const actions = useFileActions(f)
  const missing = f.size === null
  return (
    <Card padding={2}>
      <VStack gap={2}>
        <HStack gap={2} align="center" justify="between" wrap="wrap">
          <HStack gap={2} align="center">
            <Badge label={ext(f.name).toUpperCase() || 'FILE'} />
            <VStack gap={0}>
              <Text weight="medium" maxLines={1}>{f.name}</Text>
              <Text type="supporting" size="sm">{fmtSize(f.size)}</Text>
            </VStack>
          </HStack>
          {!missing && (
            <HStack gap={1} wrap="wrap">
              <Button label="Preview" size="sm" variant="secondary" onClick={() => setOpen(true)} />
              {actions.filter((a) => a.label !== 'Open in new window').map((a) => <Button key={a.label} label={a.label} size="sm" variant="ghost" onClick={a.onClick} />)}
            </HStack>
          )}
        </HStack>
        {!missing && isImage(f.name) && <ImageRow srcs={[fileUrl(f.path)]} />}
      </VStack>
      {open && <FilePreview f={f} onClose={() => setOpen(false)} />}
    </Card>
  )
}

export function FileCards({ files, caption }: { files: SharedFile[]; caption?: string | null }) {
  return (
    <VStack gap={2}>
      {caption && <Text type="supporting" size="sm">{caption}</Text>}
      {files.map((f) => <FileCard key={f.path} f={f} />)}
    </VStack>
  )
}

// ---- composer attachments (agent panel and rooms): upload on add, send the stored paths ----
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const MAX_IMAGE = 10 << 20
// WP-170: any file, not just images — mirrors the server's own DOC_EXT allowlist (server.mjs). This is only
// a doomed-upload-avoidance check; the server is the real gate (magic-byte sniff + extension allowlist).
export const FILE_EXT = ['pdf', 'zip', 'txt', 'md', 'markdown', 'csv', 'json', 'log',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cc',
  'sh', 'yml', 'yaml', 'toml', 'xml', 'sql', 'css']
export const MAX_FILE = 25 << 20
export const MAX_IMAGES = 5
// What the composer's hidden <input type=file> and the drag/paste plumbing both accept.
export const ATTACH_ACCEPT = [...IMAGE_TYPES, ...FILE_EXT.map((e) => `.${e}`)].join(',')
export interface Attachment { id: string; preview: string; name: string; size: number; kind: 'image' | 'file'; path?: string; error?: string }
const extOf = (n: string) => n.split('.').pop()?.toLowerCase() ?? ''
// A File's kind here, or null if it's neither an accepted image nor an accepted file type/size.
export function classifyFile(f: File): 'image' | 'file' | null {
  if (IMAGE_TYPES.includes(f.type)) return f.size <= MAX_IMAGE ? 'image' : null
  if (FILE_EXT.includes(extOf(f.name))) return f.size <= MAX_FILE ? 'file' : null
  return null
}
export async function uploadFile(f: File): Promise<{ path: string; name: string; size: number }> {
  const r = await fetch('/api/uploads', { method: 'POST',
    headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) }, body: f })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error ?? r.status)
  return { path: j.path, name: j.name, size: j.size }
}
// An uploads path → its served URL (null for anything else).
export const uploadUrl = (p: string) => {
  const m = p.match(/(\d{4}-\d{2}-\d{2})\/([0-9a-f-]{36}\.[a-z0-9]{1,10})$/)
  return m ? `/api/uploads/${m[1]}/${m[2]}` : null
}
// `blocked`: why nothing can be attached here (e.g. a remote agent), or null.
export function useAttachments(blocked: string | null) {
  const [atts, setAtts] = useState<Attachment[]>([])
  const [attErr, setAttErr] = useState<string | null>(null)
  // Returns the attachments it added (rooms mark their place in the text).
  const addFiles = (files: File[]): Attachment[] => {
    setAttErr(null)
    if (blocked) { setAttErr(blocked); return [] }
    const added: Attachment[] = []
    const room = MAX_IMAGES - atts.length
    const ok = files.map((f) => [f, classifyFile(f)] as const).filter((x): x is [File, 'image' | 'file'] => x[1] !== null)
    if (ok.length < files.length) setAttErr('Some files were too large or an unsupported type')
    if (ok.length > room) setAttErr(`At most ${MAX_IMAGES} attachments per message`)
    for (const [f, kind] of ok.slice(0, Math.max(0, room))) {
      const a: Attachment = { id: crypto.randomUUID(), preview: URL.createObjectURL(f), name: f.name, size: f.size, kind }
      added.push(a)
      setAtts((prev) => [...prev, a])
      uploadFile(f).then(
        ({ path }) => setAtts((prev) => prev.map((x) => (x.id === a.id ? { ...x, path } : x))),
        (e) => setAtts((prev) => prev.map((x) => (x.id === a.id ? { ...x, error: String(e.message ?? e) } : x))),
      )
    }
    return added
  }
  const removeAtt = (id: string) => setAtts((prev) => prev.filter((x) => (x.id === id ? (URL.revokeObjectURL(x.preview), false) : true)))
  const clear = () => { atts.forEach((a) => URL.revokeObjectURL(a.preview)); setAtts([]); setAttErr(null) }
  return { atts, attErr, addFiles, removeAtt, clear, uploading: atts.some((a) => !a.path && !a.error) }
}

const fmtSizeShort = (b: number) => (b < 1024 ? `${b} B` : b < 1 << 20 ? `${(b / 1024).toFixed(0)} KB` : `${(b / (1 << 20)).toFixed(1)} MB`)
const FileGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
  </svg>
)
// A composer-drawer chip for a non-image attachment (icon, name, size) — the file-typed sibling of Thumbnail.
export function AttachmentChip({ a, onRemove }: { a: { name: string; size: number; error?: string }; onRemove: () => void }) {
  return (
    <Card padding={2}>
      <HStack gap={2} align="center">
        <FileGlyph />
        <VStack gap={0}>
          <Text weight="medium" maxLines={1} style={{ maxWidth: 160 }}>{a.name}</Text>
          <Text type="supporting" size="sm">{a.error ?? fmtSizeShort(a.size)}</Text>
        </VStack>
        <IconButton label="Remove" icon={<Icon icon="close" />} size="sm" variant="ghost" onClick={onRemove} />
      </HStack>
    </Card>
  )
}
// A rendered room message's download chip for a non-image attachment.
export function AttachmentDownload({ a }: { a: { path: string; name?: string; size?: number } }) {
  const url = uploadUrl(a.path)
  if (!url) return null
  const name = a.name ?? a.path.split('/').pop() ?? 'file'
  return (
    <Card padding={2}>
      <HStack gap={2} align="center" justify="between">
        <HStack gap={2} align="center">
          <FileGlyph />
          <VStack gap={0}>
            <Text weight="medium" maxLines={1} style={{ maxWidth: 220 }}>{name}</Text>
            {a.size != null && <Text type="supporting" size="sm">{fmtSizeShort(a.size)}</Text>}
          </VStack>
        </HStack>
        <Button label="Download" size="sm" variant="ghost" onClick={() => window.open(url, '_blank', 'noopener')} />
      </HStack>
    </Card>
  )
}

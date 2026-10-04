// WP-223: Settings › Projects › New project (existing repo / git clone / new empty repo) and Hide project.
// Server side: projects.mjs. No native dialogs: the hide confirm is an AlertDialog.
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@astryxdesign/core/Dialog'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Switch } from '@astryxdesign/core/Switch'
import { TextInput } from '@astryxdesign/core/TextInput'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'

type Source = 'existing' | 'clone' | 'init'
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/ // same rule as projectPaths.mjs
export const nameError = (n: string) => (n && !NAME_RE.test(n) ? 'lowercase letters, digits, - and _ only (max 32)' : undefined)
const slug = (u: string) => u.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop()?.toLowerCase().replace(/[^a-z0-9_-]/g, '-') ?? ''

export function NewProjectButton() {
  const [open, setOpen] = useState(false)
  return <>
    <Button label="New project" variant="secondary" size="sm" onClick={() => setOpen(true)} />
    {open && <NewProjectDialog onClose={() => setOpen(false)} />}
  </>
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [source, setSource] = useState<Source>('init')
  const [path, setPath] = useState('')
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('')
  const [room, setRoom] = useState(true)
  const [orch, setOrch] = useState(false)
  const effName = source === 'clone' && !name ? slug(url) : name
  const err = source === 'existing' ? undefined : nameError(effName)
  const ready = source === 'existing' ? path.startsWith('/')
    : source === 'clone' ? !!url.trim() && parent.startsWith('/') && !!effName && !err
    : parent.startsWith('/') && !!effName && !err
  const create = useMutation({
    mutationFn: () => api<{ name: string; room: string | null; orchestrator: { error?: string } | null }>('/api/projects', { method: 'POST',
      body: JSON.stringify(source === 'existing' ? { source, path: path.trim(), room, orchestrator: orch }
        : { source, url: source === 'clone' ? url.trim() : undefined, parent: parent.trim(), name: effName, room, orchestrator: orch }) }),
    onSuccess: (r) => {
      for (const k of ['projects', 'overview', 'rooms']) qc.invalidateQueries({ queryKey: [k] })
      toast({ body: r.orchestrator?.error ? `Added ${r.name}; orchestrator failed: ${r.orchestrator.error}` : `Added ${r.name}`, type: r.orchestrator?.error ? 'error' : undefined })
      onClose()
    },
  })
  return (
    <Dialog isOpen onOpenChange={(o) => !o && !create.isPending && onClose()} width={480} padding={4}>
      <VStack gap={4}>
        <Heading level={3}>New project</Heading>
        <SegmentedControl label="Source" value={source} onChange={(v) => { setSource(v as Source); create.reset() }}>
          <SegmentedControlItem value="init" label="New empty repo" />
          <SegmentedControlItem value="clone" label="Git clone" />
          <SegmentedControlItem value="existing" label="Existing folder" />
        </SegmentedControl>
        {source === 'existing' && <TextInput label="Repository path" value={path} onChange={setPath} placeholder="/Users/me/code/my-app" description="An existing git repository inside your home folder." />}
        {source === 'clone' && <TextInput label="Repository URL" value={url} onChange={setUrl} placeholder="https://github.com/me/my-app.git" description="https://, ssh:// or git@host:path." />}
        {source !== 'existing' && <>
          <TextInput label="Parent folder" value={parent} onChange={setParent} placeholder="/Users/me/code" description="Created inside your home folder." />
          <TextInput label="Project name" value={name} onChange={setName} placeholder={source === 'clone' ? slug(url) || 'my-app' : 'my-app'} description="Lowercase letters, digits, - and _." status={err ? { type: 'error', message: err } : undefined} />
        </>}
        <HStack justify="between" align="center"><Text>Create its room</Text><Switch label="Create its room" isLabelHidden value={room} onChange={setRoom} /></HStack>
        <HStack justify="between" align="center"><Text>Start an orchestrator (opus session)</Text><Switch label="Start an orchestrator" isLabelHidden value={orch} onChange={setOrch} /></HStack>
        {create.isError && <Banner status="error" title="Could not create the project" description={create.error instanceof Error ? create.error.message : String(create.error)} />}
        <HStack gap={2} justify="end">
          <Button label="Cancel" variant="ghost" onClick={onClose} isDisabled={create.isPending} />
          <Button label={create.isPending ? 'Creating…' : 'Create'} variant="primary" isLoading={create.isPending} isDisabled={!ready || create.isPending} onClick={() => create.mutate()} />
        </HStack>
      </VStack>
    </Dialog>
  )
}

export function HideProject({ project, onHidden }: { project: string; onHidden: () => void }) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  const hide = useMutation({
    mutationFn: () => api(`/api/projects/${encodeURIComponent(project)}`, { method: 'DELETE', body: '{}' }),
    onSuccess: () => { for (const k of ['projects', 'overview']) qc.invalidateQueries({ queryKey: [k] }); toast({ body: `Hid ${project}` }); setOpen(false); onHidden() },
    onError: (e) => toast({ body: `Could not hide: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  return <>
    <Button label="Hide project" variant="ghost" size="sm" onClick={() => setOpen(true)} />
    {open && <AlertDialog isOpen onOpenChange={(o) => !o && setOpen(false)} title={`Hide ${project}?`} actionLabel="Hide" actionVariant="destructive"
      description="It disappears from the project pickers. Its folder, room and tickets are untouched; add the folder again to bring it back." isActionLoading={hide.isPending} onAction={() => hide.mutate()} />}
  </>
}

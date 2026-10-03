// Settings › Projects › Roles (WP-204): a repo's role files (.wt-pack/roles/*.md in its main checkout). Edits write the
// file and never commit: the files are committed like code, so the card shows `git status` for the folder.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Selector } from '@astryxdesign/core/Selector'
import { Text } from '@astryxdesign/core/Text'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { SettingsCard, SettingsRow } from './settingsRows'
import { Delayed, LoadError, FieldsSkeleton } from './skeletons'

type Finding = { name: string; level: 'warn' | 'error'; msg: string }
type RoleFile = { name: string; kind: 'override' | 'persona'; base: string | null; bytes: number; text: string; findings: Finding[] }
type State = { dir: string; bases: string[]; files: RoleFile[]; git: string }
const NAME = /^[a-z][a-z0-9-]{0,23}$/

export function RolesCard({ project }: { project: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const url = `/api/projects/${encodeURIComponent(project)}/roles`
  const q = useQuery({ queryKey: ['project-roles', project], queryFn: () => api<State>(url) })
  const [editing, setEditing] = useState<{ name: string; text: string; isNew: boolean } | null>(null)
  const [name, setName] = useState('')
  const [base, setBase] = useState('worker')
  const save = useMutation({
    mutationFn: (e: { name: string; text: string }) => api<State>(`${url}/${e.name}`, { method: 'PUT', body: JSON.stringify({ text: e.text }) }),
    onSuccess: (s) => { qc.setQueryData(['project-roles', project], s); setEditing(null); toast({ body: 'Saved. Commit it like code: agents read the main checkout.' }) },
    onError: (e) => toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  if (!q.data) return q.isError ? <LoadError what="roles" error={q.error} retry={() => q.refetch()} /> : <Delayed><FieldsSkeleton n={2} /></Delayed>
  const s = q.data
  const taken = s.files.some((f) => f.name === name)
  const isBase = s.bases.includes(name)
  const create = () => setEditing({ name, isNew: true, text: isBase ? '' : `---\nbase: ${base}\n---\n` })
  return (
    <SettingsCard title="Roles">
      <Text type="supporting" size="sm">
        Per-repo instructions injected into matching agents: a file named after a base role overrides it; any other name is a persona
        (its own model, MCP servers and Dispatch labels). Format and advice: the wt-roles skill. Files live in <code>{s.dir}</code>.
      </Text>
      {s.files.map((f) => (
        <SettingsRow key={f.name} title={f.name}
          description={`${f.kind}${f.kind === 'persona' ? ` of ${f.base ?? '?'}` : ''} · ${f.bytes} B`}
          control={<Button label="Edit" size="sm" variant="secondary" onClick={() => setEditing({ name: f.name, text: f.text, isNew: false })} />}
          detail={f.findings.length ? <HStack gap={2} wrap="wrap">{f.findings.map((x, i) => <Badge key={i} variant={x.level === 'error' ? 'error' : 'warning'} label={x.msg} />)}</HStack> : undefined} />
      ))}
      {!s.files.length && <Text type="supporting" size="sm">No role files yet: agents run with the pack&apos;s defaults.</Text>}
      {editing ? (
        <VStack gap={2}>
          <Text weight="semibold">{editing.isNew ? 'New' : 'Edit'} {editing.name}</Text>
          <TextArea label={`${editing.name}.md`} width="100%" rows={14} value={editing.text} onChange={(v: string) => setEditing({ ...editing, text: v })} />
          <HStack gap={2}>
            <Button label="Save" isLoading={save.isPending} isDisabled={!editing.text.trim()} onClick={() => save.mutate({ name: editing.name, text: editing.text })} />
            <Button label="Cancel" variant="ghost" onClick={() => setEditing(null)} />
          </HStack>
        </VStack>
      ) : (
        <HStack gap={2} vAlign="end" wrap="wrap">
          <TextInput label="New role name" width={220} value={name} onChange={setName} placeholder="frontend-worker" />
          {!isBase && <Selector label="Base" width={160} value={base} onChange={setBase} options={s.bases.map((b) => ({ value: b, label: b }))} />}
          <Button label="New" size="sm" variant="secondary" isDisabled={!NAME.test(name) || taken} onClick={create} />
        </HStack>
      )}
      {s.git && <Text type="supporting" size="sm">Uncommitted: <code>{s.git.replace(/\n/g, ' · ')}</code></Text>}
    </SettingsCard>
  )
}

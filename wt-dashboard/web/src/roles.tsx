// Agent roles (Settings › Roles), agent tags (pane tokens mirrored by the server) and their dialogs.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import { Dialog } from '@astryxdesign/core/Dialog'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { TextArea } from '@astryxdesign/core/TextArea'
import { Selector } from '@astryxdesign/core/Selector'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { Delayed, LoadError, FieldsSkeleton } from './skeletons'

export interface Role {
  id: string; name: string; color: string; letter: string
  match: { workspace: string; name: string }
  spawn: { start: 'main' | 'worktree' | 'choose'; workspace: string; prompt: string; projects: string[] } | null
}
export const OTHER: Role = { id: 'other', name: 'Other', color: 'gray', letter: '?', match: { workspace: '', name: '' }, spawn: null }
export const COLORS = ['blue', 'green', 'purple', 'orange', 'red', 'teal', 'pink', 'gray']
const HEX: Record<string, string> = { blue: '#3b82f6', green: '#22c55e', purple: '#a855f7', orange: '#f97316', red: '#ef4444', teal: '#14b8a6', pink: '#ec4899', gray: '#6b7280' }

export function useRoles() {
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api<{ roles: Role[]; inUse: Record<string, number> }>('/api/roles'), staleTime: 30_000 })
  const roles = q.data?.roles ?? []
  return { q, roles, inUse: q.data?.inUse ?? {}, byId: (id: string) => roles.find((r) => r.id === id) ?? OTHER }
}
export const plural = (r: Role) => (r.id === 'other' ? 'Other' : r.name.endsWith('s') ? r.name : `${r.name}s`)
export function RoleBadge({ role, size = 20 }: { role: Role; size?: number }) {
  return <span aria-label={role.name} title={role.name} style={{ display: 'inline-grid', placeItems: 'center', width: size, height: size, borderRadius: size / 2, flexShrink: 0,
    background: HEX[role.color] ?? HEX.gray, color: 'white', fontSize: size * 0.55, fontWeight: 600, lineHeight: 1 }}>{role.letter}</span>
}

type AgentLite = { machine: string; id: string; name: string; pool: string; tags?: Record<string, string> }
const tagsUrl = (a: AgentLite) => `/api/agents/${encodeURIComponent(a.machine)}/${encodeURIComponent(a.id)}/tags`

// Agent ⋯ → "Change role…" / "Edit tags…": both PATCH the same tags, which the server mirrors into pane tokens.
export function TagsDialog({ agent, mode, onClose }: { agent: AgentLite; mode: 'role' | 'tags'; onClose: () => void }) {
  const { roles } = useRoles()
  const qc = useQueryClient()
  const toast = useToast()
  const [role, setRole] = useState(agent.pool)
  const [ticket, setTicket] = useState(agent.tags?.ticket ?? '')
  const [branch, setBranch] = useState(agent.tags?.branch ?? '')
  const save = useMutation({
    mutationFn: () => api(tagsUrl(agent), { method: 'PATCH', body: JSON.stringify(mode === 'role' ? { role } : { ticket: ticket.trim(), branch: branch.trim() }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['overview'] }); qc.invalidateQueries({ queryKey: ['roles'] }); onClose() },
    onError: (e) => toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width={420}>
      <VStack gap={3}>
        <Heading level={3}>{mode === 'role' ? `Role of ${agent.name}` : `Tags of ${agent.name}`}</Heading>
        {mode === 'role'
          ? <Selector label="Role" width="100%" value={role} options={[...roles, OTHER].map((r) => ({ value: r.id, label: r.name }))} onChange={setRole} />
          : <>
              <TextInput label="Ticket" value={ticket} onChange={setTicket} placeholder="UMK-1177" />
              <TextInput label="Branch" value={branch} onChange={setBranch} placeholder="short branch name" />
            </>}
        <Text type="supporting" size="sm">Stored by the dashboard and shown in herdr as pane tokens (display only; herdr titles and status are not changed).</Text>
        <HStack justify="end" gap={2}>
          <Button label="Cancel" variant="ghost" onClick={onClose} />
          <Button label="Save" variant="primary" isLoading={save.isPending} onClick={() => save.mutate()} />
        </HStack>
      </VStack>
    </Dialog>
  )
}

export function TagList({ tags }: { tags?: Record<string, string> }) {
  const entries = Object.entries(tags ?? {})
  if (!entries.length) return <Text type="supporting">—</Text>
  return <VStack gap={0}>{entries.map(([k, v]) => <Text key={k} size="sm"><span style={{ opacity: 0.6 }}>{k.replace('_', ' ')}</span>{` ${v}`}</Text>)}</VStack>
}

// ---- Settings › Roles ----
export function RolesSection() {
  const { q, roles: saved, inUse } = useRoles()
  const qc = useQueryClient()
  const toast = useToast()
  const [draft, setDraft] = useState<Role[] | null>(null)
  const [reassign, setReassign] = useState<Record<string, string>>({})
  const [needs, setNeeds] = useState<string[]>([])
  const roles = draft ?? saved
  const put = useMutation({
    mutationFn: () => api<{ roles: Role[] }>('/api/roles', { method: 'PUT', body: JSON.stringify({ roles, reassign }) }),
    onSuccess: () => { setDraft(null); setNeeds([]); setReassign({}); qc.invalidateQueries({ queryKey: ['roles'] }); qc.invalidateQueries({ queryKey: ['overview'] }); toast({ body: 'Roles saved' }) },
    onError: (e) => {
      const m = e instanceof Error ? e.message : String(e)
      const gone = (saved.filter((r) => !roles.some((x) => x.id === r.id) && inUse[r.id]).map((r) => r.id))
      if (/in use/.test(m) && gone.length) setNeeds(gone); else toast({ body: `Could not save: ${m}`, type: 'error' })
    },
  })
  if (!q.data) return q.isError ? <LoadError what="roles" error={q.error} retry={() => q.refetch()} /> : <Delayed><FieldsSkeleton n={3} /></Delayed>
  const edit = (i: number, patch: Partial<Role>) => setDraft(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const move = (i: number, d: number) => { const x = roles.slice(); const [r] = x.splice(i, 1); x.splice(i + d, 0, r); setDraft(x) }
  const add = () => setDraft([...roles, { id: `role${roles.length + 1}`, name: 'New role', color: 'teal', letter: 'N', match: { workspace: '', name: '' }, spawn: { start: 'main', workspace: '<repo>-<role>s', prompt: '', projects: [] } }])
  return (
    <VStack gap={4}>
      <Heading level={3}>Roles</Heading>
      <Text type="supporting" size="sm">An agent&apos;s role: its <code>role</code> tag first, then the first role whose workspace pattern matches, then name pattern, else Other. Order matters; * is a wildcard.</Text>
      {roles.map((r, i) => (
        <VStack key={i} gap={2} style={{ padding: 12, border: '1px solid var(--color-border-default, #3334)', borderRadius: 8 }}>
          <HStack gap={2} align="center" justify="between">
            <HStack gap={2} align="center"><RoleBadge role={r} size={24} /><Text weight="semibold">{r.name}</Text>
              {inUse[r.id] ? <Text type="supporting" size="sm">{`${inUse[r.id]} agent${inUse[r.id] === 1 ? '' : 's'}`}</Text> : null}</HStack>
            <HStack gap={1}>
              <IconButton label="Move up" icon={<span aria-hidden>↑</span>} size="sm" variant="ghost" isDisabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton label="Move down" icon={<span aria-hidden>↓</span>} size="sm" variant="ghost" isDisabled={i === roles.length - 1} onClick={() => move(i, 1)} />
              <IconButton label={`Delete ${r.name}`} icon={<Icon icon="close" />} size="sm" variant="ghost" onClick={() => setDraft(roles.filter((_, j) => j !== i))} />
            </HStack>
          </HStack>
          <HStack gap={2} wrap="wrap">
            <TextInput label="Name" value={r.name} onChange={(v) => edit(i, { name: v })} />
            <TextInput label="Id" value={r.id} onChange={(v) => edit(i, { id: v.toLowerCase() })} />
            <TextInput label="Letter" value={r.letter} onChange={(v) => edit(i, { letter: v.slice(0, 1).toUpperCase() })} />
            <Selector label="Color" value={r.color} options={COLORS.map((c) => ({ value: c, label: c }))} onChange={(v) => edit(i, { color: v })} />
          </HStack>
          <HStack gap={2} wrap="wrap">
            <TextInput label="Workspace pattern" value={r.match.workspace} placeholder="*-planners" onChange={(v) => edit(i, { match: { ...r.match, workspace: v } })} />
            <TextInput label="Name pattern" value={r.match.name} placeholder="*planner*" onChange={(v) => edit(i, { match: { ...r.match, name: v } })} />
          </HStack>
          <Selector label="New agents" value={r.spawn ? r.spawn.start : 'off'} options={[
            { value: 'off', label: 'Cannot be spawned from the dashboard' }, { value: 'main', label: 'Start in the main checkout' },
            { value: 'worktree', label: 'Start in a worktree' }, { value: 'choose', label: 'Choose (main checkout or a worktree)' }]}
            onChange={(v) => edit(i, { spawn: v === 'off' ? null : { start: v as 'main', workspace: r.spawn?.workspace ?? '<repo>-<role>s', prompt: r.spawn?.prompt ?? '', projects: r.spawn?.projects ?? [] } })} />
          {r.spawn && <>
            <TextInput label="Workspace name" value={r.spawn.workspace} description="<repo> and <role> are filled in" onChange={(v) => edit(i, { spawn: { ...r.spawn!, workspace: v } })} />
            <TextArea label="Default first prompt" value={r.spawn.prompt} rows={2} onChange={(v) => edit(i, { spawn: { ...r.spawn!, prompt: v } })} />
            <TextInput label="Allowed projects" value={r.spawn.projects.join(', ')} description="Comma-separated; empty = all" onChange={(v) => edit(i, { spawn: { ...r.spawn!, projects: v.split(',').map((x) => x.trim()).filter(Boolean) } })} />
          </>}
        </VStack>
      ))}
      {needs.length > 0 && (
        <Banner status="warning" title="Some deleted roles are in use" description={<VStack gap={2}>
          {needs.map((id) => <Selector key={id} label={`Move agents of "${id}" to`} value={reassign[id] ?? ''} placeholder="Choose a role"
            options={[...roles, OTHER].map((r) => ({ value: r.id, label: r.name }))} onChange={(v) => setReassign({ ...reassign, [id]: v })} />)}
        </VStack>} />
      )}
      <HStack gap={2}>
        <Button label="Add role" onClick={add} />
        <Button label="Save roles" variant="primary" isDisabled={!draft || needs.some((id) => !reassign[id])} isLoading={put.isPending} onClick={() => put.mutate()} />
        {draft && <Button label="Discard" variant="ghost" onClick={() => { setDraft(null); setNeeds([]) }} />}
      </HStack>
    </VStack>
  )
}

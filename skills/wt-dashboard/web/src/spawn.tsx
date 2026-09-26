// Spawn and remove agents. The server runs the wt-agents skill's agents.sh for both, so naming and pools
// stay in one place; this file is only the dialogs.
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@astryxdesign/core/Dialog'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Selector } from '@astryxdesign/core/Selector'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Banner } from '@astryxdesign/core/Banner'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { useRoles } from './roles'

interface Project { name: string; root: string; worktrees: { path: string; branch: string | null; ticket: string | null; agents: string[] }[] }
export interface SpawnAgentLite { key: string; id: string; machine: string; local: boolean; name: string; pool: string; status: string; cwd: string; project: string | null; asks: boolean }

export const openSpawn = () => dispatchEvent(new CustomEvent('open-spawn'))
export const openRemove = (a: SpawnAgentLite) => dispatchEvent(new CustomEvent('open-remove', { detail: a }))
// A reused agent's composer opens with this text (read once by the agent panel).
export const takePrefill = (key: string) => {
  try { const v = sessionStorage.getItem(`prefill:${key}`) ?? ''; sessionStorage.removeItem(`prefill:${key}`); return v } catch { return '' }
}
const setPrefill = (key: string, text: string) => { try { sessionStorage.setItem(`prefill:${key}`, text) } catch { /* private mode */ } }
const usePhone = () => {
  const q = '(max-width: 639px)'
  const [n, setN] = useState(() => matchMedia(q).matches)
  useEffect(() => { const m = matchMedia(q); const on = () => setN(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on) }, [])
  return n
}
const short = (p: string) => p.split('/').slice(-2).join('/')

export function SpawnHost({ agents, project, onOpenAgent }: { agents: SpawnAgentLite[]; project: string; onOpenAgent: (key: string) => void }) {
  const [open, setOpen] = useState(false)
  useEffect(() => { const on = () => setOpen(true); addEventListener('open-spawn', on); return () => removeEventListener('open-spawn', on) }, [])
  return open ? <SpawnDialog agents={agents} defaultProject={project} onClose={() => setOpen(false)} onOpenAgent={onOpenAgent} /> : null
}

function SpawnDialog({ agents, defaultProject, onClose, onOpenAgent }: { agents: SpawnAgentLite[]; defaultProject: string; onClose: () => void; onOpenAgent: (key: string) => void }) {
  const phone = usePhone()
  const qc = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const { roles: allRoles } = useRoles()
  const roles = allRoles.filter((r) => r.spawn)
  const [kindSel, setKind] = useState<string>('')
  const kind = kindSel || roles[0]?.id || 'planner'
  const role = roles.find((r) => r.id === kind)
  const start = role?.spawn?.start ?? 'main'
  const [project, setProject] = useState<string>('')
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const list = projects.data ?? []
  const proj = list.find((p) => p.name === (project || (defaultProject !== 'all' ? defaultProject : ''))) ?? list[0]
  const spawn = useMutation({
    mutationFn: () => api<{ key: string; name: string; prompted: boolean }>('/api/agents/spawn', { method: 'POST', body: JSON.stringify({ kind, project: proj?.name, cwd: start === 'main' ? undefined : cwd || undefined, prompt: prompt.trim() || undefined }) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['overview'] }); onClose(); onOpenAgent(r.key) },
  })
  // Reuse before spawning: a free agent of this kind (idle/done, no question; a planner sitting in the main checkout).
  const free = proj && agents.find((a) => a.local && a.project === proj.name && !a.asks
    && (a.status === 'idle' || a.status === 'done') && a.pool === kind && (start !== 'main' || a.cwd === proj.root))
  const reuse = () => { if (!free) return; setPrefill(free.key, prompt); onClose(); onOpenAgent(free.key) }
  const worktrees = proj?.worktrees ?? []
  const allowed = !role?.spawn?.projects.length || role.spawn.projects.includes(proj?.name ?? '')
  const canSubmit = Boolean(proj) && Boolean(role) && allowed && (start !== 'worktree' || worktrees.some((w) => w.path === cwd)) && !spawn.isPending
  return (
    <Dialog isOpen onOpenChange={(o) => !o && !spawn.isPending && onClose()} {...(phone ? { variant: 'fullscreen' as const } : { width: 520 })} padding={0}>
      <div style={{ display: 'flex', flexDirection: 'column', maxHeight: phone ? '100dvh' : '85dvh', height: phone ? '100dvh' : undefined }}>
        <HStack justify="between" align="center" style={{ padding: '12px 8px 4px 16px' }}>
          <Heading level={3}>New agent</Heading>
          <Button label="Close" size="sm" variant="ghost" onClick={onClose} isDisabled={spawn.isPending} />
        </HStack>
        <ScrollableArea label="New agent" style={{ flex: 1, minHeight: 0, padding: '8px 16px calc(env(safe-area-inset-bottom) + 16px)' }}>
          <VStack gap={4}>
            <VStack gap={1}>
              <SegmentedControl label="Role" value={kind} onChange={setKind}>
                {roles.map((r) => <SegmentedControlItem key={r.id} value={r.id} label={r.name} />)}
              </SegmentedControl>
              <Text type="supporting" size="sm">{start === 'main' ? 'Starts in the main checkout.' : start === 'worktree' ? 'Starts inside an existing worktree.' : 'Starts in the main checkout, or a worktree you choose.'}{allowed ? '' : ` Not allowed in ${proj?.name}.`}</Text>
            </VStack>
            <Selector label="Project" width="100%" value={proj?.name ?? ''} isLoading={projects.isLoading}
              options={list.map((p) => ({ value: p.name, label: p.name, description: short(p.root) }))} onChange={(v) => { setProject(v); setCwd('') }} />
            {start !== 'main' && (
              <Selector label="Worktree" width="100%" value={cwd} placeholder={worktrees.length ? 'Choose a worktree' : 'No worktrees in this project'}
                isDisabled={!worktrees.length}
                options={worktrees.map((w) => ({ value: w.path, label: w.ticket ? `${w.ticket} · ${w.branch ?? short(w.path)}` : w.branch ?? short(w.path),
                  description: w.agents.length ? `occupied by ${w.agents.join(', ')}` : short(w.path) }))}
                onChange={setCwd} />
            )}
            <TextArea label="First prompt (optional)" value={prompt} onChange={setPrompt} placeholder="Optional" rows={3} />
            {free && (
              <Banner status="info" title={`${free.name} is free — use it instead?`} description="Panes pile up and nothing reaps them; reuse a free agent when you can."
                endContent={<Button label={`Use ${free.name}`} size="sm" variant="secondary" onClick={reuse} />} />
            )}
            {spawn.isError && <Banner status="error" title="Could not start the agent" description={String(spawn.error)} />}
            {spawn.isPending && <Text type="supporting">{prompt.trim() ? 'Starting… then waiting until it is ready for the prompt (up to a minute).' : 'Starting…'}</Text>}
            <Button label={spawn.isPending ? 'Starting…' : `Start ${role?.name.toLowerCase() ?? kind}`} variant="primary" width="100%" isLoading={spawn.isPending} isDisabled={!canSubmit} onClick={() => spawn.mutate()} />
          </VStack>
        </ScrollableArea>
      </div>
    </Dialog>
  )
}

export function RemoveHost() {
  const [a, setA] = useState<SpawnAgentLite | null>(null)
  const [step, setStep] = useState<'confirm' | 'force'>('confirm')
  const [typed, setTyped] = useState('')
  const qc = useQueryClient()
  const toast = useToast()
  useEffect(() => {
    const on = (e: Event) => { setA((e as CustomEvent<SpawnAgentLite>).detail); setStep('confirm'); setTyped('') }
    addEventListener('open-remove', on); return () => removeEventListener('open-remove', on)
  }, [])
  const rm = useMutation({
    mutationFn: (force: boolean) => api(`/api/agents/${encodeURIComponent(a!.machine)}/${encodeURIComponent(a!.id)}`, { method: 'DELETE', body: JSON.stringify({ force, confirmName: typed || undefined }) }),
    onSuccess: () => { toast({ body: `Removed ${a!.name}` }); setA(null); qc.invalidateQueries({ queryKey: ['overview'] }) },
    onError: (e) => { if (/working/.test(String(e)) && step === 'confirm') setStep('force'); else toast({ body: `Could not remove: ${e}`, type: 'error' }) },
  })
  if (!a) return null
  const orch = /orchestrator/i.test(a.name)
  if (step === 'force') return (
    <AlertDialog isOpen onOpenChange={(o) => !o && setA(null)} title={`${a.name} is working`} actionLabel="Remove anyway" actionVariant="destructive"
      description="Removing it now kills the turn in flight. Anything it has not committed exists only in that pane and is lost."
      isActionLoading={rm.isPending} onAction={() => rm.mutate(true)} />
  )
  if (orch) return (
    <Dialog isOpen onOpenChange={(o) => !o && setA(null)} width={440} padding={4}>
      <VStack gap={3}>
        <Heading level={3}>{`Remove ${a.name}?`}</Heading>
        <Text type="supporting">This is the orchestrator: other agents report to it. Its tab closes and its conversation ends. Type its name to confirm.</Text>
        <TextInput label="Agent name" value={typed} onChange={setTyped} placeholder={a.name} />
        <HStack gap={2} justify="end">
          <Button label="Cancel" variant="ghost" onClick={() => setA(null)} />
          <Button label="Remove agent" variant="destructive" isDisabled={typed !== a.name} isLoading={rm.isPending} onClick={() => rm.mutate(false)} />
        </HStack>
      </VStack>
    </Dialog>
  )
  return (
    <AlertDialog isOpen onOpenChange={(o) => !o && setA(null)} title={`Remove ${a.name}?`} actionLabel="Remove agent" actionVariant="destructive"
      description={`Closes its tab and ends its conversation (${a.status}). A worktree it used stays on disk.`}
      isActionLoading={rm.isPending} onAction={() => rm.mutate(false)} />
  )
}

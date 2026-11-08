// WP-351: the lifecycle menu items and confirms for one agent, shared by the Agents list row menu and the agent panel menu.
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { useToast } from '@astryxdesign/core/Toast'
import { agentActions, type ActionAgent, type ActionId } from './agentActions'
import { openRemove, type SpawnAgentLite } from './spawn'

type Agent = ActionAgent & Omit<SpawnAgentLite, 'id'>
type Item = { label: string; description?: string; isDisabled?: boolean; onClick: () => void }

export function useAgentOps(agent: Agent, opts: { canStop?: boolean; onStop?: () => void } = {}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [ask, setAsk] = useState<'pause' | 'forget' | null>(null)
  const call = async (what: 'pause' | 'resume' | 'forget') => {
    const r = await fetch(`/api/agents/by-name/${encodeURIComponent(agent.name)}/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
  }
  const refresh = () => { for (const k of ['overview', 'agents', 'projects']) qc.invalidateQueries({ queryKey: [k] }) }
  const run = useMutation({
    mutationFn: call,
    onSuccess: (_d, what) => { if (what === 'forget') toast({ body: `${agent.name} forgotten` }); refresh() },
    onError: (e, what) => toast({ body: `${what === 'forget' ? 'Not forgotten' : 'Not changed'}: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  const items: Record<ActionId, Item> = {
    pause: { label: 'Pause agent…', description: 'Save it and close its tab; Resume brings it back with its session', onClick: () => setAsk('pause') },
    remove: { label: 'Remove agent…', description: 'Close its tab and end its conversation', onClick: () => openRemove(agent as SpawnAgentLite) },
    'remove-remote': { label: 'Remove agent…', description: 'Remote agents: not supported yet', isDisabled: true, onClick: () => {} },
    resume: { label: 'Resume agent', description: 'Respawn it with its saved session (one cold cache write)', onClick: () => run.mutate('resume') },
    respawn: { label: 'Respawn agent', description: 'Start it again with its saved session', onClick: () => run.mutate('resume') },
    forget: { label: 'Forget agent', description: 'Drop its saved row; its number becomes free (transcript kept)', onClick: () => run.mutate('forget') },
    'forget-confirm': { label: 'Forget agent…', description: 'Drop its saved row; the transcript stays on disk', onClick: () => setAsk('forget') },
    stop: { label: 'Stop agent…', description: 'End its process; it stays resumable', onClick: () => opts.onStop?.() },
  }
  const menu = (): (Item & { id: ActionId })[] => agentActions(agent, { canStop: opts.canStop && !!opts.onStop }).map((id) => ({ id, ...items[id] }))
  const dialog = ask && (
    <AlertDialog isOpen onOpenChange={(o) => !o && setAsk(null)} title={ask === 'pause' ? `Pause ${agent.name}?` : `Forget ${agent.name}?`} actionLabel={ask === 'pause' ? 'Pause agent' : 'Forget agent'} actionVariant={ask === 'forget' ? 'destructive' : undefined}
      description={ask === 'pause' ? 'Its pane closes. Resume restarts it with its saved session in its saved folder (one cold cache write).' : `The dashboard drops its saved row and name, so Resume is no longer offered. Its conversation transcript is not deleted.`}
      onAction={() => { run.mutate(ask); setAsk(null) }} />
  )
  return { menu, dialog }
}

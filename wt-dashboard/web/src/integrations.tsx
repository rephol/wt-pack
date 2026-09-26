// Settings › Integrations & environment: the keys from ~/.config/wt-dashboard/env, editable. The server never
// returns a secret — only "set · …last4" — and refuses writes to a key a process env var overrides.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Field } from '@astryxdesign/core/Field'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Heading } from '@astryxdesign/core/Heading'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { useToast } from '@astryxdesign/core/Toast'
import { Switch } from '@astryxdesign/core/Switch'
import { api } from './rooms'
import { useServerControl } from './status'
import { Delayed, LoadError, FieldsSkeleton } from './skeletons'

type Item = { key: string; label: string; source: 'env' | 'keychain' | 'file' | 'default'; overridden: boolean }
  & ({ secret: true; set: boolean; last4: string | null } | { secret?: undefined; value: string | string[] | null; restartNeeded: boolean; loopbackOnly: boolean })
interface State { items: Item[]; loopback: boolean; app: boolean }
const SOURCE = { env: 'env var', keychain: 'Keychain', file: 'env file', default: 'default' }

function Source({ it }: { it: Item }) {
  return (
    <HStack gap={1} wrap="wrap">
      <Badge label={SOURCE[it.source]} />
      {it.overridden && <Badge variant="warning" label="set by the server's environment — read-only here" />}
    </HStack>
  )
}

export function IntegrationsSection() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['config'], queryFn: () => api<State>('/api/config') })
  const save = useMutation({
    mutationFn: ({ key, value, del }: { key: string; value?: unknown; del?: boolean }) =>
      api<State>(`/api/config/${key}`, { method: del ? 'DELETE' : 'PUT', body: JSON.stringify({ value }) }),
    onSuccess: (s) => { qc.setQueryData(['config'], s); qc.invalidateQueries({ queryKey: ['projects'] }); toast({ body: 'Saved' }) },
    onError: (e) => toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  if (!q.data) return q.isError ? <LoadError what="integrations" error={q.error} retry={() => q.refetch()} /> : <Delayed><FieldsSkeleton n={5} /></Delayed>
  const by = Object.fromEntries(q.data.items.map((i) => [i.key, i])) as Record<string, Item>
  const put = (key: string, value: unknown) => save.mutateAsync({ key, value }).then(() => true, () => false)
  return (
    <VStack gap={5}>
      <Heading level={3}>Integrations & environment</Heading>
      <Text type="supporting" size="sm">Precedence: server env var › Keychain (secrets) › ~/.config/wt-dashboard/env › default.</Text>
      <SecretKey it={by.LINEAR_API_KEY} put={put} del={() => save.mutate({ key: 'LINEAR_API_KEY', del: true })} placeholder="lin_api_…" testable />
      <SecretKey it={by.TYPESAFE_API_KEY} put={put} del={() => save.mutate({ key: 'TYPESAFE_API_KEY', del: true })} placeholder="TypeSafe key (console.typesafe.ai/keys)" />
      <ListEditor it={by.WT_DASHBOARD_PROJECTS} put={put} placeholder="/Users/me/Work/projects/repo" hint="Repo paths offered in New agent. Each must be a git repository." check />
      <HostsEditor it={by.WT_DASHBOARD_ALLOWED_HOSTS} loopback={q.data.loopback} put={put} />
      <RepoEditor it={by.WT_DASHBOARD_REPO} app={q.data.app} put={put} />
      <LeanMcp it={by.WT_AGENTS_MCP} put={put} />
    </VStack>
  )
}

// A Keychain-backed secret (Linear, TypeSafe); only Linear has a connection test — Jev's shows in Settings › Server.
function SecretKey({ it, put, del, placeholder, testable }: { it: Item; put: (k: string, v: unknown) => Promise<boolean>; del: () => void; placeholder: string; testable?: boolean }) {
  const [v, setV] = useState('')
  const [editing, setEditing] = useState(false)
  const test = useMutation({ mutationFn: () => api<{ ok: boolean; user?: string; workspace?: string; error?: string }>('/api/config/linear-test', { method: 'POST' }) })
  if (!it || !('set' in it)) return null
  const ro = it.overridden
  return (
    <Field label={it.label} inputID={`key-${it.key}`} isGroupLabel description="Stored in the macOS Keychain (service wt-dashboard); never shown again after saving.">
      <VStack gap={2}>
        <Source it={it} />
        {it.set && !editing ? (
          <HStack gap={2} align="center" wrap="wrap">
            <Text>{`set · ends in …${it.last4}`}</Text>
            {!ro && <Button label="Replace" size="sm" onClick={() => setEditing(true)} />}
            {!ro && <Button label="Remove" size="sm" variant="ghost" onClick={del} />}
          </HStack>
        ) : !ro && (
          <HStack gap={2} align="end" wrap="wrap">
            <div style={{ flex: '1 1 220px' }}>
              <TextInput label="API key" isLabelHidden type="password" autoComplete="off" placeholder={placeholder} value={v} onChange={setV} />
            </div>
            <Button label="Save" variant="primary" size="sm" isDisabled={!v.trim()} onClick={() => put(it.key, v.trim()).then((ok) => ok && (setV(''), setEditing(false)))} />
            {editing && <Button label="Cancel" size="sm" variant="ghost" onClick={() => { setV(''); setEditing(false) }} />}
          </HStack>
        )}
        {it.set && testable && (
          <HStack gap={2} align="center" wrap="wrap">
            <Button label="Test connection" size="sm" isLoading={test.isPending} onClick={() => test.mutate()} />
            {test.data && <Text size="sm" type={test.data.ok ? undefined : 'supporting'}>{test.data.ok ? `OK — ${test.data.user}${test.data.workspace ? ` · ${test.data.workspace}` : ''}` : `Failed: ${test.data.error}`}</Text>}
            {test.error && <Text size="sm">{`Failed: ${test.error.message}`}</Text>}
          </HStack>
        )}
      </VStack>
    </Field>
  )
}

function ListEditor({ it, put, placeholder, hint, check, locked }: { it: Item; put: (k: string, v: unknown) => Promise<boolean>; placeholder: string; hint: string; check?: boolean; locked?: boolean }) {
  const current = 'value' in it && Array.isArray(it.value) ? it.value : []
  const [draft, setDraft] = useState('')
  const [checks, setChecks] = useState<Record<string, string>>({})
  const ro = it.overridden || locked
  const validate = async (p: string) => {
    const r = await api<{ ok: boolean; root?: string; error?: string }>('/api/config/check-repo', { method: 'POST', body: JSON.stringify({ path: p }) }).catch((e): { ok: boolean; root?: string; error?: string } => ({ ok: false, error: String(e.message ?? e) }))
    setChecks((c) => ({ ...c, [p]: r.ok ? `✓ git repo (${r.root})` : `✗ ${r.error}` }))
  }
  return (
    <Field label={it.label} inputID={it.key} isGroupLabel description={hint}>
      <VStack gap={2}>
        <Source it={it} />
        {current.length === 0 && <Text type="supporting" size="sm">None.</Text>}
        {current.map((x) => (
          <HStack key={x} gap={2} align="center" wrap="wrap">
            <Text size="sm" style={{ overflowWrap: 'anywhere', flex: '1 1 200px' }}>{x}</Text>
            {check && <Button label="Validate" size="sm" variant="ghost" onClick={() => validate(x)} />}
            {!ro && <Button label="Remove" size="sm" variant="ghost" onClick={() => put(it.key, current.filter((y) => y !== x))} />}
            {checks[x] && <Text size="sm" type="supporting">{checks[x]}</Text>}
          </HStack>
        ))}
        {!ro && (
          <HStack gap={2} align="end" wrap="wrap">
            <div style={{ flex: '1 1 220px' }}><TextInput label="Add" isLabelHidden placeholder={placeholder} value={draft} onChange={setDraft} /></div>
            <Button label="Add" size="sm" isDisabled={!draft.trim()} onClick={() => put(it.key, [...current, draft.trim()]).then((ok) => ok && setDraft(''))} />
          </HStack>
        )}
      </VStack>
    </Field>
  )
}

function HostsEditor({ it, loopback, put }: { it: Item; loopback: boolean; put: (k: string, v: unknown) => Promise<boolean> }) {
  return (
    <VStack gap={2}>
      <Banner status="warning" title="Anyone who can reach this host can control agents"
        description={loopback ? 'Each hostname here is accepted in the Host/Origin guard (exact match, no wildcards) — e.g. the tailnet name tailscale serve uses.' : 'Read-only here: allowed hosts can be changed only from http://127.0.0.1:7777 on this machine, not over the tailnet.'} />
      <ListEditor it={it} put={put} placeholder="mac.tail1234.ts.net" hint="Exact hostnames. Applies immediately." locked={!loopback} />
    </VStack>
  )
}

function RepoEditor({ it, app, put }: { it: Item; app: boolean; put: (k: string, v: unknown) => Promise<boolean> }) {
  const value = 'value' in it && typeof it.value === 'string' ? it.value : ''
  const [v, setV] = useState(value)
  const { busy, run } = useServerControl()
  const restart = 'restartNeeded' in it && it.restartNeeded
  return (
    <Field label={it.label} inputID="umkmall-repo" isGroupLabel description="WT_DASHBOARD_REPO: the main checkout used for worktrees, PRs and the default project. Must be a git repository.">
      <VStack gap={2}>
        <Source it={it} />
        <HStack gap={2} align="end" wrap="wrap">
          <div style={{ flex: '1 1 260px' }}><TextInput label="Path" isLabelHidden placeholder="~/Work/projects/umkmall (default)" value={v} onChange={setV} isReadOnly={it.overridden} /></div>
          {!it.overridden && <Button label="Save" size="sm" isDisabled={v.trim() === value} onClick={() => put(it.key, v.trim())} />}
        </HStack>
        {restart && (app
          ? <HStack gap={2} align="center"><Text size="sm">Takes effect after a restart.</Text><Button label="Restart server" size="sm" variant="primary" isLoading={busy === 'restart'} onClick={() => run('restart')} /></HStack>
          : <Text size="sm">Takes effect after a restart: stop the server and run <code>npm start</code> in ~/.claude/skills/wt-dashboard.</Text>)}
      </VStack>
    </Field>
  )
}

// WT_AGENTS_MCP: lean = each new agent gets only its role's MCP servers (+ Jev's picks at handoff); off = claude's full set.
function LeanMcp({ it, put }: { it: Item; put: (k: string, v: unknown) => Promise<boolean> }) {
  if (!it || 'set' in it) return null
  return (
    <VStack gap={2}>
      <Switch label="Lean MCP for new agents" value={it.value === 'lean'} isDisabled={it.overridden} onChange={(on: boolean) => put(it.key, on ? 'lean' : 'full')}
        description="On: new agents start only their role's MCP servers (plus Jev's picks at handoff), saving a node process and memory per server per agent. Off: the full normal set." />
      <Source it={it} />
    </VStack>
  )
}

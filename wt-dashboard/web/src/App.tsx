import { useEffect, useMemo, useRef, useState } from 'react'
import { isUserSkip } from './pickerGuard.ts'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AppShell } from '@astryxdesign/core/AppShell'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Card } from '@astryxdesign/core/Card'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell } from '@astryxdesign/core/Table'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { ServerStatus } from './status'
import { ImageRow, FileCards, useAttachments, IMAGE_TYPES, MAX_IMAGES, type SharedFile } from './attachments'
import { useToast } from '@astryxdesign/core/Toast'
import { useDesktop } from './desktop'
import { SettingsHost, openSettings } from './settings'
import { InboxButton, InboxHost } from './inbox'
import { RoomsPage, useRoomsList } from './rooms'
import { composerEnter } from './keys'
import { commandSource, type Command } from './commands'
import { UsagePanel } from './usage'
import { SpawnHost, RemoveHost, openSpawn, openRemove, takePrefill } from './spawn'
import { Stepper, Step } from '@astryxdesign/core/Stepper'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Text } from '@astryxdesign/core/Text'
import { Heading } from '@astryxdesign/core/Heading'
import { Link } from '@astryxdesign/core/Link'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { ChatMarkdown } from './links'
import { Dialog } from '@astryxdesign/core/Dialog'
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout'
import { useResizable, ResizeHandle } from '@astryxdesign/core/Resizable'
import { Grid } from '@astryxdesign/core/Grid'
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList'
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { Thumbnail } from '@astryxdesign/core/Thumbnail'
import { ChatLayout, ChatMessageList, ChatMessage, ChatMessageBubble, ChatComposer, ChatComposerInput, ChatComposerDrawer, ChatSendButton, ChatToolCalls, type ChatToolCallItem, type ChatComposerTrigger, type ChatComposerInputHandle } from '@astryxdesign/core/Chat'
import { TypeaheadItem } from '@astryxdesign/core/Typeahead'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'

// ---------- types (mirror server.mjs) ----------
type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
interface Agent {
  background: number // shells/tasks still running after the turn (Stop does not end them)
  key: string
  id: string
  machine: string
  project: string | null
  local: boolean
  name: string
  pool: string
  status: AgentStatus
  statusSince: number
  cwd: string
  recap: string | null
  context: { used: string; total: string; pct: number } | null
  asks: boolean
  question: string | null
  lastPrompt: string | null
  session: string | null
  picker?: Picker | null
  task: string | null
}
type TaskState =
  | 'needs_you' | 'stalled' | 'shipped' | 'merged' | 'in_review'
  | 'building' | 'plan_ready' | 'planning' | 'done' | 'queued'
interface PR {
  number: number
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  ci: 'pass' | 'fail' | 'pending' | null
  review: string | null
}
interface Task extends Record<string, unknown> {
  id: string
  title: string
  url: string | null
  state: TaskState
  agent: { key: string; id: string; name: string; machine: string } | null
  project: string | null
  question: string | null
  branch: string | null
  plan: string | null
  pr: PR | null
  updatedAt: string | null
  adHoc: boolean
}
interface Overview {
  at: string
  linearEnabled: boolean
  agents: Agent[]
  tasks: Task[]
  machines: Machine[]
  counts: { needsYou: number; stalled: number; building: number; inReview: number; idleAgents: number }
}
interface Machine {
  label: string
  host: string
  local: boolean
  status: 'online' | 'offline' | 'stale' | 'connecting' | 'disabled'
  lastSeen: number | null
  error: string | null
  working: number
  idle: number
  total: number
}
interface AskQ { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string; preview?: string }[] }
interface Msg {
  id: string; role: 'user' | 'assistant' | 'tool' | 'question'; text: string; tool?: { name: string; summary: string }; images?: string[]; files?: SharedFile[]; caption?: string | null; ts: string
  questions?: AskQ[]; answered?: boolean; answers?: Record<string, string>; cancelled?: boolean
}
interface Picker {
  review: boolean
  tabs: { header: string; done: boolean }[]
  current?: number
  question?: string
  multiSelect?: boolean
  options?: { label: string; description: string; checked: boolean }[]
  other?: string | null
  layout?: 'preview'
  preview?: string
  answers?: { question: string; answer: string }[]
}

// ---------- api ----------
async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}
const agentUrl = (a: Agent) => `/api/agents/${encodeURIComponent(a.machine)}/${encodeURIComponent(a.id)}`
async function postAgent(a: Agent, body: { text?: string; keys?: string[] }) {
  const r = await fetch(agentUrl(a), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
}

// ---------- presentation maps ----------
type Dot = 'success' | 'warning' | 'error' | 'accent' | 'neutral'
const STATE: Record<TaskState, { label: string; dot: Dot; group: 'active' | 'review' | 'done' }> = {
  needs_you: { label: 'Needs you', dot: 'error', group: 'active' },
  stalled: { label: 'Stalled', dot: 'warning', group: 'active' },
  building: { label: 'Building', dot: 'accent', group: 'active' },
  plan_ready: { label: 'Plan ready', dot: 'success', group: 'active' },
  planning: { label: 'Planning', dot: 'accent', group: 'active' },
  queued: { label: 'Queued', dot: 'neutral', group: 'active' },
  in_review: { label: 'In review', dot: 'accent', group: 'review' },
  merged: { label: 'Merged', dot: 'success', group: 'done' },
  shipped: { label: 'Shipped', dot: 'success', group: 'done' },
  done: { label: 'Done', dot: 'neutral', group: 'done' },
}
const STATE_ORDER = Object.keys(STATE) as TaskState[]
const AGENT_DOT: Record<AgentStatus, Dot> = { working: 'accent', idle: 'neutral', blocked: 'error', done: 'success', unknown: 'neutral' }

const idleFor = (a: Agent) => {
  const m = Math.floor((Date.now() - a.statusSince) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// ---------- app ----------
type Page = 'overview' | 'tasks' | 'agents' | 'rooms'
// Project scope: ?project= wins, then localStorage, else all.
const initialProject = () => {
  const q = new URLSearchParams(location.search).get('project')
  if (q) return q
  try { return localStorage.getItem('project') ?? 'all' } catch { return 'all' }
}
function scopeToProject(o: Overview, project: string): Overview & { allProjects: boolean } {
  if (project === 'all') return { ...o, allProjects: true }
  const agents = o.agents.filter((a) => a.project === project)
  const tasks = o.tasks.filter((t) => t.project === project)
  const n = (s: TaskState) => tasks.filter((t) => t.state === s).length
  return {
    ...o,
    allProjects: false,
    agents,
    tasks,
    machines: o.machines.map((m) => {
      const mine = agents.filter((a) => a.machine === m.label)
      return { ...m, total: mine.length, working: mine.filter((a) => a.status === 'working').length, idle: mine.filter((a) => a.status === 'idle').length }
    }),
    counts: { needsYou: n('needs_you'), stalled: n('stalled'), building: n('building'), inReview: n('in_review'), idleAgents: agents.filter((a) => a.status === 'idle').length },
  }
}
const activeTasks = (ts: Task[]) => ts.filter((t) => STATE[t.state].group !== 'done')
const initials = (name: string) => name.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(-2).map((w) => w[0].toUpperCase()).join('')
function useNarrow(q = '(max-width: 899px)') {
  const [n, setN] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const on = () => setN(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return n
}
// Nav icons: tiny inline SVGs (Astryx's semantic set has no grid/list/people). `dot` = collapsed count badge.
type SvgProps = import('react').SVGProps<SVGSVGElement>
const iconCache = new Map<string, (p: SvgProps) => import('react').ReactElement>()
function svgIcon(key: string, body: (dot: boolean) => import('react').ReactNode, dot: boolean, dotColor = 'var(--color-icon-error, #e5484d)') {
  const k = `${key}:${dot}`
  if (!iconCache.has(k))
    iconCache.set(k, (p: SvgProps) => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" {...p}>
        {body(dot)}
        {dot && <circle cx="20" cy="4" r="3.5" fill={dotColor} stroke="none" />}
      </svg>
    ))
  return iconCache.get(k)!
}
const NAV_PATHS: Record<string, import('react').ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  tasks: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth={3} /></>,
  rooms: <><path d="M4 5h16v10H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>,
  agents: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.9 2.6 2.7 3 5.2" /></>,
}
const navIcon = (page: string, dot: boolean) => svgIcon(page, () => NAV_PATHS[page], dot)
const initialsIcon = (text: string, dot: boolean) =>
  svgIcon(`t:${text}`, () => (
    <text x="12" y="16.5" textAnchor="middle" fontSize={text.length > 1 ? 10 : 13} fontWeight={700} fill="currentColor" stroke="none">{text}</text>
  ), dot, 'currentColor')

const roomFromHash = () => decodeURIComponent(location.hash.match(/^#rooms\/(.+)$/)?.[1] ?? '') || null
const pageFromHash = (): Page => {
  const h = location.hash.slice(1)
  return h === 'tasks' || h === 'agents' ? h : h.startsWith('rooms') ? 'rooms' : 'overview'
}

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash)
  const [linearHidden, setLinearHidden] = useState(() => { try { return localStorage.getItem('linear-banner-hidden') === '1' } catch { return false } })
  const hideLinear = () => { setLinearHidden(true); try { localStorage.setItem('linear-banner-hidden', '1') } catch { /* private mode */ } }
  const [roomSlug, setRoomSlug] = useState<string | null>(roomFromHash)
  const roomsQ = useRoomsList()
  const suggested = new Set((roomsQ.data?.suggestions ?? []).map((x) => x.ticket))
  const [openPane, setOpenPane] = useState<string | null>(null)
  useEffect(() => {
    const on = () => { setPage(pageFromHash()); setRoomSlug(roomFromHash()) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  const q = useQuery({
    queryKey: ['overview'],
    queryFn: () => getJSON<Overview>('/api/overview'),
    refetchInterval: 4000,
    placeholderData: keepPreviousData,
  })
  const all = q.data
  const [project, setProjectState] = useState<string>(initialProject)
  const setProject = (p: string) => {
    setProjectState(p)
    const u = new URL(location.href)
    if (p === 'all') u.searchParams.delete('project')
    else u.searchParams.set('project', p)
    history.replaceState(null, '', u)
    try { localStorage.setItem('project', p) } catch { /* private mode */ }
  }
  const data = useMemo(() => (all ? scopeToProject(all, project) : undefined), [all, project])
  const projects = useMemo(() => {
    const n = new Map<string, number>()
    // count = agents + active tasks
    for (const t of activeTasks(all?.tasks ?? [])) if (t.project) n.set(t.project, (n.get(t.project) ?? 0) + 1)
    for (const a of all?.agents ?? []) if (a.project) n.set(a.project, (n.get(a.project) ?? 0) + 1)
    return [...n].sort((a, b) => b[1] - a[1])
  }, [all])
  const openAgent = all?.agents.find((a) => a.key === openPane) ?? null
  const narrow = useNarrow()
  const phone = useNarrow('(max-width: 639px)')
  const panel = useResizable({ defaultSize: 480, minSize: 380, maxSize: Math.max(400, Math.round(window.innerWidth / 2)), autoSaveId: 'agent-panel-width' })
  const [collapsed, setCollapsedState] = useState(() => { try { return localStorage.getItem('agent-panel-collapsed') === '1' } catch { return false } })
  const setCollapsed = (c: boolean) => {
    setCollapsedState(c)
    try { localStorage.setItem('agent-panel-collapsed', c ? '1' : '0') } catch { /* private mode */ }
  }
  const [navCollapsed, setNavCollapsedState] = useState(() => { try { return localStorage.getItem('nav-collapsed') === '1' } catch { return false } })
  const setNavCollapsed = (c: boolean) => {
    setNavCollapsedState(c)
    try { localStorage.setItem('nav-collapsed', c ? '1' : '0') } catch { /* private mode */ }
  }
  const open = (key: string) => {
    if (key.startsWith('room:')) { location.hash = `rooms/${encodeURIComponent(key.slice(5).split(':')[0])}`; return }
    setOpenPane(key); setCollapsed(false)
  }
  useDesktop(collapsed ? null : openPane, open)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const typing = el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
      if (e.key === ']' && !typing && openPane) setCollapsed(!collapsed)
      if (e.key === '[' && !typing) setNavCollapsed(!navCollapsed)
      // Esc inside the panel collapses it, unless something (a menu) already handled it.
      if (e.key === 'Escape' && !e.defaultPrevented && !el.closest('dialog') && openPane && !collapsed && el.closest('[data-agent-panel]')) setCollapsed(true)
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  })

  const nav = (
    <SideNav
      header={<SideNavHeading heading="wt-dashboard" subheading={phone ? undefined : 'herdr · umkmall'} />}
      collapsible={{ isCollapsed: navCollapsed, onCollapsedChange: setNavCollapsed, hasButton: true, buttonLabel: 'Toggle navigation ([)' }}
      footer={<VStack gap={0.5} className="hd-nav-footer"><InboxButton collapsed={navCollapsed} /><SideNavItem label="Settings" icon={<GearIcon />} onClick={() => openSettings('profile')} /><ServerStatus collapsed={navCollapsed} onOpen={() => openSettings('server')} /></VStack>}>
      {(['overview', 'tasks', 'agents', 'rooms'] as const).map((p) => {
        const alert = p === 'overview' && data?.counts.needsYou ? data.counts.needsYou : 0
        return (
          <SideNavItem
            key={p}
            label={p[0].toUpperCase() + p.slice(1)}
            icon={navIcon(p, navCollapsed && alert > 0)}
            href={`#${p}`}
            isSelected={page === p}
            endContent={alert ? <Badge variant="error" label={String(alert)} /> : undefined}
          />
        )
      })}
      <SideNavSection title="Projects">
        {[['all', 'All projects', all ? all.agents.length + activeTasks(all.tasks).length : 0] as const, ...projects.map(([p, n]) => [p, p, n] as const)].map(([v, label, n]) => (
          <SideNavItem key={v} label={label} icon={initialsIcon(v === 'all' ? '*' : initials(label), navCollapsed && n > 0)}
            isSelected={project === v} onClick={() => setProject(v)} endContent={<Badge label={String(n)} />} />
        ))}
      </SideNavSection>
    </SideNav>
  )

  return (
    <AppShell sideNav={nav} contentPadding={0} mobileNav={{ breakpoint: 'lg' }}>
      <Layout
        height="fill"
        content={
      <LayoutContent>
      <VStack gap={phone ? 3 : 6} padding={phone ? 3 : 6} style={page === 'rooms' ? { height: '100%', minHeight: 0 } : undefined}>
        {!(page === 'rooms' && roomSlug) && <HStack justify="between" align="center" wrap="wrap" gap={3}>
          <Heading level={1}>{page[0].toUpperCase() + page.slice(1)}</Heading>
          <HStack gap={3} align="center">
            {data && (
              <Text type="supporting">
                Updated <Timestamp value={data.at} format="relative" isLive />
              </Text>
            )}
            {(page === 'agents' || page === 'overview') && <Button label="New agent" size="sm" variant="primary" onClick={openSpawn} />}
            <Button label="Refresh" size="sm" onClick={() => q.refetch()} />
          </HStack>
        </HStack>}

        {q.isError && (
          <Banner status="error" title="Can't reach the dashboard server" description={`Is \`node server.mjs\` running on 127.0.0.1:7777? ${String(q.error)}`} />
        )}
        {data && !data.linearEnabled && !linearHidden && (page === 'overview' || page === 'tasks') && (
          <Banner status="info" title="Set LINEAR_API_KEY to show tickets" description="Tasks come from worktrees, PRs and agents only."
            endContent={<Button label="Dismiss" size="sm" variant="ghost" onClick={hideLinear} />} />
        )}

        {data && page === 'overview' && <OverviewPage data={data} onOpen={open} selected={openPane} />}
        {data && page === 'tasks' && <TaskBoard tasks={data.tasks} onOpen={open} selected={openPane} showProject={data.allProjects} suggested={suggested} />}
        {data && page === 'agents' && <AgentsPage data={data} onOpen={open} selected={openPane} />}
        {page === 'rooms' && <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><RoomsPage slug={roomSlug} agents={all?.agents ?? []} onSelect={(sl) => { location.hash = sl ? `rooms/${encodeURIComponent(sl)}` : 'rooms' }} onOpenAgent={open} /></div>}
      </VStack>
      </LayoutContent>
        }
        end={openAgent && !narrow ? (
          collapsed ? (
            <LayoutPanel width={48} hasDivider label="Agent panel (collapsed)" isScrollable={false}>
              <VStack gap={3} align="center" paddingBlock={4}>
                <Button label="‹" size="sm" variant="ghost" tooltip={`Expand ${openAgent.name} (])`} onClick={() => setCollapsed(false)} />
                <StatusDot variant={needsYou(openAgent) ? 'error' : AGENT_DOT[openAgent.status]} label={openAgent.status} />
                <Text weight="semibold" size="sm">{initials(openAgent.name)}</Text>
              </VStack>
            </LayoutPanel>
          ) : (
            <>
              <ResizeHandle direction="horizontal" hasDivider resizable={panel.props} label="Resize agent panel" />
              <LayoutPanel resizable={panel.props} label={`Agent ${openAgent.name}`} isScrollable={false} padding={0}>
                <AgentPanelBody key={openAgent.key} agent={openAgent} task={all?.tasks.find((t) => t.id === openAgent.task) ?? null}
                  onCollapse={() => setCollapsed(true)} autoFocus />
              </LayoutPanel>
            </>
          )
        ) : undefined}
      />
      {openAgent && narrow && (
        <Dialog isOpen onOpenChange={(o) => !o && setOpenPane(null)} variant="fullscreen" padding={0}>
          <AgentPanelBody key={openAgent.key} agent={openAgent} task={all?.tasks.find((t) => t.id === openAgent.task) ?? null}
            onCollapse={() => setOpenPane(null)} autoFocus />
        </Dialog>
      )}
      <SettingsHost />
      <SpawnHost agents={all?.agents ?? []} project={project} onOpenAgent={open} />
      <RemoveHost />
      <InboxHost onOpenAgent={open} />
    </AppShell>
  )
}

// ---------- overview ----------
function Kpi({ label, value, loud }: { label: string; value: number; loud?: 'red' | 'orange' }) {
  return (
    <Card variant={loud && value > 0 ? loud : 'default'}>
      <VStack gap={1}>
        <Text type="supporting">{label}</Text>
        <Text type="display-2" weight="bold">{String(value)}</Text>
      </VStack>
    </Card>
  )
}

function OverviewPage({ data, onOpen, selected }: { data: Overview & { allProjects: boolean }; onOpen: (p: string) => void; selected: string | null }) {
  const inbox = data.tasks.filter((t) => t.state === 'needs_you')
  const c = data.counts
  return (
    <VStack gap={6}>
      <MachinesStrip machines={data.machines} />
      <UsagePanel />
      <Grid columns={{ minWidth: 160 }} gap={3}>
        <Kpi label="Needs you" value={c.needsYou} loud="red" />
        <Kpi label="Stalled" value={c.stalled} loud="orange" />
        <Kpi label="Building" value={c.building} />
        <Kpi label="In review" value={c.inReview} />
        <Kpi label="Idle agents" value={c.idleAgents} />
      </Grid>

      <VStack gap={3}>
        <Heading level={2}>Needs you</Heading>
        {inbox.length === 0 ? (
          <Card variant="muted">
            <EmptyState isCompact title="Nothing waiting on you" description="No agent is asking a question right now." />
          </Card>
        ) : (
          inbox.map((t) => (
            <Card key={t.id}>
              <HStack justify="between" align="start" gap={4}>
                <VStack gap={1}>
                  <HStack gap={2} align="center">
                    <StatusDot variant="error" label="Needs you" isPulsing />
                    <Text weight="semibold">{t.agent?.name ?? '—'}</Text>
                    {t.agent && <Badge label={t.agent.machine} />}
                    <Text type="supporting">{t.adHoc ? 'ad-hoc' : t.id}</Text>
                  </HStack>
                  <Text maxLines={1}>{t.title}</Text>
                  {t.question && <Text type="supporting" maxLines={3}>{t.question}</Text>}
                </VStack>
                {t.agent && <Button label="Open" variant="primary" onClick={() => onOpen(t.agent!.key)} />}
              </HStack>
            </Card>
          ))
        )}
      </VStack>

      <VStack gap={3}>
        <Heading level={2}>Task board</Heading>
        <TaskBoard tasks={data.tasks} onOpen={onOpen} selected={selected} showProject={data.allProjects} />
      </VStack>
    </VStack>
  )
}

// ---------- task board ----------
function PrCell({ pr }: { pr: PR | null }) {
  if (!pr) return <Text type="supporting">—</Text>
  return (
    <HStack gap={1} align="center" wrap="wrap">
      <Link href={pr.url} target="_blank">{`#${pr.number}`}</Link>
      {pr.state === 'OPEN' && <Badge variant={pr.isDraft ? 'neutral' : 'info'} label={pr.isDraft ? 'draft' : 'ready'} />}
      {pr.ci && <Badge variant={pr.ci === 'pass' ? 'success' : pr.ci === 'fail' ? 'error' : 'warning'} label={`CI ${pr.ci}`} />}
      {pr.review && pr.state === 'OPEN' && (
        <Badge
          variant={pr.review === 'APPROVED' ? 'success' : pr.review === 'CHANGES_REQUESTED' ? 'error' : 'neutral'}
          label={pr.review.toLowerCase().replace('_', ' ')}
        />
      )}
    </HStack>
  )
}

function TaskBoard({ tasks, onOpen, showProject, selected, suggested }: { tasks: Task[]; onOpen: (p: string) => void; showProject: boolean; selected: string | null; suggested?: Set<string> }) {
  const [group, setGroup] = useState('active')
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    const f = filter.toLowerCase()
    return tasks
      .filter((t) => group === 'all' || STATE[t.state].group === group)
      .filter((t) => !f || [t.id, t.title, t.branch, t.agent?.name].some((s) => s?.toLowerCase().includes(f)))
      .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }, [tasks, group, filter])

  return (
    <VStack gap={3}>
      <HStack justify="between" align="end" wrap="wrap" gap={3}>
        <TabList value={group} onChange={setGroup}>
          <Tab value="active" label="Active" />
          <Tab value="review" label="Review" />
          <Tab value="done" label="Done" />
          <Tab value="all" label="All" />
        </TabList>
        <TextInput label="Filter tasks" isLabelHidden placeholder="Filter by id, title, branch, agent" value={filter} onChange={setFilter} hasClear size="sm" />
      </HStack>
      {rows.length === 0 ? (
        <EmptyState isCompact title="No tasks here" />
      ) : (
        <Table<Task>
          data={rows}
          idKey="id"
          density="compact"
          hasHover
          textOverflow="truncate"
          columns={[
            {
              key: 'task',
              header: 'Task',
              renderCell: (t) => (
                <VStack gap={0.5}>
                  {t.url ? <Link href={t.url} target="_blank">{t.id}</Link> : <Text type="supporting">{t.adHoc ? 'ad-hoc' : t.id}</Text>}
                  {suggested?.has(t.id) && <Link href="#rooms"><Text type="supporting" size="sm">room suggested</Text></Link>}
                  <Text maxLines={1}>{t.title}</Text>
                </VStack>
              ),
            },
            {
              key: 'state',
              header: 'State',
              renderCell: (t) => (
                <HStack gap={2} align="center">
                  <StatusDot variant={STATE[t.state].dot} label={STATE[t.state].label} isPulsing={t.state === 'needs_you'} />
                  <Text>{STATE[t.state].label}</Text>
                </HStack>
              ),
            },
            {
              key: 'agent',
              header: 'Agent',
              renderCell: (t) =>
                t.agent ? (
                  <HStack gap={1} align="center">
                    <Button label={t.agent.name} size="sm" variant={selected === t.agent.key ? "secondary" : "ghost"} onClick={() => onOpen(t.agent!.key)} />
                    <Text type="supporting" size="sm" maxLines={1}>{t.agent.machine}</Text>
                  </HStack>
                ) : <Text type="supporting">—</Text>,
            },
            ...(showProject ? [{ key: 'project', header: 'Project', renderCell: (t: Task) => <Text type="supporting" maxLines={1}>{t.project ?? '—'}</Text> }] : []),
            { key: 'branch', header: <Tooltip content="Worktree/PR linking is local-only: remote cwd paths differ"><Text weight="semibold">Branch</Text></Tooltip>, renderCell: (t) => <Text type="code" maxLines={1}>{t.branch ?? '—'}</Text> },
            { key: 'pr', header: 'PR', renderCell: (t) => <PrCell pr={t.pr} /> },
            {
              key: 'updatedAt',
              header: 'Updated',
              renderCell: (t) => (t.updatedAt ? <Timestamp value={t.updatedAt} format="relative" /> : <Text type="supporting">—</Text>),
            },
          ]}
        />
      )}
    </VStack>
  )
}

// ---------- images ----------
// Upload paths inside a user message → served thumbnails; the paths themselves are hidden.
const UPLOAD_PATH = /\S*\/(?:wt-dashboard|herdr-dash)\/uploads\/(\d{4}-\d{2}-\d{2})\/([0-9a-f-]{36}\.(?:png|jpg|webp|gif))/g
function splitUploads(text: string) {
  const urls = [...text.matchAll(UPLOAD_PATH)].map((m) => `/api/uploads/${m[1]}/${m[2]}`)
  return { text: text.replace(UPLOAD_PATH, '').trim(), urls }
}
// ---------- slash commands ----------

// ---------- AskUserQuestion ----------
const RECOMMENDED = /\s*\(Recommended\)\s*$/
function OptionLabel({ label }: { label: string }) {
  return (
    <HStack gap={2} align="center" wrap="wrap">
      <Text weight="medium">{label.replace(RECOMMENDED, '')}</Text>
      {RECOMMENDED.test(label) && <Badge variant="success" label="Recommended" />}
    </HStack>
  )
}
// Keeps the card mounted across Claude Code's redraws: the screen is polled fast (400ms for 5s after a send),
// and the card goes away only after TWO consecutive reads without a picker — one empty frame mid-transition
// used to swap the composer (with its Esc button) in under the user's pointer.
function useHeldPicker(agent: Agent): [Picker | null, () => void] {
  const [held, setHeld] = useState<Picker | null>(agent.picker ?? null)
  const [fastUntil, setFastUntil] = useState(0)
  const misses = useRef(0)
  const q = useQuery({
    queryKey: ['picker', agent.key],
    queryFn: () => getJSON<{ picker: Picker | null }>(`${agentUrl(agent)}?visible=1`),
    enabled: Boolean(held || agent.picker),
    refetchInterval: () => (Date.now() < fastUntil ? 400 : 2000),
    refetchIntervalInBackground: true, // a hidden tab/window must not freeze a stale card
  })
  useEffect(() => {
    if (agent.picker && !held) { misses.current = 0; setHeld(agent.picker) }
    // overview also sees no picker and the last visible read missed: two independent misses, drop it
    else if (!agent.picker && held && misses.current >= 1) setHeld(null)
  }, [agent.picker]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!q.data) return
    if (q.data.picker) { misses.current = 0; setHeld(q.data.picker) }
    else if (++misses.current >= 2) setHeld(null)
  }, [q.dataUpdatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  return [held, () => setFastUntil(Date.now() + 5000)]
}
// The pending picker, read off the agent's screen. One question per submit — Claude Code's own flow.
function PickerCard({ agent, picker, onSent }: { agent: Agent; picker: Picker; onSent: () => void }) {
  const qc = useQueryClient()
  const [single, setSingle] = useState('')
  const [multi, setMulti] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [sentFor, setSentFor] = useState<string | null>(null)
  const key = picker.review ? 'review' : picker.question ?? ''
  useEffect(() => {
    setSingle((picker.options ?? []).find((o) => o.checked)?.label ?? '') // revisited: the terminal marks the earlier answer ✔
    setMulti((picker.options ?? []).filter((o) => o.checked).map((o) => o.label))
    setOther('')
    setSentFor(null) // arriving on a screen (incl. returning to one) always re-enables it
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = sentFor === key // sent; wait for the screen to move on
  const answer = useMutation({
    mutationFn: async (body: object) => {
      const r = await fetch(`${agentUrl(agent)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error((await r.json()).error ?? r.status)
    },
    onSuccess: () => {
      setSentFor(key)
      onSent()
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['picker', agent.key] })
    },
  })
  const disabled = answer.isPending || waiting
  const OTHER = '__other__'
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.focus({ preventScroll: true }) }, [key])
  const skip = () => answer.mutate({ action: 'skip', question: picker.review ? 'review' : picker.question })
  const chat = () => answer.mutate({ action: 'chat', question: picker.question })
  const next = () => answer.mutate({
    question: picker.question,
    selected: picker.multiSelect ? multi : single && single !== OTHER ? [single] : [],
    other: picker.multiSelect || single === OTHER ? other : null,
  })
  // Keys: 1..N pick, Enter = Next/Submit, Esc = Skip (typing in the Other field keeps its keys).
  const onKey = (e: import('react').KeyboardEvent) => {
    if (disabled) return
    const inField = (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text'
    if (e.key === 'Escape') {
      e.preventDefault() // never let Esc reach the panel/terminal on its own
      if (isUserSkip({ key: e.key, cardHasFocus: Boolean(box.current?.contains(document.activeElement)), inFlight: disabled, targetIsTextField: inField })) skip()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (picker.review) answer.mutate({ action: 'submit' })
      else if (canSend) next()
      return
    }
    const k = Number(e.key)
    const opts = picker.options ?? []
    if (!inField && !picker.review && k >= 1 && k <= opts.length) {
      e.preventDefault()
      const label = opts[k - 1].label
      if (picker.multiSelect) setMulti((m) => (m.includes(label) ? m.filter((x) => x !== label) : [...m, label]))
      else setSingle(label)
    }
  }
  const canSend = picker.multiSelect ? multi.length > 0 || other.trim() : single === OTHER ? other.trim() : single
  const steps = [...picker.tabs.map((t) => t.header), 'Submit']
  const active = picker.review ? picker.tabs.length : picker.current ?? 0
  const goto = (i: number) => { if (!disabled && i !== active) answer.mutate({ action: 'goto', tab: i, question: picker.review ? 'review' : picker.question }) }
  return (
    <div ref={box} tabIndex={-1} onKeyDown={onKey} style={{ outline: 'none', flexShrink: 0 }}>
    <Card variant="yellow" padding={3}>
      {/* Header and footer pinned; only the body scrolls. */}
      <VStack gap={3} style={{ maxHeight: '55vh' }}>
        <VStack gap={2}>
          <HStack gap={2} align="center">
            <StatusDot variant="warning" label="Waiting for your answer" isPulsing={!waiting} />
            <Text weight="semibold">{picker.review ? 'Review your answers' : 'Question'}</Text>
          </HStack>
          {picker.tabs.length > 0 && (
            <Stepper activeStep={active} density="compact" label="Questions" onStepClick={goto}
              horizontalOptions={{ minimumStepWidth: 64, collapsedVariant: 'withLabel' }}>
              {steps.map((h, i) => (
                <Step key={h + i} step={i} label={h} isDisabled={disabled && i !== active}
                  indicator={i < picker.tabs.length && picker.tabs[i].done && i > active ? '✓' : 'auto'} />
              ))}
            </Stepper>
          )}
        </VStack>
        <VStack gap={3} isScrollable style={{ flex: 1, minHeight: 0 }}>
          {answer.isError && <Banner status="error" title="Could not send the answer" description={String(answer.error)} />}
          {picker.review ? (
            (picker.answers ?? []).map((a, i) => (
              <Card key={i} padding={2} onClick={() => goto(i)}
                style={{ cursor: disabled ? 'default' : 'pointer' }}>
                <HStack gap={2} justify="between" align="center">
                  <VStack gap={0.5}>
                    <Text type="supporting" size="sm">{a.question}</Text>
                    <Text weight="medium">{a.answer}</Text>
                  </VStack>
                  <Button label="Edit" size="sm" variant="ghost" isDisabled={disabled} onClick={(e) => { e.stopPropagation(); goto(i) }} />
                </HStack>
              </Card>
            ))
          ) : (
            <>
              <ChatMarkdown>{picker.question ?? ''}</ChatMarkdown>
              {picker.multiSelect ? (
                <CheckboxList label="Choose any" isLabelHidden value={multi} onChange={setMulti}>
                  {(picker.options ?? []).map((o) => (
                    <CheckboxListItem key={o.label} value={o.label} label={<OptionLabel label={o.label} />} description={o.description && o.description !== o.label ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={disabled} />
                  ))}
                </CheckboxList>
              ) : (
                <RadioList label="Choose one" isLabelHidden value={single} onChange={setSingle}>
                  {(picker.options ?? []).map((o) => (
                    <RadioListItem key={o.label} value={o.label} label={<OptionLabel label={o.label} />} description={o.description ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={disabled} />
                  ))}
                  {picker.layout !== 'preview' && <RadioListItem value={OTHER} label="Other…" isDisabled={disabled} />}
                </RadioList>
              )}
              {picker.preview && (
                <VStack gap={1}>
                  <Text type="supporting" size="sm">{`Preview · option ${(picker as Picker & { cursor?: number }).cursor ?? 1} (focused in the terminal)`}</Text>
                  <CodeBlock code={picker.preview} />
                </VStack>
              )}
              {(picker.multiSelect || single === OTHER) && (
                <TextInput label={picker.multiSelect ? 'Other (optional)' : 'Your answer'} value={other} onChange={setOther} isDisabled={disabled} placeholder="Type something" />
              )}
            </>
          )}
        </VStack>
        <HStack gap={2} justify="between" align="center" wrap="wrap">
          <HStack gap={1}>
            {!picker.review && <Button label="Chat about this" size="sm" variant="ghost" tooltip="Decline the options and talk it through" isDisabled={disabled} onClick={chat} />}
            <Button label={picker.review ? 'Cancel' : 'Skip'} size="sm" variant="ghost" tooltip="Cancels the question in the terminal (Esc)" isDisabled={disabled} onClick={skip} />
          </HStack>
          <HStack gap={2} align="center">
            {waiting && <Text type="supporting" size="sm">Sent — waiting…</Text>}
            {picker.review
              ? <Button label="Submit answers" variant="primary" isLoading={answer.isPending} isDisabled={disabled} onClick={() => answer.mutate({ action: 'submit' })} />
              : <Button label={picker.tabs.length > 1 ? 'Next' : 'Answer'} variant="primary" isLoading={answer.isPending} isDisabled={disabled || !canSend} onClick={next} />}
          </HStack>
        </HStack>
      </VStack>
    </Card>
    </div>
  )
}
// Answered (or cancelled) question from the transcript: compact summary.
function QuestionSummary({ m }: { m: Msg }) {
  const qs = m.questions ?? []
  return (
    <Collapsible defaultIsOpen={false} chevronPosition="start"
      trigger={<Text type="supporting" size="sm">{m.cancelled ? `Question cancelled (${qs.length})` : m.answered ? `Answered ${qs.length} question${qs.length === 1 ? '' : 's'}` : 'Question pending'}</Text>}>
      <VStack gap={2}>
        {qs.map((q, i) => (
          <VStack key={i} gap={0.5}>
            <HStack gap={2} align="center">{q.header && <Badge label={q.header} />}<Text size="sm">{q.question}</Text></HStack>
            <Text weight="medium" size="sm">{m.answers?.[q.question] ?? (m.cancelled ? '—' : '…')}</Text>
            {q.options.filter((o) => o.preview).map((o) => <CodeBlock key={o.label} code={o.preview!} />)}
          </VStack>
        ))}
      </VStack>
    </Collapsible>
  )
}

// ---------- machines ----------
const MACHINE_DOT: Record<Machine['status'], Dot> = { online: 'success', stale: 'warning', offline: 'error', connecting: 'neutral', disabled: 'neutral' }
function MachinesStrip({ machines }: { machines: Machine[] }) {
  return (
    <Grid columns={{ minWidth: 240 }} gap={3}>
      {machines.map((m) => (
        <Card key={m.label} padding={3}>
          <VStack gap={1}>
            <HStack gap={2} align="center">
              <StatusDot variant={MACHINE_DOT[m.status]} label={m.status} tooltip={m.error ?? m.status} />
              <Text weight="semibold" maxLines={1}>{m.label}</Text>
              <Badge label={m.local ? 'local' : m.status} variant={m.status === 'offline' ? 'error' : m.status === 'stale' ? 'warning' : 'neutral'} />
            </HStack>
            <Text type="supporting" size="sm" maxLines={1}>{`${m.host} · ${m.working} working · ${m.idle} idle · ${m.total} total`}</Text>
            {!m.local && (
              <Text type="supporting" size="sm">
                {m.lastSeen ? <>seen <Timestamp value={new Date(m.lastSeen).toISOString()} format="relative" hasTooltip={false} /></> : 'never seen'}
              </Text>
            )}
          </VStack>
        </Card>
      ))}
    </Grid>
  )
}

// ---------- agents ----------
const POOLS = [
  { key: 'orchestrator', title: 'Orchestrator' },
  { key: 'planner', title: 'Planners' },
  { key: 'worker', title: 'Workers' },
  { key: 'other', title: 'Other' },
]
const needsYou = (a: Agent) => a.asks && a.status !== 'working'
const rank = (a: Agent) => (needsYou(a) ? 0 : ({ working: 1, blocked: 2, idle: 3, unknown: 3, done: 4 } as const)[a.status])
const AGENT_FILTERS: Record<string, (a: Agent, t?: Task) => boolean> = {
  all: () => true,
  busy: (a) => a.status === 'working' || a.status === 'blocked',
  free: (a) => (a.status === 'idle' || a.status === 'done') && !needsYou(a),
  needs: needsYou,
}
const shortPath = (p: string | null) => (p ? p.split('/').filter(Boolean).at(-1) ?? p : null)

function AgentsPage({ data, onOpen, selected }: { data: Overview & { allProjects: boolean }; onOpen: (p: string) => void; selected: string | null }) {
  const [filter, setFilter] = useState('all')
  const [machine, setMachine] = useState('all')
  const taskOf = (a: Agent) => data.tasks.find((t) => t.id === a.task)
  return (
    <VStack gap={6}>
      <MachinesStrip machines={data.machines} />
      <HStack gap={3} wrap="wrap">
      <SegmentedControl label="Filter by machine" value={machine} onChange={setMachine} size="sm">
        <SegmentedControlItem value="all" label="All machines" />
        {data.machines.map((m) => <SegmentedControlItem key={m.label} value={m.label} label={m.label} />)}
      </SegmentedControl>
      <SegmentedControl label="Filter agents" value={filter} onChange={setFilter} size="sm">
        <SegmentedControlItem value="all" label="All" />
        <SegmentedControlItem value="busy" label="Busy" />
        <SegmentedControlItem value="free" label="Free" />
        <SegmentedControlItem value="needs" label="Needs you" />
      </SegmentedControl>
      </HStack>
      {POOLS.map(({ key, title }) => {
        const pool = data.agents.filter((a) => a.pool === key)
        const rows = pool
          .filter((a) => AGENT_FILTERS[filter](a, taskOf(a)) && (machine === 'all' || a.machine === machine))
          .sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name))
        if (!pool.length) return null
        return (
          <VStack key={key} gap={2}>
            <Heading level={2}>{`${title} (${pool.length})`}</Heading>
            {rows.length === 0 ? (
              <Text type="supporting">No agents match this filter.</Text>
            ) : (
              <Table density="compact" hasHover textOverflow="truncate">
                <TableHeader>
                  <TableRow isHeaderRow>
                    <TableHeaderCell style={{ width: 230, minWidth: 230, maxWidth: 230 }}>Agent</TableHeaderCell>
                    <TableHeaderCell style={{ width: 130, minWidth: 130, maxWidth: 130 }}>Machine</TableHeaderCell>
                    <TableHeaderCell style={{ width: 130, minWidth: 130, maxWidth: 130 }}>Status</TableHeaderCell>
                    {data.allProjects && <TableHeaderCell style={{ width: 120, minWidth: 120, maxWidth: 120 }}>Project</TableHeaderCell>}
                    <TableHeaderCell style={{ minWidth: 220 }}>Task</TableHeaderCell>
                    <TableHeaderCell style={{ width: 160, minWidth: 160, maxWidth: 160 }}>
                      <Tooltip content="Worktree/PR linking is local-only: remote cwd paths differ"><Text weight="semibold">Branch</Text></Tooltip>
                    </TableHeaderCell>
                    <TableHeaderCell style={{ width: 110, minWidth: 110, maxWidth: 110 }}>Context</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((a) => {
                    const t = taskOf(a)
                    const quiet = !needsYou(a) && (a.status === 'idle' || a.status === 'done') && !t
                    const color = quiet ? 'secondary' : 'primary'
                    const summary = t ? `${t.adHoc ? '' : t.id + ' · '}${t.title}` : a.recap ?? '—'
                    return (
                      <TableRow key={a.key} onClick={() => onOpen(a.key)} aria-selected={selected === a.key}>
                        <TableCell>
                          <HStack gap={2} align="center">
                            <StatusDot variant={needsYou(a) ? 'error' : AGENT_DOT[a.status]} label={a.status} isPulsing={a.status === 'working' || needsYou(a)} />
                            <Button label={a.name} variant={selected === a.key ? "secondary" : "ghost"} size="sm" onClick={(e) => { e.stopPropagation(); onOpen(a.key) }} />
                            {needsYou(a) && <Badge variant="error" label="Needs you" />}
                            {a.background > 0 && <Badge label={`${a.background} background`} />}
                            <span onClick={(e) => e.stopPropagation()} style={{ marginInlineStart: 'auto' }}>
                              <DropdownMenu button={{ label: `${a.name} actions`, icon: <span aria-hidden>⋯</span>, isIconOnly: true, size: 'sm', variant: 'ghost' }} hasChevron={false} alignment="end" items={[
                                { label: 'Open', onClick: () => onOpen(a.key) },
                                a.local ? { label: 'Remove agent…', onClick: () => openRemove(a) } : { label: 'Remove agent…', description: 'Remote agents: not supported yet', isDisabled: true, onClick: () => {} },
                              ]} />
                            </span>
                          </HStack>
                        </TableCell>
                        <TableCell>
                          <Text color={color} maxLines={1}>{a.local ? `${a.machine} (local)` : a.machine}</Text>
                        </TableCell>
                        <TableCell>
                          <Text color={color} maxLines={1}>{`${a.status} · ${idleFor(a)}`}</Text>
                        </TableCell>
                        {data.allProjects && (
                          <TableCell><Text type="supporting" maxLines={1}>{a.project ?? '—'}</Text></TableCell>
                        )}
                        <TableCell>
                          <Tooltip content={a.recap ?? summary}>
                            <HStack gap={1} align="center">
                              {t?.url && <Link href={t.url} target="_blank">{t.id}</Link>}
                              <Text color={color} maxLines={1} hasTruncateTooltip={false}>{t?.url ? t.title : summary}</Text>
                            </HStack>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Text type="code" color={color} maxLines={1}>{t?.branch ?? shortPath(a.cwd) ?? '—'}</Text>
                        </TableCell>
                        <TableCell>
                          {a.context ? (
                            <ProgressBar label="Context" isLabelHidden hasValueLabel value={a.context.pct}
                              variant={a.context.pct > 80 ? 'error' : a.context.pct > 60 ? 'warning' : 'neutral'} />
                          ) : <Text type="supporting">—</Text>}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </VStack>
        )
      })}
    </VStack>
  )
}

// ---------- drawer ----------
// Consecutive tool rows → one ChatToolCalls group; a "result" row fills the preceding call's detail.
type Row = { kind: 'msg'; m: Msg } | { kind: 'tools'; id: string; calls: ChatToolCallItem[] }
function toRows(msgs: Msg[]): Row[] {
  const rows: Row[] = []
  for (const m of msgs) {
    if (m.role !== 'tool') { rows.push({ kind: 'msg', m }); continue } // user/assistant/question
    let g = rows.at(-1)
    if (g?.kind !== 'tools') rows.push((g = { kind: 'tools', id: m.id, calls: [] }))
    const last = g.calls.at(-1)
    if (m.tool?.name === 'result' && last && !last.resultDetail) {
      last.resultDetail = <Text type="code" size="sm">{m.text || '(empty result)'}</Text>
    } else if (m.tool?.name !== 'result') {
      g.calls.push({ key: m.id, name: m.tool?.name ?? 'tool', target: m.tool?.summary, status: 'complete' })
    }
  }
  return rows.filter((r) => r.kind === 'msg' || r.calls.length)
}

function AgentPanelBody({ agent, task, onCollapse, autoFocus }: { agent: Agent; task: Task | null; onCollapse: () => void; autoFocus: boolean }) {
  const [tab, setTab] = useState('conversation')
  const narrow = useNarrow()
  const [draft, setDraft] = useState(() => takePrefill(agent.key))
  const { atts, attErr, addFiles, removeAtt, clear: clearAtts, uploading } = useAttachments(agent.local ? null : 'Images only for local agents')
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<ChatComposerInputHandle>(null)
  const [heldPicker, bumpPicker] = useHeldPicker(agent)
  // Keep the list pinned to its end when the card appears or changes height.
  const chatBox = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = chatBox.current
    if (!box || !heldPicker) return
    const toEnd = () => { const el = box.firstElementChild as HTMLElement | null; if (el) el.scrollTop = el.scrollHeight }
    const ro = new ResizeObserver(toEnd)
    ro.observe(box)
    return () => ro.disconnect()
  }, [Boolean(heldPicker)]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!autoFocus) return
    const t = setTimeout(() => {
      const el = document.activeElement as HTMLElement | null
      const typing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      if (!typing) inputRef.current?.focus()
    }, 50)
    return () => clearTimeout(t)
  }, [autoFocus, tab])
  const cmds = useQuery({
    queryKey: ['commands', agent.key],
    queryFn: () => getJSON<Command[]>(`${agentUrl(agent)}/commands`),
    staleTime: 60_000,
  })
  const slash = useMemo<ChatComposerTrigger>(() => ({
    character: '/',
    searchSource: commandSource(cmds.data ?? []),
    renderItem: (item) => {
      const c = item.auxiliaryData as Command
      return <TypeaheadItem item={item} description={c.description} group={c.source} />
    },
    onSelect: (item) => ({ value: `/${item.label}`, label: `/${item.label}`, variant: 'blue' as const }),
  }), [cmds.data])
  const submit = (v: string) => {
    const paths = atts.filter((a) => a.path).map((a) => a.path!)
    if (!v.trim() && !paths.length) return
    const text = [v.trim(), paths.join('\n')].filter(Boolean).join('\n\n')
    // "working" can lag the 4s poll right after a send, so a send within 30s of the last one counts as mid-turn too.
    const busy = agent.status === 'working' || Date.now() - lastSend.current < 30_000
    lastSend.current = Date.now()
    send.mutate({ text }, { onSuccess: () => { if (busy) setQueued((q) => [...q, { id: crypto.randomUUID(), text }]) } })
  }
  const qc = useQueryClient()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [streamErr, setStreamErr] = useState(false)
  // Keyed on the session id: /clear or a restart gives a new transcript, so reconnect.
  const live = agent.local && Boolean(agent.session)
  // Remote (or session-less) agents: pane-read timeline instead of the transcript stream.
  const pane = useQuery({
    queryKey: ['pane', agent.key],
    queryFn: () => getJSON<{ turns: { role: 'user' | 'assistant'; text: string }[] }>(`${agentUrl(agent)}?lines=500`),
    enabled: !live,
    refetchInterval: agent.status === 'working' ? 5000 : false,
  })
  useEffect(() => {
    if (!live && pane.data) setMsgs(pane.data.turns.map((t, i) => ({ id: `pane:${i}`, role: t.role, text: t.text, ts: '' })))
  }, [live, pane.data])
  useEffect(() => {
    setMsgs([])
    if (!live) return
    const es = new EventSource(`${agentUrl(agent)}/stream`)
    es.onmessage = (ev) => {
      const incoming: Msg[] = JSON.parse(ev.data)
      setMsgs((prev) => {
        const byId = new Map(prev.map((m) => [m.id, m]))
        // A question's answer arrives as an update to the same id.
        for (const m of incoming) byId.set(m.id, byId.has(m.id) && m.role === 'question' ? { ...byId.get(m.id)!, ...m, questions: byId.get(m.id)!.questions ?? m.questions } : byId.get(m.id) ?? m)
        return [...byId.values()]
      })
      setStreamErr(false)
    }
    es.onerror = () => setStreamErr(true) // EventSource retries on its own
    return () => es.close()
  }, [agent.key, agent.session, live]) // eslint-disable-line react-hooks/exhaustive-deps
  // Sent while the agent works: Claude Code takes it at its next step. Shown as "queued" until the
  // transcript has it (matched on its first line), or 15s after the agent is idle again.
  const [queued, setQueued] = useState<{ id: string; text: string }[]>([])
  const lastSend = useRef(0)
  useEffect(() => {
    if (!queued.length) return
    const users = msgs.filter((m) => m.role === 'user').slice(-20).map((m) => m.text)
    const left = queued.filter((q) => !users.some((t) => t.includes(q.text.split('\n')[0].slice(0, 60))))
    if (left.length !== queued.length) setQueued(left)
  }, [msgs]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (agent.status === 'working' || !queued.length) return
    const t = setTimeout(() => setQueued([]), 15_000)
    return () => clearTimeout(t)
  }, [agent.status, queued.length])
  const rows = useMemo(() => toRows(msgs), [msgs])

  // Stop: Escape via the server's stale-checked /stop. "Stopping…" until the status leaves working (10s → toast).
  const toast = useToast()
  const [stopping, setStopping] = useState(false)
  const stopM = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${agentUrl(agent)}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
    },
    onSuccess: () => { setStopping(true); qc.invalidateQueries({ queryKey: ['overview'] }) },
    onError: (e) => { console.error('stop failed', e); toast({ body: `Stop not sent: ${e instanceof Error ? e.message : e}`, type: 'error' }) },
  })
  const stop = () => { if (!stopping && !stopM.isPending && agent.status === 'working') stopM.mutate() }
  useEffect(() => { if (agent.status !== 'working') setStopping(false) }, [agent.status])
  useEffect(() => {
    if (!stopping) return
    const t = setTimeout(() => { setStopping(false); toast({ body: `${agent.name} is still working 10s after Stop`, type: 'error' }) }, 10_000)
    return () => clearTimeout(t)
  }, [stopping]) // eslint-disable-line react-hooks/exhaustive-deps
  const send = useMutation({
    mutationFn: (body: { text?: string; keys?: string[] }) => postAgent(agent, body),
    onSuccess: (_d, body) => {
      if (body.text && body.text !== 'continue') {
        setDraft('')
        clearAtts()
      }
      qc.invalidateQueries({ queryKey: ['overview'] })
    },
  })
  // The list is built only when the transcript (or working state) changes, never per keystroke:
  // the draft lives in this component, and re-rendering 200+ Markdown messages per key was the lag.
  const working = agent.status === 'working'
  const messageList = useMemo(() => (
              <ChatMessageList density="compact" isStreaming={working}>
                {rows.map((r) =>
                  r.kind === 'tools' ? (
                    <ChatMessage key={r.id} sender="assistant">
                      <ChatMessageBubble variant="ghost" width="100%">
                        <ChatToolCalls calls={r.calls} />
                      </ChatMessageBubble>
                    </ChatMessage>
                  ) : r.m.role === 'question' ? (!r.m.answered && !r.m.cancelled ? null : // pending: the card below is the question

                    <ChatMessage key={r.m.id} sender="assistant">
                      <ChatMessageBubble variant="ghost" width="100%"><QuestionSummary m={r.m} /></ChatMessageBubble>
                    </ChatMessage>
                  ) : r.m.role === 'user' ? (
                    <ChatMessage key={r.m.id} sender="user">
                      {(() => {
                        const u = splitUploads(r.m.text)
                        const imgs = [...u.urls, ...(r.m.images ?? [])]
                        return (
                          <>
                            {u.text && <ChatMessageBubble>{u.text}</ChatMessageBubble>}
                            {imgs.length > 0 && <ChatMessageBubble variant="ghost"><ImageRow srcs={imgs} /></ChatMessageBubble>}
                          </>
                        )
                      })()}
                    </ChatMessage>
                  ) : (
                    <ChatMessage key={r.m.id} sender="assistant">
                      <ChatMessageBubble variant="ghost" width="100%">
                        {r.m.text && <ChatMarkdown>{r.m.text}</ChatMarkdown>}
                        {r.m.images?.length ? <ImageRow srcs={r.m.images} /> : null}
                        {r.m.files?.length ? <FileCards files={r.m.files} caption={r.m.caption} /> : null}
                      </ChatMessageBubble>
                    </ChatMessage>
                  ),
                )}
              </ChatMessageList>
  ), [rows, working])

  return (
      <VStack gap={3} height="100%" padding={4} data-agent-panel="">
        <HStack justify="between" align="center" gap={2} style={{ minWidth: 0, flexWrap: 'nowrap' }}>
          <HStack gap={2} align="center" style={{ minWidth: 0, flex: 1 }}>
            <StatusDot variant={needsYou(agent) ? 'error' : AGENT_DOT[agent.status]} label={agent.status} isPulsing={agent.status === 'working'} />
            <VStack gap={0.5} style={{ minWidth: 0 }}>
              <HStack gap={1} align="center" style={{ minWidth: 0 }}>
                <Text weight="semibold" maxLines={1}>{agent.name}</Text>
                {agent.background > 0 && <Badge label={`${agent.background} background`} />}
              </HStack>
              <Text type="supporting" size="sm" maxLines={1}>{narrow
                ? `${agent.local ? '' : `${agent.machine} · `}${agent.status} · ${idleFor(agent)}`
                : `${agent.machine} · ${agent.pool} · ${agent.status} for ${idleFor(agent)}`}</Text>
            </VStack>
          </HStack>
          <HStack gap={0} style={{ flexShrink: 0 }}>
          <DropdownMenu button={{ label: 'Agent actions', icon: <span aria-hidden>⋯</span>, isIconOnly: true, size: 'sm', variant: 'ghost' }} hasChevron={false} alignment="end" items={[
            agent.local
              ? { label: 'Remove agent…', description: 'Close its tab and end its conversation', onClick: () => openRemove(agent) }
              : { label: 'Remove agent…', description: 'Remote agents: not supported yet', isDisabled: true, onClick: () => {} },
          ]} />
          <IconButton label="Close panel" icon={<Icon icon="close" />} size={narrow ? 'md' : 'sm'} variant="ghost" tooltip="Close (Esc)" onClick={onCollapse} style={{ flexShrink: 0, minWidth: narrow ? 44 : undefined, minHeight: narrow ? 44 : undefined }} />
          </HStack>
        </HStack>
        <TabList value={tab} onChange={setTab} hasDivider>
          <Tab value="summary" label="Summary" />
          <Tab value="conversation" label="Conversation" />
        </TabList>

        {tab === 'summary' ? (
          <VStack gap={3} isScrollable>
            <Text type="label">Recap</Text>
            <Text>{agent.recap ?? '—'}</Text>
            <Text type="label">Task</Text>
            <Text>{task ? `${task.adHoc ? 'ad-hoc' : task.id} · ${STATE[task.state].label} · ${task.title}` : 'No task'}</Text>
            {task?.plan && <Text type="code">{task.plan}</Text>}
            <Text type="label">cwd</Text>
            <Text type="code">{agent.cwd}</Text>
            {agent.question && (
              <>
                <Text type="label">Waiting on</Text>
                <Card variant="red"><Text>{agent.question}</Text></Card>
              </>
            )}
          </VStack>
        ) : (
          <VStack gap={2} style={{ flex: 1, minHeight: 0 }}>
            {!live && <Text type="supporting" size="sm">{agent.local ? 'no transcript · pane view' : 'remote · pane view'}</Text>}
            {pane.isError && <Banner status="error" title="Couldn't read pane" description={String(pane.error)} />}
            {streamErr && <Banner status="warning" title="Transcript stream disconnected — retrying" />}
            {send.isError && <Banner status="error" title="Send failed" description={String(send.error)} />}
            <div ref={chatBox} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ChatLayout
              emptyState={<EmptyState isCompact title="No messages yet" />}
              composer={heldPicker ? null : (
                <ChatComposer
                  sendButton={working ? <Tooltip content="Queue: Claude picks it up after its current step"><span><ChatSendButton /></span></Tooltip> : undefined}
                  value={draft}
                  onChange={setDraft}
                  onSubmit={submit}
                  isDisabled={send.isPending || uploading}
                  input={<ChatComposerInput onKeyDown={(e: import('react').KeyboardEvent) => {
                    // Esc while the agent works = Stop. (A pending question replaces this composer, so its Esc stays Skip.)
                    if (e.key === 'Escape' && agent.status === 'working' && !heldPicker) { e.preventDefault(); stop() }
                    composerEnter(e)
                  }} handleRef={inputRef} triggers={[slash]} onFiles={addFiles} placeholder={`Message ${agent.name}…`} isDisabled={send.isPending} />}
                  status={attErr ? { type: 'warning', message: attErr } : undefined}
                  headerActions={narrow ? undefined : <>
                      <IconButton label="Skills & commands" icon={<span aria-hidden style={{ fontWeight: 600 }}>/</span>} size="sm" variant="ghost" tooltip="Skills & commands (/)"
                        onClick={() => { inputRef.current?.focus(); inputRef.current?.insertText('/') }} />
                      <IconButton label="Attach image" icon={<ClipIcon />} size="sm" variant="ghost" isDisabled={!agent.local || atts.length >= MAX_IMAGES}
                        tooltip={agent.local ? 'Attach png/jpeg/webp/gif (or paste / drop)' : 'Images only for local agents'}
                        onClick={() => fileRef.current?.click()} />
                      <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden
                        onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
                    </>}
                  drawer={atts.length ? (
                    <ChatComposerDrawer>
                      <HStack gap={2} wrap="wrap">
                        {atts.map((a) => (
                          <Thumbnail key={a.id} src={a.preview} label={a.error ? `${a.name}: ${a.error}` : a.name} alt={a.name}
                            isLoading={!a.path && !a.error} onRemove={() => removeAtt(a.id)} showRemoveOn="always" />
                        ))}
                      </HStack>
                    </ChatComposerDrawer>
                  ) : undefined}
                  placeholder={`Prompt ${agent.name}…`}
                  density="compact"
                  sendActions={
                    <HStack gap={1}>
                      {narrow && <>
                      <IconButton label="Skills & commands" icon={<span aria-hidden style={{ fontWeight: 600 }}>/</span>} size="sm" variant="ghost" tooltip="Skills & commands (/)"
                        onClick={() => { inputRef.current?.focus(); inputRef.current?.insertText('/') }} />
                      <IconButton label="Attach image" icon={<ClipIcon />} size="sm" variant="ghost" isDisabled={!agent.local || atts.length >= MAX_IMAGES}
                        tooltip={agent.local ? 'Attach png/jpeg/webp/gif (or paste / drop)' : 'Images only for local agents'}
                        onClick={() => fileRef.current?.click()} />
                      <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden
                        onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
                    </>}
                      {stopping && <Text type="supporting" size="sm">Stopping…</Text>}
                      {working && !stopping && <IconButton label="Stop" icon={<Icon icon="stop" />} size="sm" variant="secondary" tooltip="Stop the current turn (Esc)" onClick={stop} />}
                      <IconButton label="Nudge" icon={<NudgeIcon />} size="sm" variant="ghost" tooltip='Nudge: send "continue"' isDisabled={send.isPending} onClick={() => send.mutate({ text: 'continue' })} />
                    </HStack>
                  }
                />
              )}>
              {messageList}
              {queued.length > 0 && (
                <VStack gap={1} style={{ padding: '0 8px 8px', alignItems: 'flex-end' }}>
                  {queued.map((q) => (
                    <HStack key={q.id} gap={1} align="center" style={{ opacity: 0.7, maxWidth: '85%' }}>
                      <Badge label="queued" />
                      <Text size="sm" maxLines={2}>{q.text}</Text>
                    </HStack>
                  ))}
                </VStack>
              )}
            </ChatLayout>
            </div>
            {/* The question card sits BELOW the list (not in the sticky dock), so nothing can draw over it. */}
            {heldPicker && <PickerCard agent={agent} picker={heldPicker} onSent={bumpPicker} />}
          </VStack>
        )}
      </VStack>
  )
}

const svg = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const ClipIcon = () => <svg {...svg}><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>
const NudgeIcon = () => <svg {...svg}><path d="m6 17 5-5-5-5M13 17l5-5-5-5" /></svg>
const GearIcon = () => <svg {...svg}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>

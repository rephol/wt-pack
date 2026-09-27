// Settings dialog, laid out after Astryx's settings-dialog template
// (@astryxdesign/cli/assets/templates/pages/settings-dialog/page.tsx): one registry (GROUPS) feeds a grouped side
// nav and a content pane with the panel's title and one-line description; panels are cards of rows
// (settingsRows.tsx). Phone: a section list, then the section full-screen with Back. Opened from the sidebar,
// ⌘, in the app, or `openSettings(section)` from anywhere. Server-side settings save on change ("Saved");
// the profile has an explicit Save because name/handle are typed.
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@astryxdesign/core/Dialog'
import { Layout, LayoutContent } from '@astryxdesign/core/Layout'
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Divider } from '@astryxdesign/core/Divider'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Switch } from '@astryxdesign/core/Switch'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { Avatar } from '@astryxdesign/core/Avatar'
import { Kbd } from '@astryxdesign/core/Kbd'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Heading } from '@astryxdesign/core/Heading'
import { useToast } from '@astryxdesign/core/Toast'
import { api, type Profile, type RoomSettings } from './rooms'
import { ServerPanel } from './status'
import { HousekeepingSection } from './housekeeping'
import { WatchdogSection } from './watchdog'
import { BoardHistorySection, RoutinesHistorySection } from './routines'
import { IntegrationsSection } from './integrations'
import { TerminalsSection } from './terminals'
import { InstallRow } from './pwa'
import { RolesSection } from './roles'
import { ObservabilitySection } from './observability'
import { MemorySection } from './memory'
import { ProjectsSection } from './projects-settings'
import { UsageBreakdown } from './usage'
import { useChatDensity, setChatDensity, useLinkPreviews, setLinkPreviews, type ChatDensity } from './density'
import { isDesktop, loadPrefs, PREFS_KEY } from './desktop'
import type { Kind } from './notifyGate'
import { Delayed, LoadError, FieldsSkeleton } from './skeletons'
import { SettingsCard, SettingsRow, CONTROL_WIDTH } from './settingsRows'

export type Section = 'profile' | 'roles' | 'memory' | 'rooms' | 'notifications' | 'integrations' | 'projects' | 'observability' | 'usage' | 'terminals' | 'server' | 'about'
type Panel = { id: Section; label: string; description: string }
// The one list both shells read, as in the template: a panel can't drift out of the nav or the phone list.
const GROUPS: { label: string; panels: Panel[] }[] = [
  { label: 'You', panels: [
    { id: 'profile', label: 'General', description: 'Your profile in rooms, and how chat looks in this browser.' },
    { id: 'notifications', label: 'Notifications', description: 'What reaches the inbox and, in the desktop app, macOS notifications.' },
  ] },
  { label: 'Agents', panels: [
    { id: 'rooms', label: 'Rooms', description: 'How agents talk to each other and to you in rooms.' },
    { id: 'roles', label: 'Roles', description: 'How agents are classified, badged and spawned.' },
    { id: 'memory', label: 'Memory', description: 'Standing preferences every agent receives at session start.' },
  ] },
  { label: 'System', panels: [
    { id: 'integrations', label: 'Integrations', description: 'API keys, projects, hosts and Jev judgments.' },
    { id: 'projects', label: 'Projects', description: 'Per-project overrides: GitHub account, base branch, agent MCP, dispatch cap and board automation.' },
    { id: 'terminals', label: 'Terminals', description: 'Shells on this machine, mirrored into the dashboard.' },
    { id: 'usage', label: 'Usage', description: 'Claude usage by agent, project and model.' },
    { id: 'observability', label: 'Observability', description: 'Jev calls, outcomes, the server log, housekeeping and the watchdog.' },
    { id: 'server', label: 'Server', description: 'The dashboard server and its data sources.' },
    { id: 'about', label: 'About', description: 'What this is, keyboard shortcuts and install.' },
  ] },
]
const PANELS = GROUPS.flatMap((g) => g.panels)
const panel = (id: Section) => PANELS.find((p) => p.id === id)!

// No section: the default — General on desktop, the section list on a phone.
export const openSettings = (section?: Section) => dispatchEvent(new CustomEvent('open-settings', { detail: section }))

const PHONE = '(max-width: 639px)'
// The sidebar project scope, for sections that filter by it (Routines history).
type Scope = { project: string; agents: { name: string; project?: string | null }[] }
const ScopeCtx = createContext<Scope>({ project: 'all', agents: [] })

export function SettingsHost(scope: Scope) {
  return <ScopeCtx.Provider value={scope}><SettingsDialog /></ScopeCtx.Provider>
}

function SettingsDialog() {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<Section>('profile')
  const [listing, setListing] = useState(false) // phone: the section list instead of a section
  useEffect(() => {
    const show = (s?: Section) => { setOpen(true); setSection(s ?? 'profile'); setListing(!s) }
    const on = (e: Event) => show((e as CustomEvent<Section | undefined>).detail)
    const key = (e: KeyboardEvent) => { if (e.metaKey && e.key === ',') { e.preventDefault(); show() } }
    addEventListener('open-settings', on)
    addEventListener('keydown', key)
    return () => { removeEventListener('open-settings', on); removeEventListener('keydown', key) }
  }, [])
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches)
  useEffect(() => { const m = matchMedia(PHONE); const on = () => setPhone(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on) }, [])
  if (!open) return null
  const close = <IconButton label="Close settings" icon={<Icon icon="close" size="sm" />} size="sm" variant="ghost" onClick={() => setOpen(false)} />
  const pick = (id: Section) => { setSection(id); setListing(false) }
  const onOpenChange = (o: boolean) => !o && setOpen(false)

  if (phone) return (
    <Dialog isOpen onOpenChange={onOpenChange} variant="fullscreen" padding={0} aria-label="Settings">
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', minWidth: 0, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <HStack justify="between" align="center" gap={2} paddingInline={3} paddingBlock={2}>
          {listing
            ? <Heading level={3}>Settings</Heading>
            : <Button label="Settings" size="sm" variant="ghost" icon={<span aria-hidden>‹</span>} onClick={() => setListing(true)} />}
          {close}
        </HStack>
        <Divider />
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {listing
            ? <nav aria-label="Settings sections">
                {GROUPS.map((g) => (
                  <div key={g.label} style={{ paddingBlock: 8 }}>
                    <div style={{ padding: '8px 16px 4px' }}><Text type="supporting" weight="semibold" color="secondary">{g.label}</Text></div>
                    {g.panels.map((p) => (
                      <button key={p.id} type="button" className="hd-set-list" onClick={() => pick(p.id)}>
                        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <Text type="label">{p.label}</Text>
                          <Text type="supporting" color="secondary">{p.description}</Text>
                        </span>
                        <span aria-hidden style={{ opacity: 0.5 }}>›</span>
                      </button>
                    ))}
                  </div>
                ))}
              </nav>
            : <div style={{ padding: 16 }}><PanelPane id={section} /></div>}
        </div>
      </div>
    </Dialog>
  )
  return (
    <Dialog isOpen onOpenChange={onOpenChange} width={1040} padding={0} aria-label="Settings">
      <div style={{ height: 'min(760px, calc(100dvh - 2rem))', display: 'flex', flexDirection: 'column' }}>
        <Layout
          start={
            <SideNav aria-label="Settings sections" className="hd-set-nav"
              header={<HStack align="center" paddingInline={2} minHeight={32}><Heading level={4}>Settings</Heading></HStack>}>
              {GROUPS.map((g) => (
                <SideNavSection key={g.label} title={g.label}>
                  {g.panels.map((p) => <SideNavItem key={p.id} label={p.label} isSelected={p.id === section} onClick={() => pick(p.id)} />)}
                </SideNavSection>
              ))}
            </SideNav>
          }
          content={
            <LayoutContent isScrollable padding={6}>
              <HStack justify="end" style={{ position: 'sticky', top: 0, height: 0, zIndex: 1 }}>{close}</HStack>
              <PanelPane id={section} />
            </LayoutContent>
          }
        />
      </div>
    </Dialog>
  )
}

// The panel's own title and one-line description (shell-owned, so every panel reads the same), then its body.
function PanelPane({ id }: { id: Section }) {
  const p = panel(id)
  return (
    <div className="hd-set-panel">
      <VStack gap={0.5}>
        <div style={{ paddingInlineEnd: 40 }}><Heading level={2}>{p.label}</Heading></div>
        <Text type="supporting" color="secondary">{p.description}</Text>
      </VStack>
      <SectionBody section={id} />
    </div>
  )
}

function SectionBody({ section }: { section: Section }) {
  const scope = useContext(ScopeCtx)
  return (
    <>
          {section === 'profile' && <ProfileSection />}
          {section === 'roles' && <RolesSection />}
          {section === 'memory' && <MemorySection />}
          {section === 'rooms' && <RoomsSection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'integrations' && <IntegrationsSection />}
          {section === 'projects' && <ProjectsSection />}
          {section === 'observability' && <VStack gap={6}><ObservabilitySection /><RoutinesHistorySection {...scope} /><BoardHistorySection /><HousekeepingSection /><WatchdogSection /></VStack>}
          {section === 'usage' && <UsageBreakdown />}
          {section === 'terminals' && <TerminalsSection />}
          {section === 'server' && <VStack gap={6}><SettingsCard title="Status"><div className="hd-set-row"><ServerPanel /></div></SettingsCard></VStack>}
          {section === 'about' && <AboutSection />}
    </>
  )
}

function useServerSettings() {
  const qc = useQueryClient()
  const toast = useToast()
  const [savedAt, setSavedAt] = useState(0)
  const q = useQuery({ queryKey: ['room-settings'], queryFn: () => api<RoomSettings>('/api/settings') })
  const set = useMutation({
    mutationFn: (p: Partial<RoomSettings>) => api<RoomSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(p) }),
    onSuccess: (s) => { qc.setQueryData(['room-settings'], s); qc.invalidateQueries({ queryKey: ['rooms'] }); setSavedAt(Date.now()) },
    onError: (e) => { console.error('settings save failed', e); toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }) },
  })
  return { s: q.data, q, set, saved: set.isPending ? 'Saving…' : Date.now() - savedAt < 3000 ? 'Saved' : '' }
}

const Status = ({ text }: { text: string }) => <span role="status"><Text type="supporting" size="sm">{text}</Text></span>

function ProfileSection() {
  const { s, q, set, saved } = useServerSettings()
  if (!s) return q.isError ? <LoadError what="settings" error={q.error} retry={() => q.refetch()} /> : <Delayed><FieldsSkeleton n={4} /></Delayed>
  return <ProfileForm key={JSON.stringify(s.profile)} profile={s.profile} save={(profile) => set.mutate({ profile })} status={saved} busy={set.isPending} />
}

function ProfileForm({ profile, save, status, busy }: { profile: Profile; save: (p: Profile) => void; status: string; busy: boolean }) {
  const density = useChatDensity()
  const previews = useLinkPreviews()
  const toast = useToast()
  const [name, setName] = useState(profile.name)
  const [handle, setHandle] = useState(profile.handle)
  const [avatar, setAvatar] = useState(profile.avatar)
  const file = useRef<HTMLInputElement>(null)
  const dirty = name !== profile.name || handle !== profile.handle || avatar !== profile.avatar
  const upload = async (f: File | undefined) => {
    if (!f) return
    try {
      const r = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': f.type }, body: f })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setAvatar(j.url)
    } catch (e) { console.error('avatar upload failed', e); toast({ body: `Avatar upload failed: ${e}`, type: 'error' }) }
  }
  return (
    <>
      <VStack gap={3}>
        <SettingsCard title="Profile — seen by agents and in rooms" end={<Status text={status} />}>
          <SettingsRow title="Avatar" description="png, jpeg, webp or gif."
            control={<>
              <Avatar name={name} src={avatar ?? undefined} size="md" />
              <input ref={file} id="profile-avatar" aria-label="Avatar image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => upload(e.target.files?.[0])} hidden />
              <Button label="Upload" size="sm" onClick={() => file.current?.click()} />
              {avatar && <Button label="Remove" size="sm" variant="ghost" onClick={() => setAvatar(null)} />}
            </>} />
          <SettingsRow title="Display name" description="Shown on your messages in rooms."
            control={<TextInput label="Display name" isLabelHidden size="sm" width={CONTROL_WIDTH} value={name} onChange={setName} />} />
          <SettingsRow title="Handle" description="Agents write @handle to reach you. Letters, digits, _ and -."
            control={<TextInput label="Handle" isLabelHidden size="sm" width={CONTROL_WIDTH} value={handle} onChange={setHandle} />} />
        </SettingsCard>
        <HStack gap={2}>
          <Button label="Save profile" variant="primary" size="sm" isDisabled={!dirty || !name.trim()} isLoading={busy} onClick={() => save({ name, handle, avatar })} />
          {dirty && <Button label="Revert" variant="ghost" size="sm" onClick={() => { setName(profile.name); setHandle(profile.handle); setAvatar(profile.avatar) }} />}
        </HStack>
      </VStack>
      <SettingsCard title="This browser only">
        <SettingsRow title="Chat density" description="Spacing in agent conversations and rooms."
          control={
            <SegmentedControl label="Chat density" value={density} onChange={(v) => setChatDensity(v as ChatDensity)} size="sm">
              <SegmentedControlItem value="compact" label="Compact" />
              <SegmentedControlItem value="balanced" label="Balanced" />
              <SegmentedControlItem value="spacious" label="Spacious" />
            </SegmentedControl>
          } />
        <SettingsRow title="Link previews" description="A card under messages with links: title, summary, image; PR, issue and Linear status. Pages are fetched by the server, never your browser."
          control={<Switch label="Link previews" isLabelHidden value={previews} onChange={setLinkPreviews} />} />
      </SettingsCard>
    </>
  )
}

// A number box that saves on blur/Enter, not on every keystroke.
function NumberBox({ label, value, onSave, width = 72 }: { label: string; value: number; onSave: (n: number) => void; width?: number }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => { const n = Number(v); if (Number.isInteger(n) && n >= 0 && n <= 1000 && n !== value) onSave(n); else setV(String(value)) }
  return (
    <div style={{ width }}>
      <TextInput label={label} isLabelHidden size="sm" value={v} onChange={setV} onBlur={commit} onKeyDown={(e: import('react').KeyboardEvent) => e.key === 'Enter' && commit()} />
    </div>
  )
}

function RoomsSection() {
  const { s, q, set, saved } = useServerSettings()
  if (!s) return q.isError ? <LoadError what="settings" error={q.error} retry={() => q.refetch()} /> : <Delayed><FieldsSkeleton n={4} /></Delayed>
  return (
    <>
      <SettingsCard title="Agent to agent" end={<Status text={saved} />}>
        <SettingsRow title="Allow agents to @mention other agents" description="Off: an agent's @mention of another agent is shown but not delivered."
          control={<Switch label="Allow agents to @mention other agents" isLabelHidden value={s.agentToAgent} onChange={(v) => set.mutate({ agentToAgent: v })} />} />
        {s.agentToAgent && (
          <SettingsRow title="Hops before a human reply" description="Agent→agent deliveries in a row; then the room waits for you."
            control={<NumberBox label="Hops" value={s.maxHops} onSave={(n) => set.mutate({ maxHops: n })} />} />
        )}
        <SettingsRow title="Agents can create rooms" description="Off: `room create` from an agent is refused. On: up to 3 rooms per agent per hour; you get an inbox notice with an Archive action. Agents can never archive or delete."
          control={<Switch label="Agents can create rooms" isLabelHidden value={s.agentsCreateRooms} onChange={(v) => set.mutate({ agentsCreateRooms: v })} />} />
        <SettingsRow title="Agent post rate limit" description="Per agent, across all rooms."
          control={<>
            <NumberBox label="Posts" value={s.rateCount} onSave={(n) => set.mutate({ rateCount: n })} width={60} />
            <Text size="sm">posts per</Text>
            <NumberBox label="Minutes" value={s.rateWindowMin} onSave={(n) => set.mutate({ rateWindowMin: n })} width={60} />
            <Text size="sm">min</Text>
          </>} />
      </SettingsCard>
      <SettingsCard title="Tickets">
        <SettingsRow title="Rooms for tickets" description="Suggest offers a room when a ticket gets activity; Auto-create makes one."
          control={
            <SegmentedControl label="Rooms for tickets" value={s.ticketRooms} onChange={(v) => set.mutate({ ticketRooms: v as RoomSettings['ticketRooms'] })} size="sm">
              <SegmentedControlItem value="off" label="Off" />
              <SegmentedControlItem value="suggest" label="Suggest" />
              <SegmentedControlItem value="auto" label="Auto-create" />
            </SegmentedControl>
          } />
      </SettingsCard>
    </>
  )
}

function NotificationsSection() {
  const [prefs, setPrefs] = useState(loadPrefs)
  const [savedAt, setSavedAt] = useState(0)
  const set = (where: 'inbox' | 'native', k: Kind, v: boolean) => {
    const next = { ...prefs, [where]: { ...prefs[where], [k]: v } }
    setPrefs(next)
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); setSavedAt(Date.now()) } catch { /* private mode */ }
  }
  const GROUPS: [string, [Kind, string][]][] = [
    ['Needs you', [['question', 'An agent asks a question'], ['mention-user', 'An agent @mentions you in a room'], ['memory-proposal', 'An agent proposes a global preference'], ['pr-held', 'A reviewer holds a PR for clarification']]],
    ['Agents', [['agent-done', 'Agent done'], ['agent-stalled', 'Agent stalled'], ['ci-failed', 'PR CI failing'], ['room-suggestion', 'Room suggestions for tickets'], ['memory', 'An agent remembers a preference']]],
    ['System', [['server', 'Server events'], ['watchdog', 'Watchdog findings'], ['usage', 'Claude usage at 80% / 95%']]],
  ]
  const cell = { width: 52, display: 'flex', justifyContent: 'center' } as const
  const head = <HStack gap={0}><div style={cell}><Text type="supporting" size="sm">Inbox</Text></div><div style={cell}><Text type="supporting" size="sm">Native</Text></div></HStack>
  return (
    <>
      <Text type="supporting">{`Inbox: shown in the bell panel. Native: macOS notifications from the desktop app${isDesktop ? '' : ' (not this browser)'}; needs the inbox kind on. Remembered in this browser.`}</Text>
      {GROUPS.map(([title, kinds], gi) => (
        <SettingsCard key={title} title={title} end={<HStack gap={3} align="center">{gi === 0 && <Status text={Date.now() - savedAt < 3000 ? 'Saved' : ''} />}{head}</HStack>}>
          {kinds.map(([k, label]) => (
            <SettingsRow key={k} title={label}
              control={<HStack gap={0}>
                <div style={cell}><Switch label={`${label} in the inbox`} isLabelHidden value={prefs.inbox[k]} onChange={(v) => set('inbox', k, v)} /></div>
                <div style={cell}><Switch label={`${label} as a native notification`} isLabelHidden value={prefs.native[k]} isDisabled={!prefs.inbox[k]} onChange={(v) => set('native', k, v)} /></div>
              </HStack>} />
          ))}
        </SettingsCard>
      ))}
    </>
  )
}

function AboutSection() {
  const rows: [string, string][] = [
    ['⌥⌘H', 'Show / hide the window (app)'], ['⌘,', 'Settings (app)'], ['[', 'Collapse the left nav'],
    [']', 'Show / hide the agent panel'], ['⌘K', 'Quick switcher (⌘↩ on a row: full page)'], ['⌘⇧↩', 'Open the agent panel as a full page'], ['Esc', 'Stop a working agent (in its composer); skip a question (on its card)'],
  ]
  return (
    <>
      <SettingsCard title="wt-dashboard">
        <SettingsRow title="A local control room for herdr-managed Claude Code agents"
          description={`${isDesktop ? 'Desktop app (Tauri).' : 'Browser.'} Server details are under Server.`} control={<InstallRow />} />
      </SettingsCard>
      <SettingsCard title="Keyboard shortcuts">
        {rows.map(([k, d]) => <SettingsRow key={k} title={d} control={<Kbd keys={k} />} />)}
      </SettingsCard>
    </>
  )
}

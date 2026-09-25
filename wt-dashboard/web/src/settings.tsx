// Settings modal: Profile, Rooms, Notifications, Server, About. Opened from the sidebar (Settings / Server),
// ⌘, in the app, or `openSettings(section)` from anywhere. Server-side settings save on change ("Saved");
// the profile has an explicit Save because name/handle are typed.
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea'
import { Fragment, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@astryxdesign/core/Dialog'
import { FormLayout } from '@astryxdesign/core/FormLayout'
import { Field } from '@astryxdesign/core/Field'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Switch } from '@astryxdesign/core/Switch'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Button } from '@astryxdesign/core/Button'
import { Avatar } from '@astryxdesign/core/Avatar'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Heading } from '@astryxdesign/core/Heading'
import { useToast } from '@astryxdesign/core/Toast'
import { api, type Profile, type RoomSettings } from './rooms'
import { ServerPanel } from './status'
import { IntegrationsSection } from './integrations'
import { TerminalsSection } from './terminals'
import { InstallRow } from './pwa'
import { isDesktop, loadPrefs, PREFS_KEY } from './desktop'
import type { Kind } from './notifyGate'

export type Section = 'profile' | 'rooms' | 'notifications' | 'integrations' | 'terminals' | 'server' | 'about'
const SECTIONS: [Section, string][] = [['profile', 'Profile'], ['rooms', 'Rooms'], ['notifications', 'Notifications'], ['integrations', 'Integrations'], ['terminals', 'Terminals'], ['server', 'Server'], ['about', 'About']]
export const openSettings = (section: Section = 'profile') => dispatchEvent(new CustomEvent('open-settings', { detail: section }))

const PHONE = '(max-width: 639px)'
export function SettingsHost() {
  const [section, setSection] = useState<Section | null>(null)
  useEffect(() => {
    const on = (e: Event) => setSection((e as CustomEvent<Section>).detail)
    const key = (e: KeyboardEvent) => { if (e.metaKey && e.key === ',') { e.preventDefault(); setSection('profile') } }
    addEventListener('open-settings', on)
    addEventListener('keydown', key)
    return () => { removeEventListener('open-settings', on); removeEventListener('keydown', key) }
  }, [])
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches)
  useEffect(() => { const m = matchMedia(PHONE); const on = () => setPhone(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on) }, [])
  if (!section) return null
  const body = <SectionBody section={section} />
  const close = <Button label="Close" size="sm" variant="ghost" onClick={() => setSection(null)} />
  const tabs = SECTIONS.map(([id, label]) => (
    <Button key={id} label={label} size="sm" variant={section === id ? 'secondary' : 'ghost'} onClick={() => setSection(id)} />
  ))
  // Phone: full-screen, section tabs as one scrolling row over the content.
  if (phone) return (
    <Dialog isOpen onOpenChange={(o) => !o && setSection(null)} variant="fullscreen" padding={0}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', minWidth: 0, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <HStack justify="between" align="center" padding={3}><Heading level={3}>Settings</Heading>{close}</HStack>
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', padding: '0 12px 8px', flexShrink: 0 }}>{tabs}</div>
        <ScrollableArea label="Settings" style={{ flex: 1, minHeight: 0 }} padding={4}>{body}</ScrollableArea>
      </div>
    </Dialog>
  )
  return (
    <Dialog isOpen onOpenChange={(o) => !o && setSection(null)} width={760} maxHeight="80vh" padding={0}>
      <div style={{ display: 'flex', flexWrap: 'wrap', height: 'min(80vh, 640px)', minWidth: 0 }}>
        <nav style={{ flex: '0 0 170px', padding: 16, borderInlineEnd: '1px solid var(--color-border-default, rgba(128,128,128,.25))' }}>
          <VStack gap={1}>
            <Heading level={3}>Settings</Heading>
            {tabs}
          </VStack>
        </nav>
        <ScrollableArea label="Settings" style={{ flex: '1 1 320px', minWidth: 0, height: '100%' }} padding={6}>
          <HStack justify="end">{close}</HStack>
          {body}
        </ScrollableArea>
      </div>
    </Dialog>
  )
}
function SectionBody({ section }: { section: Section }) {
  return (
    <>
          {section === 'profile' && <ProfileSection />}
          {section === 'rooms' && <RoomsSection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'integrations' && <IntegrationsSection />}
          {section === 'terminals' && <TerminalsSection />}
          {section === 'server' && <ServerPanel />}
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
  return { s: q.data, set, saved: set.isPending ? 'Saving…' : Date.now() - savedAt < 3000 ? 'Saved' : '' }
}

function SectionHead({ title, status }: { title: string; status?: string }) {
  return (
    <HStack justify="between" align="center">
      <Heading level={3}>{title}</Heading>
      {status ? <Text type="supporting" size="sm">{status}</Text> : null}
    </HStack>
  )
}

function ProfileSection() {
  const { s, set, saved } = useServerSettings()
  if (!s) return <Text type="supporting">…</Text>
  return <ProfileForm key={JSON.stringify(s.profile)} profile={s.profile} save={(profile) => set.mutate({ profile })} status={saved} busy={set.isPending} />
}

function ProfileForm({ profile, save, status, busy }: { profile: Profile; save: (p: Profile) => void; status: string; busy: boolean }) {
  const toast = useToast()
  const [name, setName] = useState(profile.name)
  const [handle, setHandle] = useState(profile.handle)
  const [avatar, setAvatar] = useState(profile.avatar)
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
    <VStack gap={4}>
      <SectionHead title="Profile" status={status} />
      <FormLayout>
        <Field label="Avatar" inputID="profile-avatar" description="png, jpeg, webp or gif">
          <HStack gap={3} align="center">
            <Avatar name={name} src={avatar ?? undefined} size="lg" />
            <input id="profile-avatar" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => upload(e.target.files?.[0])} style={{ maxWidth: '100%' }} />
            {avatar && <Button label="Remove" size="sm" variant="ghost" onClick={() => setAvatar(null)} />}
          </HStack>
        </Field>
        <TextInput label="Display name" description="Shown on your messages in rooms." value={name} onChange={setName} />
        <TextInput label="Handle" description="Agents write @handle to reach you. Letters, digits, _ and -." value={handle} onChange={setHandle} />
      </FormLayout>
      <HStack gap={2}>
        <Button label="Save profile" variant="primary" isDisabled={!dirty || !name.trim()} isLoading={busy} onClick={() => save({ name, handle, avatar })} />
        {dirty && <Button label="Revert" variant="ghost" onClick={() => { setName(profile.name); setHandle(profile.handle); setAvatar(profile.avatar) }} />}
      </HStack>
    </VStack>
  )
}

// A number box that saves on blur/Enter, not on every keystroke.
function NumberBox({ label, value, onSave, width = 72 }: { label: string; value: number; onSave: (n: number) => void; width?: number }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => { const n = Number(v); if (Number.isInteger(n) && n >= 0 && n <= 1000 && n !== value) onSave(n); else setV(String(value)) }
  return (
    <div style={{ width }}>
      <TextInput label={label} isLabelHidden value={v} onChange={setV} onBlur={commit} onKeyDown={(e: import('react').KeyboardEvent) => e.key === 'Enter' && commit()} />
    </div>
  )
}

function RoomsSection() {
  const { s, set, saved } = useServerSettings()
  if (!s) return <Text type="supporting">…</Text>
  return (
    <VStack gap={4}>
      <SectionHead title="Rooms" status={saved} />
      <FormLayout>
        <Switch label="Allow agents to @mention other agents" description="Off: an agent's @mention of another agent is shown but not delivered."
          value={s.agentToAgent} onChange={(v) => set.mutate({ agentToAgent: v })} />
        {s.agentToAgent && (
          <Field label="Hops before a human reply" inputID="hops" description="Agent→agent deliveries in a row; then the room waits for you.">
            <NumberBox label="Hops" value={s.maxHops} onSave={(n) => set.mutate({ maxHops: n })} />
          </Field>
        )}
        <Field label="Rooms for tickets" inputID="ticket-rooms" isGroupLabel description="Suggest offers a room when a ticket gets activity; Auto-create makes one.">
          <SegmentedControl label="Rooms for tickets" value={s.ticketRooms} onChange={(v) => set.mutate({ ticketRooms: v as RoomSettings['ticketRooms'] })} size="sm">
            <SegmentedControlItem value="off" label="Off" />
            <SegmentedControlItem value="suggest" label="Suggest" />
            <SegmentedControlItem value="auto" label="Auto-create" />
          </SegmentedControl>
        </Field>
        <Field label="Agent post rate limit" inputID="rate" isGroupLabel description="Per agent, across all rooms.">
          <HStack gap={2} align="center" wrap="wrap">
            <Text>Max</Text>
            <NumberBox label="Posts" value={s.rateCount} onSave={(n) => set.mutate({ rateCount: n })} />
            <Text>posts per</Text>
            <NumberBox label="Minutes" value={s.rateWindowMin} onSave={(n) => set.mutate({ rateWindowMin: n })} />
            <Text>minutes</Text>
          </HStack>
        </Field>
      </FormLayout>
    </VStack>
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
  const LABELS: [Kind, string][] = [
    ['question', 'An agent asks a question'], ['mention-user', 'An agent @mentions you in a room'], ['room-suggestion', 'Room suggestions for tickets'],
    ['agent-done', 'Agent done'], ['agent-stalled', 'Agent stalled'], ['ci-failed', 'PR CI failing'], ['server', 'Server events'], ['usage', 'Claude usage at 80% / 95%'],
  ]
  return (
    <VStack gap={4}>
      <SectionHead title="Notifications" status={Date.now() - savedAt < 3000 ? 'Saved' : ''} />
      <Text type="supporting">Inbox: shown in the bell panel. Native: macOS notifications from the desktop app{isDesktop ? '' : ' (not this browser)'}. Native needs the inbox kind on.</Text>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: '10px 16px', alignItems: 'center' }}>
        <Text size="sm" weight="semibold">Kind</Text><Text size="sm" weight="semibold">Inbox</Text><Text size="sm" weight="semibold">Native</Text>
        {LABELS.map(([k, label]) => (
          <Fragment key={k}>
            <Text size="sm">{label}</Text>
            <Switch label={`${label} in the inbox`} isLabelHidden value={prefs.inbox[k]} onChange={(v) => set('inbox', k, v)} />
            <Switch label={`${label} as a native notification`} isLabelHidden value={prefs.native[k]} isDisabled={!prefs.inbox[k]} onChange={(v) => set('native', k, v)} />
          </Fragment>
        ))}
      </div>
    </VStack>
  )
}

function AboutSection() {
  const rows: [string, string][] = [
    ['⌥⌘H', 'Show / hide the window (app)'], ['⌘,', 'Settings (app)'], ['[', 'Collapse the left nav'],
    [']', 'Show / hide the agent panel'], ['⌘K', 'Quick switcher (⌘↩ on a row: full page)'], ['⌘⇧↩', 'Open the agent panel as a full page'], ['Esc', 'Stop a working agent (in its composer); skip a question (on its card)'],
  ]
  return (
    <VStack gap={3}>
      <Heading level={3}>About</Heading>
      <Text>wt-dashboard — a local control room for herdr-managed Claude Code agents.</Text>
      <Text type="supporting">{isDesktop ? 'Desktop app (Tauri).' : 'Browser.'} Server details are under Server.</Text>
      <InstallRow />
      <Text weight="semibold">Shortcuts</Text>
      {rows.map(([k, d]) => <HStack key={k} gap={3}><Text weight="medium" style={{ minWidth: 48 }}>{k}</Text><Text type="supporting">{d}</Text></HStack>)}
    </VStack>
  )
}

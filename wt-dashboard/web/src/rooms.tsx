// Rooms: shared chat between the user and agents. Live via /api/rooms/:slug/stream; posting as the user.
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChatLayout, ChatMessageList, ChatMessage, ChatMessageBubble, ChatComposer, ChatComposerInput, ChatComposerDrawer, type ChatComposerTrigger, type ChatComposerInputHandle } from '@astryxdesign/core/Chat'
import { TypeaheadItem, type SearchSource, type SearchableItem } from '@astryxdesign/core/Typeahead'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Popover } from '@astryxdesign/core/Popover'
import { Switch } from '@astryxdesign/core/Switch'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { Heading } from '@astryxdesign/core/Heading'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Banner } from '@astryxdesign/core/Banner'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { ChatMarkdown } from './links'
import { VirtualRows } from './virtual'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { Avatar } from '@astryxdesign/core/Avatar'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { BottomSheet } from '@astryxdesign/core/BottomSheet'
import { Selector } from '@astryxdesign/core/Selector'
import { Divider } from '@astryxdesign/core/Divider'
import { Icon } from '@astryxdesign/core/Icon'
import { useToast } from '@astryxdesign/core/Toast'
import { openInbox } from './inbox'
import { composerEnter } from './keys'
import { commandSource, type Command } from './commands'
import { ImageRow, useAttachments, uploadUrl, IMAGE_TYPES, MAX_IMAGES } from './attachments'
import { Thumbnail } from '@astryxdesign/core/Thumbnail'
import { Link } from '@astryxdesign/core/Link'
import { useChatDensity } from './density'
import { LinkPreviews } from './previews'
import { useStream, mergeById } from './streamStore'
import { Delayed, LoadError, ChatSkeleton } from './skeletons'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { Token, type TokenColor } from '@astryxdesign/core/Token'
import type { MarkdownInlinePlugin } from '@astryxdesign/core/Markdown'
import { useRoles } from './roles'
import { roomRows, membersFirst, attMarker, orphanedAtts, numberMarkers } from './roomRows'

export interface RoomAgent { key: string; name: string; status: string; asks?: boolean; machine: string; pool?: string }
interface Room { slug: string; title: string; project: string | null; createdAt: string; paused: boolean; archived?: boolean; members: string[]; hops: number; responder?: string | null; responderName?: string | null; responderPinned?: boolean; broadcast?: boolean; needsYou?: { agent: string; text: string }[] }
export interface Profile { name: string; handle: string; avatar: string | null }
interface Suggestion { ticket: string; slug: string; title: string; agent: string | null; reason: string }
interface RoomMsg {
  id: string; ts: string; text: string; mentions: string[]; deliveredTo: string[]
  author: { kind: 'user' | 'agent' | 'system'; name: string; machine?: string; avatar?: string | null }
  blocked?: { name: string; reason: string }[]
  queuedFor?: string[]; notified?: boolean
  attachments?: { path: string; type: string; size: number }[]; undelivered?: { to: string; n: number }[]
  command?: { text: string; target: string }; agentKey?: string
  replyTo?: { id: string; name: string; text: string }
}
export interface RoomSettings { profile: Profile; agentToAgent: boolean; agentsCreateRooms: boolean; maxHops: number; ticketRooms: 'off' | 'suggest' | 'auto'; rateCount: number; rateWindowMin: number; dismissedTickets: string[] }

const dotOf = (a?: RoomAgent) => (!a ? 'neutral' : a.asks ? 'error' : a.status === 'working' ? 'accent' : a.status === 'done' ? 'success' : 'neutral') as 'neutral' | 'error' | 'accent' | 'success'
export const api = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j as T
}

export function useRoomsList() {
  return useQuery({ queryKey: ['rooms'], queryFn: () => api<{ rooms: Room[]; settings: RoomSettings; suggestions: Suggestion[]; pending: Record<string, number> }>('/api/rooms'), refetchInterval: 10_000 })
}

export function RoomsPage({ slug, agents, onSelect, onOpenAgent }: { slug: string | null; agents: RoomAgent[]; onSelect: (slug: string | null) => void; onOpenAgent: (key: string) => void }) {
  const q = useRoomsList()
  const qc = useQueryClient()
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [responder, setResponder] = useState<RoomAgent | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['rooms'] })
  const create = useMutation({
    mutationFn: (b: { title?: string; ticket?: string; responder?: string }) => api<Room>('/api/rooms', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: (r) => { setTitle(''); setResponder(null); refresh(); onSelect(r.slug) },
    onError: (e) => toast({ body: `Could not create the room: ${e}`, type: 'error' }),
  })
  const room = q.data?.rooms.find((r) => r.slug === slug) ?? null
  const restore = useMutation({
    mutationFn: (s: string) => api(`/api/rooms/${s}`, { method: 'PATCH', body: JSON.stringify({ archived: false }) }),
    onSuccess: refresh, onError: (e) => toast({ body: String(e), type: 'error' }),
  })
  if (room && q.data) return <RoomView key={room.slug} room={room} agents={agents} profile={q.data.settings.profile} onBack={() => onSelect(null)} onOpenAgent={onOpenAgent} />
  const live = (q.data?.rooms ?? []).filter((r) => !r.archived)
  const archived = (q.data?.rooms ?? []).filter((r) => r.archived)
  return (
    <VStack gap={4} isScrollable style={{ flex: 1, minHeight: 0 }}>
      {q.isError && <Banner status="error" title="Could not load rooms" description={String(q.error)} />}
      <HStack gap={2} align="end">
        <TextInput label="New room" placeholder="e.g. Release coordination" value={title} onChange={setTitle} />
        <DropdownMenu button={{ label: `Responder: ${responder?.name ?? 'none'}`, variant: 'ghost' }} items={[
          { label: 'None', onClick: () => setResponder(null) },
          ...agents.map((a) => ({ label: a.name, description: a.status, onClick: () => setResponder(a) })),
        ]} />
        <Button label="Create" variant="primary" isDisabled={!title.trim()} isLoading={create.isPending} onClick={() => create.mutate({ title, responder: responder?.key })} />
      </HStack>
      {(q.data?.suggestions.length ?? 0) > 0 && (
        <Button label={`${q.data!.suggestions.length} room suggestion${q.data!.suggestions.length === 1 ? '' : 's'} →`} size="sm" variant="ghost" onClick={() => openInbox('room-suggestion')} />
      )}
      {q.isError && !q.data && <LoadError what="rooms" error={q.error} retry={() => q.refetch()} />}
      {!q.data && !q.isError && <Delayed><VStack gap={2}>{[0, 1, 2].map((i) => <Skeleton key={i} width="100%" height={64} radius={2} index={i} />)}</VStack></Delayed>}
      {q.data && !live.length && <EmptyState title={archived.length ? 'No active rooms' : 'No rooms yet'} description={archived.length ? `${archived.length} archived room${archived.length === 1 ? '' : 's'} below — restore one, or create a new room.` : 'Create one, then @mention agents to bring them in.'} />}
      {live.map((r) => (
        <Card key={r.slug} padding={3} onClick={() => onSelect(r.slug)} style={{ cursor: 'pointer' }}>
          <HStack gap={2} align="center" justify="between" wrap="wrap">
            <VStack gap={0}>
              <Text weight="semibold">{`#${r.slug}`}</Text>
              <Text type="supporting" size="sm">{r.title}</Text>
            </VStack>
            <HStack gap={2} align="center">
              {r.needsYou?.length ? <Badge variant="error" label={`Needs you · ${r.needsYou.map((n) => n.agent).join(', ')}`} /> : null}
              {r.paused && <Badge variant="warning" label="Paused" />}
              <Text type="supporting" size="sm">{`${r.members.length} member${r.members.length === 1 ? '' : 's'}`}</Text>
            </HStack>
          </HStack>
        </Card>
      ))}
      {archived.length > 0 && (
        <VStack gap={2}>
          <Text weight="semibold">Archived</Text>
          {archived.map((r) => (
            <Card key={r.slug} padding={2}>
              <HStack gap={2} align="center" justify="between">
                <Button label={`#${r.slug}`} size="sm" variant="ghost" onClick={() => onSelect(r.slug)} />
                <Button label="Restore" size="sm" variant="secondary" isLoading={restore.isPending} onClick={() => restore.mutate(r.slug)} />
              </HStack>
            </Card>
          ))}
        </VStack>
      )}
    </VStack>
  )
}

function mentionSource(agents: RoomAgent[], profile: Profile, members: string[]): SearchSource<SearchableItem> {
  const items: SearchableItem[] = [{ id: 'all', label: 'all', auxiliaryData: { status: 'everyone in the room' } },
    { id: 'user', label: profile.handle, auxiliaryData: { status: `you (${profile.name})` } },
    ...membersFirst(agents, members).map((a) => ({ id: a.key, label: a.name, auxiliaryData: a }))]
  return {
    bootstrap: () => items.slice(0, 50),
    search: (query) => items.filter((it) => it.label.toLowerCase().includes(query.toLowerCase().trim())).slice(0, 50),
  }
}

// Room stream for streamStore. The cursor is the message count we hold; the server resends from 50 before it
// (their delivery state catches up) and live events are merged by id, a re-sent message replacing ours.
function roomStreamSpec(slug: string) {
  return {
    url: (_c: string | null, items: RoomMsg[]) => `/api/rooms/${encodeURIComponent(slug)}/stream${items.length ? `?since=${items.length}` : ''}`,
    persistKey: `room|${slug}`, keep: Infinity,
    attach: (es: EventSource, apply: (fn: (items: RoomMsg[]) => RoomMsg[], cursor?: string | null) => void) => {
      const replace = (_o: RoomMsg, n: RoomMsg) => n
      es.addEventListener('backlog', (e) => {
        const b = JSON.parse((e as MessageEvent).data) as { from: number; messages: RoomMsg[] }
        apply((xs) => (b.from === 0 ? b.messages : mergeById(xs, b.messages, replace)))
      })
      es.addEventListener('message', (e) => { const m = JSON.parse((e as MessageEvent).data) as RoomMsg; apply((xs) => mergeById(xs, [m], replace)) })
      es.addEventListener('delivered', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { id: string; to: string; dropped?: number }
        apply((xs) => xs.map((x) => (x.id === d.id && !x.deliveredTo.includes(d.to)
          ? { ...x, deliveredTo: [...x.deliveredTo, d.to], ...(d.dropped ? { undelivered: [...(x.undelivered ?? []), { to: d.to, n: d.dropped }] } : {}) } : x)))
      })
    },
  }
}
// @name → a Token in rendered markdown (text nodes only: code spans/blocks are left alone).
function mentionPlugin(agents: RoomAgent[], profile: Profile, colorOf: (a: RoomAgent) => TokenColor, onOpen: (key: string) => void): MarkdownInlinePlugin {
  const byLower = new Map(agents.map((a) => [a.name.toLowerCase(), a]))
  const who = (n: string) => n.toLowerCase() === profile.handle.toLowerCase() || n.toLowerCase() === 'user' ? 'you' : n.toLowerCase() === 'all' ? 'all' : byLower.get(n.toLowerCase())
  return {
    pattern: /@([A-Za-z0-9][\w-]*[A-Za-z0-9]|[A-Za-z0-9])/g,
    getEndIndex: (text, match) => (match.index! > 0 && /[\w@.]/.test(text[match.index! - 1])) || !who(match[1]) ? false : match.index! + match[0].length,
    render: (match, key) => {
      const w = who(match[1])!
      if (w === 'you') return <Token key={key} size="sm" label={`@${profile.name}`} color="default" />
      if (w === 'all') return <Token key={key} size="sm" label="@all" color="default" />
      return <Token key={key} size="sm" label={`@${w.name}`} color={colorOf(w)} onClick={() => onOpen(w.key)} />
    },
  }
}

function RoomView({ room, agents, profile, onBack, onOpenAgent }: { room: Room; agents: RoomAgent[]; profile: Profile; onBack: () => void; onOpenAgent: (key: string) => void }) {
  const [deleting, setDeleting] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [typed, setTyped] = useState('')
  const del = useMutation({
    mutationFn: () => api(`/api/rooms/${room.slug}`, { method: 'DELETE' }),
    onSuccess: () => { setDeleting(false); onBack(); qc.invalidateQueries({ queryKey: ['rooms'] }) },
    onError: (e) => toast({ body: `Could not delete: ${e}`, type: 'error' }),
  })
  const qc = useQueryClient()
  const toast = useToast()
  const roomStream = useStream<RoomMsg>(`room|${room.slug}`, () => roomStreamSpec(room.slug))
  const msgs = roomStream.items
  const syncing = !roomStream.synced && !msgs.length
  const [draft, setDraft] = useState('')
  const density = useChatDensity()
  const [confirm, setConfirm] = useState<string | null>(null)
  const { atts, attErr, addFiles: addAtts, removeAtt, clear: clearAtts, uploading } = useAttachments(null)
  // Each added image leaves a [image:…] chip at the caret (as the @ menu inserts chips; insertToken emits no change,
  // so an input event syncs the draft). Deleting a chip drops its image.
  const addFiles = (files: File[]) => {
    const h = inputRef.current, el = document.querySelector('[aria-label="Message input"]') as HTMLElement | null
    const added = addAtts(files)
    if (!h || !el || !added.length) return
    if (!el.contains(getSelection()?.anchorNode ?? null)) { el.focus(); getSelection()?.selectAllChildren(el); getSelection()?.collapseToEnd() }
    for (const a of added) h.insertToken({ value: attMarker(a.id), label: `📎 ${a.name}`, variant: 'neutral' })
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<ChatComposerInputHandle>(null)
  const [sendErr, setSendErr] = useState<string | null>(null)
  // Quick reply: the message being answered (the server addresses its agent author), and a jump to a reply's original.
  const [replyTo, setReplyTo] = useState<RoomMsg | null>(null)
  const [jump, setJump] = useState<{ key: string } | null>(null)
  const startReply = useCallback((m: RoomMsg) => {
    setReplyTo(m)
    setTimeout(() => { // after the drawer mounts; caret to the end so typing lands in the input
      const el = document.querySelector('[aria-label="Message input"]') as HTMLElement | null
      if (!el) return
      el.focus(); getSelection()?.selectAllChildren(el); getSelection()?.collapseToEnd()
      // An @author chip, as the @ menu would insert it; not for your own message, nor twice.
      const at = `@${m.author.name}`, h = inputRef.current
      if (m.author.kind !== 'user' && h && !h.getValue().includes(at)) { h.insertToken({ value: at, label: at, variant: 'blue' }); el.dispatchEvent(new Event('input', { bubbles: true })) } // insertToken emits no change: sync the placeholder and draft
    }, 50)
  }, [])
  // Dismiss the reply; drop the prefilled @author chip too, unless the user has typed more since.
  const cancelReply = () => {
    // insertToken doesn't fire onChange, so read the editor itself and clear it the way typing would.
    const el = document.querySelector('[aria-label="Message input"]') as HTMLElement | null
    if (replyTo && el && inputRef.current?.getValue().trim() === `@${replyTo.author.name}`) {
      el.focus(); getSelection()?.selectAllChildren(el); document.execCommand('delete')
    }
    setReplyTo(null)
  }
  // The @ button types an @ at the caret (after a space when needed), which opens the mention menu.
  const startMention = () => {
    const el = document.querySelector('[aria-label="Message input"]') as HTMLElement | null
    if (!el) return
    const sel = getSelection()
    if (!el.contains(sel?.anchorNode ?? null)) { el.focus(); sel?.selectAllChildren(el); sel?.collapseToEnd() }
    const before = sel?.anchorNode?.textContent?.slice(0, sel.anchorOffset) ?? ''
    document.execCommand('insertText', false, before && !/\s$/.test(before) ? ' @' : '@')
  }
  const jumpTo = useCallback((id: string) => {
    setJump({ key: id })
    const flash = () => document.getElementById(`rm-${id}`)?.parentElement?.animate([{ background: 'var(--color-background-muted, rgba(127,127,127,.25))' }, { background: 'transparent' }], 1200)
    const el = document.getElementById(`rm-${id}`)
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash() } else setTimeout(flash, 300)
  }, [])
  const post = useMutation({
    mutationFn: (b: { text: string; confirmAll?: boolean }) => api<RoomMsg>(`/api/rooms/${room.slug}/messages`, { method: 'POST',
      body: JSON.stringify({ ...b, text: numberMarkers(b.text, atts.filter((a) => a.path).map((a) => a.id)), attachments: atts.filter((a) => a.path).map((a) => a.path), replyTo: replyTo?.id }) }),
    onSuccess: () => { setDraft(''); setConfirm(null); clearAtts(); setSendErr(null); setReplyTo(null); qc.invalidateQueries({ queryKey: ['rooms'] }) },
    onError: (e) => { const m = e instanceof Error ? e.message : String(e); if (/one agent/.test(m)) setSendErr(m); else toast({ body: `Could not post: ${m}`, type: 'error' }) },
  })
  // The / menu lists the commands of the agent a command would go to: the one @mentioned, else the responder.
  const cmdTarget = (() => {
    const named = agents.filter((a) => room.members.includes(a.name) && new RegExp(`(^|\\s)@${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(draft))
    return named.length === 1 ? named[0] : named.length ? null : agents.find((a) => a.key === room.responder) ?? null
  })()
  const cmds = useQuery({
    queryKey: ['commands', cmdTarget?.key],
    queryFn: () => api<Command[]>(`/api/agents/${encodeURIComponent(cmdTarget!.machine)}/${encodeURIComponent(cmdTarget!.key.slice(cmdTarget!.machine.length + 1))}/commands`),
    enabled: Boolean(cmdTarget), staleTime: 60_000,
  })
  const slash = useMemo<ChatComposerTrigger>(() => ({
    character: '/',
    searchSource: commandSource(cmds.data ?? []),
    renderItem: (item) => <TypeaheadItem item={item} description={(item.auxiliaryData as Command).description} group={(item.auxiliaryData as Command).source} />,
    onSelect: (item) => ({ value: `/${item.label}`, label: `/${item.label}`, variant: 'blue' as const }),
  }), [cmds.data])
  const patch = useMutation({
    mutationFn: (b: Partial<Room>) => api<Room>(`/api/rooms/${room.slug}`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rooms'] }),
    onError: (e) => toast({ body: String(e), type: 'error' }),
  })
  const mention = useMemo<ChatComposerTrigger>(() => ({
    character: '@',
    searchSource: mentionSource(agents, profile, room.members),
    renderItem: (item) => {
      const a = item.auxiliaryData as RoomAgent
      return <TypeaheadItem item={item} description={room.members.includes(item.label) ? `in this room · ${a.status}` : a.status} icon={item.id === 'user' ? <Avatar name={profile.name} src={profile.avatar ?? undefined} size="xsm" /> : <StatusDot variant={dotOf(item.id === 'all' ? undefined : a)} label={a.status} />} />
    },
    onSelect: (item) => ({ value: `@${item.label}`, label: `@${item.label}`, variant: 'blue' as const }),
  }), [agents, profile, room.members])
  const submit = (v: string) => {
    const text = v.trim()
    if (!text && !atts.some((a) => a.path)) return
    if (uploading) return setSendErr('Wait for the images to finish uploading')
    if (/(^|[^\w@])@all\b/i.test(text)) setConfirm(text)
    else post.mutate({ text })
  }
  const byName = new Map(agents.map((a) => [a.name, a]))
  const narrow = useNarrow()
  const [sheet, setSheet] = useState(false)
  const act = (f: () => void) => () => { setSheet(false); f() }
  const members = (
    <VStack gap={2} padding={3} style={{ minWidth: 240 }}>
      <Text weight="semibold">Members</Text>
      {!room.members.length && <Text type="supporting" size="sm">Nobody yet — @mention an agent.</Text>}
      {room.members.map((n) => (
        <HStack key={n} gap={2} align="center"><StatusDot variant={dotOf(byName.get(n))} label={byName.get(n)?.status ?? 'offline'} /><Text size="sm">{n}</Text>
          <Text size="sm" type="supporting">{byName.get(n)?.asks ? 'needs you' : byName.get(n)?.status ?? 'gone'}</Text></HStack>
      ))}
    </VStack>
  )
  const layoutRef = useRef<HTMLDivElement>(null) // ChatLayout's root is the scroll container (VirtualRows scrolls it)
  // Built only when messages/members change, never per keystroke (the draft lives in this component).
  // Working members, each under the last message that was delivered to them.
  const workingAfter = useMemo(() => {
    const out = new Map<string, string[]>()
    for (const n of room.members) {
      if (byName.get(n)?.status !== 'working') continue
      const m = msgs.findLast((x) => x.deliveredTo.includes(n))
      if (m) out.set(m.id, [...(out.get(m.id) ?? []), n])
    }
    return out
  }, [msgs, room.members, byName])
  const { byId: roleOf } = useRoles()
  const rows = useMemo(() => roomRows(msgs, profile.handle, workingAfter), [msgs, profile.handle, workingAfter])
  const mentions = useMemo(() => [mentionPlugin(agents, profile, (a) => roleOf(a.pool ?? 'other').color as TokenColor, onOpenAgent)], [agents, profile, roleOf, onOpenAgent])
  const messageList = useMemo(() => syncing ? <Delayed><ChatSkeleton /></Delayed> : (
        <ChatMessageList density={density}>
          <VirtualRows items={rows} scrollRef={layoutRef} keyOf={(r) => r.id} jump={jump} render={(r) => r.kind === 'status' ? (
            <ChatMessage key={r.id} sender="system">
              <Text type="supporting" size="sm" maxLines={1}>{r.text}</Text>
            </ChatMessage>
          ) : ((m) => m.author.kind === 'system' ? (
            <ChatMessage key={m.id} sender="system">
              <Text type="supporting" size="sm">{`— ${m.text} · `}<Timestamp value={m.ts} format="relative" />
                {m.agentKey && <>{' · '}<Link onClick={() => onOpenAgent(m.agentKey!)}>open agent</Link></>}</Text>
            </ChatMessage>
          ) : (
            <ChatMessage key={m.id} sender={m.author.kind === 'user' ? 'user' : 'assistant'}
              avatar={m.author.kind === 'user' ? <Avatar name={profile.name} src={profile.avatar ?? undefined} size="sm" /> : undefined}
              name={m.author.kind === 'agent'
                ? <HStack gap={1} align="center"><StatusDot variant={dotOf(byName.get(m.author.name))} label="" /><Text size="sm" weight="medium">{m.author.name}</Text></HStack>
                : <Text size="sm" weight="medium">{profile.name}</Text>}
              metadata={<RoomMeta m={m} onReply={startReply} />}>
              <span id={`rm-${m.id}`} />
              {m.replyTo && <Link onClick={() => jumpTo(m.replyTo!.id)}><Text type="supporting" size="sm" maxLines={1}>{`↪ ${m.replyTo.name}: ${m.replyTo.text}`}</Text></Link>}
              {m.text && <ChatMessageBubble variant={m.author.kind === 'user' ? undefined : 'ghost'}><ChatMarkdown inlinePlugins={mentions}>{m.text}</ChatMarkdown></ChatMessageBubble>}
              {m.text && <LinkPreviews text={m.text} />}
              {m.attachments?.length ? <ChatMessageBubble variant="ghost"><ImageRow srcs={m.attachments.map((a) => uploadUrl(a.path)).filter((u): u is string => Boolean(u))} /></ChatMessageBubble> : null}
            </ChatMessage>
          ))(r.m)} />
        </ChatMessageList>
  ), [rows, profile, agents, mentions, density, syncing, jump]) // eslint-disable-line react-hooks/exhaustive-deps
  // One body for the phone sheet and the desktop popover.
  const roomSettings = (
    <div style={{ display: 'flex', flexDirection: 'column', width: narrow ? '100%' : 340, maxHeight: '85dvh', minWidth: 0 }}>
      <HStack justify="between" align="center" style={{ padding: '4px 8px 4px 16px', flexShrink: 0 }}>
        <Heading level={3}>Room settings</Heading>
        <IconButton label="Close" icon={<Icon icon="close" />} variant="ghost" onClick={() => setSheet(false)} style={{ minWidth: 44, minHeight: 44, visibility: narrow ? 'visible' : 'hidden' }} />
      </HStack>
      <ScrollableArea label="Room settings" style={{ padding: `8px 16px calc(env(safe-area-inset-bottom) + 16px)` }}>
        <VStack gap={4}>
          {room.title !== room.slug && <Text type="supporting" size="sm">{room.title}</Text>}
          {!room.archived && (
            <Selector label="Responder" width="100%" value={room.responder ?? ''}
              description={room.responder && !room.responderPinned ? 'Chosen automatically; pick one to pin it.' : 'Answers messages that mention nobody.'}
              options={[{ value: '', label: 'None', description: 'unmentioned messages go to nobody' },
                ...room.members.map((n) => byName.get(n)).filter((a): a is RoomAgent => Boolean(a)).map((a) => ({ value: a.key, label: a.name, description: a.status }))]}
              onChange={(v) => patch.mutate({ responder: v || null })} />
          )}
          {!room.archived && <Switch label="All members hear the user" description="Each message costs one turn per member." value={Boolean(room.broadcast)} onChange={(v) => patch.mutate({ broadcast: v })} />}
          {!room.archived && <Switch label="Paused" description="Agents receive nothing until resumed." value={room.paused} onChange={(v) => patch.mutate({ paused: v })} />}
          <Divider />
          <VStack gap={2}>
            <Text weight="semibold" size="sm">Danger zone</Text>
            {room.archived
              ? <Button label="Restore" variant="secondary" width="100%" onClick={act(() => patch.mutate({ archived: false }))} />
              : <Button label="Archive…" variant="secondary" width="100%" onClick={act(() => setArchiving(true))} />}
            <Button label="Delete…" variant="destructive" width="100%" onClick={act(() => { setTyped(''); setDeleting(true) })} />
          </VStack>
        </VStack>
      </ScrollableArea>
    </div>
  )
  return (
    <VStack gap={2} style={{ flex: 1, minHeight: 0 }}>
      <HStack gap={1} align="center" style={{ minWidth: 0, flexWrap: 'nowrap' }}>
        <IconButton icon={<span aria-hidden style={{ fontSize: 20, lineHeight: 1 }}>‹</span>} label="Back to rooms" size="sm" variant="ghost" onClick={onBack} />
        <Heading level={3} maxLines={1} style={{ minWidth: 0 }}>{`#${room.slug}`}</Heading>
        {room.paused && !room.archived && <Badge variant="warning" label="paused" />}
        {room.broadcast && !room.archived && <Badge variant="blue" label="broadcast" />}
        {room.archived && <Badge label="archived" />}
        <div style={{ flex: 1 }} />
        <Popover placement="below" alignment="end" content={members}>
          <Button label={`${room.members.length}`} size="sm" variant="ghost" tooltip="Members" icon={<PeopleIcon />} />
        </Popover>
        {narrow ? (
          <>
            <IconButton icon={<span aria-hidden>⋯</span>} label="Room settings" size="sm" variant="ghost" onClick={() => setSheet(true)} />
            <BottomSheet label="Room settings" isOpen={sheet} onOpenChange={setSheet} height="auto">{roomSettings}</BottomSheet>
          </>
        ) : (
          <Popover placement="below" alignment="end" content={roomSettings} isOpen={sheet} onOpenChange={setSheet}>
            <IconButton icon={<span aria-hidden>⋯</span>} label="Room settings" size="sm" variant="ghost" />
          </Popover>
        )}
      </HStack>
      {room.archived && <Banner status="info" title="Archived — read-only" description="Restore it from the ⋯ menu to post again." />}
      {room.paused && !room.archived && (
        <Card padding={2} variant="yellow">
          <HStack gap={2} align="center" justify="between">
            <Text size="sm">Room paused — agents won't receive messages</Text>
            <Button label="Resume" size="sm" variant="secondary" onClick={() => patch.mutate({ paused: false })} />
          </HStack>
        </Card>
      )}
      <AlertDialog isOpen={archiving} onOpenChange={setArchiving} title={`Archive #${room.slug}?`}
        description="It leaves the Rooms list and becomes read-only. Restore it any time from the Archived section." actionLabel="Archive" actionVariant="primary"
        onAction={() => { setArchiving(false); patch.mutate({ archived: true }) }} />
      <Dialog isOpen={deleting} onOpenChange={setDeleting} width={440} padding={4}>
        <VStack gap={3}>
          <Heading level={3}>{`Delete #${room.slug}?`}</Heading>
          <Text type="supporting">This removes the room and all its messages, and drops anything still queued for agents. Type the room name to confirm.</Text>
          <TextInput label="Room name" value={typed} onChange={setTyped} placeholder={room.slug} />
          <HStack gap={2} justify="end">
            <Button label="Cancel" variant="ghost" onClick={() => setDeleting(false)} />
            <Button label="Delete room" variant="destructive" isDisabled={typed !== room.slug} isLoading={del.isPending} onClick={() => del.mutate()} />
          </HStack>
        </VStack>
      </Dialog>
      <ChatLayout ref={layoutRef} style={{ flex: 1, minHeight: 0 }}
        emptyState={syncing ? <Delayed><ChatSkeleton /></Delayed> : <EmptyState isCompact title="No messages yet" description="@mention an agent to bring it in." />}
        composer={room.archived ? null : (
          <VStack gap={1}>
          <ChatComposer value={draft} onChange={(v) => { setDraft(v); if (sendErr) setSendErr(null); orphanedAtts(v, atts.map((a) => a.id)).forEach(removeAtt) }} onSubmit={submit} isDisabled={post.isPending || syncing} density="compact"
            status={sendErr ? { type: 'error', message: sendErr } : attErr ? { type: 'warning', message: attErr }
              : /^\s*(@\S+\s+)*\//.test(draft) && !cmdTarget ? { type: 'warning', message: 'A command goes to one agent: @mention it or set a responder' } : undefined}
            headerActions={<>
              <IconButton label="Mention someone" icon={<AtIcon />} size="sm" variant="ghost" onClick={startMention} />
              <IconButton label="Attach image" icon={<ClipIcon />} size="sm" variant="ghost" isDisabled={atts.length >= MAX_IMAGES} onClick={() => fileRef.current?.click()} />
              <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
            </>}
            headerContext={!replyTo ? <div style={{ display: 'grid', width: '100%', minWidth: 0 }}><Text type="supporting" size="sm" maxLines={1}>{room.broadcast ? '→ every member hears this' : room.responderName ? `→ ${room.responderName} answers · @ to mention someone else` : '→ no responder: @mention someone'}</Text></div> : <HStack gap={1} align="center" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', width: '100%', minWidth: 0 }}>{/* grid: the header sizes to content, so a long quote would push the x off-screen */}
              <Text type="supporting" size="sm" maxLines={1}>{`↪ ${replyTo.author.kind === 'user' ? profile.name : replyTo.author.name}: ${replyTo.text.split('\n')[0]}`}</Text>
              <IconButton label="Cancel reply" icon={<Icon icon="close" size="sm" />} size="sm" variant="ghost" onClick={cancelReply} />
            </HStack>}
            drawer={atts.length ? (
              <ChatComposerDrawer>
                <HStack gap={2} wrap="wrap">
                  {atts.map((a) => <Thumbnail key={a.id} src={a.preview} label={a.error ? `${a.name}: ${a.error}` : a.name} alt={a.name} isLoading={!a.path && !a.error} onRemove={() => removeAtt(a.id)} showRemoveOn="always" />)}
                </HStack>
              </ChatComposerDrawer>
            ) : undefined}
            input={<ChatComposerInput handleRef={inputRef} triggers={[mention, slash]} onFiles={addFiles} onKeyDown={(e) => { if (e.key === 'Escape' && replyTo && !e.defaultPrevented) { e.preventDefault(); cancelReply() } else composerEnter(e) }} placeholder={`Message #${room.slug}`} />} />
          </VStack>
        )}>
        {messageList}
      </ChatLayout>
      <AlertDialog isOpen={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)} title="Message everyone?"
        description={`@all delivers this to all ${room.members.length} members of #${room.slug}.`} actionLabel="Send to all" actionVariant="primary"
        isActionLoading={post.isPending} onAction={() => confirm && post.mutate({ text: confirm, confirmAll: true })} />
    </VStack>
  )
}


// Timestamp, with the details behind an info icon (as in the agent chat).
function RoomMeta({ m, onReply }: { m: RoomMsg; onReply: (m: RoomMsg) => void }) {
  const [open, setOpen] = useState(false)
  const details = [new Date(m.ts).toLocaleString(), m.mentions.length ? `mentions ${m.mentions.map((n) => `@${n}`).join(' ')}` : '',
    m.deliveredTo.length ? `delivered to ${m.deliveredTo.join(', ')}` : ''].filter(Boolean).join(' · ')
  return (
    <VStack gap={0}>
      <HStack gap={1} align="center"><Text type="supporting" size="sm"><Timestamp value={m.ts} format="relative" /></Text>
        <IconButton label="Reply" icon={<ReplyIcon />} variant="ghost" size="sm" onClick={() => onReply(m)} />
        <IconButton label="Message details" icon={<Icon icon="info" size="sm" />} variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)} /></HStack>
      {open && <Text type="supporting" size="sm">{details}</Text>}
    </VStack>
  )
}
const PeopleIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
    <circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3" />
  </svg>
)
function useNarrow(q = '(max-width: 639px)') {
  const [n, setN] = useState(() => matchMedia(q).matches)
  useEffect(() => { const m = matchMedia(q); const on = () => setN(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on) }, [q])
  return n
}
const ReplyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 17 4 12l5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" />
  </svg>
)
const AtIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
  </svg>
)
const ClipIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </svg>
)

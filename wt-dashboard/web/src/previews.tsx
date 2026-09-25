// Link preview cards under agent and room messages: up to 3 per message, from /api/unfurl (server-side fetch with
// SSRF guards; images come through /api/unfurl/image, never hotlinked). PRs, issues and Linear tickets get status
// badges from data the server already has. Clicking goes through linkClick (in-app browser in the desktop app).
import { useQuery } from '@tanstack/react-query'
import { Card } from '@astryxdesign/core/Card'
import { Item } from '@astryxdesign/core/Item'
import { Badge } from '@astryxdesign/core/Badge'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { linkClick, linksIn } from './links.ts'
import { useChatDensity, useLinkPreviews } from './density.ts'

type CardData = { kind: 'page' | 'pr' | 'issue' | 'linear' | 'artifact'; url: string; title?: string | null; description?: string | null; image?: string | null
  icon?: string | null; siteName?: string | null; error?: string; number?: number; identifier?: string; state?: string; review?: string | null
  ci?: 'pass' | 'fail' | 'pending' | null; priority?: string; assignee?: string | null }

const img = (u?: string | null) => (u ? `/api/unfurl/image?url=${encodeURIComponent(u)}` : undefined)
const tone = (s?: string) => (/merged|done|completed|pass|approved/i.test(s ?? '') ? 'success' : /closed|canceled|fail|changes/i.test(s ?? '') ? 'error' : /draft|pending|progress|review/i.test(s ?? '') ? 'warning' : 'neutral')

export function LinkPreviews({ text }: { text: string }) {
  const on = useLinkPreviews()
  const urls = on ? linksIn(text) : []
  if (!urls.length) return null
  return <VStack gap={1} style={{ marginTop: 6, maxWidth: 520 }}>{urls.map((u) => <Preview key={u} url={u} />)}</VStack>
}

function Preview({ url }: { url: string }) {
  const density = useChatDensity()
  const q = useQuery({
    queryKey: ['unfurl', url], staleTime: 60_000, retry: false,
    queryFn: async (): Promise<CardData> => {
      const r = await fetch(`/api/unfurl?url=${encodeURIComponent(url)}`)
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      return r.json()
    },
  })
  const c = q.data
  if (!c || c.error || (!c.title && !c.description)) return null // nothing worth a card (fetch refused, no metadata)
  const badges = c.kind === 'pr' ? [c.state, c.ci && `CI ${c.ci}`, c.review?.replace('_', ' ').toLowerCase()]
    : c.kind === 'issue' ? [c.state] : c.kind === 'linear' ? [c.state, c.priority, c.assignee] : []
  const label = c.kind === 'pr' || c.kind === 'issue' ? `#${c.number} ${c.title}` : c.kind === 'linear' ? `${c.identifier} ${c.title}` : c.title
  const site = <HStack gap={1} align="center">
    {c.icon && <img src={img(c.icon)} alt="" width={14} height={14} style={{ borderRadius: 3, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = 'none' }} />}
    <span>{c.siteName}</span>
    {badges.filter(Boolean).map((b) => <Badge key={b!} label={b!} variant={tone(b!)} />)}
  </HStack>
  return (
    <Card variant="default" padding={0} style={{ overflow: 'hidden', maxHeight: 88 }}>
      <Item density={density} label={label} labelLines={1} descriptionLines={c.kind === 'page' && c.description ? 1 : 2}
        description={<VStack gap={0}>{c.kind === 'page' && c.description && <span>{c.description}</span>}{site}</VStack>}
        href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => linkClick(url, e as unknown as MouseEvent)}
        endContent={c.image ? <img src={img(c.image)} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, display: 'block' }} onError={(e) => { e.currentTarget.style.display = 'none' }} /> : undefined} />
    </Card>
  )
}

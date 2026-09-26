// The Tasks page: an action queue. Every action runs only on a click, through a server endpoint.
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Card } from '@astryxdesign/core/Card'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Heading } from '@astryxdesign/core/Heading'
import { Link } from '@astryxdesign/core/Link'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { api } from './rooms'
import { sections, type QTask } from './taskQueue'

const post = (url: string, body: object) => api(url, { method: 'POST', body: JSON.stringify(body) })
// Agent keys are `<machine>/<pane>`.
const promptKey = (key: string, text: string) => {
  const i = key.indexOf('/')
  return post(`/api/agents/${encodeURIComponent(key.slice(0, i))}/${encodeURIComponent(key.slice(i + 1))}`, { text })
}

export function TaskQueue({ tasks, onOpen, showProject, suggested }: { tasks: QTask[]; onOpen: (key: string) => void; showProject: boolean; suggested?: Set<string> }) {
  const [who, setWho] = useState('mine')
  const secs = sections(who === 'mine' ? tasks.filter((t) => t.mine !== false) : tasks)
  return (
    <VStack gap={5}>
      <SegmentedControl label="Whose tasks" value={who} onChange={setWho} size="sm">
        <SegmentedControlItem value="mine" label="Mine" />
        <SegmentedControlItem value="all" label="Everyone" />
      </SegmentedControl>
      {!secs.length && <EmptyState title="Nothing to act on" description="No task needs you, is ready to hand off, in review, stalled or up next." />}
      {secs.map((s) => {
        const rows = <VStack gap={2}>{s.tasks.map((t) => <Row key={t.id} t={t} section={s.key} onOpen={onOpen} showProject={showProject} suggested={suggested?.has(t.id)} />)}</VStack>
        return s.key === 'shipped'
          ? <Collapsible key={s.key} defaultIsOpen={false} chevronPosition="start" trigger={<Text weight="semibold">{s.label} ({s.tasks.length})</Text>}>{rows}</Collapsible>
          : <VStack key={s.key} gap={2}><Heading level={3}>{s.label} ({s.tasks.length})</Heading>{rows}</VStack>
      })}
    </VStack>
  )
}

function Row({ t, section, onOpen, showProject, suggested }: { t: QTask; section: string; onOpen: (key: string) => void; showProject: boolean; suggested?: boolean }) {
  const qc = useQueryClient()
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: () => qc.invalidateQueries({ queryKey: ['overview'] }) })
  const [text, setText] = useState('')
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { if (!confirm) return; const id = setTimeout(() => setConfirm(false), 5000); return () => clearTimeout(id) }, [confirm])
  const resp = t.responder
  const noResp = resp ? undefined : 'No live worker or planner on this task'
  const handoff = (mode: 'worker' | 'reassign') => act.mutate(() => post(`/api/tasks/${encodeURIComponent(t.id)}/handoff`, { mode }))
  const busy = act.isPending

  let actions: React.ReactNode = null
  if (section === 'needs_you') {
    actions = t.roomNeed
      ? <Button label="Open room" size="sm" variant="primary" href={`#rooms/${encodeURIComponent(t.roomNeed)}`} />
      : <>
          <TextInput label="Answer" isLabelHidden size="sm" placeholder="Answer…" value={text} onChange={setText}
            onEnter={() => text.trim() && t.agent && act.mutate(() => promptKey(t.agent!.key, text).then(() => setText('')))} />
          <Button label="Send" size="sm" variant="primary" isLoading={busy} isDisabled={!text.trim() || !t.agent}
            onClick={() => act.mutate(() => promptKey(t.agent!.key, text).then(() => setText('')))} />
        </>
  } else if (section === 'plan_ready') {
    actions = <Button label="Hand to worker" size="sm" variant="primary" isLoading={busy} onClick={() => handoff('worker')} />
  } else if (section === 'in_review' && t.pr) {
    actions = <>
      <Button label="Babysit" size="sm" variant="primary" isLoading={busy} isDisabled={!resp} tooltip={noResp}
        onClick={() => act.mutate(() => promptKey(resp!.key, `/wt-babysit ${t.pr!.url}`))} />
      <Link href={t.pr.url} target="_blank">Open PR</Link>
    </>
  } else if (section === 'stalled') {
    actions = <>
      <Button label="Nudge" size="sm" variant="primary" isLoading={busy} isDisabled={!resp} tooltip={noResp}
        onClick={() => act.mutate(() => promptKey(resp!.key, `You've been idle 20+ min on ${t.id}. Continue ${t.plan ?? t.title}; if blocked, say what you need.`))} />
      <Button label={confirm ? 'Confirm reassign' : 'Reassign'} size="sm" variant={confirm ? 'secondary' : 'ghost'} isDisabled={busy || !t.plan}
        tooltip={t.plan ? undefined : 'No plan to hand to a new worker'}
        onClick={() => { if (!confirm) return setConfirm(true); setConfirm(false); handoff('reassign') }} />
    </>
  } else if (section === 'up_next') {
    actions = <Button label="Plan it" size="sm" variant="primary" isLoading={busy} isDisabled={!t.project}
      onClick={() => act.mutate(() => post('/api/agents/spawn', { kind: 'planner', project: t.project, prompt: `/wt-plan ${t.id}` }))} />
  } else if (section === 'shipped') {
    actions = <Button label="Finish" size="sm" variant="primary" isLoading={busy} isDisabled={!resp} tooltip={noResp}
      onClick={() => act.mutate(() => promptKey(resp!.key, '/wt-finish'))} />
  }

  return (
    <Card>
      <VStack gap={2}>
        <HStack gap={2} align="center" wrap="wrap">
          {t.url ? <Link href={t.url} target="_blank">{t.id}</Link> : !t.id.includes(':') && <Text type="supporting">{t.id}</Text>}
          <Text weight="semibold">{t.title}</Text>
        </HStack>
        <HStack gap={2} align="center" wrap="wrap">
          {t.agent && (t.agent.id || t.roomNeed) && <Button label={t.agent.name} size="sm" variant="ghost" onClick={() => onOpen(t.agent!.key)} />}
          {showProject && t.project && <Text type="supporting" size="sm">{t.project}</Text>}
          {t.plan && <Text type="code" size="sm">{t.plan}</Text>}
          {t.pr && <Link href={t.pr.url} target="_blank">#{t.pr.number}</Link>}
          {section === 'in_review' && t.pr?.ci && <Badge label={`CI ${t.pr.ci}`} variant={t.pr.ci === 'pass' ? 'success' : t.pr.ci === 'fail' ? 'error' : 'warning'} />}
          {section === 'in_review' && t.pr?.unresolved ? <Badge label={`${t.pr.unresolved} unresolved`} variant="warning" /> : null}
          {section === 'in_review' && t.pr?.behind && <Badge label="behind base" variant="warning" />}
          {suggested && <Link href="#rooms">room suggested</Link>}
          {t.updatedAt && <Text type="supporting" size="sm"><Timestamp value={t.updatedAt} format="relative" /></Text>}
        </HStack>
        {t.question && section === 'needs_you' && <Text maxLines={3}>{t.question}</Text>}
        {actions && <HStack gap={2} align="center" wrap="wrap">{actions}</HStack>}
        {act.error && <Banner status="error" title={act.error.message} />}
      </VStack>
    </Card>
  )
}

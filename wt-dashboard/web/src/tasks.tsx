// The Tasks page: an action queue. Every action runs only on a click, through a server endpoint.
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { VStack } from '@astryxdesign/core/VStack'
import { Heading } from '@astryxdesign/core/Heading'
import { Link } from '@astryxdesign/core/Link'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Timestamp } from '@astryxdesign/core/Timestamp'
import { api } from './rooms'
import { isBabysitting, sections, type QTask } from './taskQueue'

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
    <VStack gap={5} className="hd-tq">
      <SegmentedControl label="Whose tasks" value={who} onChange={setWho} size="sm">
        <SegmentedControlItem value="mine" label="Mine" />
        <SegmentedControlItem value="all" label="Everyone" />
      </SegmentedControl>
      {!secs.length && <EmptyState title="Nothing to act on" description="No task needs you, is ready to hand off, in review, stalled or up next." />}
      {secs.map((s) => {
        const rows = <div className="hd-tq-list">{s.tasks.map((t) => <Row key={t.id} t={t} section={s.key} onOpen={onOpen} showProject={showProject} suggested={suggested?.has(t.id)} />)}</div>
        return s.key === 'shipped'
          ? <Collapsible key={s.key} defaultIsOpen={false} chevronPosition="start" trigger={<Text weight="semibold">{s.label} ({s.tasks.length})</Text>}>{rows}</Collapsible>
          : <VStack key={s.key} gap={2}><Heading level={3}>{s.label} ({s.tasks.length})</Heading>{rows}</VStack>
      })}
    </VStack>
  )
}

function Row({ t, section, onOpen, showProject, suggested }: { t: QTask; section: string; onOpen: (key: string) => void; showProject: boolean; suggested?: boolean }) {
  const qc = useQueryClient()
  // Optimistic: once an action is sent its button stays off until the next poll brings the task back
  // (by then a pane label, e.g. task_state 'babysitting …', carries it); an error re-enables it.
  const [sent, setSent] = useState(false)
  useEffect(() => setSent(false), [t])
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onMutate: () => setSent(true), onError: () => setSent(false), onSuccess: () => qc.invalidateQueries({ queryKey: ['overview'] }) })
  const [text, setText] = useState('')
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { if (!confirm) return; const id = setTimeout(() => setConfirm(false), 5000); return () => clearTimeout(id) }, [confirm])
  const resp = t.responder
  // No live worker/planner on this machine: say so where the button would be, not a silent disabled button.
  const noAgent = <Text type="supporting" size="sm">no agent to {section === 'in_review' ? 'babysit' : section === 'stalled' ? 'nudge' : 'finish'} it</Text>
  const handoff = (mode: 'worker' | 'reassign') => act.mutate(() => post(`/api/tasks/${encodeURIComponent(t.id)}/handoff`, { mode }))
  const busy = act.isPending || sent
  const babysitting = isBabysitting(t)

  let actions: React.ReactNode = null
  if (section === 'needs_you') {
    actions = t.roomNeed
      ? <Button label="Open room" size="sm" variant="primary" href={`#rooms/${encodeURIComponent(t.roomNeed)}`} />
      : <>
          <TextInput label="Answer" isLabelHidden size="sm" placeholder="Answer…" value={text} onChange={setText}
            onEnter={() => text.trim() && t.agent && act.mutate(() => promptKey(t.agent!.key, text).then(() => setText('')))} />
          <Button label="Send" size="sm" variant="primary" isLoading={act.isPending} isDisabled={act.isPending || !text.trim() || !t.agent}
            onClick={() => act.mutate(() => promptKey(t.agent!.key, text).then(() => setText('')))} />
        </>
  } else if (section === 'plan_ready') {
    actions = <Button label="Hand to worker" size="sm" variant="primary" isLoading={act.isPending} isDisabled={busy} onClick={() => handoff('worker')} />
  } else if (section === 'in_review' && t.pr) {
    actions = <>
      {resp ? <Button label="Babysit" size="sm" variant="primary" isLoading={act.isPending} isDisabled={busy || babysitting} tooltip={babysitting ? resp.taskState ?? undefined : undefined}
        onClick={() => act.mutate(() => promptKey(resp.key, `/wt-babysit ${t.pr!.url}`))} /> : noAgent}
          </>
  } else if (section === 'stalled') {
    actions = <>
      {resp ? <Button label="Nudge" size="sm" variant="primary" isLoading={act.isPending} isDisabled={busy}
        onClick={() => act.mutate(() => promptKey(resp.key, `You've been idle 20+ min on ${t.id}. Continue ${t.plan ?? t.title}; if blocked, say what you need.`))} /> : noAgent}
      <Button label={confirm ? 'Confirm reassign' : 'Reassign'} size="sm" variant={confirm ? 'secondary' : 'ghost'} isDisabled={busy || !t.plan}
        tooltip={t.plan ? undefined : 'No plan to hand to a new worker'}
        onClick={() => { if (!confirm) return setConfirm(true); setConfirm(false); handoff('reassign') }} />
    </>
  } else if (section === 'up_next') {
    actions = <Button label="Plan it" size="sm" variant="primary" isLoading={act.isPending} isDisabled={busy || !t.project}
      onClick={() => act.mutate(() => post('/api/agents/spawn', { kind: 'planner', project: t.project, prompt: `/wt-plan ${t.id}` }))} />
  } else if (section === 'shipped') {
    actions = resp ? <Button label="Finish" size="sm" variant="primary" isLoading={act.isPending} isDisabled={busy}
      onClick={() => act.mutate(() => promptKey(resp.key, '/wt-finish'))} /> : noAgent
  }

  const dot = <Text type="supporting" size="sm" aria-hidden>·</Text>
  const meta = [
    t.agent && (t.agent.id || t.roomNeed) && <Link key="a" href="#" onClick={(e: React.MouseEvent) => { e.preventDefault(); onOpen(t.agent!.key) }}>{t.agent.name}</Link>,
    showProject && t.project && <Text key="p" type="supporting" size="sm">{t.project}</Text>,
    t.plan && <Tooltip key="pl" content={t.plan}><Text type="supporting" size="sm" tabIndex={0} className="hd-tq-plan">plan</Text></Tooltip>,
    suggested && <Link key="r" href="#rooms">room suggested</Link>,
    t.updatedAt && <Text key="u" type="supporting" size="sm"><Timestamp value={t.updatedAt} format="relative" /></Text>,
  ].filter(Boolean) as React.ReactElement[]
  const review = section === 'in_review' && t.pr
  return (
    <div className="hd-tq-row">
      <div className="hd-tq-main">
        <div className="hd-tq-title">
          {t.url ? <Link href={t.url} target="_blank">{t.id}</Link> : !t.id.includes(':') && <Text type="supporting">{t.id}</Text>}
          <Text weight="semibold" maxLines={2}>{t.title}</Text>
        </div>
        {meta.length > 0 && <div className="hd-tq-meta">{meta.flatMap((m, i) => (i ? [<span key={`d${i}`}>{dot}</span>, m] : [m]))}</div>}
      </div>
      <div className="hd-tq-side">
        {t.pr && <Link href={t.pr.url} target="_blank">PR #{t.pr.number}</Link>}
        {review && t.pr!.ci && <Badge label={`CI ${t.pr!.ci}`} variant={t.pr!.ci === 'pass' ? 'success' : t.pr!.ci === 'fail' ? 'error' : 'warning'} />}
        {review && t.pr!.unresolved ? <Badge label={`${t.pr!.unresolved} unresolved`} variant="warning" /> : null}
        {review && t.pr!.behind && <Badge label="behind base" variant="warning" />}
        {review && (babysitting || (sent && !act.error)) && <Badge label="Babysitting" variant="info" />}
        {actions}
      </div>
      {t.question && section === 'needs_you' && <div className="hd-tq-wide"><Text maxLines={3}>{t.question}</Text></div>}
      {act.error && <div className="hd-tq-wide"><Banner status="error" title={act.error.message} /></div>}
    </div>
  )
}

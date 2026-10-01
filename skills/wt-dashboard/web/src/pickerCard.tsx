// The native AskUserQuestion picker, mirrored off an agent's terminal screen ('B' in WP-164): its shape
// (Picker), the polling hook that keeps a card mounted across Claude Code's redraws (useHeldPicker), and the
// card itself (PickerCard). Named distinctly from App.tsx's Dock.tsx-adjacent siblings — macOS is
// case-insensitive, so a `dock.ts`-shaped name here would collide (WP-112).
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Card } from '@astryxdesign/core/Card'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Stepper, Step } from '@astryxdesign/core/Stepper'
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList'
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Text } from '@astryxdesign/core/Text'
import { CodeBlock } from '@astryxdesign/core/CodeBlock'
import { ChatMarkdown } from './links'
import { isUserSkip } from './pickerGuard.ts'
import { matchBatch, hasPreview, isAnswered, toPayload, summary, initialAnswer, fingerprint, OTHER as BATCH_OTHER, type BatchQuestion, type TabAnswer } from './pickerBatch.ts'

export interface Picker {
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
// The fields PickerCard/useHeldPicker/agentUrl need off an agent — App.tsx's fuller Agent satisfies this
// structurally, so passing one here needs no import from App.tsx (which would be circular).
export interface PickerAgent { key: string; machine: string; id: string; picker?: Picker | null }

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}
export const agentUrl = (a: PickerAgent) => `/api/agents/${encodeURIComponent(a.machine)}/${encodeURIComponent(a.id)}`

// The live agent list with its picker, for anything that needs to find an agent's pending B picker outside
// its own chat page (room chips, the Inbox). Shares App.tsx's own ['overview'] query and 4s poll — this adds
// an observer, not a second fetch cadence.
export function useOverviewAgents(): (PickerAgent & { name: string })[] {
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: () => getJSON<{ agents: (PickerAgent & { name: string })[] }>('/api/overview'),
    refetchInterval: 4000,
  })
  return q.data?.agents ?? []
}

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
export function useHeldPicker(agent: PickerAgent): [Picker | null, () => void] {
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
// The pending picker. A multi-tab one is scanned once (the server steps through its tabs and back) and then answered
// locally, sent once at Submit (WP-203); a single question, a failed scan or a popup without a scan mirrors the
// terminal one tab at a time. The scan is keyed by the picker's headers + the tab it sits on, so a new question
// set re-scans while polling never does.
export function PickerCard({ agent, picker, onSent }: { agent: PickerAgent; picker: Picker; onSent: () => void }) {
  const multi = !picker.review && picker.tabs.length >= 2
  const scan = useQuery({
    queryKey: ['picker-scan', agent.key, picker.tabs.map((t) => t.header).join('|'), picker.current ?? 0, picker.question],
    queryFn: async () => {
      const r = await fetch(`${agentUrl(agent)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scan' }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? String(r.status))
      return (await r.json()).questions as BatchQuestion[]
    },
    enabled: multi, staleTime: Infinity, gcTime: 60_000, retry: false, refetchOnWindowFocus: false,
  })
  const qs = multi ? matchBatch(picker.tabs, picker.review, scan.data) : null
  if (multi && scan.isPending) return <Card variant="yellow" padding={3}><Text type="supporting">Reading the questions…</Text></Card>
  return qs ? <BatchPickerCard agent={agent} picker={picker} qs={qs} onSent={onSent} /> : <TerminalPickerCard agent={agent} picker={picker} onSent={onSent} />
}

// Per-picker answers survive a remount or a poll; dropped once sent.
const batchDrafts = new Map<string, { tab: number; ans: TabAnswer[] }>()
function BatchPickerCard({ agent, picker, qs, onSent }: { agent: PickerAgent; picker: Picker; qs: BatchQuestion[]; onSent: () => void }) {
  const qc = useQueryClient()
  const fp = fingerprint(agent.key, qs)
  const [st, setSt] = useState(() => batchDrafts.get(fp) ?? { tab: 0, ans: qs.map(initialAnswer) })
  useEffect(() => { setSt(batchDrafts.get(fp) ?? { tab: 0, ans: qs.map(initialAnswer) }) }, [fp]) // eslint-disable-line react-hooks/exhaustive-deps
  const put = (next: { tab: number; ans: TabAnswer[] }) => { batchDrafts.set(fp, next); setSt(next) }
  const n = qs.length, tab = Math.min(st.tab, n)
  const setAns = (i: number, patch: Partial<TabAnswer>) => put({ ...st, ans: st.ans.map((a, j) => (j === i ? { ...a, ...patch } : a)) })
  const send = useMutation({
    mutationFn: async (body: object) => {
      const r = await fetch(`${agentUrl(agent)}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.status)
    },
    onSuccess: () => { batchDrafts.delete(fp); onSent(); qc.invalidateQueries({ queryKey: ['overview'] }); qc.invalidateQueries({ queryKey: ['picker', agent.key] }) },
  })
  const busy = send.isPending
  const allDone = qs.every((q, i) => isAnswered(q, st.ans[i]))
  const submit = () => send.mutate({ action: 'bulk', answers: qs.map((q, i) => toPayload(q, st.ans[i])) })
  const skip = () => send.mutate({ action: 'skip', question: picker.question })
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.focus({ preventScroll: true }) }, [tab])
  const q = qs[tab], a = st.ans[tab]
  const onKey = (e: import('react').KeyboardEvent) => {
    if (busy) return
    const inField = (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text'
    if (e.key === 'Escape') {
      e.preventDefault()
      if (isUserSkip({ key: e.key, cardHasFocus: Boolean(box.current?.contains(document.activeElement)), inFlight: busy, targetIsTextField: inField })) skip()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (tab === n) { if (allDone) submit() } else put({ ...st, tab: tab + 1 })
    }
  }
  return (
    <div ref={box} tabIndex={-1} onKeyDown={onKey} style={{ outline: 'none', flexShrink: 0 }}>
    <Card variant="yellow" padding={3}>
      <VStack gap={3} style={{ maxHeight: '55vh' }}>
        <VStack gap={2}>
          <HStack gap={2} align="center">
            <StatusDot variant="warning" label="Waiting for your answer" isPulsing={!busy} />
            <Text weight="semibold">{tab === n ? 'Review your answers' : 'Question'}</Text>
          </HStack>
          <Stepper activeStep={tab} density="compact" label="Questions" onStepClick={(i) => { if (!busy) put({ ...st, tab: i }) }}
            horizontalOptions={{ minimumStepWidth: 64, collapsedVariant: 'withLabel' }}>
            {[...qs.map((x) => x.header ?? ''), 'Submit'].map((h, i) => (
              <Step key={h + i} step={i} label={h} isDisabled={busy}
                indicator={i < n && isAnswered(qs[i], st.ans[i]) && i !== tab ? '✓' : 'auto'} />
            ))}
          </Stepper>
        </VStack>
        <VStack gap={3} isScrollable style={{ flex: 1, minHeight: 0 }}>
          {send.isError && <Banner status="error" title="Couldn't send — answer in the terminal" description={`${String(send.error)}. Your answers are kept here.`} />}
          {tab === n ? (
            qs.map((x, i) => (
              <Card key={i} padding={2} onClick={() => put({ ...st, tab: i })} style={{ cursor: busy ? 'default' : 'pointer' }}>
                <HStack gap={2} justify="between" align="center">
                  <VStack gap={0.5}>
                    <Text type="supporting" size="sm">{x.question}</Text>
                    <Text weight="medium">{isAnswered(x, st.ans[i]) ? summary(x, st.ans[i]) : 'Not answered yet'}</Text>
                  </VStack>
                  <Button label="Edit" size="sm" variant="ghost" isDisabled={busy} onClick={(e) => { e.stopPropagation(); put({ ...st, tab: i }) }} />
                </HStack>
              </Card>
            ))
          ) : (
            <>
              <ChatMarkdown>{q.question}</ChatMarkdown>
              {q.multiSelect ? (
                <CheckboxList label="Choose any" isLabelHidden value={a.multi} onChange={(v: string[]) => setAns(tab, { multi: v })}>
                  {q.options.map((o) => (
                    <CheckboxListItem key={o.label} value={o.label} label={<OptionLabel label={o.label} />} description={o.description && o.description !== o.label ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={busy} />
                  ))}
                </CheckboxList>
              ) : (
                <RadioList label="Choose one" isLabelHidden value={a.single} onChange={(v: string) => setAns(tab, { single: v })}>
                  {q.options.map((o) => (
                    <RadioListItem key={o.label} value={o.label} label={<OptionLabel label={o.label} />} description={o.description ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={busy} />
                  ))}
                  {!hasPreview(q) && <RadioListItem value={BATCH_OTHER} label="Other…" isDisabled={busy} />}
                </RadioList>
              )}
              {(q.multiSelect || a.single === BATCH_OTHER) && (
                <TextInput label={q.multiSelect ? 'Other (optional)' : 'Your answer'} value={a.other} onChange={(v: string) => setAns(tab, { other: v })} isDisabled={busy} placeholder="Type something" />
              )}
            </>
          )}
        </VStack>
        <HStack gap={2} justify="between" align="center" wrap="wrap">
          <HStack gap={1}>
            <Button label="Cancel" size="sm" variant="ghost" tooltip="Cancels the question in the terminal (Esc)" isDisabled={busy} onClick={skip} />
          </HStack>
          <HStack gap={2} align="center">
            {tab > 0 && <Button label="Back" size="sm" variant="ghost" isDisabled={busy} onClick={() => put({ ...st, tab: tab - 1 })} />}
            {tab === n
              ? <Button label="Submit answers" variant="primary" isLoading={busy} isDisabled={busy || !allDone} onClick={submit} />
              : <Button label="Next" variant="primary" isDisabled={busy} onClick={() => put({ ...st, tab: tab + 1 })} />}
          </HStack>
        </HStack>
      </VStack>
    </Card>
    </div>
  )
}

// The pending picker, read off the agent's screen. One question per submit — Claude Code's own flow.
function TerminalPickerCard({ agent, picker, onSent }: { agent: PickerAgent; picker: Picker; onSent: () => void }) {
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

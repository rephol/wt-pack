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
// The pending picker, read off the agent's screen. One question per submit — Claude Code's own flow.
export function PickerCard({ agent, picker, onSent }: { agent: PickerAgent; picker: Picker; onSent: () => void }) {
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

// The popup a room chip or an Inbox 'ask'/'question' item opens (WP-164 U3): a wt-ask card ('A', steps +
// free text, the recommended option first and marked) or a mirrored native picker ('B', reusing PickerCard).
// A dialog on desktop; on a phone a real BottomSheet (WP-164 follow-up), not a fullscreen Dialog — its default
// purpose='info' gives Escape, scrim-tap and swipe dismissal for free, closable without answering either way
// (the chip stays until the ask/picker itself closes). No native dialogs here (window.confirm/alert): Astryx's
// Dialog/BottomSheet only.
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@astryxdesign/core/Dialog'
import { BottomSheet } from '@astryxdesign/core/BottomSheet'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Icon } from '@astryxdesign/core/Icon'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Stepper, Step } from '@astryxdesign/core/Stepper'
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList'
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Text } from '@astryxdesign/core/Text'
import { ChatMarkdown } from './links'
import { PickerCard, type Picker, type PickerAgent } from './pickerCard'

export interface AskQuestion { question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean; recommended?: string }
export interface Ask { id: string; agent: string; room: string | null; ticket: string | null; questions: AskQuestion[]; status: string; created: string }
export type PopupTarget = { kind: 'ask'; ask: Ask } | { kind: 'picker'; agent: PickerAgent; picker: Picker }

function useNarrow(q = '(max-width: 639px)') {
  const [n, setN] = useState(() => matchMedia(q).matches)
  useEffect(() => { const m = matchMedia(q); const on = () => setN(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on) }, [q])
  return n
}
const recommendedLabel = (o: { label: string }, recommended?: string) =>
  o.label === recommended ? <HStack gap={2} align="center" wrap="wrap"><Text weight="medium">{o.label}</Text><Badge variant="success" label="Recommended" /></HStack> : o.label

function AskCard({ ask, onClose, onAnswered }: { ask: Ask; onClose: () => void; onAnswered: () => void }) {
  const [step, setStep] = useState(0)
  // The recommended option is marked (sorted first, badged) but never pre-selected — same as the native
  // picker (B), which only ever pre-checks an option the terminal itself already marked answered.
  const [selected, setSelected] = useState<string[][]>(() => ask.questions.map(() => []))
  const [text, setText] = useState('')
  // WP-233: 'Other' is a selectable choice per question (like the native picker), its text kept per question.
  const [other, setOther] = useState<string[]>(() => ask.questions.map(() => ''))
  const [otherOn, setOtherOn] = useState<boolean[]>(() => ask.questions.map(() => false))
  const qc = useQueryClient()
  const answer = useMutation({
    mutationFn: async (chat?: boolean) => {
      const body = chat ? { chat: true } : { selected, other: other.map((t, i) => (otherOn[i] ? t.trim() : '')), ...(text.trim() ? { text: text.trim() } : {}) }
      const r = await fetch(`/api/asks/${ask.id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (r.status === 409) throw new Error('Already answered — this ask closed before your answer went through.')
      if (!r.ok) throw new Error((await r.json()).error ?? r.status)
    },
    // WP-169: a second surface (room chip vs. Inbox) racing this one must see the ask close right away, not
    // after the next 5s poll — invalidate both caches the ask can appear in.
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['inbox'] }); qc.invalidateQueries({ queryKey: ['asks'] }); onAnswered(); onClose() },
  })
  const q = ask.questions[step]
  const sorted = [...q.options].sort((a, b) => Number(b.label === q.recommended) - Number(a.label === q.recommended))
  const OTHER = '\u0000other' // not a real label: RadioList/CheckboxList values are strings
  const set = (labels: string[]) => {
    const on = labels.includes(OTHER)
    setOtherOn((o) => o.map((v, i) => (i === step ? on : v)))
    setSelected((s) => s.map((v, i) => (i === step ? labels.filter((l) => l !== OTHER) : v)))
  }
  const done = (i: number) => selected[i].length > 0 || (otherOn[i] && other[i].trim() !== '')
  const canNext = done(step)
  const last = step === ask.questions.length - 1
  // The Stepper allows jumping ahead (like PickerCard's own tabs); Answer still needs every question answered.
  const canAnswer = last && ask.questions.every((_, i) => done(i))
  const otherItem = { label: 'Other', description: undefined }
  const otherInput = otherOn[step] && <TextInput label="Your answer" value={other[step]} onChange={(v) => setOther((o) => o.map((t, i) => (i === step ? v : t)))} isDisabled={answer.isPending} placeholder="Type your answer" />
  return (
    <VStack gap={3}>
      <HStack gap={2} align="center">
        <StatusDot variant="warning" label="Waiting for your answer" isPulsing />
        <Text weight="semibold">{ask.agent} asks</Text>
      </HStack>
      {ask.questions.length > 1 && (
        <Stepper activeStep={step} density="compact" label="Questions" onStepClick={setStep}
          horizontalOptions={{ minimumStepWidth: 64, collapsedVariant: 'withLabel' }}>
          {ask.questions.map((qq, i) => <Step key={qq.header + i} step={i} label={qq.header} indicator={i !== step && done(i) ? '✓' : 'auto'} />)}
        </Stepper>
      )}
      {answer.isError && <Banner status="error" title="Could not send the answer" description={String(answer.error)} />}
      <ChatMarkdown>{q.question}</ChatMarkdown>
      {q.multiSelect ? (
        <CheckboxList label="Choose any" isLabelHidden value={otherOn[step] ? [...selected[step], OTHER] : selected[step]} onChange={set}>
          {sorted.map((o) => (
            <CheckboxListItem key={o.label} value={o.label} label={recommendedLabel(o, q.recommended)}
              description={o.description ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={answer.isPending} />
          ))}
          <CheckboxListItem value={OTHER} label={otherItem.label} isDisabled={answer.isPending} />
        </CheckboxList>
      ) : (
        <RadioList label="Choose one" isLabelHidden value={otherOn[step] ? OTHER : selected[step][0] ?? ''} onChange={(v) => set([v])}>
          {sorted.map((o) => (
            <RadioListItem key={o.label} value={o.label} label={recommendedLabel(o, q.recommended)}
              description={o.description ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={answer.isPending} />
          ))}
          <RadioListItem value={OTHER} label={otherItem.label} isDisabled={answer.isPending} />
        </RadioList>
      )}
      {otherInput}
      {last && <TextInput label="Anything else? (optional)" value={text} onChange={setText} isDisabled={answer.isPending} placeholder="Type something" />}
      <HStack gap={2} justify="end" style={{ position: 'sticky', bottom: 0, paddingBlock: 8, background: 'var(--color-background-surface)' }}>
        <Button label="Chat about this" size="sm" variant="ghost" isDisabled={answer.isPending} onClick={() => answer.mutate(true)} />
        {step > 0 && <Button label="Back" size="sm" variant="ghost" isDisabled={answer.isPending} onClick={() => setStep((s) => s - 1)} />}
        {last
          ? <Button label="Answer" variant="primary" isLoading={answer.isPending} isDisabled={!canAnswer} onClick={() => answer.mutate(false)} />
          : <Button label="Next" variant="primary" isDisabled={!canNext} onClick={() => setStep((s) => s + 1)} />}
      </HStack>
    </VStack>
  )
}

export function QuestionPopup({ target, onClose, onDone }: { target: PopupTarget; onClose: () => void; onDone: () => void }) {
  const phone = useNarrow()
  const label = target.kind === 'ask' ? `${target.ask.agent} asks` : 'Question'
  const card = target.kind === 'ask'
    ? <AskCard ask={target.ask} onClose={onClose} onAnswered={onDone} />
    : <PickerCard agent={target.agent} picker={target.picker} onSent={onDone} />
  if (phone) return (
    <BottomSheet label={label} isOpen onOpenChange={(o) => !o && onClose()} height="hug">
      {/* Sheet sizes to content (BottomSheet's 'hug', capped at 92vh by the library); the 16px side gutter
          matches rooms.tsx's own BottomSheet content (rooms.tsx:400). */}
      <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '85dvh', minWidth: 0 }}>
        {/* The handle overlays the top ~24px of content (rooms.tsx has none, so it needs no clearance) —
            this row must clear it or its clicks are eaten. */}
        <HStack justify="end" style={{ paddingTop: 20, paddingInline: 16, flexShrink: 0 }}>
          <IconButton label="Close" icon={<Icon icon="close" />} size="sm" variant="ghost" onClick={onClose} style={{ minWidth: 44, minHeight: 44 }} />
        </HStack>
        {/* WP-265: native scroller (ScrollableArea stayed overflow:clip here, so Other / Answer fell off the screen); the card's action row sticks to its bottom. */}
        <div aria-label={label} style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 16px calc(env(safe-area-inset-bottom) + 16px)' }}>
          {card}
        </div>
      </div>
    </BottomSheet>
  )
  return (
    <Dialog isOpen onOpenChange={(o: boolean) => !o && onClose()} width={480} padding={4}>
      {/* WP-269: same trap as the sheet — cap to the Dialog's own 75dvh limit (less its padding) and scroll the body natively; the close row stays put. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 'calc(75dvh - 40px)', minWidth: 0 }}>
        <HStack justify="end" style={{ flexShrink: 0 }}>
          <IconButton label="Close" icon={<Icon icon="close" />} size="sm" variant="ghost" onClick={onClose} style={{ minWidth: 44, minHeight: 44 }} />
        </HStack>
        <div aria-label={label} style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {card}
        </div>
      </div>
    </Dialog>
  )
}

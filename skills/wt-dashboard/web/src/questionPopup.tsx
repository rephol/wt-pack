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
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea'
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
  const qc = useQueryClient()
  const answer = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/asks/${ask.id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected, ...(text.trim() ? { text: text.trim() } : {}) }) })
      if (r.status === 409) throw new Error('Already answered — this ask closed before your answer went through.')
      if (!r.ok) throw new Error((await r.json()).error ?? r.status)
    },
    // WP-169: a second surface (room chip vs. Inbox) racing this one must see the ask close right away, not
    // after the next 5s poll — invalidate both caches the ask can appear in.
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['inbox'] }); qc.invalidateQueries({ queryKey: ['asks'] }); onAnswered(); onClose() },
  })
  const q = ask.questions[step]
  const sorted = [...q.options].sort((a, b) => Number(b.label === q.recommended) - Number(a.label === q.recommended))
  const set = (labels: string[]) => setSelected((s) => s.map((v, i) => (i === step ? labels : v)))
  const canNext = selected[step].length > 0
  const last = step === ask.questions.length - 1
  // The Stepper allows jumping ahead (like PickerCard's own tabs); Answer still needs every question picked.
  const canAnswer = last && selected.every((s) => s.length > 0)
  return (
    <VStack gap={3}>
      <HStack gap={2} align="center">
        <StatusDot variant="warning" label="Waiting for your answer" isPulsing />
        <Text weight="semibold">{ask.agent} asks</Text>
      </HStack>
      {ask.questions.length > 1 && (
        <Stepper activeStep={step} density="compact" label="Questions" onStepClick={setStep}
          horizontalOptions={{ minimumStepWidth: 64, collapsedVariant: 'withLabel' }}>
          {ask.questions.map((qq, i) => <Step key={qq.header + i} step={i} label={qq.header} indicator={i !== step && selected[i].length > 0 ? '✓' : 'auto'} />)}
        </Stepper>
      )}
      {answer.isError && <Banner status="error" title="Could not send the answer" description={String(answer.error)} />}
      <ChatMarkdown>{q.question}</ChatMarkdown>
      {q.multiSelect ? (
        <CheckboxList label="Choose any" isLabelHidden value={selected[step]} onChange={set}>
          {sorted.map((o) => (
            <CheckboxListItem key={o.label} value={o.label} label={recommendedLabel(o, q.recommended)}
              description={o.description ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={answer.isPending} />
          ))}
        </CheckboxList>
      ) : (
        <RadioList label="Choose one" isLabelHidden value={selected[step][0] ?? ''} onChange={(v) => set([v])}>
          {sorted.map((o) => (
            <RadioListItem key={o.label} value={o.label} label={recommendedLabel(o, q.recommended)}
              description={o.description ? <Text type="supporting">{o.description}</Text> : undefined} isDisabled={answer.isPending} />
          ))}
        </RadioList>
      )}
      {last && <TextInput label="Anything else? (optional)" value={text} onChange={setText} isDisabled={answer.isPending} placeholder="Type something" />}
      <HStack gap={2} justify="end">
        {step > 0 && <Button label="Back" size="sm" variant="ghost" isDisabled={answer.isPending} onClick={() => setStep((s) => s - 1)} />}
        {last
          ? <Button label="Answer" variant="primary" isLoading={answer.isPending} isDisabled={!canAnswer} onClick={() => answer.mutate()} />
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
        <ScrollableArea label={label} style={{ padding: '0 16px calc(env(safe-area-inset-bottom) + 16px)' }}>
          {card}
        </ScrollableArea>
      </div>
    </BottomSheet>
  )
  return (
    <Dialog isOpen onOpenChange={(o: boolean) => !o && onClose()} width={480} padding={4}>
      <VStack gap={3}>
        <HStack justify="end">
          <IconButton label="Close" icon={<Icon icon="close" />} size="sm" variant="ghost" onClick={onClose} style={{ minWidth: 44, minHeight: 44 }} />
        </HStack>
        {card}
      </VStack>
    </Dialog>
  )
}

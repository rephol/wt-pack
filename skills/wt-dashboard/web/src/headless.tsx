// WP-293: the Conversation view's bar for a headless run — state chip (+ stuck flag), Interrupt/Stop for live runs,
// Resume for ended/failed ones, and answer controls for its open asks.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import { useToast } from '@astryxdesign/core/Toast'
import { getJSON } from './pickerCard'
import { askAnswerBody, askQuestions, canResume, stateChip, type HeadlessRun } from './headlessData'

export function HeadlessBar({ id }: { id: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const url = `/api/headless/${encodeURIComponent(id)}`
  const run = useQuery({ queryKey: ['headless', id], queryFn: () => getJSON<HeadlessRun>(url), refetchInterval: (q) => (q.state.data?.live ? 3000 : false) })
  const act = useMutation({
    mutationFn: async ({ sub, body = {} }: { sub: string; body?: object }) => {
      const r = await fetch(`${url}/${sub}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['headless', id] }); qc.invalidateQueries({ queryKey: ['overview'] }) },
    onError: (e) => toast({ body: `Not sent: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  const r = run.data
  if (!r) return null
  const busy = act.isPending
  return (
    <VStack gap={2} data-headless-bar="">
      <HStack gap={2} align="center" wrap="wrap">
        <Badge label={stateChip(r)} variant={r.state === 'failed' ? 'error' : r.asks.length ? 'warning' : 'neutral'} />
        {r.stuck ? <Badge label="stuck" variant="warning" /> : null}
        <HStack gap={1} style={{ marginInlineStart: 'auto' }}>
          {r.state === 'working' && <Button label="Interrupt" size="sm" variant="secondary" isDisabled={busy} onClick={() => act.mutate({ sub: 'interrupt' })} />}
          {r.live && <Button label="Stop" size="sm" variant="ghost" isDisabled={busy} onClick={() => act.mutate({ sub: 'stop' })} />}
          {canResume(r.state) && <Button label="Resume" size="sm" variant="secondary" isDisabled={busy} onClick={() => act.mutate({ sub: 'resume' })} />}
        </HStack>
      </HStack>
      {r.asks.map((a) => {
        const qs = askQuestions(a)
        return (
          <VStack key={a.id} gap={1} style={{ padding: 8, borderRadius: 8, border: '1px solid var(--color-border-default, rgba(128,128,128,.3))' }}>
            {qs.length ? qs.map((q) => (
              <VStack key={q.question} gap={1}>
                <Text weight="medium">{q.question}</Text>
                <HStack gap={1} wrap="wrap">
                  {(q.options ?? []).map((o) => <Button key={o.label} label={o.label} size="sm" variant="secondary" isDisabled={busy}
                    onClick={() => act.mutate({ sub: 'answer', body: askAnswerBody(a, { question: q.question, label: o.label }) })} />)}
                </HStack>
              </VStack>
            )) : (<>
              <Text weight="medium">{`${a.tool} wants to run`}</Text>
              <Text type="code" size="sm" maxLines={3}>{JSON.stringify(a.input)}</Text>
              <HStack gap={1}>
                <Button label="Allow" size="sm" variant="primary" isDisabled={busy} onClick={() => act.mutate({ sub: 'answer', body: askAnswerBody(a, true) })} />
                <Button label="Deny" size="sm" variant="secondary" isDisabled={busy} onClick={() => act.mutate({ sub: 'answer', body: askAnswerBody(a, false) })} />
              </HStack>
            </>)}
          </VStack>
        )
      })}
    </VStack>
  )
}

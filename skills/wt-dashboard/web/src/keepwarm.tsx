// Settings › Usage › Keepwarm (WP-318): the budget for keeping an idle agent's 1 h prompt cache warm.
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Switch } from '@astryxdesign/core/Switch'
import { Selector } from '@astryxdesign/core/Selector'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { useToast } from '@astryxdesign/core/Toast'
import { api } from './rooms'
import { SettingsCard, SettingsRow } from './settingsRows'
import { KW_ROLES, WINDOW_HOURS, toBody, type KwSettings } from './keepwarmData'

type State = { settings: KwSettings; defaults: KwSettings }
const asDraft = (s: KwSettings) => ({ enabled: s.enabled, roles: s.roles, minContext: String(s.minContext), intervalMin: String(s.intervalMin), windowH: String(s.windowH), dailyCap: String(s.dailyCap) })

export function KeepwarmSection() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['keepwarm'], queryFn: () => api<State>('/api/keepwarm/settings') })
  const [d, setD] = useState<ReturnType<typeof asDraft> | null>(null)
  useEffect(() => { if (q.data) setD(asDraft(q.data.settings)) }, [q.data?.settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: (body: KwSettings) => api('/api/keepwarm/settings', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['keepwarm'] }); toast({ body: 'Saved' }) },
    onError: (e) => toast({ body: `Could not save: ${e instanceof Error ? e.message : e}`, type: 'error' }),
  })
  if (!q.data || !d) return null
  const dirty = JSON.stringify(d) !== JSON.stringify(asDraft(q.data.settings))
  const set = (p: Partial<typeof d>) => setD({ ...d, ...p })
  const num = (k: 'minContext' | 'intervalMin' | 'dailyCap', label: string, description: string) => (
    <SettingsRow title={label} description={description}
      control={<TextInput label={label} isLabelHidden size="sm" width={88} value={d[k]} onChange={(v: string) => set({ [k]: v })} placeholder={String(q.data.defaults[k])} />} />
  )
  return (
    <VStack gap={3}>
      <SettingsCard title="Keepwarm">
        <SettingsRow title="Keep idle agents warm" description="A tool-less ping reads the agent's context once, renewing its 1 h prompt cache. A read costs about 2.5% of a cold re-send."
          control={<Switch label="Keep idle agents warm" isLabelHidden value={d.enabled} onChange={(v) => set({ enabled: v })} />} />
        <SettingsRow title="For these roles" description="Any agent can also be armed or turned off from its menu."
          control={<HStack gap={2} wrap="wrap">{KW_ROLES.map((r) => <CheckboxInput key={r} label={r} value={d.roles.includes(r)} onChange={(on) => set({ roles: on ? [...d.roles, r] : d.roles.filter((x) => x !== r) })} />)}</HStack>} />
        {num('intervalMin', 'Ping every (minutes, 5–59)', 'Idle time before a ping. Stay under 60: a longer gap loses the cache.')}
        <SettingsRow title="Keep warm for (hours after the last real turn)" description="Pings stop once the agent has been idle this long."
          control={<Selector label="Window" isLabelHidden width={120} value={d.windowH} onChange={(v: string) => set({ windowH: v })}
            options={WINDOW_HOURS.map((h) => ({ value: String(h), label: `${h} h` }))} />} />
        {num('dailyCap', 'Pings per agent per day', 'A hard cap, whatever the window.')}
        {num('minContext', 'Only above (context tokens)', 'A small context is cheap to re-send cold.')}
      </SettingsCard>
      <HStack gap={2}>
        <Button label="Save" size="sm" variant="primary" isDisabled={!dirty} isLoading={save.isPending} onClick={() => save.mutate(toBody(d))} />
      </HStack>
    </VStack>
  )
}

// Settings building blocks, after Astryx's settings-dialog template
// (@astryxdesign/cli/assets/templates/pages/settings-dialog/page.tsx): a card groups one subject as aligned rows,
// name and explanation left, control right; every row stacks at the same panel width (CSS `.hd-set-*`).
// ponytail: plain CSS classes instead of the template's StyleX xstyle — this app has no StyleX compiler.
import { Children, type ReactNode } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'

/** One control column down the panel, as in the template. */
export const CONTROL_WIDTH = 220

export function SettingsCard({ title, end, children }: { title?: string; end?: ReactNode; children: ReactNode }) {
  return (
    <div className="hd-set-card">
      {(title || end) && (
        <HStack justify="between" align="end" gap={2}>
          <Text type="supporting" weight="semibold" color="secondary">{title}</Text>
          {end}
        </HStack>
      )}
      <Card padding={0} width="100%" variant="muted">
        <ul role="list" className="hd-set-rows">
          {Children.toArray(children).filter(Boolean).map((row, i) => <li key={i}>{row}</li>)}
        </ul>
      </Card>
    </div>
  )
}

export function SettingsRow({ title, description, control, detail }: { title: ReactNode; description?: ReactNode; control?: ReactNode; detail?: ReactNode }) {
  return (
    <div className="hd-set-row">
      <div className="hd-set-line">
        <div className="hd-set-text">
          <Text type="label">{title}</Text>
          {description != null && <Text type="supporting" color="secondary">{description}</Text>}
        </div>
        {control != null && <div className="hd-set-control">{control}</div>}
      </div>
      {detail}
    </div>
  )
}

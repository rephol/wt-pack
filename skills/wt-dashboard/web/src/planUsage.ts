// WP-179: sidebar Claude plan usage bar — pure logic, kept out of status.tsx so it can be unit-tested (the
// repo's *.test.ts runner can't parse JSX).
export type PlanMeter = { pct: number; reset: string }
export type PlanUsage = { session: PlanMeter; weekly: PlanMeter; at: number } | null | undefined

// >95% danger, >80% warn, otherwise the plan's own accent colour.
export const planVariant = (pct: number) => (pct > 95 ? 'error' : pct > 80 ? 'warning' : 'accent') as 'error' | 'warning' | 'accent'

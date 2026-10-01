// WP-203: a multi-tab AskUserQuestion picker answered client-side. The server scans every tab's options off the
// terminal ({action:'scan'}, server.mjs scanTabs), the card holds one answer per tab and sends them all at Submit
// ({action:'bulk'}); the server walks the terminal through them (runBulk).
export interface BatchQuestion { question: string; header?: string; multiSelect?: boolean; layout?: 'preview'; options: { label: string; description?: string; checked?: boolean }[] }
export interface TabAnswer { single: string; multi: string[]; other: string }
export const OTHER = '__other__'
// A revisited tab arrives with the terminal's earlier answer ticked.
export const initialAnswer = (q: BatchQuestion): TabAnswer => ({ single: q.multiSelect ? '' : q.options.find((o) => o.checked)?.label ?? '', multi: q.multiSelect ? q.options.filter((o) => o.checked).map((o) => o.label) : [], other: '' })
export const emptyAnswer = (): TabAnswer => ({ single: '', multi: [], other: '' })

// The batch flow needs ≥2 tabs, a scanned question per tab whose header equals the tab's, and the terminal not yet
// at its own review step. Anything else (scan failed or pending) keeps the per-tab flow.
export function matchBatch(tabs: { header: string }[], review: boolean, questions?: BatchQuestion[] | null): BatchQuestion[] | null {
  if (review || !questions || tabs.length < 2 || questions.length !== tabs.length) return null
  return tabs.every((t, i) => questions[i].header === t.header && questions[i].options?.length) ? questions : null
}
export const hasPreview = (q: BatchQuestion) => q.layout === 'preview'
export const isAnswered = (q: BatchQuestion, a: TabAnswer) =>
  Boolean(q.multiSelect ? a.multi.length || a.other.trim() : a.single === OTHER ? a.other.trim() : a.single)
// Same shape the single-tab POST /answer takes, plus the tab header the server checks against the screen.
export const toPayload = (q: BatchQuestion, a: TabAnswer) => ({
  header: q.header ?? '',
  selected: q.multiSelect ? a.multi : a.single && a.single !== OTHER ? [a.single] : [],
  other: q.multiSelect || a.single === OTHER ? a.other : null,
})
export const summary = (q: BatchQuestion, a: TabAnswer) =>
  q.multiSelect ? [...a.multi, ...(a.other.trim() ? [a.other.trim()] : [])].join(', ') : a.single === OTHER ? a.other.trim() : a.single
// Survives a remount/poll: keyed by agent + the picker's own fingerprint (its tab headers and questions).
export const fingerprint = (agentKey: string, qs: BatchQuestion[]) => `${agentKey}|${qs.map((q) => `${q.header}:${q.question}`).join('|')}`

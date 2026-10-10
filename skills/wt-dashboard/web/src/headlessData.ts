// WP-293: pure helpers for headless runs (server-owned `claude -p` agents) in the Agents list and Conversation view.
export type HeadlessState = 'queued' | 'starting' | 'working' | 'idle' | 'ended' | 'failed'
export type HeadlessAsk = { id: string; tool: string; input: Record<string, unknown>; created: number }
export type HeadlessRun = { id: string; state: HeadlessState; reason: string | null; asks: HeadlessAsk[]; live: boolean; stuck?: number | null }
type Question = { question: string; options?: { label: string }[] }

// The list badge: queued runs say so, every other run is just "headless".
export const headlessBadge = (state?: string) => (state === 'queued' ? 'queued' : 'headless')
// Header chip: the state, plus its reason when the run ended or failed (e.g. "ended: idle release").
export const stateChip = (r: Pick<HeadlessRun, 'state' | 'reason'>) => (r.reason && (r.state === 'ended' || r.state === 'failed') ? `${r.state}: ${r.reason}` : r.state)
export const canResume = (state: string) => state === 'ended' || state === 'failed'
export const askQuestions = (a: HeadlessAsk): Question[] => (a.tool === 'AskUserQuestion' && Array.isArray(a.input.questions) ? a.input.questions as Question[] : [])
// Body for POST /api/headless/<id>/answer: a tool ask takes allow, an AskUserQuestion takes {question text: label}.
export function askAnswerBody(a: HeadlessAsk, answer: boolean | { question: string; label: string }) {
  return typeof answer === 'boolean' ? { ask: a.id, allow: answer } : { ask: a.id, answers: { [answer.question]: answer.label } }
}

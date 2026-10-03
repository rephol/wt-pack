import type { Register } from 'claude-code'
import type { SkillsDir } from '../../wt-mods/hooks/commands'

// WP-206: in a wt-pack herdr agent pane, answer AskUserQuestion through wt-dashboard (wt-ask posts the chip and
// Inbox card, --wait blocks for the answer) and return it as the tool's result. Anything off the happy path
// (no pane, dashboard down, a text/number question, a wt-ask error) calls next(e): the native dialog.
const SLICE_S = 300 // one --wait call; $.process.run caps a command at ten minutes

type Q = { question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean; kind?: string }
type Answer = { selected: string[][]; text?: string }

export const registerAsk = (on: Parameters<Register>[0], options: Parameters<Register>[1], skills: SkillsDir) => {
  {
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
      const qs = e.questions as Q[]
      if (qs.some((q) => q.kind && q.kind !== 'choice')) return next(e) // wt-ask only carries option questions
      const wt = `${skills($.plugin.root)}/wt-ask/scripts/wt-ask`
      const run = (argv: string[], stdin?: string, timeoutMs = 15000) => $.process.run([wt, ...argv], { stdin, timeoutMs }).catch(() => null)

      if ((await run(['--ping']))?.exitCode !== 0) return next(e) // not a known agent pane, or dashboard down
      const body = JSON.stringify({ questions: qs.map(({ question, header, options, multiSelect }) => ({ question, header, options: options.map(({ label, description }) => ({ label, description })), multiSelect })) })
      const posted = await run(['--json', '-', '--no-deliver'], body)
      const id = posted?.exitCode === 0 ? posted.stdout.trim() : ''
      if (!id) return next(e)

      const timeoutMin = Number(options.timeoutMin) > 0 ? Number(options.timeoutMin) : 30
      const deadline = (await $.clock.now()) + timeoutMin * 60_000
      // Core's record: answers maps question -> label(s), `response` is freeform text typed instead of selecting.
      const answered = (a: Answer) => ({
        result: {
          questions: e.questions,
          answers: Object.fromEntries(qs.map((q, i) => [q.question, (a.selected[i] ?? []).join(', ') || (i === 0 && a.text ? a.text : '')])),
          ...(a.text ? { response: a.text } : {}),
        },
      })
      $.ui.status('asked in wt-dashboard, waiting for the answer…')
      try {
        for (;;) {
          const left = Math.ceil((deadline - (await $.clock.now())) / 1000)
          if (left <= 0) break
          if (next.signal.aborted) break // interrupted: stop polling, resolve the ask below
          const slice = Math.min(SLICE_S, left)
          const w = await run(['--wait', id, '--timeout', String(slice)], undefined, (slice + 15) * 1000)
          if (w?.exitCode === 0) {
            let a: Answer
            try { a = JSON.parse(w.stdout) as Answer } catch { return next(e) }
            return answered(a)
          }
          if (w?.exitCode === 3 && w.stderr.includes('resolved')) return { deny: 'The question was closed in wt-dashboard without an answer; continue without it or ask again.' }
          if (w?.exitCode !== 3) { await run(['--resolve', id]); return next(e) } // dashboard went away: ask natively
        }
        if (next.signal.aborted) { await run(['--resolve', id]); return { deny: 'Interrupted while waiting for the dashboard answer.' } }
        // --resolve is a 409 when the user answered in the last moment: take that answer rather than deny it.
        if ((await run(['--resolve', id]))?.exitCode !== 0) {
          const late = await run(['--wait', id, '--timeout', '1'], undefined, 20000)
          if (late?.exitCode === 0) return answered(JSON.parse(late.stdout) as Answer)
        }
        return { deny: `No answer from the user within ${timeoutMin} min (asked via wt-dashboard); continue without it or ask again.` }
      } finally {
        $.ui.status(undefined)
      }
    })
  }
}

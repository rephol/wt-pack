// Review-comment classes for wt-judge triage --classes (wt-babysit, WT_JEV_BABYSIT_TRIAGE); shared with jev-eval.mjs.
export const triageClass = {
  // The comment rides inside `instructions` (an object is allowed), as wt-judge's noul questions do.
  question: (comment) => ({ type: 'choice',
    instructions: { comment, question: 'What does `comment`, a pull-request review comment, need from the author?' },
    criteria: {
      must_fix: 'A defect or a required change: the reviewer will not approve until the code changes.',
      question: 'A question the author must answer (it may or may not lead to a change).',
      nit: 'An optional style, naming or polish suggestion.',
      no_action: 'Praise, acknowledgement, agreement, or a note for later that needs no reply.',
    } }),
  questions: (state) => ({ k0: triageClass.question(state.comment) }),
  decide: (a) => a?.k0?.choice ?? null,
}

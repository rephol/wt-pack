# Security lens

Triggered when the target touches auth, credentials, safety, secrets or user data.

## Look for

- **A predicate that fails open.** A guard keyed on a variable someone has to remember to set, or on an
  environment name that is unset in some deployment — an unset variable read as "not production" is the
  classic. A security predicate must fail closed and must not depend on a value a human configures.
- **A guard applied at the wrong scope.** A middleware attached to a whole controller when the intent was one
  route opens every sibling, including routes added to that file later, in an edit that never mentions them.
- **Two switches whose defaults compose wrongly.** Independent flags governing overlapping cohorts can admit
  exactly the cohort they were meant to refuse. Enumerate the combinations.
- **A secret or prompt reaching a surface it should not.** A debug payload, an error message carrying PII, a
  column marked internal reaching a public client, a stack preserved for an error whose message is the leak.
- **Credential handling on the success path.** The dangerous bug is usually not the error path — it is a
  success response mishandled, e.g. overwriting a held credential with an absent one.
- **A widened allowlist used to silence a refusal.** The absence of a declaration is often a deliberate
  answer. Widening it to stop something failing removes the control.

## Rules

- Verify against the code before reporting; name the file.
- Do not re-derive the codebase — verify the `[unsourced]` claims and the target's own reasoning.
- A `settled:` decision is challengeable only as infeasibility. A security defect is not a preference, so if
  one is real, say so at full strength regardless of any label.

## done =

Every file the target touches that handles auth, credentials, secrets or user data opened, each guard traced
to its actual fail-open/fail-closed behaviour, and every `[unsourced]` security claim verified against the
code rather than taken as stated.

## Don't flag

- An allowlist or scope that is narrower than the general pattern elsewhere in the codebase — narrower is
  the safe direction; flag only where it is wider than intended.
- A credential or secret that never leaves the process boundary (stays in memory, a local env var, a
  same-process call) — the finding is about a surface it reaches, not about the value existing at all.

## Return

Findings ranked by severity, each with the concrete exploit or exposure it produces. No threat-model essays.

Write findings per `references/reviewer-contract.md` and SKILL.md's schema — JSON to
`<scratchpad>/findings/security.json`, a one-line count and the worst one in your reply. The caller groups
duplicates and checks every finding against the file it cites, and both read this file — a prose reply means
neither runs.

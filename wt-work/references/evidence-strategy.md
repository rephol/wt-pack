# Evidence strategy

Decide **before** changing behaviour where the proof for this unit lives. Test discovery decides it, not
preference.

## Test discovery

Before implementing a change to a file, find its existing tests: files that import it, reference it, or share
its naming pattern. When the plan names test files, start there, then check for coverage the plan did not
enumerate — a plan's test list is rarely complete.

## The decision

| Situation | Action |
|---|---|
| An existing test already fails for the intended behaviour | Use it as the red evidence. Do not add a duplicate. |
| An existing test covers the contract but asserts the old expectation | Update **that** test, run it, observe the expected failure before implementing |
| An existing test is over-mocked and misses the real chain | Strengthen it narrowly, then verify it fails for the right reason |
| No existing test covers the behaviour | Add the smallest focused failing test that proves the slice |
| Testing is genuinely inappropriate | Record the no-test exception **and** the replacement verification, before marking complete |

For behaviour-bearing changes, default to test-first or characterization-first whenever the current code and
its tests make that practical — even when the plan says nothing about it.

## Scenario completeness

Before writing tests for a feature-bearing unit, check the categories that apply. A plan scenario reading
"validates correctly", with no inputs and no expected outcome, produces a test that asserts nothing and
passes.

| Category | Applies when | Derive it from |
|---|---|---|
| Happy path | always, for feature-bearing units | the unit's goal: core input/output pairs |
| Edge cases | the unit has boundaries — inputs, state, concurrency | boundary values, empty/nil, concurrent access |
| Error paths | the unit has failure modes — validation, external calls, permissions | inputs it must reject, denials it must enforce, downstream failures it must handle |
| Integration | the unit crosses layers — callbacks, middleware, multi-service | the cross-layer chain, exercised without mocks |

## Guardrails

- Do not write the test and the implementation in the same step when working proof-first.
- Do not skip verifying that a new or changed test fails **for the expected reason**.
- Do not over-implement beyond the behaviour slice the red proves.
- Do not add a duplicate regression test when an existing test is the right home.
- Skip proof-first for trivial renames, pure config, pure styling, generated artifacts and manual-only
  surfaces — but record the reason and the replacement verification.

## One test per defect, not one per unit

**Test count is not coverage.** Mutation-tested across three independently produced suites for the same
ticket, all three scored identically on defect detection while differing by five tests — the extra tests were
redundancy. One mutation fired eight tests in one suite and one in another; both caught it equally.

So, after writing a test, ask what defect it is the *only* proof of. If another test already reds on the same
injection, the new one buys nothing and costs a reader's attention forever.

- **Prove it by injection, not by assertion.** Break the thing the test exists for and watch that test go
  red. A test that stays green through its own defect is decoration — and one that reds alongside six others
  is not proving anything the six did not.
- **A guard asserting a derived value against its own derivation cannot fail.** It passes with the bug live
  and reads as coverage. Pin literals, or pin the invariant, not the computation.
- **Prefer the boundary to the middle.** All three suites in that comparison missed an off-by-one at the
  retention-window edge while collectively spending twenty-odd tests elsewhere. The edge is where the defects
  that survive review live.

## The honest exception

"Testing is inappropriate here" is a legitimate answer roughly as often as people claim it, and it is only
legitimate **with a replacement verification named**. "Manually checked" is not one unless you say what you
did and what you saw.

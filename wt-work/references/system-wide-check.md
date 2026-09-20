# System-wide check

Run before marking a unit done. This is the highest-value page in the skill: it catches the failures that a
green unit test cannot see, because the unit is correct in isolation and the system is not.

## The five questions

**1. What fires when this runs?** Trace two levels out from your change — callbacks, middleware, observers,
event handlers, hooks. Read the actual code, not the docs, for callbacks on anything you touched and
middleware in the request chain.

**2. Do my tests exercise the real chain?** If every dependency is mocked, the test proves your logic works
*in isolation* and says nothing about the interaction. Write at least one test that uses real objects through
the full chain, with no mocks for the layers that actually interact.

**3. Can failure leave orphaned state?** If the code persists state — a row, a cache entry, a file, an
uploaded object — before calling something that can fail, what happens when it fails? Does a retry create a
duplicate? Trace the failure path with real objects. If state is created before the risky call, prove that
failure cleans up or that retry is idempotent.

**4. What other interfaces expose this?** Mixins, alternative entry points, a second component holding the
same list, a parallel surface (web vs native, chat vs agent). Grep for the behaviour, not the identifier. If
parity is needed, it is needed now — not as a follow-up nobody files.

**5. Do error strategies align across layers?** Retry middleware plus application fallback plus framework
error handling can conflict or double-execute. List the specific error classes each layer raises and catches,
and verify your rescue list matches what the layer below actually throws.

## When to skip

Leaf changes with no callbacks, no persisted state and no parallel interface. A purely additive helper or a
new partial: the check takes ten seconds and the answer is "nothing fires".

## When it matters most

Anything touching a model with callbacks, error handling with fallback or retry, or behaviour exposed through
more than one interface. Also: anything the plan's blindspot findings flagged as a second copy — question 4
is where that finding gets acted on.

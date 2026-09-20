#!/usr/bin/env node
// Typed judgments for decisions the wt-* pack currently makes by eyeballing.
//
//   wt-judge.mjs lenses   <target> [--mode plan|diff] [--t 0.6]
//   wt-judge.mjs dedupe   <findings.json> [--t 0.6]   (a false merge loses a finding)
//   wt-judge.mjs cite     <records.json> [--t 0.5]
//   wt-judge.mjs learning <learning.md> --against <file> [--against <file>]
//   wt-judge.mjs triage   <comments.json> [--t 0.5]
//   wt-judge.mjs ci       <failure.json>
//   wt-judge.mjs simplify <candidates.json> [--t 0.7]
//   wt-judge.mjs relevance <candidates.json> --question <q> [--max 60]
//     ADVISORY: a READING ORDER for wt-research, never a shorter list. The
//     candidate set there is open, so cutting it is how the unnamed thing is
//     missed — and nothing afterwards can prove it was.
//   wt-judge.mjs attention <diff> --lens <name> [--t 0.5] [--max 40]
//     ADVISORY: ranks hunks by what a lens should read closely. Read everything
//     anyway until the log says the bottom of the ranking is really empty.
//   wt-judge.mjs verify   <findings.json> [--rev <sha>] [--root <dir>] [--t 0.5]
//     findings: [{title, detail, file, line?, related?: [path]}] — `related` is
//     where a refutation would live (the test that pins a string, the caller).
//
//   wt-judge.mjs mark <run>#<i> yes|no [...]   record what actually happened
//   wt-judge.mjs calibrate [cmd] [--apply]     thresholds from those outcomes
//
// Add --json for machine output. Exit 3 means no API key: the caller falls back
// to the pack's existing behaviour, which is never "do nothing".
//
// These DECIDE rather than report, unlike wt-eval.mjs. That is why every
// subcommand prints the probability beside its verdict: a caller that acts on
// 0.51 the same way it acts on 0.99 has thrown away the calibration.
import { ask, noul, choice, readJson, readText, pct, requireKey,
         logJudgments, readLog, learnedThresholds, runId, LOG, THRESHOLDS } from './typesafe.mjs';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const flagAll = (name) => argv.reduce((a, v, i) => (v === `--${name}` ? [...a, argv[i + 1]] : a), []);
const json = argv.includes('--json');
// Per-command defaults, set from observed behaviour rather than picked at 0.5:
//   simplify — the model is cautious about "could this change behaviour for ANY
//     input" and floors around 0.6 even for provably equivalent rewrites
//     ([...new Set(ids)] scored 0.63). Below 0.7 everything looks risky.
//   dedupe — a false merge silently drops a finding, so it must be surer than
//     a false split, which only costs a duplicate line.
//   lenses — 0.5 fired all seven on a real plan; 0.4-0.6 is genuinely "the
//     reviewer's call", and the fence belongs above it.
const DEFAULT_T = { simplify: 0.7, dedupe: 0.6, lenses: 0.4, verify: 0.5 };
// Learned thresholds win over the shipped defaults. They only exist once
// `calibrate --apply` has seen enough labelled outcomes to justify a change.
const LEARNED = learnedThresholds();
const RUN = runId();
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !arr[i - 1]?.startsWith('--'));
const t = Number(flag('t', String(LEARNED[cmd]?.t ?? DEFAULT_T[cmd] ?? 0.5)));

function usage() {
  console.error(readText(new URL(import.meta.url).pathname).split('\n').slice(1, 29).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(2);
}


function logged(cmd, rows) {
  logJudgments(RUN, cmd, t, rows);
  if (!json) console.log(`\n  run ${RUN} \u00b7 correct it with: wt-judge.mjs mark ${RUN}#<i> yes|no`);
}

// ── lenses ───────────────────────────────────────────────────────────────────
// wt-review's sizing step, as calibrated judgments instead of trigger matching.
// The always-on lenses are NOT asked about: they are structural, and asking
// invites the model to drop one.
// Only TARGET properties are judged. `standards` and `learnings` are REPO
// properties — "is there an instructions file", "is there a learnings store" —
// and a directory check answers those for free and correctly.
//
// This is not a tidy-up. Judging them cost real findings on PR #1083: rewriting
// the learnings trigger from "does the repo have a store" (static, true) into
// "would the store have a lesson about this target" (unknowable up front) scored
// 50%, dropped the lens, and lost a finding where a docblock endorsed a false
// OTA mechanism the store had already recorded. Do not turn a cheap fact into a
// judgment.
const REPO_LENSES = {
  standards: (root) => ['CLAUDE.md', 'CONTRIBUTING.md', '.cursorrules', 'AGENTS.md'].some((f) => existsSync(join(root, f))),
  learnings: (root) => ['docs/solutions', 'docs/learnings', '.claude/solutions'].some((d) => existsSync(join(root, d))),
};

const LENS_TRIGGERS = {
  testing: 'Does this target add or change tests, or claim that something is guarded by a test?',
  security: 'Does this target touch authentication, authorisation, credentials, secrets, safety controls, or personal user data?',
  data: 'Does this target change a database schema, run a migration, alter a persisted data shape, or backfill existing rows?',
  scope: 'Is this target large, or does it defer work to a later section or leave parts explicitly unfinished?',
  adversarial: 'Is this target worth challenging at the premise — does it depend on something unvalidated, unproven on real hardware, or outside this repository, such that the whole approach could be wrong rather than merely buggy?',
};

async function lenses() {
  const target = positional[0] ?? usage();
  const mode = flag('mode', /diff --git|^index [0-9a-f]{7}/m.test(readText(target)) ? 'diff' : 'plan');
  const always = mode === 'diff' ? ['correctness', 'regression'] : ['coherence', 'feasibility'];
  const questions = Object.fromEntries(Object.entries(LENS_TRIGGERS).map(([k, q]) => [k, noul(q)]));

  const body = await ask({ target: readText(target), mode }, questions);
  // Fire on >= t, but 0.4-0.6 is the model saying "your call" and the skill's own
  // rule is that adding a lens is the safer error — so the fence sits at 0.4 and
  // anything in that band is marked as borderline rather than silently dropped.
  const fired = Object.entries(body.answers).filter(([, a]) => a.noul >= t).map(([k]) => k);
  const repoRoot = flag('root', process.cwd());
  const repoFired = Object.entries(REPO_LENSES).filter(([, test]) => test(repoRoot)).map(([k]) => k);
  const out = { mode, always, repo: repoFired, triggered: fired, probabilities: Object.fromEntries(Object.entries(body.answers).map(([k, a]) => [k, a.noul])) };

  if (json) return console.log(JSON.stringify(out, null, 2));
  console.log(`mode ${mode}  ·  always: ${always.join(', ')}`);
  console.log(`  repo (checked, not judged): ${repoFired.join(', ') || 'none'}\n`);
  for (const [k, a] of Object.entries(body.answers)) {
    const mark = a.noul >= t ? '✓' : ' ';
    const band = a.noul >= 0.4 && a.noul < 0.6 ? '  ← borderline, adding it is the safer error' : '';
    console.log(`  ${mark} ${k.padEnd(14)} ${pct(a.noul).padStart(4)}${band}`);
  }
  console.log(`\n  lens set: ${[...always, ...repoFired, ...fired].join(', ')}`);
  logged('lenses', Object.entries(body.answers).map(([k, a]) => ({ p: a.noul, item: k })));
}

// ── dedupe ───────────────────────────────────────────────────────────────────
// Pairwise "same defect?" over findings. Batched into one call, but the pair
// count is quadratic — cap it rather than sending a 500-question request.
async function dedupe() {
  const findings = readJson(positional[0] ?? usage());
  // 14 was too low: a real three-lens review returned 18. 20 is 190 pairs,
  // still one call, and the warning fires rather than silently dropping any.
  const MAX = Number(flag('max', '20'));
  if (findings.length > MAX) {
    console.error(`${findings.length} findings; comparing the first ${MAX} (pairs grow quadratically)`);
  }
  const items = findings.slice(0, MAX);
  const pairs = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) pairs.push([i, j]);
  if (!pairs.length) return console.log('nothing to compare');

  const questions = Object.fromEntries(pairs.map(([i, j]) => [`p_${i}_${j}`, noul({
    a: items[i],
    b: items[j],
    question: 'Do `a` and `b` report the same underlying defect, such that fixing one fixes the other?',
  }, {
    true: 'The same defect, even if the two describe it in different words or point at different symptoms of it.',
    false: 'Different defects, even if they sit in the same file or were found by the same reviewer.',
  })]));

  const body = await ask({ findings: items }, questions);

  // Union-find over pairs above threshold: duplicates are transitive, and
  // reporting A~B and B~C as two separate pairs leaves the caller to merge.
  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const [i, j] of pairs) if (body.answers[`p_${i}_${j}`].noul >= t) parent[find(i)] = find(j);

  const groups = {};
  items.forEach((_, i) => (groups[find(i)] ??= []).push(i));
  const merged = Object.values(groups);

  if (json) return console.log(JSON.stringify({ groups: merged.map((g) => g.map((i) => items[i])) }, null, 2));
  console.log(`${items.length} findings → ${merged.length} distinct\n`);
  for (const g of merged) {
    const label = (x) => x.title ?? x.summary ?? JSON.stringify(x).slice(0, 70);
    console.log(`  • ${label(items[g[0]])}`);
    for (const i of g.slice(1)) console.log(`    ↳ duplicate: ${label(items[i])}`);
  }
}

// ── cite ─────────────────────────────────────────────────────────────────────
// The failure a document-level evidence score cannot see: a real quote that
// does not establish the claim drawn from it.
async function cite() {
  const records = readJson(positional[0] ?? usage());
  const questions = Object.fromEntries(records.map((r, i) => [`r${i}`, noul({
    record: r,
    question: 'Does the quoted evidence in `record` actually establish the claim `record` makes, on its own, without assuming anything not shown?',
  }, {
    true: 'The quote shows what the claim asserts; a reader could reach the same conclusion from the quote alone.',
    false: 'The quote is absent, is about something adjacent, or requires an inference the quote does not support — including a path cited without its contents.',
  })]));

  const body = await ask({ records }, questions);
  const rows = records.map((r, i) => ({ record: r, supported: body.answers[`r${i}`].noul }));
  if (json) return console.log(JSON.stringify(rows, null, 2));
  const weak = rows.filter((x) => x.supported < t);
  console.log(`${records.length} records · ${weak.length} unsupported\n`);
  for (const { record, supported } of rows) {
    const mark = supported >= t ? '✓' : '✗';
    console.log(`  ${mark} ${pct(supported).padStart(4)}  ${(record.claim ?? record.title ?? JSON.stringify(record)).slice(0, 88)}`);
  }
  logged('cite', rows.map((r, i) => ({ p: r.supported, item: String(i) })));
}

// ── learning ─────────────────────────────────────────────────────────────────
// wt-compound's own gate, asked of something other than the author.
async function learning() {
  const doc = readText(positional[0] ?? usage());
  const against = flagAll('against');
  if (!against.length) usage();

  const body = await ask(
    { learning: doc, existing_artifacts: against.map((p) => ({ path: p, content: readText(p) })) },
    {
      redundant: noul(
        'Is the reasoning in `learning` already recoverable from `existing_artifacts` — the code, its tests, the plan or the docs — by someone reading them without this learning?',
        {
          true: 'A competent reader of those artifacts would reach the same conclusion; the learning restates what they already show.',
          false: 'The reasoning is absent from those artifacts: they show what was done but not why, or the alternative that was rejected and the reason.',
        },
      ),
      findable: noul(
        'Does `learning` name the trigger situation in the words someone hitting that situation would search for?',
        {
          true: 'It leads with the situation and its vocabulary, so it surfaces for someone who does not know this learning exists.',
          false: 'It is written in the vocabulary of the moment it was learned; finding it requires already knowing it is there.',
        },
      ),
    },
  );
  const { redundant, findable } = body.answers;
  if (json) return console.log(JSON.stringify({ redundant: redundant.noul, findable: findable.noul }, null, 2));
  console.log(`  redundant  ${pct(redundant.noul).padStart(4)}  ${redundant.noul >= t ? '← already recoverable; consider not writing it' : 'carries reasoning the artifacts do not'}`);
  console.log(`  findable   ${pct(findable.noul).padStart(4)}  ${findable.noul >= t ? 'names its trigger situation' : '← reword around the trigger situation'}`);
}

// ── triage ───────────────────────────────────────────────────────────────────
async function triage() {
  const comments = readJson(positional[0] ?? usage());
  const questions = Object.fromEntries(comments.map((c, i) => [`c${i}`, noul({
    comment: c,
    question: 'Does `comment` ask for a change to the code, or for an answer the author must give, rather than being acknowledgement, praise, or discussion that needs no action?',
  }, {
    true: 'It requests a change, disputes a decision, or asks a question that blocks the reviewer from approving.',
    false: 'Acknowledgement, agreement, praise, a note for later, or a remark the author has already addressed.',
  })]));

  const body = await ask({ comments }, questions);
  const rows = comments.map((c, i) => ({ comment: c, actionable: body.answers[`c${i}`].noul }));
  if (json) return console.log(JSON.stringify(rows, null, 2));
  for (const { comment, actionable } of rows) {
    const mark = actionable >= t ? '→' : ' ';
    console.log(`  ${mark} ${pct(actionable).padStart(4)}  ${(comment.body ?? JSON.stringify(comment)).replace(/\s+/g, ' ').slice(0, 88)}`);
  }
  console.log(`\n  ${rows.filter((r) => r.actionable >= t).length} of ${rows.length} actionable`);
  logged('triage', rows.map((r, i) => ({ p: r.actionable, item: String(i) })));
}

async function ci() {
  const failure = readJson(positional[0] ?? usage());
  const body = await ask(failure, {
    cause: choice(
      'What is the most likely cause of this CI failure?',
      {
        our_change: 'The failure is produced by the change under review: the failing assertion or build error names code this branch touched.',
        flaky: 'The failure is non-deterministic — a timeout, a race, a network call, or a test that passes on retry with no change.',
        stale_base: 'The failure comes from the base branch having moved: the change is behind, or something merged into base broke it independently.',
        infrastructure: 'The runner, the network, a registry or a dependency install failed — the test suite never got a fair run.',
      },
    ),
  });
  const a = body.answers.cause;
  if (json) return console.log(JSON.stringify(a, null, 2));
  console.log(`  cause: ${a.choice}  (confidence ${a.confidence.toFixed(2)})`);
  for (const [k, p] of Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])) {
    console.log(`    ${k.padEnd(16)} ${pct(p).padStart(4)}`);
  }
}

// ── simplify ─────────────────────────────────────────────────────────────────
// Turns wt-simplify's stated constraint — behaviour must not change — into a
// checked one, per candidate.
async function simplify() {
  const candidates = readJson(positional[0] ?? usage());
  const questions = Object.fromEntries(candidates.map((c, i) => [`s${i}`, noul({
    candidate: c,
    question: 'Could `candidate` change observable behaviour — output, side effects, error cases, ordering, or timing — for any input the code can receive?',
  }, {
    true: 'Some input, including an edge case or an error path, would behave differently after this change.',
    false: 'Every input produces the same observable result; only the shape of the code differs.',
  })]));

  const body = await ask({ candidates }, questions);
  const rows = candidates.map((c, i) => ({ candidate: c, risk: body.answers[`s${i}`].noul }));
  if (json) return console.log(JSON.stringify(rows, null, 2));
  for (const { candidate, risk } of rows) {
    const mark = risk >= t ? '!' : '✓';
    console.log(`  ${mark} ${pct(risk).padStart(4)}  ${(candidate.description ?? JSON.stringify(candidate)).slice(0, 88)}`);
  }
  console.log(`\n  ${rows.filter((r) => r.risk >= t).length} of ${rows.length} may change behaviour — do not apply those blind`);
  console.log('  (the model floors near 0.6 on equivalent rewrites; read the number, not the mark)');
  logged('simplify', rows.map((r, i) => ({ p: r.risk, item: String(i) })));
}

// ── relevance ────────────────────────────────────────────────────────────────
// Reranking for wt-research: 40 grep candidates arrive, 6 matter, and reading
// the other 34 is most of what research costs.
//
// The asymmetry that shapes this. `attention` reorders a CLOSED set — the diff
// bounds it, so a bad ranking costs reading order and nothing else. Research's
// set is OPEN, and research's stated job is to sweep for what nobody named. A
// ranking that trims it is the most direct way to miss exactly that, with no
// complete set left to diff against afterwards and prove the miss.
//
// So this prints an ORDER, never a shorter list, and there is no threshold to
// cut on. Read down the order until the question is answered; when something
// near the bottom turns out to have mattered, mark it — that is the only
// evidence that could ever justify trimming.
const PREVIEW = 700;

async function relevance() {
  const raw = readJson(positional[0] ?? usage());
  const question = flag('question') ?? usage();
  const max = Number(flag('max', '60'));
  const root = flag('root', process.cwd());
  const rev = flag('rev');

  const items = raw.slice(0, max).map((c) => {
    const path = typeof c === 'string' ? c : (c.path ?? c.file);
    // A path alone is a weak signal and a whole file is the cost being avoided,
    // so: whatever the caller already has (a grep match), else the head.
    const excerpt = (typeof c === 'object' && (c.excerpt ?? c.text ?? c.match))
      ?? (fileAt(path, rev, root) ?? '').slice(0, PREVIEW);
    return { path, line: typeof c === 'object' ? c.line ?? null : null, excerpt };
  });
  if (!items.length) return console.log('no candidates');
  if (raw.length > max) console.error(`${raw.length} candidates; ranking the first ${max}`);

  const questions = Object.fromEntries(items.map((c, i) => [`c${i}`, noul({
    candidate: c,
    question: 'Would reading `candidate` in full bear on the research question — either by answering part of it, or by revealing something about it that nobody thought to ask?',
  }, {
    true: 'It is on the path of the question: it implements, calls, configures, tests or documents what the question is about, or it is the kind of place a surprise about it would hide.',
    false: 'Reading it in full would not bear on the question. Not merely "less central" — genuinely beside the point.',
  })]));

  const body = await ask({ research_question: question }, questions);
  const rows = items.map((c, i) => ({ ...c, p: body.answers[`c${i}`].noul }))
    .sort((a, b) => b.p - a.p);

  if (json) return console.log(JSON.stringify({ question, advisory: true, order: rows }, null, 2));

  console.log(`${rows.length} candidates · READING ORDER, not a shorter list\n`);
  rows.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. ${pct(r.p).padStart(4)}  ${r.path}${r.line ? `:${r.line}` : ''}`);
  });
  console.log('\n  Read down this order. Do not stop because the numbers got small: the set is open,');
  console.log('  and the thing nobody named is the thing a ranking is worst at seeing.');
  console.log('  When something near the bottom mattered, say so — that is the whole experiment:');
  logged('relevance', rows.map((r) => ({ p: r.p, item: `${r.path}${r.line ? `:${r.line}` : ''}` })));
}

// ── attention ────────────────────────────────────────────────────────────────
// The first judgment that steers a reviewer's reading rather than filtering its
// output, and therefore the first one that can fail INVISIBLY: a hunk ranked
// low is never read, and nothing logs the finding that was never made.
//
// So it ships advisory. It prints a ranking and the hunks it would have cut,
// and the skill says to read them anyway. The cut list is the experiment: when
// a confirmed finding comes out of a hunk this ranked at the bottom, that is a
// `mark <run>#<i> yes` on a judgment that said "skip", and the log finally has
// the ground truth it is starving for. Only once the bottom is measurably empty
// does this get to actually cut reading.
//
// FIRST RUN FALSIFIED IT, and the fix is why the two rules above exist. On PR
// #1083, lens `correctness`, the file holding the run's most serious confirmed
// defect — `arm()` awaiting a handshake with no timeout — scored 0.31 and
// landed in the cut list, while the hunk that merely CALLS it scored 0.78. Two
// causes, both fixed: a new file was judged as one inert hunk of "+" lines
// (now the whole file is fetched), and the question asked what was wrong IN the
// code, which no absence can answer (now it asks about absence explicitly).
// Same PR after both: 0.74, ranked second, kept. Spread stayed honest —
// 0.13-0.86 over 51 hunks, docs and .gitignore at the bottom.
//
// That is ONE recovered case, n=3 in the log. It stays advisory.
const LENS_FOCUS = {
  correctness: 'code that does not do what it says: wrong conditions, off-by-one, a branch that cannot be reached, a contract broken by its own implementation',
  regression: 'behaviour that existed before this change and may not survive it, including callers of anything whose signature or semantics moved',
  coherence: 'the target disagreeing with itself: two sections specifying different things, a count that does not match what is counted, a stale reference',
  feasibility: 'a step that cannot actually be performed as written, or depends on something that does not exist yet',
  standards: "the repo's own documented rules and conventions being broken",
  testing: 'guards that cannot fail, tests routed away from their fixtures, a claim of coverage the test does not deliver',
  learnings: "a trap the repo has already recorded a solution for, or a claim contradicting what its docs say",
  security: 'auth, credentials, secrets, user data, an exported surface, an input crossing a trust boundary',
  data: 'migrations, schema and data-shape changes, backfills, anything that can leave stored data wrong',
  scope: 'work beyond what the ticket asked for, and work the ticket asked for that is missing',
  adversarial: "the premise itself: whether the change solves a problem that exists, and what its docblocks and comments assert without proof",
};

// A hunk is the unit a reviewer actually reads. Anything bigger hides the thing
// being judged; anything smaller loses the context that makes it legible.
function hunks(diff, max, maxChars = 2400) {
  const out = [];
  let file = '(unknown)';
  let cur = null;
  let isNew = false;
  for (const line of diff.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) { file = f[1]; continue; }
    if (/^new file mode /.test(line)) { isNew = true; continue; }
    if (/^diff --git /.test(line)) { if (cur) out.push(cur); cur = null; isNew = false; continue; }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { if (cur) out.push(cur); cur = { file, line: Number(h[1]), text: '', whole_file: isNew }; continue; }
    if (cur) cur.text += line + '\n';
  }
  if (cur) out.push(cur);
  return out.filter((h) => h.text.trim())
    .map((h) => ({ ...h, text: h.text.slice(0, maxChars) }))
    .slice(0, max);
}

async function attention() {
  const target = positional[0] ?? usage();
  const lens = flag('lens') ?? usage();
  const focus = LENS_FOCUS[lens];
  if (!focus) {
    console.error(`unknown lens ${lens}; expected one of ${Object.keys(LENS_FOCUS).join(', ')}`);
    process.exit(2);
  }
  const max = Number(flag('max', '40'));
  const rev = flag('rev');
  const root = flag('root', process.cwd());
  // A new file arrives as one undifferentiated hunk of "+" lines, and judged on
  // that shape it reads as inert — which is how PR #1083's worst defect scored
  // 0.31. Hand the whole file instead: an absence is only visible against the
  // whole of what is there.
  const items = hunks(readText(target), max).map((h) => {
    if (!h.whole_file) return h;
    const full = fileAt(h.file, rev, root);
    return full ? { ...h, text: full.slice(0, 12000) } : h;
  });
  if (!items.length) return console.log('no hunks to rank');

  const questions = Object.fromEntries(items.map((h, i) => [`h${i}`, noul({
    hunk: h,
    lens,
    looks_for: focus,
    question: 'Would a reviewer carrying this lens find something by reading `hunk` closely — either something wrong that is PRESENT, or something necessary that is ABSENT?',
  }, {
    true: 'A defect of that kind could be here. Count an absence as much as a presence: a missing timeout, guard, check, cleanup, error path or test is exactly this kind of finding, and code that looks orderly can still be missing one. Code that other code depends on for the property this lens is about also counts.',
    false: 'Nothing this lens looks for could be here or missing from here — it is the wrong kind of change entirely, not merely a tidy one.',
  })]));

  const body = await ask({ lens, looks_for: focus }, questions);
  const rows = items.map((h, i) => ({ ...h, p: body.answers[`h${i}`].noul }))
    .sort((a, b) => b.p - a.p);

  if (json) return console.log(JSON.stringify({ lens, advisory: true, hunks: rows }, null, 2));

  const keep = rows.filter((r) => r.p >= t);
  const cut = rows.filter((r) => r.p < t);
  console.log(`lens ${lens} · ${items.length} hunks · ADVISORY, this does not decide what you read\n`);
  for (const r of keep) console.log(`  ${pct(r.p).padStart(4)}  ${r.file}:${r.line}`);
  if (cut.length) {
    console.log(`\n  would have cut ${cut.length}:`);
    for (const r of cut) console.log(`  ${pct(r.p).padStart(4)}  ${r.file}:${r.line}`);
    console.log('\n  READ THESE ANYWAY. A finding out of one of them is the point of running this:');
    console.log('  mark it yes and the ranking is falsified on the record.');
    console.log('  Measured: on PR #1083 this once cut the file holding that run\'s worst defect.');
  }
  logged('attention', rows.map((r) => ({ p: r.p, item: `${r.file}:${r.line}` })));
}

// ── verify ───────────────────────────────────────────────────────────────────
// The one judgment that reads the TREE rather than the paperwork. `cite` asks
// whether a quote supports its claim; this asks whether the claim is TRUE of
// the code, by fetching the file itself and handing the model both.
//
// Measured need: on a real three-lens review, eight load-bearing findings went
// out unverified and two were plainly false against the file they named — an
// "exported receiver with no sender check" on a module whose manifest is empty,
// and a "typo ships green" on a string a test pins. Neither survives seeing the
// file, and neither reviewer had read it.
//
// Three outcomes, not two: "unverifiable" is a real answer, and collapsing it
// into refuted throws away findings whose evidence is outside the repo (an SDK
// return type, a runtime behaviour) — exactly the ones worth a human minute.
const WINDOW = 120;        // lines of context around a cited line
const MAX_CHARS = 12000;   // per file, so one call stays one call

function fileAt(path, rev, root) {
  if (!path) return null;
  try {
    return rev
      ? execFileSync('git', ['-C', root, 'show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 26 })
      : readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

function window(text, line) {
  if (!text) return null;
  const lines = text.split('\n');
  const number = (from, take) => lines.slice(from, from + take)
    .map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`).join('\n').slice(0, MAX_CHARS);
  // No line cited — a related file, usually — means the whole file up to the cap.
  // Windowing it to the head is how a test that refutes the finding on line 180
  // gets cut off and the model agrees with the finding instead: measured.
  if (!line) return number(0, lines.length);
  return number(Math.max(0, line - 1 - WINDOW / 2), WINDOW);
}

async function verify() {
  const findings = readJson(positional[0] ?? usage());
  const rev = flag('rev');
  const root = flag('root', process.cwd());

  // A finding's refutation often lives somewhere other than the file it cites —
  // "a typo here ships green" is answered by the test that pins the string, not
  // by the string. Reviewers list those in `related`; without them the verdict
  // is honestly "unverifiable" rather than a guess.
  const evidence = findings.map((f) => {
    const path = f.file ?? f.path ?? null;
    const text = fileAt(path, rev, root);
    const related = (f.related ?? []).map((p) => ({ path: p, excerpt: window(fileAt(p, rev, root), null) }))
      .filter((r) => r.excerpt !== null);
    return { path, found: text !== null, excerpt: window(text, Number(f.line) || null), related };
  });

  const questions = Object.fromEntries(findings.map((f, i) => [`f${i}`, choice({
    finding: f,
    cited_file: evidence[i].path ?? '(the finding names no file)',
    file_contents: evidence[i].found ? evidence[i].excerpt : '(the cited file does not exist at this revision)',
    related_files: evidence[i].related.length ? evidence[i].related : '(none supplied)',
    question: 'Judge `finding` against `file_contents`, which is the real content of the file it cites.',
  }, {
    confirmed: 'The file shows the defect the finding describes. What it claims is there is there, and the failure it predicts follows from it.',
    refuted: 'The file contradicts the finding: the code it describes is not what is there, a guard it says is missing is present, or the defect cannot occur as described.',
    unverifiable: 'The file neither shows nor contradicts it — the answer depends on something outside this file: a dependency\'s behaviour, a runtime value, a build output, or a file that was not supplied. A guard the finding says is missing may exist in a file nobody handed you — say unverifiable, never refuted, on evidence you were not given.',
  })]));

  const body = await ask({ findings, evidence: evidence.map(({ path, found }) => ({ path, found })) }, questions);

  const rows = findings.map((f, i) => {
    const a = body.answers[`f${i}`];
    return { finding: f, verdict: a.choice, confidence: a.confidence, probabilities: a.probabilities,
             file_read: evidence[i].found };
  });

  if (json) return console.log(JSON.stringify(rows, null, 2));

  const MARKS = { confirmed: '✓', refuted: '✗', unverifiable: '?' };
  const label = (f) => (f.title ?? f.summary ?? JSON.stringify(f)).replace(/\s+/g, ' ').slice(0, 76);
  for (const r of rows) {
    console.log(`  ${MARKS[r.verdict]} ${r.verdict.padEnd(13)} ${pct(r.probabilities[r.verdict]).padStart(4)}  ${label(r.finding)}`);
    if (!r.file_read) console.log(`    ${''.padEnd(18)}(cited file not read — verdict is from the finding's own words only)`);
  }
  const n = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n  ${n('confirmed')} confirmed · ${n('refuted')} refuted · ${n('unverifiable')} needs a human`);
  console.log('  Refuted findings go back to the lens that raised them. Do not drop them silently:');
  console.log('  a lens that produces refuted findings is the finding worth keeping.');

  // Logged on P(confirmed), so `mark <run>#<i> yes` means "this really was a
  // defect" — an outcome that arrives when someone fixes it, not from a re-read.
  logged('verify', rows.map((r, i) => ({ p: r.probabilities.confirmed, item: String(i) })));
}

// ── mark ─────────────────────────────────────────────────────────────────────
// Attach what actually happened to a logged judgment. Rewrites the line in
// place; the log stays append-mostly and small enough that rewriting is fine.
function mark() {
  const pairs = positional;
  if (pairs.length < 2) usage();
  const log = readLog();
  let n = 0;
  for (let k = 0; k < pairs.length; k += 2) {
    const [run, i] = pairs[k].split('#');
    const label = pairs[k + 1];
    if (!['yes', 'no'].includes(label)) usage();
    const row = log.find((e) => e.run === run && String(e.i) === i);
    if (!row) { console.error(`no judgment ${pairs[k]}`); continue; }
    row.label = label === 'yes';
    n++;
  }
  writeFileSync(LOG, log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`${n} marked`);
}

// ── calibrate ────────────────────────────────────────────────────────────────
// What the labelled outcomes say about the threshold. Brier score measures
// calibration (how well probabilities match reality); the sweep measures the
// decision (where to cut). They are different questions and both matter: a
// well-calibrated model can still be cut in the wrong place.
function calibrate() {
  const only = positional[0];
  const apply = argv.includes('--apply');
  const labelled = readLog().filter((e) => e.label !== undefined && (!only || e.cmd === only));
  if (!labelled.length) {
    console.log('no labelled judgments yet — run some, then: wt-judge.mjs mark <run>#<i> yes|no');
    console.log(`log: ${LOG}`);
    return;
  }

  const byCmd = {};
  for (const e of labelled) (byCmd[e.cmd] ??= []).push(e);
  const out = {};

  for (const [c, rows] of Object.entries(byCmd)) {
    const brier = rows.reduce((a, e) => a + (e.p - (e.label ? 1 : 0)) ** 2, 0) / rows.length;
    // A false positive and a false negative are not equally bad, and which is
    // worse is a property of the command, not of the data.
    const fpCost = { dedupe: 3, simplify: 1, lenses: 1 }[c] ?? 1;   // dedupe: a false merge loses a finding
    const fnCost = { dedupe: 1, simplify: 3, lenses: 2 }[c] ?? 1;   // simplify: a missed behaviour change ships
    let best = null;
    for (let th = 0.05; th <= 0.96; th += 0.05) {
      const fp = rows.filter((e) => e.p >= th && !e.label).length;
      const fn = rows.filter((e) => e.p < th && e.label).length;
      const cost = fp * fpCost + fn * fnCost;
      if (!best || cost < best.cost) best = { th: Math.round(th * 100) / 100, fp, fn, cost };
    }
    const current = LEARNED[c]?.t ?? DEFAULT_T[c] ?? 0.5;
    out[c] = { n: rows.length, brier: Math.round(brier * 1000) / 1000, current, ...best };
  }

  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    for (const [c, r] of Object.entries(out)) {
      console.log(`  ${c.padEnd(10)} n=${String(r.n).padEnd(4)} brier ${r.brier.toFixed(3)}  current ${r.current}  suggests ${r.th}  (fp ${r.fp} / fn ${r.fn})`);
    }
    console.log('\n  brier: 0 is perfect, 0.25 is a coin flip. Under ~20 samples per command, treat both numbers as noise.');
  }

  if (!apply) return;
  // A threshold moved on five samples is superstition, not calibration.
  const eligible = Object.entries(out).filter(([, r]) => r.n >= 20);
  const thin = Object.entries(out).filter(([, r]) => r.n < 20).map(([c, r]) => `${c} (n=${r.n})`);
  if (thin.length) console.log(`  not applied, too few samples: ${thin.join(', ')}`);
  if (!eligible.length) return;
  const next = { ...LEARNED };
  for (const [c, r] of eligible) next[c] = { t: r.th, n: r.n, brier: r.brier, at: new Date().toISOString() };
  writeFileSync(THRESHOLDS, JSON.stringify(next, null, 2) + '\n');
  console.log(`  applied: ${eligible.map(([c, r]) => `${c} → ${r.th}`).join(', ')}`);
  console.log(`  ${THRESHOLDS}`);
}

const COMMANDS = { lenses, dedupe, cite, learning, triage, ci, simplify, relevance, attention, verify, mark, calibrate };
if (!COMMANDS[cmd]) usage();
// mark and calibrate read the local log; they need no API key and must work
// on a machine that never had one.
if (!['mark', 'calibrate'].includes(cmd)) requireKey();
await COMMANDS[cmd]();

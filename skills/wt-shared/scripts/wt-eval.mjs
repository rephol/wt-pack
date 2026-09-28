#!/usr/bin/env node
// Score a wt-* pack document against the dimensions the pack keeps failing on.
//
//   wt-eval.mjs <file> [--type plan|research|review|learning] [--json]
//
// Report only; thresholds are not baked in — read the scores on your own
// documents first, then decide what a bar should be. Judgments come from
// TypeSafe's System One API, one call per document: independent questions over
// the same state run in parallel there.
//
// Exit codes are the contract for callers, because this is OPTIONAL:
//   0  scored
//   1  the run failed (API error, unreadable file) — worth reporting
//   2  usage error
//   3  no API key configured — SKIP SILENTLY, this tool is not set up here
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveKeyed } from './typesafe.mjs';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

// Score levels describe concrete situations rather than grades, so the selected
// level is itself the finding — the API returns no rationale to print.
const EVIDENCE = {
  type: 'score',
  instructions:
    'How well are this document\'s factual claims about the codebase backed by evidence quoted from the real tree, rather than asserted from memory?',
  criteria: [
      'Claims about the code are asserted with no quoted evidence: file contents, symbol names and behaviour are stated as known.',
      'A few claims carry quoted evidence; most load-bearing ones do not, or cite a path without showing what is in it.',
      'Load-bearing claims quote evidence, but some quotes do not actually establish the claim made from them.',
      'Every claim the work depends on quotes evidence from the tree that establishes it, and uncertainty is stated where evidence was unavailable.',
  ],
};

const DOD = {
  type: 'score',
  instructions:
    'Could an evaluator reading ONLY a transcript of the work — with no ability to run commands or read files — decide whether this document\'s Definition of Done has been met?',
  criteria: [
      'No Definition of Done, or one stated as an intention ("the feature works") with nothing observable.',
      'Criteria exist but are judged from outside the transcript: they need someone to inspect the tree or the running system.',
      'Most criteria name observable outcomes; at least one still needs outside inspection.',
      'Every criterion names an outcome the work itself would surface — a command and its result, a stated check, an explicit count.',
  ],
};

const SCOPE = {
  type: 'noul',
  instructions:
    'Does this document commit to work beyond what the ticket or request it cites actually asked for?',
  criteria: {
    true: 'It adds refactors, abstractions, renames, extra features or cleanups that the cited request does not call for and does not need.',
    false: 'Everything it commits to follows from the cited request, including work that is genuinely required to make that request land safely.',
  },
};

const UNITS = {
  type: 'score',
  instructions:
    'Are this plan\'s units of work independently implementable and committable in the order given?',
  criteria: [
      'Units are not separable: they describe one change split arbitrarily, or a later unit must be written before an earlier one compiles or passes.',
      'Units are separable in principle but carry undeclared dependencies on each other, so the stated order breaks partway through.',
      'Units are ordered correctly and mostly independent; one or two share state that the plan does not call out.',
      'Each unit stands on its own, declares what it depends on, and leaves the tree in a committable state.',
  ],
};

const ACTIONABLE = {
  type: 'score',
  instructions:
    'Are these review findings specific enough to act on without re-deriving the reviewer\'s reasoning?',
  criteria: [
      'Findings restate concerns in general terms ("consider error handling") with no location and no failure they would cause.',
      'Findings name a location but not what is wrong with it, or name a problem but not where it is.',
      'Most findings give location and defect; some lack the concrete failure that makes them worth fixing.',
      'Each finding names the location, the defect, and the failure it produces, so the fix follows from the finding.',
  ],
};

const FINDABLE = {
  type: 'score',
  instructions:
    'Would an agent working on a related problem later actually retrieve this learning, given the words it uses?',
  criteria: [
      'It is written in the vocabulary of the moment it was learned — searching for the problem it solves would not surface it.',
      'It names its subject but uses terms a future reader would be unlikely to search for.',
      'Findable by someone already looking for it; the trigger situation is implied rather than named.',
      'It names the trigger situation in the words someone hitting that situation would use, so it surfaces unprompted.',
  ],
};

// Not every dimension applies to every artifact: unit decomposition is a plan
// property, actionability a review property. Asking a question the document
// cannot answer returns a confident low score that means nothing.
const SETS = {
  plan: { evidence: EVIDENCE, definition_of_done: DOD, out_of_scope: SCOPE, unit_decomposition: UNITS },
  research: { evidence: EVIDENCE, out_of_scope: SCOPE },
  review: { evidence: EVIDENCE, actionable: ACTIONABLE },
  learning: { evidence: EVIDENCE, findable: FINDABLE },
};

function detectType(path, text) {
  const n = basename(path).toLowerCase();
  if (/research|findings/.test(n)) return 'research';
  if (/review/.test(n)) return 'review';
  if (/learning|compound/.test(n)) return 'learning';
  if (/plan/.test(n)) return 'plan';
  // Fall back to content: a plan is the only one that carries a Definition of Done.
  if (/definition of done/i.test(text)) return 'plan';
  return 'plan';
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const typeFlag = args.includes('--type') ? args[args.indexOf('--type') + 1] : null;
const file = args.find((a) => !a.startsWith('--') && a !== typeFlag);

if (!file) {
  console.error('usage: wt-eval.mjs <file> [--type plan|research|review|learning] [--json]');
  process.exit(2);
}
const { key, source: keySource } = resolveKeyed();
if (!key) {
  console.error('TYPESAFE_API_KEY is not set, and no TYPESAFE_API_KEY line in ~/.claude/.env');
  process.exit(3);
}

const text = readFileSync(file, 'utf8');
const type = typeFlag ?? detectType(file, text);
const questions = SETS[type];
if (!questions) {
  console.error(`unknown --type ${type}; expected one of ${Object.keys(SETS).join(', ')}`);
  process.exit(2);
}

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  // The document is the state; every question judges the same state.
  body: JSON.stringify({ state: { document: text, kind: type }, model: MODEL, questions }),
});

if (!res.ok) {
  const authNote = res.status === 401 || res.status === 403 ? ` (key from ${keySource})` : '';
  console.error(`TypeSafe ${res.status}${authNote}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const body = await res.json();

if (json) {
  console.log(JSON.stringify({ file, type, ...body }, null, 2));
  process.exit(0);
}

console.log(`${basename(file)}  (${type})\n`);
for (const [id, a] of Object.entries(body.answers)) {
  if (a.type === 'noul') {
    // A noul near 0.5 is genuine ambiguity between yes and no, not a middling
    // amount of the thing — so say which side it leans and how far.
    const pct = Math.round(a.noul * 100);
    console.log(`  ${id.padEnd(20)} ${pct}% yes`);
  } else {
    // Print the nearest level's text: the description IS the finding.
    const nearest = String(Math.round(a.score));
    console.log(`  ${id.padEnd(20)} ${a.score.toFixed(2)}/${Object.keys(a.legend).length - 1}  (confidence ${a.confidence.toFixed(2)})`);
    console.log(`  ${''.padEnd(20)} ${a.legend[nearest]}`);
  }
  console.log('');
}
console.log(`  model ${body.model}  ·  ${body.usage.input_tokens} in / ${body.usage.output_tokens} out`);

// Jev judgments for wt-memory, shared by the CLI (remember), the Claude plugin hook and jev-eval.mjs.
// Everything here is optional: loadTypesafe() returns null when the pack's typesafe.mjs is not found.
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// WT_TYPESAFE_MODULE (tests: a stub judge) › the pack next to this file › the linked pack under ~/.claude/skills.
export async function loadTypesafe() {
  const here = dirname(realpathSync(fileURLToPath(import.meta.url)))
  const f = [process.env.WT_TYPESAFE_MODULE, join(here, '..', '..', 'wt-shared', 'scripts', 'typesafe.mjs'),
    join(homedir(), '.claude', 'skills', 'wt-shared', 'scripts', 'typesafe.mjs')].find((p) => p && existsSync(p))
  try { return f ? await import(pathToFileURL(f).href) : null } catch { return null }
}

// remember: one batched call, one choice per existing entry (the newest 40).
export const memoryDup = {
  questions: ({ note, existing }) => Object.fromEntries(existing.map((e, i) => [`e${i}`, { type: 'choice',
    instructions: `Compare the new note with this existing memory entry: "${e}". Is the new note a duplicate of it, in conflict with it, or unrelated?`,
    criteria: { duplicate: 'Same instruction or preference, possibly worded differently.', conflicts: 'They give contradicting instructions for the same situation.', unrelated: 'Different topics, or compatible instructions.' } }])),
  decide: (a) => Object.keys(a ?? {}).sort((x, y) => x.slice(1) - y.slice(1)).map((k) => a[k]?.choice ?? 'unrelated'),
}

// UserPromptSubmit: is this prompt a standing preference worth remembering?
export const memorySuggest = {
  questions: () => ({ standing: { type: 'noul', instructions: 'Is this message a standing preference or recurring correction (something that should apply from now on), rather than a one-off task instruction?',
    criteria: { true: 'It states how things should always/never be done, or corrects a recurring behaviour.', false: 'It asks for one task or one change, or is a question.' } } }),
  decide: (a, min = 0.8) => (a?.standing?.noul ?? 0) >= min,
}

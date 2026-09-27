// WP-122: where a sibling skill's file lives. Under the root wt-pack plugin (and the ./setup symlinks) the skills sit
// three levels up from this file (skills/wt-memory/claude-plugin/hooks → skills/); the standalone wt-memory plugin's
// cache copy has no siblings, so it falls back to the ./setup link under ~/.claude/skills.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function skillPath(rel, from = import.meta.url) {
  const sib = fileURLToPath(new URL(`../../../${rel}`, from))
  return existsSync(sib) ? sib : join(homedir(), '.claude', 'skills', rel)
}

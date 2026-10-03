// The wt-mods plugin's one hooks module (hooks.json allows a single entry): the /wt command and per-request model
// routing. The plugin sits inside the skills dir (linked by ./setup), so the other skills are its siblings.
import type { Register } from 'claude-code'
import { registerCommands } from './commands'
import { registerRouting } from './routing'

const skills = (root: string) => `${root}/..`

export const register: Register = on => {
  registerCommands(on, skills)
  registerRouting(on, skills)
}

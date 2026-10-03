// The root plugin's (wt-pack@wt-pack, plugin-only install) hooks module: the same mods as skills/wt-mods, which a
// full ./setup install loads as a skills-dir plugin. Here the skills live at `<root>/skills`.
import type { Register } from 'claude-code'
import { registerCommands } from '../skills/wt-mods/hooks/commands'
import { registerRouting } from '../skills/wt-mods/hooks/routing'

const skills = (root: string) => `${root}/skills`

export const register: Register = on => {
  registerCommands(on, skills)
  registerRouting(on, skills)
}

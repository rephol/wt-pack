// WP-378: test helper around fake-hc/hc. installFakeHc({cases}) -> {dir, env, calls(), cleanup()}; put `env` (or just
// PATH) in front of the code under test and it calls the fake instead of the real hc. See fake-hc/hc for the case syntax.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHIM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fake-hc')

export function installFakeHc({ cases = {}, env: extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hc-'))
  const log = join(dir, 'calls.jsonl')
  const env = { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH}`, HC_BIN: join(SHIM_DIR, 'hc'), FAKE_HC_CASES: JSON.stringify(cases), FAKE_HC_LOG: log, FAKE_HC_STATE: dir, ...extra }
  // children of a test must not act as an agent terminal (CLAUDE.md: strip HC_* from the child env)
  for (const k of Object.keys(env)) if (/^(HC_(TERMINAL_ID|SCOPE|TERMINAL_SOCKET|SESSION)|HERDR_)/.test(k) && !(k in extra)) delete env[k]
  env.HC_BIN = join(SHIM_DIR, 'hc')
  return {
    dir, env,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

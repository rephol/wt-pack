// Sessions page (WP-228): Claude Code sessions from ~/.claude/projects, pins shared with `ccsessions freeze`
// (~/.claude/ccsessions-frozen.json, { [id]: { note, at, proj } }). Rows use ccsessions --json's field names.
import { readdir, readFile, open, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'

export const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
// `<repo>-<role>-NN` (a pool name) → role; anything else → null.
export const roleFromAgent = (name) => /^[a-z0-9_]+(?:-[a-z0-9_]+)*-([a-z][a-z0-9]*)-\d+$/.exec(name ?? '')?.[1] ?? null

const userText = (m) => {
  const c = m?.content
  return typeof c === 'string' ? c : Array.isArray(c) ? c.find((p) => p?.type === 'text')?.text ?? '' : ''
}

// First 64 KB of a transcript → { cwd, started, tldr }. A cut-off last line simply fails to parse.
export function parseHead(text) {
  const out = { cwd: null, started: null, tldr: '' }
  for (const line of text.split('\n')) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    out.cwd ??= j.cwd ?? null
    out.started ??= j.timestamp ?? null
    if (!out.tldr && j.type === 'user' && !j.isSidechain) {
      const t = userText(j.message).trim()
      if (t && !t.startsWith('<command-') && !t.startsWith('<local-command')) out.tldr = t.replace(/\s+/g, ' ').slice(0, 200)
    }
    if (out.cwd && out.started && out.tldr) break
  }
  return out
}

// Newest `limit` transcripts by mtime. ponytail: newest-500 cap; paging when someone needs older.
export async function listBuiltin(projectsDir, limit = 500) {
  const files = []
  for (const d of await readdir(projectsDir).catch(() => [])) {
    for (const f of await readdir(join(projectsDir, d)).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(projectsDir, d, f)
      const s = await stat(p).catch(() => null)
      if (s?.isFile()) files.push({ p, id: f.slice(0, -6), mtime: s.mtimeMs / 1000 })
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return Promise.all(files.slice(0, limit).map(async ({ p, id, mtime }) => {
    const fh = await open(p).catch(() => null)
    const buf = Buffer.alloc(65536)
    const n = fh ? (await fh.read(buf, 0, buf.length, 0).catch(() => ({ bytesRead: 0 }))).bytesRead : 0
    await fh?.close()
    const h = parseHead(buf.toString('utf8', 0, n))
    return { id, cwd: h.cwd, proj: h.cwd ? basename(h.cwd) : '', tldr: h.tldr, doing: '', mtime, started: h.started, live: false, frozen: false, closed: false, agent: null }
  }))
}

export const readPins = async (file) => JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) ?? {}
// pin = { note?, proj? } to set, null to remove; other entries are kept.
export async function writePin(file, id, pin) {
  const all = await readPins(file)
  if (pin) all[id] = { note: pin.note ?? '', at: new Date().toISOString(), proj: pin.proj ?? '' }
  else delete all[id]
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(all, null, 1))
}

// Pins and live agents onto rows; pinned first, then newest.
export const overlay = (rows, pins, liveIds) =>
  rows.map((r) => ({ ...r, frozen: r.id in pins, note: pins[r.id]?.note ?? '', live: r.live || liveIds.has(r.id) }))
    .sort((a, b) => b.frozen - a.frozen || b.mtime - a.mtime)

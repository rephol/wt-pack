// WP-369: line tags in wt-memory entries (`[role: a, b]` / `[project: c]`), as `wt-memory list --json` reports them.
export type EntryTags = { role?: string[]; project?: string[] }
export type EntryLite = { scope: string; name: string | null; by: string; at: string; pending?: boolean; tags?: EntryTags }

/** "for a, b" / "in project c" for the tags an entry carries; '' when untagged. */
export function tagsLabel(tags?: EntryTags): string {
  const parts: string[] = []
  if (tags?.role?.length) parts.push(`for ${tags.role.join(', ')}`)
  if (tags?.project?.length) parts.push(`in project ${tags.project.join(', ')}`)
  return parts.join(' · ')
}

/** The supporting line under a remembered entry: where it is stored, its tags, who wrote it and when. */
export function entryLine(e: EntryLite): string {
  const where = e.pending ? 'global' : e.name ? `${e.scope} ${e.name}` : e.scope
  return [where, tagsLabel(e.tags), e.by, e.at].filter(Boolean).join(' · ')
}

export const TAG_HINT = 'Start a line with [role: id] or [project: name] to send it only to those agents.'

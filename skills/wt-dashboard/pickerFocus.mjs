// WP-378 D6: which tab of an AskUserQuestion picker is focused. the old multiplexer drew it in ANSI (the focused tab is highlighted); `hc read` is plain
// text, where the tab bar is identical on every tab and only the question under it changes (spike S2). So the dashboard tracks it:
//  - a picker seen for the first time starts at its first unanswered tab (tab 0 for a new one; `pk.current` from the plain parse); the tabs'
//    headers are its signature (a different bar = a different picker)
//  - every frame teaches "tab i asks <question>"; a frame showing a question already learned for tab j IS tab j (the screen wins, which also
//    discards a stale frame read right after a key press); a question never seen before is the focused tab, or the next one when the focused tab
//    already has its own question (we moved forward and the redraw landed)
//  - the keys the dashboard presses move the belief: left/right by one (clamped); the review step is tab n
export class PickerFocus {
  #by = new Map() // pane -> { sig, n, idx, q: [] }
  // pk: parsePickerText() output for this pane's screen, or null. Returns the focused tab index (or null when there is no tab bar).
  read(pane, pk) {
    if (!pk || !pk.tabs?.length) { this.#by.delete(pane); return null }
    const sig = pk.tabs.map((t) => t.header).join('\u0001'), n = pk.tabs.length
    let s = this.#by.get(pane)
    if (!s || s.sig !== sig) { s = { sig, n, idx: Number.isInteger(pk.current) ? pk.current : 0, q: [] }; this.#by.set(pane, s) }
    if (pk.review) { s.idx = n; return n }
    const j = s.q.indexOf(pk.question)
    if (j >= 0) s.idx = j
    else if (s.q[s.idx] === undefined) s.q[s.idx] = pk.question
    else { s.idx = Math.min(s.idx + 1, n - 1); s.q[s.idx] = pk.question }
    return s.idx
  }
  // keys the dashboard pressed on this pane, in hc key names
  keys(pane, keys) {
    const s = this.#by.get(pane)
    if (!s) return
    for (const k of keys) {
      if (k === 'left') s.idx = Math.max(0, s.idx - 1)
      else if (k === 'right') s.idx = Math.min(s.n, s.idx + 1)
    }
  }
  clear(pane) { this.#by.delete(pane) }
}

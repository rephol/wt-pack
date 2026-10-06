// WP-271: what a grouped phone notification shows. Pure, shared by sw.js (importScripts) and push-summary.test.mjs.
// `prev` = the `data` of the notification already shown under the same tag (the category), or null; `d` = the push payload
// {title, body, cat, kind, url}. Returns the notification's {title, body, data}; data carries n, kinds and the newest names.
(function (root) {
  const LABEL = { 'needs-you': (n) => `${n} need you`, agents: (n) => `${n} agent updates`, system: (n) => `${n} system alerts` }
  function pushSummary(prev, d) {
    if (!prev || !d.cat) return { title: d.title, body: d.body || '', data: { url: d.url, cat: d.cat, kind: d.kind, n: 1, kinds: [d.kind], names: [d.title] } }
    const n = (prev.n || 1) + 1
    const kinds = [...new Set([d.kind, ...(prev.kinds || [])])]
    const names = [d.title, ...(prev.names || [])].slice(0, 3)
    const title = kinds.length === 1 && d.kind === 'agent-done' ? `${n} agents done` : (LABEL[d.cat] || ((k) => `${k} notifications`))(n)
    return { title, body: names.join('\n'), data: { url: `/#inbox/${d.cat}`, cat: d.cat, kind: d.kind, n, kinds, names } }
  }
  root.pushSummary = pushSummary
})(self)

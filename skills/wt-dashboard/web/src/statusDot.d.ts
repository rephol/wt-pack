// WP-277: a violet 'working' StatusDot variant (colours in index.css) so working is not blue next to the green done dot.
import '@astryxdesign/core/StatusDot'
declare module '@astryxdesign/core/StatusDot' {
  interface StatusDotVariantMap { working: true }
}

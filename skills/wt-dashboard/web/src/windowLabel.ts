// WP-166: one window per project. Only the primary window ('main', or a plain browser tab) relays the tray and
// notifications to Rust; every window would otherwise post its own copy of each notification.
type Meta = { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }
export const windowLabel = (w: object = window): string | undefined => (w as Meta).__TAURI_INTERNALS__?.metadata?.currentWindow?.label
export const isPrimaryWindow = (w: object = window): boolean => (windowLabel(w) ?? 'main') === 'main'

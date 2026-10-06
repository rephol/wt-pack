// WP-268: what "Phone notifications" can do on this device, as a pure function of the environment (tested in
// pushState.test.ts). Order matters: iOS only exposes Web Push to an installed PWA, and only over https.
export type PushState = 'install' | 'insecure' | 'unsupported' | 'denied' | 'off' | 'on'
export interface PushEnv { ios: boolean; standalone: boolean; secure: boolean; supported: boolean; permission: NotificationPermission | 'none'; subscribed: boolean }

export function pushState(e: PushEnv): PushState {
  if (e.ios && !e.standalone) return 'install'
  if (!e.secure) return 'insecure'
  if (!e.supported) return 'unsupported'
  if (e.permission === 'denied') return 'denied'
  return e.subscribed ? 'on' : 'off'
}

export const PUSH_HINT: Record<PushState, string> = {
  install: 'iPhone and iPad only allow push for an installed app: in Safari tap Share → Add to Home Screen, then open the dashboard from the home screen and come back here.',
  insecure: 'Push needs https: open the dashboard through its https address (for example the Tailscale HTTPS URL) or on 127.0.0.1. See the docs for reaching it from a phone.',
  unsupported: 'This browser does not support Web Push.',
  denied: 'Notifications are blocked for this site: allow them in the browser or system settings, then reload.',
  off: 'Not enabled on this device.',
  on: 'Enabled on this device.',
}

// A short name for a device list, from the user agent.
export const deviceLabel = (ua: string) => /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac browser' : /Windows/.test(ua) ? 'Windows browser' : 'Browser'

// applicationServerKey wants bytes; the server hands out the VAPID public key as base64url.
export function keyBytes(b64url: string): Uint8Array {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '='))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

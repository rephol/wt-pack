// Routine form (WP-54): schedule presets ⇄ the server's schedule string ('every 30m' or 5-field cron).
export type Preset = 'every 15m' | 'every 30m' | 'every 1h' | 'daily' | 'weekly' | 'custom'
export type Sched = { preset: Preset; time: string; dow: string; cron: string }

const pad = (n: string) => n.padStart(2, '0')

export function fromSchedule(s: string): Sched {
  const base = { time: '09:00', dow: '1', cron: s }
  if (s === 'every 15m' || s === 'every 30m' || s === 'every 1h') return { ...base, preset: s }
  const m = s.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/)
  if (m && +m[1] < 60 && +m[2] < 24) return { ...base, time: `${pad(m[2])}:${pad(m[1])}`, dow: m[3] === '*' ? '1' : m[3], preset: m[3] === '*' ? 'daily' : 'weekly' }
  return { ...base, preset: 'custom' }
}

export function toSchedule(x: Sched): string {
  if (x.preset === 'custom') return x.cron.trim()
  if (x.preset !== 'daily' && x.preset !== 'weekly') return x.preset
  const [h, m] = x.time.split(':').map(Number)
  return `${m} ${h} * * ${x.preset === 'daily' ? '*' : x.dow}`
}

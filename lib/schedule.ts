import * as SunCalc from 'suncalc'

export type WindowKey = 'early' | 'morning' | 'midday' | 'late'

export const TIME_WINDOWS: { key: WindowKey; label: string; startHour: number; endHour: number | 'sunset' }[] = [
  { key: 'early', label: 'Early', startHour: 6, endHour: 9 },
  { key: 'morning', label: 'Morning', startHour: 9, endHour: 12 },
  { key: 'midday', label: 'Afternoon', startHour: 12, endHour: 15 },
  { key: 'late', label: 'Twilight', startHour: 15, endHour: 'sunset' },
]

/** Minimum overlap with a chosen slot for a course to count as "open" then. */
const MIN_OPEN_MS = 60 * 60 * 1000

export interface Slot {
  start: Date
  end: Date
}

export type CourseFit =
  | { status: 'open'; hoursLabel: string | null }
  | { status: 'closed'; hoursLabel: string | null }
  | { status: 'unknown' }

/** yyyy-mm-dd in the browser's local time zone. */
export function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function parseIsoDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function upcomingDays(count = 7): string[] {
  const today = new Date()
  return Array.from({ length: count }, (_, i) => isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)))
}

export function sunTimes(day: string, lat: number, lon: number): { sunrise: Date; sunset: Date } {
  const noon = parseIsoDay(day)
  noon.setHours(12)
  const t = SunCalc.getTimes(noon, lat, lon)
  // Polar day/night has no sunrise or sunset; fall back to a normal golf day.
  return { sunrise: t.sunrise ?? at(day, 6), sunset: t.sunset ?? at(day, 20) }
}

export function at(day: string, hour: number): Date {
  const d = parseIsoDay(day)
  d.setHours(hour)
  return d
}

/**
 * Build the concrete time slots the golfer picked. No days picked means "any of
 * the next 7 days"; no windows picked means "any daylight hour". Slots that end
 * up entirely after dark are dropped.
 */
export function buildSlots(days: string[], windows: WindowKey[], lat: number, lon: number): Slot[] {
  const dayList = days.length > 0 ? days : upcomingDays()
  const windowList = TIME_WINDOWS.filter((w) => windows.length === 0 || windows.includes(w.key))
  const slots: Slot[] = []
  for (const day of dayList) {
    const { sunrise, sunset } = sunTimes(day, lat, lon)
    if (windows.length === 0) {
      slots.push({ start: sunrise, end: sunset })
      continue
    }
    for (const w of windowList) {
      const start = at(day, w.startHour)
      const end = w.endHour === 'sunset' ? sunset : at(day, w.endHour)
      const clippedEnd = end > sunset ? sunset : end
      if (clippedEnd.getTime() - start.getTime() >= MIN_OPEN_MS / 2) slots.push({ start, end: clippedEnd })
    }
  }
  return slots
}

export function formatHour(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined }).replace(':00', '').replace(' ', '').toLowerCase()
}

export function dayLabel(day: string, style: 'short' | 'long' = 'short'): string {
  const d = parseIsoDay(day)
  const today = isoDay(new Date())
  const tomorrow = isoDay(new Date(Date.now() + 86_400_000))
  if (style === 'short') {
    if (day === today) return 'Today'
    if (day === tomorrow) return 'Tmrw'
    return d.toLocaleDateString([], { weekday: 'short' })
  }
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

export function formatTime(d: Date): string {
  return formatHour(d)
}

// Loaded on demand: the opening_hours parser (with holiday data) is large.
import OpeningHours from 'opening_hours'
import type { Course } from './courses'
import { formatHour, parseIsoDay, sunTimes, type CourseFit, type Slot } from './schedule'

/** Minimum overlap with a chosen slot for a course to count as "open" then. */
const MIN_OPEN_MS = 60 * 60 * 1000

const hoursCache = new Map<string, OpeningHours | null>()

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The parser assumes 06:00/18:00 for sunrise/sunset. Swap in the real times for
 * this location (they move only a few minutes across the 7-day search window).
 */
function withSunTimes(raw: string, day: string, lat: number, lon: number): string {
  if (!/sunrise|sunset|dawn|dusk/i.test(raw)) return raw
  const { sunrise, sunset } = sunTimes(day, lat, lon)
  return raw
    .replace(/\(?\s*(sunrise|dawn)\s*([+-]\s*\d{1,2}:\d{2})?\s*\)?/gi, hhmm(sunrise))
    .replace(/\(?\s*(sunset|dusk)\s*([+-]\s*\d{1,2}:\d{2})?\s*\)?/gi, hhmm(sunset))
}

function parseHours(raw: string, day: string, lat: number, lon: number): OpeningHours | null {
  const resolved = withSunTimes(raw, day, lat, lon)
  if (hoursCache.has(resolved)) return hoursCache.get(resolved)!
  let parsed: OpeningHours | null = null
  try {
    parsed = new OpeningHours(resolved, { lat, lon, address: { country_code: '', state: '' } } as never)
  } catch {
    parsed = null
  }
  hoursCache.set(resolved, parsed)
  return parsed
}

/** "6am–8pm" for the course's hours on a given day, or "Closed". */
function hoursOn(oh: OpeningHours, day: string): string {
  const start = parseIsoDay(day)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
  const intervals = oh.getOpenIntervals(start, end)
  if (intervals.length === 0) return 'Closed'
  const first = intervals[0][0]
  const last = intervals[intervals.length - 1][1]
  if (last.getTime() - first.getTime() >= 24 * 3600 * 1000 - 60_000) return 'Open 24h'
  return `${formatHour(first)}–${formatHour(last)}`
}

export function courseFit(course: Course, slots: Slot[], labelDay: string): CourseFit {
  if (!course.openingHours) return { status: 'unknown' }
  const oh = parseHours(course.openingHours, labelDay, course.lat, course.lon)
  if (!oh) return { status: 'unknown' }
  let hoursLabel: string | null = null
  try {
    hoursLabel = hoursOn(oh, labelDay)
    const open = slots.some((slot) => {
      const [openMs] = oh.getOpenDuration(slot.start, slot.end)
      const slotMs = slot.end.getTime() - slot.start.getTime()
      return openMs >= Math.min(MIN_OPEN_MS, slotMs)
    })
    return { status: open ? 'open' : 'closed', hoursLabel }
  } catch {
    return { status: 'unknown' }
  }
}


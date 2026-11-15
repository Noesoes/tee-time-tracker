export interface Course {
  id: string
  name: string
  lat: number
  lon: number
  distanceMiles: number
  address: string | null
  website: string | null
  phone: string | null
  openingHours: string | null
  access: CourseAccess
  holes: number | null
  searchUrl: string
  directionsUrl: string
}

export type CourseAccess = 'public' | 'private' | 'unknown'

export interface GeocodeResult {
  lat: number
  lon: number
  displayName: string
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
// Each mirror gets this long before we give up on it.
const OVERPASS_TIMEOUT_MS = 9_000
// Give up on Overpass entirely (and fall back to Nominatim) after this long.
const OVERPASS_DEADLINE_MS = 9_000
// Start the next mirror if the previous one hasn't answered within this window.
const OVERPASS_STAGGER_MS = 1_500
const CACHE_TTL_MS = 5 * 60 * 1000

const courseCache = new Map<string, { expiresAt: number; courses: Course[] }>()

export class LocationNotFoundError extends Error {}

export async function geocodeLocation(query: string): Promise<GeocodeResult> {
  const url = new URL(NOMINATIM_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Geocoding request failed with status ${res.status}`)
  }

  const results = (await res.json()) as Array<{
    lat: string
    lon: string
    display_name: string
  }>

  if (results.length === 0) {
    throw new LocationNotFoundError(`No location found for "${query}"`)
  }

  return {
    lat: parseFloat(results[0].lat),
    lon: parseFloat(results[0].lon),
    displayName: results[0].display_name,
  }
}

export async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lon))
  url.searchParams.set('format', 'json')

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Reverse geocoding request failed with status ${res.status}`)
  }

  const result = (await res.json()) as { display_name?: string; error?: string }

  return {
    lat,
    lon,
    displayName: result.display_name ?? 'your location',
  }
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8 // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function buildAddress(tags: Record<string, string>): string | null {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'],
    tags['addr:state'],
    tags['addr:postcode'],
  ].filter((part) => part && part.length > 0)
  return parts.length > 0 ? parts.join(', ') : null
}

function normalizeWebsite(raw: string | undefined): string | null {
  if (!raw) return null
  const value = raw.split(';')[0].trim()
  if (!value) return null
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    const url = new URL(withScheme)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function parseAccess(tags: Record<string, string>): CourseAccess {
  const access = (tags.access ?? tags['golf:access'] ?? '').toLowerCase()
  if (['private', 'members', 'no', 'customers'].includes(access)) return 'private'
  if (['yes', 'public', 'permissive'].includes(access)) return 'public'
  if (tags.fee === 'yes') return 'public'
  return 'unknown'
}

function parseHoles(tags: Record<string, string>): number | null {
  const raw = tags.holes ?? tags['golf:course'] ?? tags['golf:holes'] ?? ''
  const match = raw.match(/\d+/)
  if (!match) return null
  const holes = parseInt(match[0], 10)
  return holes > 0 && holes <= 72 ? holes : null
}

function buildSearchUrl(name: string, address: string | null): string {
  const query = [name, address, 'tee times'].filter(Boolean).join(' ')
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

interface BBox {
  south: number
  west: number
  north: number
  east: number
}

function boundingBox(lat: number, lon: number, radiusMiles: number): BBox {
  const dLat = radiusMiles / 69.0
  const dLon = radiusMiles / (69.0 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01))
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon }
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, outer: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  outer.addEventListener('abort', onOuterAbort)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer)
    outer.removeEventListener('abort', onOuterAbort)
  })
}

/**
 * Query the Overpass mirrors, staggered so a slow or overloaded mirror can't
 * stall the search: the first one to answer wins and the rest are cancelled.
 */
async function fetchOverpass(box: BBox): Promise<OverpassElement[]> {
  const query = `[out:json][timeout:20];nwr["leisure"="golf_course"](${box.south},${box.west},${box.north},${box.east});out center tags qt;`
  const body = `data=${encodeURIComponent(query)}`
  const done = new AbortController()

  const attempts = OVERPASS_URLS.map(async (url, i) => {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, i * OVERPASS_STAGGER_MS))
      if (done.signal.aborted) throw new Error('cancelled')
    }
    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      OVERPASS_TIMEOUT_MS,
      done.signal
    )
    if (!res.ok) throw new Error(`Overpass ${url} returned ${res.status}`)
    const json = (await res.json()) as { elements?: OverpassElement[]; remark?: string }
    // Overpass reports server-side timeouts as a 200 with a remark and no data.
    if (!json.elements || (json.elements.length === 0 && json.remark)) {
      throw new Error(`Overpass ${url}: ${json.remark ?? 'no data'}`)
    }
    return json.elements
  })

  const deadline = setTimeout(() => done.abort(), OVERPASS_DEADLINE_MS)
  try {
    return await Promise.any(attempts)
  } finally {
    clearTimeout(deadline)
    done.abort()
  }
}

/** Fallback when every Overpass mirror is down: Nominatim's POI search. */
async function fetchNominatimCourses(box: BBox): Promise<OverpassElement[]> {
  const url = new URL(NOMINATIM_URL)
  url.searchParams.set('q', 'golf course')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('viewbox', `${box.west},${box.north},${box.east},${box.south}`)
  url.searchParams.set('bounded', '1')
  url.searchParams.set('limit', '40')
  url.searchParams.set('extratags', '1')
  url.searchParams.set('addressdetails', '1')

  const res = await fetchWithTimeout(url.href, {}, 15_000, new AbortController().signal)
  if (!res.ok) throw new Error(`Nominatim course search failed with status ${res.status}`)
  const results = (await res.json()) as Array<{
    osm_type: 'node' | 'way' | 'relation'
    osm_id: number
    lat: string
    lon: string
    name?: string
    category?: string
    type?: string
    extratags?: Record<string, string>
    address?: Record<string, string>
  }>

  return results
    .filter((r) => r.name && (r.type === 'golf_course' || /golf/i.test(r.name)))
    .map((r) => ({
      type: r.osm_type,
      id: r.osm_id,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      tags: {
        name: r.name!,
        ...(r.extratags ?? {}),
        ...(r.address?.road ? { 'addr:street': r.address.road } : {}),
        ...(r.address?.house_number ? { 'addr:housenumber': r.address.house_number } : {}),
        ...(r.address?.city || r.address?.town || r.address?.village
          ? { 'addr:city': (r.address.city ?? r.address.town ?? r.address.village)! }
          : {}),
        ...(r.address?.state ? { 'addr:state': r.address.state } : {}),
        ...(r.address?.postcode ? { 'addr:postcode': r.address.postcode } : {}),
      },
    }))
}

export async function findNearbyCourses(
  origin: GeocodeResult,
  radiusMiles: number
): Promise<Course[]> {
  const cacheKey = `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)},${radiusMiles}`
  const cached = courseCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.courses
  }

  const box = boundingBox(origin.lat, origin.lon, radiusMiles)
  const elements = await fetchOverpass(box).catch(() => fetchNominatimCourses(box))
  const data = { elements }

  const courses: Course[] = data.elements
    .filter((el) => el.tags?.name)
    .map((el) => {
      const lat = el.lat ?? el.center?.lat
      const lon = el.lon ?? el.center?.lon
      if (lat === undefined || lon === undefined) return null

      const tags = el.tags ?? {}
      const name = tags.name!
      const address = buildAddress(tags)
      const website = normalizeWebsite(tags.website ?? tags['contact:website'])
      const phone = (tags.phone ?? tags['contact:phone'] ?? '').split(';')[0].trim() || null

      const course: Course = {
        id: `${el.type}/${el.id}`,
        name,
        lat,
        lon,
        distanceMiles: haversineMiles(origin.lat, origin.lon, lat, lon),
        address,
        website,
        phone,
        openingHours: tags.opening_hours?.trim() || null,
        access: parseAccess(tags),
        holes: parseHoles(tags),
        searchUrl: buildSearchUrl(name, address),
        directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`,
      }
      return course
    })
    .filter((c): c is Course => c !== null && c.distanceMiles <= radiusMiles)
    .filter((c, i, all) => all.findIndex((o) => o.name === c.name && Math.abs(o.distanceMiles - c.distanceMiles) < 0.5) === i)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)

  courseCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, courses })

  return courses
}

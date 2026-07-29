export interface Course {
  id: string
  name: string
  lat: number
  lon: number
  distanceMiles: number
  address: string | null
  website: string | null
  searchUrl: string
}

export interface GeocodeResult {
  lat: number
  lon: number
  displayName: string
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
]
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

function buildSearchUrl(name: string, address: string | null): string {
  const query = [name, address, 'tee times'].filter(Boolean).join(' ')
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
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

  const radiusMeters = Math.round(radiusMiles * 1609.34)
  const query = `[out:json][timeout:25];nwr["leisure"="golf_course"](around:${radiusMeters},${origin.lat},${origin.lon});out center tags;`

  let data: { elements: OverpassElement[] } | null = null
  let lastStatus = 0
  for (const url of OVERPASS_URLS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `data=${encodeURIComponent(query)}`,
    })
    if (res.ok) {
      data = (await res.json()) as { elements: OverpassElement[] }
      break
    }
    lastStatus = res.status
  }

  if (!data) {
    throw new Error(`Overpass request failed with status ${lastStatus}`)
  }

  const courses: Course[] = data.elements
    .filter((el) => el.tags?.name)
    .map((el) => {
      const lat = el.lat ?? el.center?.lat
      const lon = el.lon ?? el.center?.lon
      if (lat === undefined || lon === undefined) return null

      const tags = el.tags ?? {}
      const name = tags.name!
      const address = buildAddress(tags)
      const website = tags.website ?? tags['contact:website'] ?? null

      const course: Course = {
        id: `${el.type}/${el.id}`,
        name,
        lat,
        lon,
        distanceMiles: haversineMiles(origin.lat, origin.lon, lat, lon),
        address,
        website,
        searchUrl: buildSearchUrl(name, address),
      }
      return course
    })
    .filter((c): c is Course => c !== null)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)

  courseCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, courses })

  return courses
}

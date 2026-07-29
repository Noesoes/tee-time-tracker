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
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const USER_AGENT = 'tee-time-tracker/0.1 (contact: noahfonoimoana@gmail.com)'

export class LocationNotFoundError extends Error {}

export async function geocodeLocation(query: string): Promise<GeocodeResult> {
  const url = new URL(NOMINATIM_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })
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
  const radiusMeters = Math.round(radiusMiles * 1609.34)
  const query = `[out:json][timeout:25];nwr["leisure"="golf_course"](around:${radiusMeters},${origin.lat},${origin.lon});out center tags;`

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
  })

  if (!res.ok) {
    throw new Error(`Overpass request failed with status ${res.status}`)
  }

  const data = (await res.json()) as { elements: OverpassElement[] }

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

  return courses
}

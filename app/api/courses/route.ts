import { type NextRequest } from 'next/server'
import {
  findNearbyCourses,
  geocodeLocation,
  reverseGeocode,
  LocationNotFoundError,
} from '@/lib/courses'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const location = searchParams.get('location')?.trim()
  const latParam = searchParams.get('lat')
  const lonParam = searchParams.get('lon')
  const radiusParam = searchParams.get('radius')
  const radiusMiles = radiusParam ? parseFloat(radiusParam) : 15

  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0 || radiusMiles > 100) {
    return Response.json({ error: 'Radius must be between 1 and 100 miles' }, { status: 400 })
  }

  try {
    let origin
    if (latParam && lonParam) {
      const lat = parseFloat(latParam)
      const lon = parseFloat(lonParam)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return Response.json({ error: 'Invalid lat/lon' }, { status: 400 })
      }
      origin = await reverseGeocode(lat, lon)
    } else if (location) {
      origin = await geocodeLocation(location)
    } else {
      return Response.json(
        { error: 'Provide either "location" or "lat" and "lon" query parameters' },
        { status: 400 }
      )
    }

    const courses = await findNearbyCourses(origin, radiusMiles)
    return Response.json({ origin, courses })
  } catch (err) {
    if (err instanceof LocationNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 })
    }
    console.error(err)
    return Response.json({ error: 'Failed to fetch nearby courses' }, { status: 502 })
  }
}

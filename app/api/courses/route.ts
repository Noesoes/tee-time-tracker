import { type NextRequest } from 'next/server'
import { findNearbyCourses, geocodeLocation, LocationNotFoundError } from '@/lib/courses'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const location = searchParams.get('location')?.trim()
  const radiusParam = searchParams.get('radius')
  const radiusMiles = radiusParam ? parseFloat(radiusParam) : 15

  if (!location) {
    return Response.json({ error: 'Missing "location" query parameter' }, { status: 400 })
  }
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0 || radiusMiles > 100) {
    return Response.json({ error: 'Radius must be between 1 and 100 miles' }, { status: 400 })
  }

  try {
    const origin = await geocodeLocation(location)
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

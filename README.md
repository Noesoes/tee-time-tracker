# Tee Time Tracker

Finds golf courses near a given location and links out to each course's own
website so you can book directly. Built with Next.js.

## How it works

1. `lib/courses.ts` geocodes the location you enter using
   [Nominatim](https://nominatim.org/) (OpenStreetMap), then queries the
   [Overpass API](https://overpass-api.de/) for `leisure=golf_course` points
   within the chosen radius.
2. `app/api/courses/route.ts` exposes that as `GET /api/courses?location=...&radius=...`.
3. `app/page.tsx` is the search UI: enter a location, pick a radius, and get
   a distance-sorted list of nearby courses. Each result links to the
   course's website when OpenStreetMap has one on file, or falls back to a
   Google search for the course's booking page.

This is a directory/link-out tool, not a live tee-time availability
aggregator — actual bookable time slots live behind several competing
platforms (GolfNow, ForeUp, Chronogolf, EZLinks, custom course sites) with
no unified public API.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and search a city, zip,
or address.

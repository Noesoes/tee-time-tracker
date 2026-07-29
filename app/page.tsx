"use client";

import { useState, type FormEvent } from "react";
import type { Course, GeocodeResult } from "@/lib/courses";

interface ApiResponse {
  origin?: GeocodeResult;
  courses?: Course[];
  error?: string;
}

const RADIUS_OPTIONS = [5, 10, 15, 25, 50];

export default function Home() {
  const [location, setLocation] = useState("");
  const [radius, setRadius] = useState(15);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<GeocodeResult | null>(null);
  const [courses, setCourses] = useState<Course[] | null>(null);

  async function runSearch(params: URLSearchParams) {
    setLoading(true);
    setError(null);
    setCourses(null);

    try {
      params.set("radius", String(radius));
      const res = await fetch(`/api/courses?${params.toString()}`);
      const data: ApiResponse = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        return;
      }

      setOrigin(data.origin ?? null);
      setCourses(data.courses ?? []);
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!location.trim()) return;
    await runSearch(new URLSearchParams({ location }));
  }

  function handleUseLocation() {
    if (!navigator.geolocation) {
      setError("Geolocation isn't supported by this browser.");
      return;
    }

    setLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        setLocation("");
        await runSearch(
          new URLSearchParams({
            lat: String(position.coords.latitude),
            lon: String(position.coords.longitude),
          })
        );
      },
      () => {
        setLoading(false);
        setError("Couldn't get your location. Check your browser's location permission.");
      },
      { timeout: 10000 }
    );
  }

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-2xl flex-col gap-8 px-6 py-16">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Tee Time Tracker
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Find golf courses near you and jump straight to their booking site.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="City, address, or zip code"
            className="flex-1 rounded-md border border-zinc-300 bg-white px-4 py-2 text-black placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <select
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          >
            {RADIUS_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r} mi
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-zinc-900 px-5 py-2 font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-black dark:hover:bg-zinc-300"
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </form>

        <button
          type="button"
          onClick={handleUseLocation}
          disabled={loading}
          className="self-start text-sm font-medium text-zinc-600 underline underline-offset-2 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Use my current location
        </button>

        {error && (
          <p className="rounded-md bg-red-50 px-4 py-3 text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {origin && courses && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Showing courses within {radius} miles of {origin.displayName}
          </p>
        )}

        {courses && courses.length === 0 && (
          <p className="text-zinc-600 dark:text-zinc-400">
            No golf courses found in that radius. Try a larger search radius.
          </p>
        )}

        {courses && courses.length > 0 && (
          <ul className="flex flex-col gap-3">
            {courses.map((course) => (
              <li
                key={course.id}
                className="flex items-center justify-between gap-4 rounded-md border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex flex-col">
                  <span className="font-medium text-black dark:text-zinc-50">
                    {course.name}
                  </span>
                  {course.address && (
                    <span className="text-sm text-zinc-500 dark:text-zinc-400">
                      {course.address}
                    </span>
                  )}
                  <span className="text-sm text-zinc-500 dark:text-zinc-400">
                    {course.distanceMiles.toFixed(1)} mi away
                  </span>
                </div>
                <a
                  href={course.website ?? course.searchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-black hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-800"
                >
                  {course.website ? "Book" : "Find booking site"}
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

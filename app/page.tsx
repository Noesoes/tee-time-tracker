"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  findNearbyCourses,
  geocodeLocation,
  reverseGeocode,
  LocationNotFoundError,
  type Course,
  type GeocodeResult,
} from "@/lib/courses";
import {
  TIME_WINDOWS,
  buildSlots,
  dayLabel,
  formatTime,
  isoDay,
  parseIsoDay,
  sunTimes,
  upcomingDays,
  type CourseFit,
  type WindowKey,
} from "@/lib/schedule";

const CourseMap = dynamic(() => import("@/components/CourseMap"), {
  ssr: false,
  loading: () => <div className="skeleton h-full w-full" />,
});

const MIN_RADIUS = 1;
const MAX_RADIUS = 50;
const DEFAULT_RADIUS = 15;
const RADIUS_PRESETS = [5, 10, 25, 50];

type SortKey = "distance" | "name";

function shortName(displayName: string): string {
  return displayName.split(",").slice(0, 2).join(",").trim();
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<GeocodeResult | null>(null);
  const [fetched, setFetched] = useState<{ courses: Course[]; radius: number } | null>(null);
  const [hidePrivate, setHidePrivate] = useState(false);
  const [sort, setSort] = useState<SortKey>("distance");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [days, setDays] = useState<string[]>([]);
  const [windows, setWindows] = useState<WindowKey[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [dayOptions, setDayOptions] = useState<string[]>([]);
  const [hoursLib, setHoursLib] = useState<typeof import("@/lib/hours") | null>(null);

  // The opening-hours parser is large, so fetch it after first paint.
  useEffect(() => {
    let cancelled = false;
    import("@/lib/hours").then((mod) => {
      if (!cancelled) setHoursLib(mod);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestRef = useRef(0);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  // Day chips depend on "today", so compute them on the client only.
  useEffect(() => {
    const t = setTimeout(() => setDayOptions(upcomingDays()), 0);
    return () => clearTimeout(t);
  }, []);

  function syncWhenToUrl(nextDays: string[], nextWindows: WindowKey[]) {
    const params = new URLSearchParams(window.location.search);
    if (nextDays.length) params.set("d", nextDays.join(","));
    else params.delete("d");
    if (nextWindows.length) params.set("t", nextWindows.join(","));
    else params.delete("t");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }

  function toggleDay(day: string) {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
    setDays(next);
    syncWhenToUrl(next, windows);
  }

  function toggleWindow(key: WindowKey) {
    const next = windows.includes(key)
      ? windows.filter((w) => w !== key)
      : TIME_WINDOWS.map((w) => w.key).filter((k) => k === key || windows.includes(k));
    setWindows(next);
    syncWhenToUrl(days, next);
  }

  function clearWhen() {
    setDays([]);
    setWindows([]);
    syncWhenToUrl([], []);
  }

  const loadCourses = useCallback(async (at: GeocodeResult, radiusMiles: number) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const courses = await findNearbyCourses(at, radiusMiles);
      if (requestId !== requestRef.current) return;
      setFetched({ courses, radius: radiusMiles });
    } catch {
      if (requestId !== requestRef.current) return;
      setError("Couldn't load courses right now. The map data service may be busy — try again in a moment.");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  const runSearch = useCallback(
    async (getOrigin: () => Promise<GeocodeResult>, radiusMiles: number) => {
      const requestId = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const at = await getOrigin();
        if (requestId !== requestRef.current) return;
        setOrigin(at);
        setFetched(null);
        setActiveId(null);
        setQuery(shortName(at.displayName));
        const params = new URLSearchParams({
          lat: at.lat.toFixed(5),
          lon: at.lon.toFixed(5),
          r: String(radiusMiles),
          q: shortName(at.displayName),
        });
        const current = new URLSearchParams(window.location.search);
        for (const key of ["d", "t"]) {
          const value = current.get(key);
          if (value) params.set(key, value);
        }
        window.history.replaceState(null, "", `?${params}`);
        await loadCourses(at, radiusMiles);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setLoading(false);
        setError(
          err instanceof LocationNotFoundError
            ? "We couldn't find that place. Try a city, zip code, or full address."
            : "Something went wrong looking up that location. Please try again."
        );
      }
    },
    [loadCourses]
  );

  // Restore a search from the URL (shareable links / refresh).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const today = isoDay(new Date());
    const savedDays = (params.get("d") ?? "")
      .split(",")
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today);
    const validWindows = TIME_WINDOWS.map((w) => w.key) as string[];
    const savedWindows = (params.get("t") ?? "").split(",").filter((w) => validWindows.includes(w)) as WindowKey[];
    const restoreWhen = setTimeout(() => {
      if (savedDays.length) setDays(savedDays);
      if (savedWindows.length) setWindows(savedWindows);
    }, 0);
    const lat = parseFloat(params.get("lat") ?? "");
    const lon = parseFloat(params.get("lon") ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return () => clearTimeout(restoreWhen);
    const r = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, parseInt(params.get("r") ?? "", 10) || DEFAULT_RADIUS));
    const displayName = params.get("q") || "Selected location";
    const timer = setTimeout(() => {
      setRadius(r);
      runSearch(async () => ({ lat, lon, displayName }), r);
    }, 0);
    return () => {
      clearTimeout(timer);
      clearTimeout(restoreWhen);
    };
  }, [runSearch]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    runSearch(() => geocodeLocation(query.trim()), radius);
  }

  function handleUseLocation() {
    if (!navigator.geolocation) {
      setError("Geolocation isn't supported by this browser.");
      return;
    }
    setLoading(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        runSearch(() => reverseGeocode(latitude, longitude), radius);
      },
      () => {
        setLoading(false);
        setError("Couldn't get your location. Check your browser's location permission.");
      },
      { timeout: 10000 }
    );
  }

  function handleRadiusChange(next: number) {
    setRadius(next);
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    if (!origin) return;
    const params = new URLSearchParams(window.location.search);
    params.set("r", String(next));
    window.history.replaceState(null, "", `?${params}`);
    // Shrinking the radius just filters what we already have; growing it needs more data.
    if (fetched && next <= fetched.radius) return;
    refetchTimer.current = setTimeout(() => loadCourses(origin, next), 450);
  }

  const handlePickLocation = useCallback(
    (lat: number, lon: number) => {
      setPicking(false);
      runSearch(
        () => reverseGeocode(lat, lon).catch(() => ({ lat, lon, displayName: "Dropped pin" })),
        radius
      );
    },
    [runSearch, radius]
  );

  const handleSelect = useCallback((id: string) => {
    setActiveId(id);
    cardRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const inRadius = useMemo(
    () => (fetched ? fetched.courses.filter((c) => c.distanceMiles <= radius) : []),
    [fetched, radius]
  );
  const whenActive = days.length > 0 || windows.length > 0;
  const labelDay = days[0] ?? dayOptions[0] ?? null;
  const fits = useMemo(() => {
    const map = new Map<string, CourseFit>();
    if (!origin || !labelDay || !hoursLib) return map;
    const slots = buildSlots(days, windows, origin.lat, origin.lon);
    for (const c of inRadius) map.set(c.id, hoursLib.courseFit(c, slots, labelDay));
    return map;
  }, [inRadius, days, windows, origin, labelDay, hoursLib]);
  const closedCount = whenActive ? inRadius.filter((c) => fits.get(c.id)?.status === "closed").length : 0;
  const unknownCount = whenActive ? inRadius.filter((c) => (fits.get(c.id)?.status ?? "unknown") === "unknown").length : 0;

  const privateCount = useMemo(() => inRadius.filter((c) => c.access === "private").length, [inRadius]);
  const visible = useMemo(() => {
    const list = inRadius.filter((c) => {
      if (hidePrivate && c.access === "private") return false;
      if (!whenActive) return true;
      const status = fits.get(c.id)?.status ?? "unknown";
      if (status === "closed" && !showClosed) return false;
      if (status === "unknown" && confirmedOnly) return false;
      return true;
    });
    return sort === "name" ? [...list].sort((a, b) => a.name.localeCompare(b.name)) : list;
  }, [inRadius, hidePrivate, sort, whenActive, fits, showClosed, confirmedOnly]);

  const fill = ((radius - MIN_RADIUS) / (MAX_RADIUS - MIN_RADIUS)) * 100;
  const hasSearched = origin !== null;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="relative overflow-hidden bg-fairway-900 text-cream">
        <div
          aria-hidden
          className="absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(60% 120% at 85% 0%, #2f7d4a 0%, transparent 60%), radial-gradient(40% 90% at 10% 100%, #1a4d2c 0%, transparent 70%)",
          }}
        />
        <div className="relative mx-auto flex w-full max-w-[1500px] items-center gap-3 px-5 py-4 sm:px-8">
          <FlagIcon className="h-8 w-8 shrink-0 text-fairway-300" />
          <div>
            <h1 className="font-display text-2xl font-semibold leading-none tracking-tight">Tee Time Tracker</h1>
            <p className="mt-1 text-sm text-fairway-100/80">Every course around you, one tap from booking.</p>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col lg:min-h-0 lg:flex-row">
        {/* Search + results */}
        <section className="flex w-full flex-col lg:min-h-0 lg:w-[460px] lg:shrink-0 xl:w-[500px]">
          <div className="border-b border-sand bg-white/70 px-5 py-5 backdrop-blur sm:px-8">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label htmlFor="location" className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
                  Location
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <PinIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                    <input
                      id="location"
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="City, address, or zip code"
                      autoComplete="off"
                      className="w-full rounded-xl border border-sand bg-white py-3 pl-9 pr-3 text-ink shadow-sm placeholder:text-muted/60 focus:border-fairway-500 focus:outline-none focus:ring-4 focus:ring-fairway-500/15"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleUseLocation}
                    disabled={loading}
                    title="Use my current location"
                    aria-label="Use my current location"
                    className="grid w-12 shrink-0 place-items-center rounded-xl border border-sand bg-white text-fairway-600 shadow-sm transition hover:border-fairway-300 hover:bg-fairway-50 disabled:opacity-50"
                  >
                    <CrosshairIcon className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-baseline justify-between">
                  <label htmlFor="radius" className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Search radius
                  </label>
                  <span className="font-display text-xl font-semibold tabular-nums text-fairway-700">
                    {radius} <span className="text-sm font-medium text-muted">mi</span>
                  </span>
                </div>
                <input
                  id="radius"
                  type="range"
                  min={MIN_RADIUS}
                  max={MAX_RADIUS}
                  value={radius}
                  onChange={(e) => handleRadiusChange(Number(e.target.value))}
                  className="radius-slider w-full"
                  style={{ "--fill": `${fill}%` } as React.CSSProperties}
                />
                <div className="mt-3 flex gap-2">
                  {RADIUS_PRESETS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => handleRadiusChange(r)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                        radius === r
                          ? "bg-fairway-600 text-white"
                          : "bg-fairway-50 text-fairway-700 hover:bg-fairway-100"
                      }`}
                    >
                      {r} mi
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">When</span>
                  {whenActive ? (
                    <button type="button" onClick={clearWhen} className="text-xs font-medium text-fairway-600 hover:underline">
                      Any time
                    </button>
                  ) : (
                    <span className="text-xs text-muted">Any day · any time</span>
                  )}
                </div>
                <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Days">
                  {dayOptions.map((day) => {
                    const on = days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(day)}
                        aria-pressed={on}
                        className={`flex min-w-[3.25rem] shrink-0 flex-col items-center rounded-xl border px-2 py-1.5 transition ${
                          on
                            ? "border-fairway-600 bg-fairway-600 text-white shadow-sm"
                            : "border-sand bg-white text-ink hover:border-fairway-300"
                        }`}
                      >
                        <span className={`text-[11px] font-medium ${on ? "text-fairway-100" : "text-muted"}`}>
                          {dayLabel(day)}
                        </span>
                        <span className="font-display text-lg font-semibold leading-tight">{parseIsoDay(day).getDate()}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 grid grid-cols-4 gap-1.5" role="group" aria-label="Times of day">
                  {TIME_WINDOWS.map((w) => {
                    const on = windows.includes(w.key);
                    const sunset =
                      w.endHour === "sunset" && origin && labelDay ? sunTimes(labelDay, origin.lat, origin.lon).sunset : null;
                    const range =
                      w.endHour === "sunset"
                        ? `3pm–${sunset ? formatTime(sunset) : "dusk"}`
                        : `${formatTime(new Date(2000, 0, 1, w.startHour))}–${formatTime(new Date(2000, 0, 1, w.endHour))}`;
                    return (
                      <button
                        key={w.key}
                        type="button"
                        onClick={() => toggleWindow(w.key)}
                        aria-pressed={on}
                        className={`flex flex-col items-center rounded-xl border px-1 py-1.5 transition ${
                          on
                            ? "border-fairway-600 bg-fairway-600 text-white shadow-sm"
                            : "border-sand bg-white text-ink hover:border-fairway-300"
                        }`}
                      >
                        <span className="text-xs font-semibold">{w.label}</span>
                        <span className={`text-[10px] tabular-nums ${on ? "text-fairway-100" : "text-muted"}`}>{range}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="flex items-center justify-center gap-2 rounded-xl bg-fairway-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-fairway-700 focus:outline-none focus:ring-4 focus:ring-fairway-500/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Spinner /> Searching…
                  </>
                ) : (
                  "Find courses"
                )}
              </button>
            </form>
          </div>

          <div className="flex-1 px-5 py-5 sm:px-8 lg:min-h-0 lg:overflow-y-auto">
            {error && (
              <p role="alert" className="mb-4 rounded-xl border border-flag/20 bg-flag/10 px-4 py-3 text-sm text-flag">
                {error}
              </p>
            )}

            {!hasSearched && !loading && !error && (
              <div className="flex flex-col items-center px-4 py-12 text-center">
                <div className="grid h-16 w-16 place-items-center rounded-full bg-fairway-100">
                  <FlagIcon className="h-8 w-8 text-fairway-600" />
                </div>
                <h2 className="mt-4 font-display text-xl font-semibold">Where are you playing?</h2>
                <p className="mt-2 max-w-xs text-sm text-muted">
                  Enter a location, use your current position, or drop a pin on the map — then set how far
                  you&apos;re willing to drive.
                </p>
              </div>
            )}

            {loading && !fetched && (
              <ul className="flex flex-col gap-3" aria-hidden>
                {Array.from({ length: 5 }, (_, i) => (
                  <li key={i} className="skeleton h-28 rounded-2xl" />
                ))}
              </ul>
            )}

            {hasSearched && fetched && (
              <>
                <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="font-display text-xl font-semibold">
                      {visible.length} {visible.length === 1 ? "course" : "courses"}
                    </h2>
                    <p className="text-sm text-muted">
                      within {radius} mi of {shortName(origin.displayName)}
                    </p>
                    {whenActive && (
                      <p className="mt-0.5 text-sm font-medium text-fairway-700">
                        {days.length ? days.map((d) => dayLabel(d)).join(", ") : "Any day"} ·{" "}
                        {windows.length
                          ? TIME_WINDOWS.filter((w) => windows.includes(w.key)).map((w) => w.label).join(", ")
                          : "Any time"}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {privateCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setHidePrivate((v) => !v)}
                        aria-pressed={hidePrivate}
                        className={`rounded-full border px-3 py-1.5 font-medium transition ${
                          hidePrivate
                            ? "border-fairway-600 bg-fairway-600 text-white"
                            : "border-sand bg-white text-muted hover:border-fairway-300"
                        }`}
                      >
                        Hide private
                      </button>
                    )}
                    <select
                      value={sort}
                      onChange={(e) => setSort(e.target.value as SortKey)}
                      aria-label="Sort courses"
                      className="rounded-full border border-sand bg-white px-3 py-1.5 font-medium text-muted focus:outline-none focus:ring-2 focus:ring-fairway-500/30"
                    >
                      <option value="distance">Nearest first</option>
                      <option value="name">A → Z</option>
                    </select>
                  </div>
                </div>

                {whenActive && (closedCount > 0 || unknownCount > 0) && (
                  <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-fairway-50 px-3 py-2 text-xs text-fairway-700">
                    {closedCount > 0 && (
                      <button type="button" onClick={() => setShowClosed((v) => !v)} className="font-medium hover:underline">
                        {showClosed
                          ? "Hide courses closed then"
                          : `${closedCount} closed at those times — show`}
                      </button>
                    )}
                    {unknownCount > 0 && (
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={confirmedOnly}
                          onChange={(e) => setConfirmedOnly(e.target.checked)}
                          className="accent-fairway-600"
                        />
                        Only courses with posted hours ({inRadius.length - unknownCount - closedCount})
                      </label>
                    )}
                  </div>
                )}

                {visible.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-sand px-6 py-10 text-center">
                    <p className="font-medium">No courses in this radius.</p>
                    <p className="mt-1 text-sm text-muted">Slide the radius up to widen the search.</p>
                  </div>
                ) : (
                  <ul className={`flex flex-col gap-3 transition-opacity ${loading ? "opacity-60" : ""}`}>
                    {visible.map((course, i) => (
                      <li
                        key={course.id}
                        ref={(el) => {
                          if (el) cardRefs.current.set(course.id, el);
                          else cardRefs.current.delete(course.id);
                        }}
                        onMouseEnter={() => setActiveId(course.id)}
                        className={`rounded-2xl border bg-white p-4 shadow-sm transition ${
                          whenActive && fits.get(course.id)?.status === "closed" ? "opacity-60 " : ""
                        }${
                          activeId === course.id
                            ? "border-fairway-500 shadow-md ring-4 ring-fairway-500/10"
                            : "border-sand hover:border-fairway-300"
                        }`}
                      >
                        <div className="flex gap-3">
                          <span
                            className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white ${
                              activeId === course.id ? "bg-flag" : "bg-fairway-600"
                            }`}
                          >
                            {i + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <h3 className="font-semibold leading-snug">{course.name}</h3>
                              <span className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums text-fairway-700">
                                {course.distanceMiles.toFixed(1)} mi
                              </span>
                            </div>
                            {course.address && <p className="mt-0.5 truncate text-sm text-muted">{course.address}</p>}
                            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                              {(() => {
                                const fit = fits.get(course.id);
                                if (fit && fit.status !== "unknown" && fit.hoursLabel && labelDay) {
                                  const closed = fit.status === "closed" && whenActive;
                                  return (
                                    <span
                                      className={`rounded-full px-2 py-0.5 font-medium ${
                                        closed ? "bg-flag/10 text-flag" : "bg-fairway-600 text-white"
                                      }`}
                                    >
                                      {closed ? "Closed then · " : ""}
                                      {dayLabel(labelDay)} {fit.hoursLabel}
                                    </span>
                                  );
                                }
                                return whenActive ? (
                                  <span className="rounded-full border border-dashed border-sand px-2 py-0.5 text-muted">
                                    Hours not listed
                                  </span>
                                ) : null;
                              })()}
                              {course.access === "public" && (
                                <span className="rounded-full bg-fairway-50 px-2 py-0.5 font-medium text-fairway-700">
                                  Public
                                </span>
                              )}
                              {course.access === "private" && (
                                <span className="rounded-full bg-sand px-2 py-0.5 font-medium text-muted">Private</span>
                              )}
                              {course.holes && (
                                <span className="rounded-full bg-fairway-50 px-2 py-0.5 font-medium text-fairway-700">
                                  {course.holes} holes
                                </span>
                              )}
                              {course.phone && (
                                <a href={`tel:${course.phone}`} className="px-1 text-muted underline-offset-2 hover:underline">
                                  {course.phone}
                                </a>
                              )}
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <a
                                href={
                                  course.website ??
                                  (days.length === 1
                                    ? `${course.searchUrl}+${encodeURIComponent(dayLabel(days[0], "long"))}`
                                    : course.searchUrl)
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 rounded-lg bg-fairway-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-fairway-700"
                              >
                                {course.website ? "Check" : "Search"}
                                {days.length === 1 ? ` ${dayLabel(days[0])}` : ""} tee times
                                <ArrowIcon className="h-3.5 w-3.5" />
                              </a>
                              <a
                                href={course.directionsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center rounded-lg border border-sand px-3 py-1.5 text-sm font-medium text-ink transition hover:border-fairway-300 hover:bg-fairway-50"
                              >
                                Directions
                              </a>
                              {course.website && (
                                <span className="self-center truncate text-xs text-muted">{hostname(course.website)}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <p className="mt-6 text-xs leading-relaxed text-muted">
                  Course data and posted hours from OpenStreetMap; the day/time filter uses those hours and
                  daylight. Tee time buttons open each course&apos;s own booking site, where live availability is
                  shown.
                </p>
              </>
            )}
          </div>
        </section>

        {/* Map */}
        <section className="relative order-first h-[42vh] min-h-[280px] border-b border-sand lg:order-none lg:h-auto lg:flex-1 lg:border-b-0 lg:border-l">
          <div className={`h-full w-full ${picking ? "cursor-crosshair [&_.leaflet-container]:cursor-crosshair" : ""}`}>
            <CourseMap
              origin={origin}
              radiusMiles={radius}
              courses={visible}
              activeId={activeId}
              onSelect={handleSelect}
              onPickLocation={(lat, lon) => {
                if (picking) handlePickLocation(lat, lon);
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => setPicking((v) => !v)}
            aria-pressed={picking}
            className={`absolute left-3 top-3 z-[1000] flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold shadow-lg transition ${
              picking ? "bg-flag text-white" : "bg-white text-ink hover:bg-fairway-50"
            }`}
          >
            <PinIcon className="h-4 w-4" />
            {picking ? "Click the map to set location…" : "Drop a pin"}
          </button>
        </section>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function FlagIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 21V3" />
      <path d="M8 4l10 3.5L8 11" fill="currentColor" fillOpacity="0.25" />
      <ellipse cx="10" cy="21" rx="7" ry="1.5" />
    </svg>
  );
}

function PinIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

function CrosshairIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17L17 7M9 7h8v8" />
    </svg>
  );
}

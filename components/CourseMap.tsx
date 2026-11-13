"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Course, GeocodeResult } from "@/lib/courses";

interface Props {
  origin: GeocodeResult | null;
  radiusMiles: number;
  courses: Course[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onPickLocation: (lat: number, lon: number) => void;
}

const METERS_PER_MILE = 1609.34;

export default function CourseMap({
  origin,
  radiusMiles,
  courses,
  activeId,
  onSelect,
  onPickLocation,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const originMarkerRef = useRef<L.Marker | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const layerRef = useRef<L.LayerGroup | null>(null);
  const onSelectRef = useRef(onSelect);
  const onPickRef = useRef(onPickLocation);

  useEffect(() => {
    onSelectRef.current = onSelect;
    onPickRef.current = onPickLocation;
  });

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, {
      center: [39.5, -98.35],
      zoom: 4,
      zoomControl: false,
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on("click", (e) => onPickRef.current(e.latlng.lat, e.latlng.lng));
    mapRef.current = map;

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      circleRef.current = null;
      originMarkerRef.current = null;
    };
  }, []);

  // Origin marker + radius circle.
  const lat = origin?.lat;
  const lon = origin?.lon;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lat === undefined || lon === undefined) return;
    const radius = radiusMiles * METERS_PER_MILE;

    if (!circleRef.current) {
      circleRef.current = L.circle([lat, lon], {
        radius,
        color: "#236339",
        weight: 1.5,
        dashArray: "6 6",
        fillColor: "#2f7d4a",
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
    } else {
      circleRef.current.setLatLng([lat, lon]).setRadius(radius);
    }

    if (!originMarkerRef.current) {
      originMarkerRef.current = L.marker([lat, lon], {
        icon: L.divIcon({ className: "", html: '<div class="origin-pin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
        interactive: false,
        zIndexOffset: 1000,
      }).addTo(map);
    } else {
      originMarkerRef.current.setLatLng([lat, lon]);
    }

    map.fitBounds(circleRef.current.getBounds(), { padding: [24, 24] });
  }, [lat, lon, radiusMiles]);

  // Course markers.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    markersRef.current.clear();
    courses.forEach((course, i) => {
      const marker = L.marker([course.lat, course.lon], {
        icon: L.divIcon({
          className: "",
          html: `<div class="course-pin" data-id="${course.id}">${i + 1}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        title: course.name,
      });
      marker.bindTooltip(course.name, { direction: "top", offset: [0, -14] });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        onSelectRef.current(course.id);
      });
      marker.addTo(layer);
      markersRef.current.set(course.id, marker);
    });
  }, [courses]);

  // Highlight the active marker.
  useEffect(() => {
    markersRef.current.forEach((marker, id) => {
      const el = marker.getElement()?.querySelector(".course-pin");
      el?.classList.toggle("is-active", id === activeId);
      marker.setZIndexOffset(id === activeId ? 900 : 0);
    });
  }, [activeId, courses]);

  return <div ref={containerRef} className="h-full w-full" aria-label="Map of nearby golf courses" />;
}

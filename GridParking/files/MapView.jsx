import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const NAVY = "#214082", MARIGOLD = "#f6b93b";
const TILES = "https://{s}.basemaps.cartocdn.com/rasterTiles/voyager/{z}/{x}/{y}{r}.png";
const icon = (html) => L.divIcon({ className: "", html, iconSize: [0, 0] });

export default function MapView({ center, radius, spots, selectedId, onSelect, me, follow, line, trip }) {
  const host = useRef(null), map = useRef(null), layers = useRef({}), meMarker = useRef(null);

  useEffect(() => {
    const m = L.map(host.current, { zoomControl: false }).setView([center.lat, center.lng], 16);
    L.control.zoom({ position: "bottomright" }).addTo(m);
    L.tileLayer(TILES, { maxZoom: 19, subdomains: "abcd", attribution: "© OpenStreetMap contributors © CARTO" }).addTo(m);
    layers.current = { zone: L.layerGroup().addTo(m), spots: L.layerGroup().addTo(m), route: L.layerGroup().addTo(m) };
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(host.current);
    return () => { ro.disconnect(); m.remove(); meMarker.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Search centre + search radius; fly there whenever the searched place changes.
  useEffect(() => {
    const z = layers.current.zone;
    z.clearLayers();
    if (trip) return;
    L.circle([center.lat, center.lng], { radius, color: NAVY, weight: 1.5, dashArray: "6 8", fillOpacity: 0.04, interactive: false }).addTo(z);
    L.marker([center.lat, center.lng], { icon: icon('<div class="center"></div>'), interactive: false, keyboard: false }).addTo(z);
    map.current.flyTo([center.lat, center.lng], radius > 2000 ? 14 : 16, { duration: 0.8 });
  }, [center.lat, center.lng, radius, trip]);

  useEffect(() => {
    const g = layers.current.spots;
    g.clearLayers();
    spots.forEach((s) => {
      const ok = s.fits_vehicle !== false && s.occupancy_status === "VACANT";
      const cls = `pin ${s.slot_id === selectedId ? "sel" : ""} ${s.is_overflow_reserve ? "alt" : ok ? "" : "off"}`;
      const label = s.is_overflow_reserve ? "<b>!</b>Overflow" : `<b>P</b>₹${Math.round(s.hourly_rate_inr)}`;
      L.marker([s.lat, s.lng], { icon: icon(`<div class="${cls}">${label}</div>`), title: s.title })
        .on("click", () => onSelect?.(s.slot_id)).addTo(g);
    });
  }, [spots, selectedId, onSelect]);

  useEffect(() => {
    if (!me) { meMarker.current?.remove(); meMarker.current = null; return; }
    if (meMarker.current) meMarker.current.setLatLng([me.lat, me.lng]);
    else meMarker.current = L.marker([me.lat, me.lng], { icon: icon('<div class="me"></div>'), interactive: false, zIndexOffset: 1000 }).addTo(map.current);
    if (follow) map.current.panTo([me.lat, me.lng]);
  }, [me, follow]);

  // The signature move: a navy road casing, with the marigold route painted along it.
  useEffect(() => {
    const r = layers.current.route;
    r.clearLayers();
    if (!line?.length) return;
    const round = { lineCap: "round", lineJoin: "round", interactive: false };
    L.polyline(line, { color: NAVY, weight: 10, ...round }).addTo(r);
    const paint = L.polyline(line, { color: MARIGOLD, weight: 5, ...round }).addTo(r);
    const el = paint.getElement();
    if (el?.getTotalLength && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const len = el.getTotalLength();
      el.style.strokeDasharray = len;
      el.style.strokeDashoffset = len;
      el.getBoundingClientRect(); // commit the start state before transitioning
      el.style.transition = "stroke-dashoffset 1.6s cubic-bezier(.16,1,.3,1)";
      el.style.strokeDashoffset = 0;
    }
    const wide = window.innerWidth >= 900;
    map.current.fitBounds(L.latLngBounds(line), {
      paddingTopLeft: [wide ? 470 : 40, 70], paddingBottomRight: [40, wide ? 70 : window.innerHeight * 0.5], maxZoom: 17,
    });
  }, [line]);

  return <div ref={host} className="map" role="application" aria-label="Parking map" />;
}

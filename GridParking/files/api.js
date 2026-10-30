// Relative by default: nginx (Docker) and the Vite proxy (dev) both forward /api to FastAPI.
const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function call(path, opts) {
  const res = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = body.detail;
    throw new Error(typeof d === "string" ? d : d?.[0]?.msg || `Request failed (${res.status})`);
  }
  return body;
}
const post = (path, data) => call(path, { method: "POST", body: JSON.stringify(data) });

export const api = {
  vahan: (rc) => call(`/api/v1/vahan/lookup/${encodeURIComponent(rc)}`),
  nearby: ({ lat, lng, radius, rc, type }) =>
    call("/api/v1/spots/nearby?" + new URLSearchParams({
      lat, lng, radius_m: radius, ...(rc && { rc_number: rc }), ...(type && { property_type: type }),
    })),
  book: (data) => post("/api/v1/bookings/instant", data),
  scrub: (id, mins) => post(`/api/v1/bookings/${id}/simulate-timer`, { simulated_minutes_after_end: mins }),
  checkin: (data) => post("/api/v1/p2p/checkin", data),
  edge: (data) => post("/api/v1/edge/occupancy-webhook", data),
  ledger: () => call("/api/v1/rwa/ledger-summary"),
};

/* ---------- geo: free OSM services, no API keys ---------- */

// Nominatim asks for <= 1 request/sec; callers debounce. Results are biased (not limited) to Bhopal.
export async function searchPlaces(q, signal) {
  const u = new URLSearchParams({ format: "jsonv2", q, countrycodes: "in", limit: "5", viewbox: "77.2,23.4,77.6,23.1" });
  const r = await fetch("https://nominatim.openstreetmap.org/search?" + u, { signal });
  if (!r.ok) throw new Error("Place search is unavailable right now");
  return (await r.json()).map((p) => ({ name: p.display_name, lat: +p.lat, lng: +p.lon }));
}

const stepText = (s) => {
  const { type, modifier } = s.maneuver;
  const on = s.name ? ` onto ${s.name}` : "";
  if (type === "depart") return `Head ${modifier || "out"}${s.name ? ` on ${s.name}` : ""}`;
  if (type === "arrive") return "Arrive at your parking spot";
  if (type === "roundabout" || type === "rotary") return `Take the roundabout${on}`;
  return `${modifier ? `Turn ${modifier}` : "Continue"}${on}`;
};

// shortcut: public OSRM demo server, fair-use only; point at your own OSRM/Valhalla before launch.
export async function getRoute(from, to, signal) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
  const r = await fetch(url, { signal });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.code !== "Ok") throw new Error("Couldn't find a driving route to this spot");
  const rt = d.routes[0];
  return {
    distance: rt.distance,
    duration: rt.duration,
    line: rt.geometry.coordinates.map(([x, y]) => [y, x]),
    steps: rt.legs[0].steps.map((s) => ({ text: stepText(s), distance: s.distance })),
  };
}

export const locate = () =>
  new Promise((ok, no) =>
    navigator.geolocation
      ? navigator.geolocation.getCurrentPosition(
          (p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), no, { enableHighAccuracy: true, timeout: 8000 })
      : no(new Error("Geolocation not supported")));

export function haversine(a, b) {
  const r = 6371000, rad = Math.PI / 180;
  const dp = (b.lat - a.lat) * rad, dl = (b.lng - a.lng) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
export const fmtMin = (s) => `${Math.max(1, Math.round(s / 60))} min`;
export const inr = (n) => "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const hhmm = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

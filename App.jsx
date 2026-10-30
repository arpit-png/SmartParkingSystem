import { ThemeToggle, TextRoll, SmoothInput, AnimatedNumber, AnimatedArrow, SessionPill, ParkingAssistant } from "./components.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bike, Building2, Camera, Car, ChevronUp, Clock, ExternalLink, Home, LocateFixed, MapPin, Minus, Navigation,
  Plus, QrCode, Receipt, Route, Search, ShieldCheck, Wallet,
} from "lucide-react";
import MapView from "./MapView.jsx";
import { Btn, Reveal, spotlight } from "./fx.jsx";
import { api, fmtDist, fmtMin, getRoute, haversine, hhmm, inr, locate, searchPlaces } from "./api.js";

const MZ = { name: "MP Nagar Zone-I micro-zone, Bhopal", lat: 23.2332, lng: 77.4343 };
const DEMO_RCS = ["MP04CJ4821", "DL01CA9922", "KA05MG7788", "MH12AB1122"];
const TYPES = [["", "All"], ["GATED_COLONY_RWA", "RWA colony"], ["INDEPENDENT_DRIVEWAY", "Driveway"], ["COMMERCIAL_LOT", "Commercial"]];
const TYPE_LABEL = { GATED_COLONY_RWA: "RWA colony", INDEPENDENT_DRIVEWAY: "Driveway", COMMERCIAL_LOT: "Commercial lot" };
const TYPE_ICON = { GATED_COLONY_RWA: Building2, INDEPENDENT_DRIVEWAY: Home, COMMERCIAL_LOT: Building2 };
const STATUS = {
  BOOKED: ["Booked", ""], ACTIVE: ["Parked", "good"], GRACE_WINDOW: ["Grace window", "warn"],
  OVERSTAY_PENALTY: ["Overstay · 4× surge", "bad"], COMPLETED: ["Completed", ""],
};

export default function App() {
  const [tab, setTab] = useState("find");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [place, setPlace] = useState(MZ);
  const [radius, setRadius] = useState(1000);
  const [rcInput, setRcInput] = useState("MP04CJ4821");
  const [vehicle, setVehicle] = useState(null);
  const [vehicleErr, setVehicleErr] = useState("");
  const [type, setType] = useState("");
  const [spots, setSpots] = useState([]);
  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0); // bump to refetch after occupancy changes
  const [selId, setSelId] = useState(null);
  const [booking, setBooking] = useState(null);
  const [bookedSpot, setBookedSpot] = useState(null);
  const [nav, setNav] = useState(null); // { route, approx } | { error } | { loading }
  const [me, setMe] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [trackErr, setTrackErr] = useState("");
  const watch = useRef(null);
  const bar = useRef(null);

  const lookup = useCallback(async (rc) => {
    setVehicleErr("");
    try {
      const v = await api.vahan(rc.replace(/[\s-]/g, ""));
      setVehicle(v);
      setRcInput(v.rc_number);
    } catch (e) {
      setVehicleErr(e.message);
      if (!vehicle) { setPhase("error"); setError(e.message); }
    }
  }, []);
  useEffect(() => { lookup("MP04CJ4821"); }, [lookup]);

  useEffect(() => {
    if (!vehicle) return;
    let stale = false;
    setPhase("loading");
    api.nearby({ lat: place.lat, lng: place.lng, radius, rc: vehicle.rc_number, type })
      .then((s) => !stale && (setSpots(s), setPhase("ready")))
      .catch((e) => !stale && (setError(e.message), setPhase("error")));
    return () => { stale = true; };
  }, [place, radius, vehicle, type, tick]);

  useEffect(() => () => watch.current != null && navigator.geolocation.clearWatch(watch.current), []);

  const bookable = useMemo(() => spots.filter((s) => !s.is_overflow_reserve), [spots]);
  const selected = bookable.find((s) => s.slot_id === selId);
  const tripSpots = useMemo(() => {
    if (!bookedSpot) return [];
    const alt = spots.filter((s) => s.slot_id === booking?.assigned_overflow_slot_id);
    return [bookedSpot, ...alt];
  }, [bookedSpot, booking, spots]);

  const onMapPick = useCallback((id) => { setSelId(id); setTab("find"); }, []);
  const pickPlace = (p) => { setPlace(p); setSelId(null); setRadius(1000); setSheetOpen(false); };

  async function useMyLocation() {
    try {
      const p = await locate();
      setMe(p);
      pickPlace({ name: "Your location", ...p });
    } catch {
      setError("Location permission is off. Search for a place instead.");
      setPhase("error");
    }
  }

  async function startTrip(spot) {
    setNav({ loading: true });
    let from, approx = false;
    try { from = await locate(); setMe(from); } catch { from = { lat: place.lat, lng: place.lng }; approx = true; }
    try { setNav({ route: await getRoute(from, spot), approx }); }
    catch (e) { setNav({ error: e.message, spot }); }
  }

  function onBooked(b, spot) {
    setBooking(b);
    setBookedSpot(spot);
    setTab("trip");
    setSheetOpen(false);
    startTrip(spot);
  }

  function toggleTrack() {
    if (tracking) { navigator.geolocation.clearWatch(watch.current); watch.current = null; return setTracking(false); }
    if (!navigator.geolocation) return setTrackErr("This device can't share its location.");
    setTrackErr("");
    watch.current = navigator.geolocation.watchPosition(
      (p) => setMe({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => { setTrackErr(`Location unavailable: ${e.message}`); setTracking(false); if (watch.current != null) navigator.geolocation.clearWatch(watch.current); watch.current = null; },
      { enableHighAccuracy: true },
    );
    setTracking(true);
  }

  function finishTrip() {
    if (tracking) toggleTrack();
    setBooking(null); setBookedSpot(null); setNav(null); setSelId(null); setTab("find"); setTick((t) => t + 1);
  }

  const onScroll = (e) => {
    const el = e.currentTarget;
    bar.current.style.scale = `${el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)} 1`;
  };

  const inTrip = tab === "trip" && booking;
  return (
    <div className="app">
      <aside className="panel" data-open={sheetOpen}>
        <button className="handle" onClick={() => setSheetOpen((o) => !o)} aria-label={sheetOpen ? "Collapse panel" : "Expand panel"} aria-expanded={sheetOpen}>
          <ChevronUp size={20} />
        </button>
        <header className="hdr">
          <div className="brand-row"><div className="brand"><span className="brand-mark">P</span>ParkGrid <span className="brand-in">India</span></div><ThemeToggle /></div><div className="demo-label"><i /> INTERACTIVE SANDBOX · BHOPAL</div>
          <nav className="tabs" role="tablist">
            {[["find", "Find parking"], ["trip", "My trip"], ["ledger", "RWA ledger"]].map(([id, label]) => (
              <button key={id} role="tab" className="tab" aria-selected={tab === id} disabled={id === "trip" && !booking} onClick={() => setTab(id)}>
                <TextRoll>{label}</TextRoll>
              </button>
            ))}
          </nav>
          <i className="progress" ref={bar} />
        </header>
        <main className="scroller" onScroll={onScroll} key={tab}>
          {tab === "find" && (
            selected ? (
              <SpotDetail spot={selected} vehicle={vehicle} onBack={() => setSelId(null)} onBooked={onBooked} />
            ) : (
              <FindPanel {...{ place, radius, setRadius, rcInput, setRcInput, vehicle, vehicleErr, lookup, type, setType, bookable, phase, error, setSelId, pickPlace, useMyLocation }} />
            )
          )}
          {tab === "trip" && booking && (
            <TripPanel {...{ booking, setBooking, spot: bookedSpot, vehicle, nav, startTrip, me, tracking, toggleTrack, trackErr, finishTrip }}
              refresh={() => setTick((t) => t + 1)} />
          )}
          {tab === "ledger" && <LedgerPanel />}
        </main>
      </aside>

      <div className="map-heading"><span className="map-eyebrow">A LITTLE LESS CIRCLING. A LOT MORE LIVING.</span><strong>Your city. Your space.</strong><span>MP Nagar, Bhopal <i /> Seeded demo inventory</span></div>
      <SessionPill booking={booking} />
      <ParkingAssistant spots={bookable} onSelect={onMapPick} />
      <MapView
        center={place} radius={radius} trip={!!inTrip}
        spots={inTrip ? tripSpots : bookable} selectedId={inTrip ? bookedSpot?.slot_id : selId}
        onSelect={inTrip ? undefined : onMapPick}
        me={me} follow={tracking} line={inTrip ? nav?.route?.line : null}
      />
    </div>
  );
}

/* ====================== FIND ====================== */

function PlaceSearch({ onPick, onLocate }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 3) { setItems([]); setMsg(""); return; }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await searchPlaces(q.trim(), ac.signal);
        setItems(r);
        setMsg(r.length ? "" : "No places match that search.");
      } catch (e) {
        if (e.name !== "AbortError") setMsg(e.message);
      } finally { setBusy(false); }
    }, 1100);
    return () => { clearTimeout(t); ac.abort(); };
  }, [q]);

  const pick = (p) => { onPick(p); setQ(""); setItems([]); };
  return (
    <div className="search">
      <label className="field search-box">
        <Search size={18} aria-hidden />
        <SmoothInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search an area, landmark or address" aria-label="Search a destination" autoComplete="off" />
        <button type="button" className="icon-btn" onClick={onLocate} aria-label="Use my current location" title="Use my location"><LocateFixed size={20} /></button>
      </label>
      {(items.length > 0 || msg || busy) && (
        <ul className="suggest" role="listbox">
          {busy && <li className="muted pad">Searching…</li>}
          {items.map((p) => (
            <li key={p.name + p.lat}>
              <button className="suggest-item" onClick={() => pick(p)}><MapPin size={16} aria-hidden /><span>{p.name}</span></button>
            </li>
          ))}
          {msg && !busy && <li className="muted pad" role="alert">{msg}</li>}
        </ul>
      )}
      <div className="chips">
        <button className="chip chip-btn" onClick={() => onPick(MZ)}><MapPin size={14} aria-hidden />MP Nagar micro-zone</button>
      </div>
    </div>
  );
}

function FindPanel({ place, radius, setRadius, rcInput, setRcInput, vehicle, vehicleErr, lookup, type, setType, bookable, phase, error, setSelId, pickPlace, useMyLocation }) {
  const vacant = bookable.filter((s) => s.fits_vehicle && s.occupancy_status === "VACANT").length;
  return (
    <>
      <Reveal>
        <span className="eyebrow">THE SMARTER WAY TO ARRIVE</span><h1>Good days start<br/>with a good spot<span className="accent">.</span></h1>
        <p className="muted">Search a place, pick a bay that fits your car, and we’ll take you there.</p>
      </Reveal>
      <Reveal delay={60}><PlaceSearch onPick={pickPlace} onLocate={useMyLocation} /></Reveal>

      <Reveal delay={120} className="stack">
        <h2>Your vehicle</h2>
        <form className="rc-form" onSubmit={(e) => { e.preventDefault(); lookup(rcInput); }}>
          <label className="field">
            <SmoothInput value={rcInput} onChange={(e) => setRcInput(e.target.value.toUpperCase())} aria-label="Vehicle registration number" placeholder="MP04CJ4821" />
          </label>
          <Btn variant="dark" type="submit" magnetic={false}>Look up</Btn>
        </form>
        <div className="chips">
          {DEMO_RCS.map((rc) => (
            <button key={rc} className="chip chip-btn num" onClick={() => lookup(rc)} aria-pressed={vehicle?.rc_number === rc}>{rc}</button>
          ))}
        </div>
        {vehicleErr && <p className="err" role="alert">{vehicleErr}</p>}
        {vehicle && (
          <div className="vehicle">
            {vehicle.footprint_category === "TWO_WHEELER" ? <Bike size={22} aria-hidden /> : <Car size={22} aria-hidden />}
            <div>
              <strong>{vehicle.make_model}</strong>
              <div className="muted num">{vehicle.length_m} × {vehicle.width_m} m · Demo vehicle profile</div>
            </div>
            <span className="chip"><Wallet size={14} aria-hidden /><span className="num">{inr(vehicle.escrow_mandate_balance_inr)}</span></span>
          </div>
        )}
      </Reveal>

      <Reveal delay={180} className="stack">
        <div className="row-between">
          <h2>Bays near {place.name.split(",")[0]}</h2>
          <span className="muted num">{radius / 1000} km</span>
        </div>
        <div className="seg" role="group" aria-label="Property type">
          {TYPES.map(([v, label]) => (
            <button key={v} aria-pressed={type === v} onClick={() => setType(v)}>{label}</button>
          ))}
        </div>
        {phase === "loading" && <p className="muted">Finding bays…</p>}
        {phase === "error" && <p className="err" role="alert">{error}</p>}
        {phase === "ready" && (
          bookable.length === 0 ? (
            <div className="empty">
              <strong>No bays within {radius / 1000} km of here</strong>
              <p className="muted">ParkGrid is live in the MP Nagar Zone-I corridor so far.</p>
              <div className="chips">
                {radius < 5000 && <Btn variant="ghost" magnetic={false} onClick={() => setRadius(5000)}>Search 5 km</Btn>}
                <Btn variant="ghost" magnetic={false} onClick={() => pickPlace(MZ)}>Jump to MP Nagar</Btn>
              </div>
            </div>
          ) : (
            <>
              <div className="availability"><div><AnimatedNumber value={vacant}/><span>AVAILABLE & COMPATIBLE</span></div><span className="chip good"><i className="status-dot"/> Demo inventory</span></div>
              <ul className="list">
                {bookable.map((s, i) => <li key={s.slot_id}><SpotRow s={s} i={i} onPick={() => setSelId(s.slot_id)} /></li>)}
              </ul>
            </>
          )
        )}
      </Reveal>
    </>
  );
}

function SpotRow({ s, i, onPick }) {
  const why = !s.fits_vehicle ? "Too small for your vehicle" : s.occupancy_status !== "VACANT" ? "Occupied right now" : "";
  const Icon = TYPE_ICON[s.property_type];
  return (
    <Reveal delay={Math.min(i, 6) * 50}>
      <button className="row" disabled={!!why} onClick={onPick} onPointerMove={spotlight}>
        <Icon size={20} aria-hidden />
        <span className="row-main">
          <strong>{s.title}</strong>
          <span className="muted num">{fmtDist(s.distance_m)} away · fits {s.max_length_m} × {s.max_width_m} m</span>
          {why && <span className="chip bad">{why}</span>}
        </span>
        <span className="price num">₹{Math.round(s.hourly_rate_inr)}<small>/hr</small></span><AnimatedArrow/>
      </button>
    </Reveal>
  );
}

function SpotDetail({ spot, vehicle, onBack, onBooked }) {
  const [hours, setHours] = useState(2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const gross = hours * spot.hourly_rate_inr;
  const Icon = TYPE_ICON[spot.property_type];

  async function book() {
    setBusy(true); setErr("");
    try { onBooked(await api.book({ rc_number: vehicle.rc_number, slot_id: spot.slot_id, duration_hours: hours, escrow_preauth_inr: 500 }), spot); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <>
      <Reveal><button className="link" onClick={onBack}>← Back to results</button></Reveal>
      <Reveal delay={40} className="stack">
        <h1>{spot.title}</h1>
        <div className="chips">
          <span className="chip"><Icon size={14} aria-hidden />{TYPE_LABEL[spot.property_type]}</span>
          <span className="chip num"><MapPin size={14} aria-hidden />{fmtDist(spot.distance_m)}</span>
          {spot.host_kyc_digilocker_verified && <span className="chip good"><ShieldCheck size={14} aria-hidden />Demo host profile</span>}
        </div>
        <p className="muted num">Fits up to {spot.max_length_m} × {spot.max_width_m} m. Your {vehicle.make_model} is {vehicle.length_m} × {vehicle.width_m} m. Instant-book {spot.instant_book_window}.</p>
      </Reveal>

      <Reveal delay={90} className="stack">
        <h2>How long?</h2>
        <div className="stepper">
          <button className="icon-btn" aria-label="Less time" disabled={hours <= 0.5} onClick={() => setHours((h) => h - 0.5)}><Minus size={18} /></button>
          <output className="num" aria-live="polite">{hours} {hours === 1 ? "hour" : "hours"}</output>
          <button className="icon-btn" aria-label="More time" disabled={hours >= 12} onClick={() => setHours((h) => h + 0.5)}><Plus size={18} /></button>
        </div>
        <dl className="bill num">
          <div><dt>Parking · {hours} h × ₹{spot.hourly_rate_inr}</dt><dd>{inr(gross)}</dd></div>
          <div><dt>Simulated cover (₹25,000)</dt><dd>{inr(1.5)}</dd></div>
          <div className="total"><dt>Charged from escrow</dt><dd>{inr(gross + 1.5)}</dd></div>
        </dl>
        <p className="muted"><Wallet size={14} aria-hidden /> In this demo, ₹500 is held in simulated escrow and the unused part is refunded. The host gets a 30-minute return buffer after your slot ends.</p>
      </Reveal>

      <Reveal delay={140} className="stack">
        {err && <p className="err" role="alert">{err}</p>}
        <Btn loading={busy} onClick={book} className="block">Book instantly · {inr(gross + 1.5)}</Btn>
        <p className="muted center">You’ll get the route straight after booking.</p>
      </Reveal>
    </>
  );
}

/* ====================== TRIP ====================== */

function TripPanel({ booking, setBooking, spot, vehicle, nav, startTrip, me, tracking, toggleTrack, trackErr, finishTrip, refresh }) {
  const [label, tone] = STATUS[booking.status];
  const toPin = me ? haversine(me, spot) : null;
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}&travelmode=driving`;
  const s = booking.settlement;
  const overflow = booking.assigned_overflow_slot_id;

  return (
    <>
      <Reveal className="stack">
        <div className="row-between"><h1>Head to your bay</h1><span className={`chip ${tone}`}>{label}</span></div>
        <p className="muted"><MapPin size={14} aria-hidden /> {spot.title}</p>
      </Reveal>

      <Reveal delay={50} className="stack">
        {nav?.loading && <p className="muted">Finding the best route…</p>}
        {nav?.error && (
          <>
            <p className="err" role="alert">{nav.error}</p>
            <Btn variant="ghost" magnetic={false} onClick={() => startTrip(spot)}>Try again</Btn>
          </>
        )}
        {nav?.route && (
          <div className="eta">
            <div><span className="big num">{fmtMin(nav.route.duration)}</span><span className="muted num">{fmtDist(nav.route.distance)} by road</span></div>
            {toPin != null && tracking && <div className="muted num">{toPin < 30 ? "You’ve arrived" : `${fmtDist(toPin)} to go (straight line)`}</div>}
          </div>
        )}
        {nav?.approx && <p className="muted">Location is off, so this route starts from the place you searched. Turn on location for exact directions.</p>}
        <div className="btn-row">
          <Btn onClick={toggleTrack}><Navigation size={18} aria-hidden />{tracking ? "Stop navigation" : "Start navigation"}</Btn>
          <Btn variant="ghost" href={gmaps}><ExternalLink size={18} aria-hidden />Google Maps</Btn>
        </div>
        {trackErr && <p className="err" role="alert">{trackErr}</p>}
        {nav?.route && (
          <details className="steps">
            <summary><Route size={16} aria-hidden /> Turn-by-turn ({nav.route.steps.length} steps)</summary>
            <ol>{nav.route.steps.map((st, i) => <li key={i}><span>{st.text}</span><span className="muted num">{fmtDist(st.distance)}</span></li>)}</ol>
          </details>
        )}
      </Reveal>

      <Reveal delay={80} className="stack">
        <h2>Booking {booking.booking_id}</h2>
        <dl className="bill num">
          <div><dt>Slot ends</dt><dd>{hhmm(booking.booked_end_utc)}</dd></div>
          <div><dt>Host return buffer until</dt><dd>{hhmm(booking.landlord_buffer_end_utc)}</dd></div>
          <div><dt>Escrow held</dt><dd>{inr(booking.escrow_locked_inr)}</dd></div>
          <div><dt>Insurance cover</dt><dd>{booking.insurance_policy_active ? inr(booking.insurance_coverage_inr) : "Ended"}</dd></div>
        </dl>
        {spot.property_type === "GATED_COLONY_RWA" && (
          <p className="muted"><ShieldCheck size={14} aria-hidden /> Your plate {booking.rc_number} is whitelisted at the colony gate.</p>
        )}
        {overflow && <p className="chip warn wrap"><strong>Host returning:</strong> overflow bay {overflow} is pinned on the map.</p>}
      </Reveal>

      {s && (
        <Reveal delay={110} className="stack">
          <h2>Settlement</h2>
          <dl className="bill num">
            <div><dt>Parking</dt><dd>{inr(s.gross_base_inr)}</dd></div>
            <div><dt>Cover</dt><dd>{inr(s.micro_insurance_fee_inr)}</dd></div>
            {s.penalty_total_inr > 0 && <div className="bad-row"><dt>Overstay penalty (4× surge)</dt><dd>{inr(s.penalty_total_inr)}</dd></div>}
            <div className="total"><dt>Refunded to you</dt><dd>{inr(s.escrow_refund_to_driver_inr)}</dd></div>
          </dl>
          <p className="muted num">Split: host {inr(s.spot_owner_payout_inr)} · RWA fund {inr(s.rwa_maintenance_payout_inr)} · ParkGrid {inr(s.platform_commission_inr)}</p>
        </Reveal>
      )}

      <Reveal delay={140} className="stack">
        <h2>Try it out</h2>
        <Scrubber booking={booking} onChange={setBooking} />
        {spot.property_type === "INDEPENDENT_DRIVEWAY"
          ? <P2PCheckIn booking={booking} spot={spot} onChange={setBooking} />
          : <EdgeEvents spot={spot} booking={booking} onDone={async () => { setBooking(await api.booking(booking.booking_id)); refresh(); }} />}
      </Reveal>

      <Reveal delay={170}>
        <Btn variant="ghost" magnetic={false} className="block" onClick={finishTrip}>Done, find another bay</Btn>
      </Reveal>
    </>
  );
}

function Scrubber({ booking, onChange }) {
  const [v, setV] = useState(0);
  const [err, setErr] = useState("");
  const commit = async () => {
    try { onChange(await api.scrub(booking.booking_id, v)); setErr(""); } catch (e) { setErr(e.message); }
  };
  const phase = v < -15 ? "Parked, plenty of time" : v <= 10 ? "Grace window" : "Overstay: 4× surge, host routed to overflow bay";
  return (
    <div className="tool">
      <label htmlFor="scrub"><Clock size={16} aria-hidden /> Time scrubber</label>
      <input id="scrub" type="range" min={-60} max={240} step={5} value={v} onChange={(e) => setV(+e.target.value)} onPointerUp={commit} onKeyUp={commit} />
      <div className="row-between"><span className="num">{v < 0 ? `${-v} min before end` : `${v} min after end`}</span><span className="muted">{phase}</span></div>
      {err && <p className="err" role="alert">{err}</p>}
    </div>
  );
}

function P2PCheckIn({ booking, spot, onChange }) {
  const [qr, setQr] = useState(spot.qr_sticker_token);
  const [plate, setPlate] = useState(booking.rc_number);
  const [msg, setMsg] = useState("");
  const [bad, setBad] = useState(false);
  async function go(getPos) {
    try {
      const pos = await getPos();
      const b = await api.checkin({ booking_id: booking.booking_id, qr_sticker_token: qr, driver_lat: pos.lat, driver_lng: pos.lng, scanned_plate_ocr: plate });
      onChange(b); setBad(false); setMsg("Checked in. Enjoy your stay.");
    } catch (e) { setBad(true); setMsg(e.message); }
  }
  return (
    <div className="tool">
      <label><QrCode size={16} aria-hidden /> Driveway check-in (15 m geofence)</label>
      <div className="two">
        <label className="field"><input value={qr} onChange={(e) => setQr(e.target.value)} aria-label="Wall QR sticker token" /></label>
        <label className="field"><input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} aria-label="Scanned number plate" /></label>
      </div>
      <div className="btn-row">
        <Btn variant="dark" onClick={() => go(locate)}>Check in with my GPS</Btn>
        <Btn variant="ghost" onClick={() => go(async () => ({ lat: spot.lat, lng: spot.lng }))}>Simulate at the pin</Btn>
      </div>
      {msg && <p className={bad ? "err" : "ok"} role="alert">{msg}</p>}
    </div>
  );
}

function EdgeEvents({ spot, booking, onDone }) {
  const [msg, setMsg] = useState("");
  async function send(status, iou) {
    try {
      const r = await api.edge({ lot_id: spot.lot_id, slot_id: spot.slot_id, status, iou, timestamp: Date.now() / 1000 });
      setMsg(`Camera reported ${status}. Booking is now ${r.linked_booking_status ?? "unlinked"}.`);
      await onDone();
    } catch (e) { setMsg(e.message); }
  }
  return (
    <div className="tool">
      <label><Camera size={16} aria-hidden /> Simulated camera event for {booking.slot_id}</label>
      <div className="btn-row">
        <Btn variant="dark" onClick={() => send("OCCUPIED", 0.62)}>Car detected</Btn>
        <Btn variant="ghost" onClick={() => send("VACANT", 0)}>Car left</Btn>
      </div>
      {msg && <p className="muted" role="status">{msg}</p>}
    </div>
  );
}

/* ====================== LEDGER ====================== */

function LedgerPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.ledger().then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <p className="err" role="alert">{err}</p>;
  if (!d) return <p className="muted">Loading ledger…</p>;
  const c = d.cumulative_settlements_inr, y = d.anti_leakage_yield_comparison;
  const max = Math.max(y.static_off_app_commuter_monthly_inr, y.dynamic_multi_user_on_app_monthly_inr);
  const logs = d.security_guard_anpr_gate_logs;
  return (
    <>
      <Reveal><h1>RWA ledger</h1><p className="muted">{d.micro_zone}</p></Reveal>
      <Reveal delay={50} className="stack">
        <h2><Receipt size={18} aria-hidden /> Settled so far</h2>
        <dl className="bill num">
          <div><dt>Spot owners (65% + penalties)</dt><dd>{inr(c.spot_owners_65_pct_plus_penalties)}</dd></div>
          <div><dt>RWA maintenance fund (20%)</dt><dd>{inr(c.rwa_maintenance_fund_20_pct)}</dd></div>
          <div><dt>Platform (15% + penalties)</dt><dd>{inr(c.platform_net_15_pct_plus_penalties)}</dd></div>
        </dl>
      </Reveal>
      <Reveal delay={90} className="stack">
        <h2>Host earnings per month</h2>
        {[["Off-app, one fixed commuter", y.static_off_app_commuter_monthly_inr, ""], ["On ParkGrid, many drivers", y.dynamic_multi_user_on_app_monthly_inr, "hot"]].map(([l, v, k]) => (
          <div key={l} className="bar-row">
            <div className="row-between"><span>{l}</span><strong className="num">{inr(v)}</strong></div>
            <div className="bar"><i className={k} style={{ "--w": `${(v / max) * 100}%` }} /></div>
          </div>
        ))}
        <p className="muted num">+{y.host_upside_pct}% host upside, with ₹{y.active_micro_insurance_per_session_inr.toLocaleString("en-IN")} cover on every session.</p>
      </Reveal>
      <Reveal delay={130} className="stack">
        <h2><ShieldCheck size={18} aria-hidden /> Gate security log</h2>
        {logs.length === 0 ? (
          <div className="empty"><strong>No gate passes yet</strong><p className="muted">Book an RWA bay and the plate shows up here for the guard.</p></div>
        ) : (
          <div className="table-wrap">
            <table className="num">
              <thead><tr><th>Time</th><th>Plate</th><th>Vehicle</th><th>Bay</th><th>Gate</th></tr></thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.booking_id}><td>{hhmm(l.timestamp_utc)}</td><td>{l.rc_number}</td><td>{l.vehicle_model}</td><td>{l.slot_id}</td><td>Whitelisted</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Reveal>
    </>
  );
}

// Parking adaptations of Skiper 3, 26, 37, 58, 61, 87, 99 and 106.
import { useEffect, useState } from 'react';
import { ArrowUpRight, Moon, Sun, Sparkles, X } from 'lucide-react';
import { api } from './api.js';

export function TextRoll({ children }) {
  return <span className="text-roll"><span>{children}</span><span aria-hidden="true">{children}</span></span>;
}
export function ThemeToggle() {
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('parkgrid-theme') === 'dark'; } catch { return false; } });
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; try { localStorage.setItem('parkgrid-theme', dark ? 'dark' : 'light'); } catch {} }, [dark]);
  return <button className="theme-toggle" aria-label={`Switch to ${dark ? 'light' : 'dark'} theme`} aria-pressed={dark} onClick={() => setDark(!dark)}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button>;
}
export function AnimatedNumber({ value }) {
  return <span className="animated-number num" key={value}>{value}</span>;
}
export function SmoothInput(props) {
  return <input {...props} className={`smooth-input ${props.className || ''}`} />;
}
export function AnimatedArrow() { return <ArrowUpRight className="animated-arrow" size={18} aria-hidden="true"/>; }
export function SessionPill({ booking }) {
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  if (!booking) return null;
  const mins = Math.max(0, Math.ceil((Date.parse(booking.booked_end_utc) - now) / 60000));
  return <button className="session-pill" aria-expanded={open} onClick={() => setOpen(!open)}><i/> <AnimatedNumber value={mins}/> min left {open && <span>· Bay {booking.slot_id} · {booking.status}</span>}</button>;
}
export function ParkingAssistant({ spots, onSelect }) {
  const [open, setOpen] = useState(false), [q, setQ] = useState(''), [answer, setAnswer] = useState(null), [busy, setBusy] = useState(false);
  const candidates = spots.filter(s => s.fits_vehicle && s.occupancy_status === 'VACANT');
  async function ask(e) {
    e.preventDefault(); if (!q.trim() || busy) return;
    setBusy(true);
    try { setAnswer(await api.assistant(q)); }
    catch (e) { setAnswer({ source: 'Connection error', answer: e.message }); }
    finally { setBusy(false); }
  }
  return <div className="assistant-wrap">
    {open && <section className="assistant-card" aria-label="Parking assistant">
      <div className="row-between"><h2><Sparkles size={17}/> Your parking copilot</h2><button className="icon-btn" aria-label="Close assistant" onClick={() => setOpen(false)}><X size={18}/></button></div>
      <p className="muted">Ask about parking, pricing or check-in. Recommendations below use bay availability and vehicle fit.</p>
      <div className="fade-scroll">{candidates.length ? [...candidates].sort((a,b) => a.hourly_rate_inr - b.hourly_rate_inr).map(s => <button className="assistant-spot" key={s.slot_id} onClick={() => { onSelect(s.slot_id); setOpen(false); }}><span>{s.title}</span><strong>₹{s.hourly_rate_inr}/hr</strong><AnimatedArrow/></button>) : <p className="muted">No compatible vacant bays in this search.</p>}</div>
      <form onSubmit={ask} className="assistant-form"><SmoothInput aria-label="Ask the parking assistant" placeholder="How does check-in work?" maxLength={1000} value={q} onChange={e => setQ(e.target.value)}/><button className="icon-btn" disabled={busy || !q.trim()} aria-label="Send question"><AnimatedArrow/></button></form>
      {busy && <p role="status">Thinking…</p>}{answer && <div className="assistant-answer" aria-live="polite"><small>{answer.source}</small><p>{answer.answer}</p></div>}
    </section>}
    <button className="copilot-trigger" aria-expanded={open} onClick={() => setOpen(!open)}><Sparkles size={18}/><TextRoll>Parking copilot</TextRoll><span className="copilot-plus">{open ? '−' : '+'}</span></button>
  </div>;
}

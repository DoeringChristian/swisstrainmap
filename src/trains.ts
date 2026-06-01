import type { DayData } from './types';

/**
 * Each journey is reduced to a list of timed events alternating between
 * (depart stop i, arrive stop i+1, depart stop i+1, …) along the path. The
 * interpolator at time t finds the segment between consecutive events and
 * either lerps (different coords → train is moving) or stays put (same
 * coords → train is dwelling at a stop).
 *
 * Times are minutes since the operating-day midnight. NaN events are
 * dropped, so a journey with sparse data still works as long as ≥ 2 events
 * remain.
 */
type Event = {
  t: number;
  lon: number;
  lat: number;
  /** delay (minutes) at this event */
  delay: number;
};

export type CompiledJourney = {
  id: string;
  line: string;
  events: Event[];
  start: number;
  end: number;
};

export function compile(data: DayData): CompiledJourney[] {
  const out: CompiledJourney[] = [];
  for (const j of data.journeys) {
    const n = j.stops.length;
    if (n < 2) continue;

    // Resolve coordinates; abort the journey if any stop has none.
    const coords: [number, number][] = new Array(n);
    let bad = false;
    for (let i = 0; i < n; i++) {
      const c = data.stations[j.stops[i].bpuic];
      if (!c) {
        bad = true;
        break;
      }
      coords[i] = c;
    }
    if (bad) continue;

    // Walk stops, carry the last known delay forward across NaN slots.
    let lastDelay = 0;
    const events: Event[] = [];
    for (let i = 0; i < n; i++) {
      const s = j.stops[i];
      const [lon, lat] = coords[i];

      const sa = s.schedArr;
      if (sa != null) {
        if (s.actArr != null) lastDelay = s.actArr - sa;
        const t = sa + lastDelay;
        if (i > 0 && Number.isFinite(t)) {
          events.push({ t, lon, lat, delay: lastDelay });
        }
      }
      const sd = s.schedDep;
      if (sd != null) {
        if (s.actDep != null) lastDelay = s.actDep - sd;
        const t = sd + lastDelay;
        if (i < n - 1 && Number.isFinite(t)) {
          events.push({ t, lon, lat, delay: lastDelay });
        }
      }
    }

    if (events.length < 2) continue;
    // Operating-day rollover can put later stops slightly before earlier
    // ones in wall-clock terms (or sloppy data). Stable-sort just in case.
    events.sort((a, b) => a.t - b.t);

    out.push({
      id: j.id,
      line: j.line,
      events,
      start: events[0].t,
      end: events[events.length - 1].t,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export type Snapshot = {
  lon: number;
  lat: number;
  delay: number;
  line: string;
  id: string;
};

export function snapshot(journeys: CompiledJourney[], t: number): Snapshot[] {
  const snaps: Snapshot[] = [];
  for (const j of journeys) {
    if (t < j.start || t > j.end) continue;
    const ev = j.events;
    // Linear scan — events.length is small (<60 in practice).
    let k = 0;
    while (k < ev.length - 1 && ev[k + 1].t <= t) k++;
    const a = ev[k];
    const b = ev[k + 1] ?? a;
    const span = b.t - a.t;
    const p = span > 0 ? (t - a.t) / span : 0;
    const q = p < 0 ? 0 : p > 1 ? 1 : p;
    const lon = a.lon + (b.lon - a.lon) * q;
    const lat = a.lat + (b.lat - a.lat) * q;
    const delay = a.delay + (b.delay - a.delay) * q;
    snaps.push({ lon, lat, delay, line: j.line, id: j.id });
  }
  return snaps;
}

/** Map delay (minutes) → r,g,b. 0 → green, ≥ maxDelay → red, through yellow. */
export function delayColor(
  delay: number,
  maxDelay: number,
): [number, number, number] {
  const d = delay < 0 ? 0 : delay;
  const t = Math.min(1, d / Math.max(0.01, maxDelay));
  if (t < 0.5) {
    const u = t / 0.5;
    return [
      Math.round(60 + (240 - 60) * u),
      200,
      Math.round(120 + (80 - 120) * u),
    ];
  }
  const u = (t - 0.5) / 0.5;
  return [
    Math.round(240 + (220 - 240) * u),
    Math.round(200 + (60 - 200) * u),
    Math.round(80 + (60 - 80) * u),
  ];
}

export function formatTime(minutes: number): string {
  const m = Math.floor(minutes);
  const hh = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

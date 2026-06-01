import { useEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './MapView';
import { compile, formatTime, snapshot } from './trains';
import type { DayData } from './types';

const DAY_MIN = 24 * 60;

export function App() {
  const [data, setData] = useState<DayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(8 * 60); // 08:00 default
  const [maxDelay, setMaxDelay] = useState(30);
  const [playing, setPlaying] = useState(false);
  /** simulated minutes per real second */
  const [speed, setSpeed] = useState(30);

  useEffect(() => {
    fetch('/day.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: DayData) => setData(d))
      .catch((e) => setError(String(e)));
  }, []);

  const compiled = useMemo(() => (data ? compile(data) : []), [data]);
  const snapshots = useMemo(
    () => (compiled.length ? snapshot(compiled, time) : []),
    [compiled, time],
  );

  // rAF loop driving auto-play. Speed is read via a ref so dragging the
  // speed slider mid-play doesn't restart the loop and skip a frame.
  const speedRef = useRef(speed);
  speedRef.current = speed;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => {
        const next = t + dt * speedRef.current;
        if (next >= DAY_MIN - 1) {
          setPlaying(false);
          return DAY_MIN - 1;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  if (error) {
    return (
      <div className="loading">
        Could not load day.json — did you run <code>npm run build-day</code>?
        <br />
        {error}
      </div>
    );
  }
  if (!data) {
    return <div className="loading">Loading…</div>;
  }

  const atEnd = time >= DAY_MIN - 1;

  return (
    <div className="app">
      <MapView snapshots={snapshots} maxDelay={maxDelay} />
      <div className="panel">
        <h1>Swiss trains — {data.date}</h1>
        <div className="row">
          <button
            className="play"
            onClick={() => {
              if (atEnd) setTime(0);
              setPlaying((p) => !p);
            }}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? '❚❚' : atEnd ? '⟲' : '▶'}
          </button>
          <input
            id="time"
            type="range"
            min={0}
            max={DAY_MIN - 1}
            step={1}
            value={time}
            onChange={(e) => {
              setPlaying(false);
              setTime(Number(e.target.value));
            }}
          />
          <span className="value">{formatTime(time)}</span>
        </div>
        <div className="row">
          <label htmlFor="speed">Speed</label>
          <input
            id="speed"
            type="range"
            min={1}
            max={240}
            step={1}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
          <span className="value">{speed}×</span>
        </div>
        <div className="row">
          <label htmlFor="max">Red at</label>
          <input
            id="max"
            type="number"
            min={1}
            max={120}
            step={1}
            value={maxDelay}
            onChange={(e) =>
              setMaxDelay(Math.max(1, Number(e.target.value) || 1))
            }
          />
          <span className="value">min</span>
        </div>
        <div className="stat">
          {snapshots.length.toLocaleString()} trains running ·{' '}
          {data.journeys.length.toLocaleString()} journeys in dataset
        </div>
      </div>
      <div className="legend">
        <span>0 min</span>
        <div className="bar" />
        <span>{maxDelay}+ min</span>
      </div>
    </div>
  );
}

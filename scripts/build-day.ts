/**
 * Downloads one day of opentransportdata.swiss Ist-Daten + the Swiss
 * service-point list, joins them, filters to trains, and emits a compact
 * public/day.json the React app can load directly.
 *
 * Usage:
 *   npm run build-day                   # uses DEFAULT_DATE
 *   npm run build-day -- 2026-05-15     # specific date
 *   npm run build-day -- 2026-05-15 https://.../2026-05-15_istdaten.csv
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CACHE_DIR = resolve(ROOT, '.cache');
const OUT = resolve(ROOT, 'public', 'day.json');

const ISTDATEN_DATASET_URL =
  'https://data.opentransportdata.swiss/dataset/istdaten';
const STATIONS_URL =
  'https://data.sbb.ch/api/explore/v2.1/catalog/datasets/dienststellen-gemass-opentransportdataswiss/exports/json' +
  '?limit=-1&select=number,geopos,isocountrycode&where=isocountrycode%20%3D%20%22CH%22';

type StopEvent = {
  /** scheduled arrival, minutes since midnight on operating day; null if first stop */
  schedArr: number | null;
  /** actual arrival, minutes since midnight; null if no measurement */
  actArr: number | null;
  schedDep: number | null;
  actDep: number | null;
  bpuic: number;
};

type Journey = {
  id: string;
  line: string;
  stops: StopEvent[];
};

function parseTime(operatingDay: string, dt: string): number | null {
  // operatingDay format: DD.MM.YYYY
  // dt format: "DD.MM.YYYY HH:MM" or "DD.MM.YYYY HH:MM:SS"
  if (!dt) return null;
  const [date, time] = dt.split(' ');
  if (!date || !time) return null;
  const [h, m] = time.split(':');
  const hours = Number(h);
  const minutes = Number(m);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  let total = hours * 60 + minutes;
  // If the event is on a later operating day (overnight trains), add 1440.
  if (date !== operatingDay) {
    const [dDay, dMon, dYear] = date.split('.').map(Number);
    const [oDay, oMon, oYear] = operatingDay.split('.').map(Number);
    const eventDate = new Date(Date.UTC(dYear, dMon - 1, dDay));
    const opDate = new Date(Date.UTC(oYear, oMon - 1, oDay));
    const dayDiff = Math.round((+eventDate - +opDate) / 86_400_000);
    total += dayDiff * 1440;
  }
  return total;
}

async function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

async function download(url: string, dest: string): Promise<void> {
  console.log(`  → ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'swiss-train-delay-map prep-script' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

/**
 * Fetches the dataset index page and returns every (date, url) currently
 * listed there, newest first.
 */
async function listIstdatenLinks(): Promise<{ date: string; url: string }[]> {
  const res = await fetch(ISTDATEN_DATASET_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 swiss-train-delay-map prep-script' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${ISTDATEN_DATASET_URL}`);
  }
  const html = await res.text();
  const re =
    /https:\/\/data\.opentransportdata\.swiss\/dataset\/[^"]+\/download\/(\d{4}-\d{2}-\d{2})_istdaten\.csv/gi;
  const seen = new Map<string, string>();
  for (const m of html.matchAll(re)) {
    if (!seen.has(m[1])) seen.set(m[1], m[0]);
  }
  return [...seen.entries()]
    .map(([date, url]) => ({ date, url }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

async function findIstdatenUrl(date: string): Promise<string> {
  console.log(`Looking up Ist-Daten resource URL for ${date}…`);
  const links = await listIstdatenLinks();
  const hit = links.find((l) => l.date === date);
  if (!hit) {
    const available = links
      .slice(0, 5)
      .map((l) => l.date)
      .join(', ');
    throw new Error(
      `Could not find a CSV link for ${date} on the dataset page. ` +
        `Most recent available: ${available}. ` +
        `Pass an available date or the URL as arguments.`,
    );
  }
  return hit.url;
}

/** Resolves the most recent date that's currently published in the archive. */
async function findLatestDate(): Promise<{ date: string; url: string }> {
  console.log(`Looking up most recent Ist-Daten date…`);
  const links = await listIstdatenLinks();
  if (links.length === 0) {
    throw new Error('No Ist-Daten CSV links found on the dataset page.');
  }
  console.log(`  Latest available: ${links[0].date}`);
  return links[0];
}

async function loadStations(): Promise<Map<number, [number, number]>> {
  const cached = resolve(CACHE_DIR, 'stations.json');
  if (!existsSync(cached)) {
    console.log('Downloading Swiss service-point list…');
    await download(STATIONS_URL, cached);
  } else {
    console.log('Using cached station list.');
  }
  type Row = {
    number: number;
    geopos: { lon: number; lat: number } | null;
  };
  const rows: Row[] = JSON.parse(await readFile(cached, 'utf8'));
  const map = new Map<number, [number, number]>();
  for (const r of rows) {
    if (r.geopos && Number.isFinite(r.number)) {
      map.set(r.number, [r.geopos.lon, r.geopos.lat]);
    }
  }
  console.log(`  ${map.size} stations with coordinates.`);
  return map;
}

async function buildDay(date: string, urlOverride?: string) {
  await ensureDir(CACHE_DIR);
  await ensureDir(resolve(ROOT, 'public'));

  const csvCache = resolve(CACHE_DIR, `${date}_istdaten.csv`);
  if (!existsSync(csvCache)) {
    const url = urlOverride ?? (await findIstdatenUrl(date));
    console.log(`Downloading Ist-Daten for ${date}…`);
    await download(url, csvCache);
  } else {
    console.log(`Using cached CSV ${csvCache}`);
  }

  const stations = await loadStations();

  console.log('Parsing CSV…');
  // The CSV is large enough (~230 MB) that readFile('utf8') trips V8's
  // max string length on the GH Actions runner. Stream line-by-line.
  const rl = createInterface({
    input: createReadStream(csvCache, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let header: string[] | null = null;
  let iDay = -1,
    iId = -1,
    iProd = -1,
    iLine = -1,
    iCancel = -1,
    iBpuic = -1,
    iSchedArr = -1,
    iActArr = -1,
    iActArrStatus = -1,
    iSchedDep = -1,
    iActDep = -1,
    iActDepStatus = -1;

  const journeys = new Map<string, Journey>();
  const operatingDayDots = date.split('-').reverse().join('.'); // DD.MM.YYYY

  let kept = 0;
  let skippedProduct = 0;
  let skippedCancel = 0;
  let skippedDay = 0;
  let skippedStation = 0;

  for await (const line of rl) {
    if (!line) continue;
    if (header === null) {
      header = line.split(';');
      const col = (name: string) => {
        const i = header!.indexOf(name);
        if (i < 0) throw new Error(`Missing column ${name} in header`);
        return i;
      };
      iDay = col('BETRIEBSTAG');
      iId = col('FAHRT_BEZEICHNER');
      iProd = col('PRODUKT_ID');
      iLine = col('LINIEN_TEXT');
      iCancel = col('FAELLT_AUS_TF');
      iBpuic = col('BPUIC');
      iSchedArr = col('ANKUNFTSZEIT');
      iActArr = col('AN_PROGNOSE');
      iActArrStatus = col('AN_PROGNOSE_STATUS');
      iSchedDep = col('ABFAHRTSZEIT');
      iActDep = col('AB_PROGNOSE');
      iActDepStatus = col('AB_PROGNOSE_STATUS');
      continue;
    }
    const f = line.split(';');
    if (f.length < header.length) continue;
    if (f[iDay] !== operatingDayDots) {
      skippedDay++;
      continue;
    }
    if (f[iProd] !== 'Zug') {
      skippedProduct++;
      continue;
    }
    if (f[iCancel] === 'true') {
      skippedCancel++;
      continue;
    }
    const bpuic = Number(f[iBpuic]);
    if (!stations.has(bpuic)) {
      skippedStation++;
      continue;
    }

    // Only trust actual times when status is REAL (measured). Otherwise leave null.
    const actArr =
      f[iActArrStatus] === 'REAL'
        ? parseTime(operatingDayDots, f[iActArr])
        : null;
    const actDep =
      f[iActDepStatus] === 'REAL'
        ? parseTime(operatingDayDots, f[iActDep])
        : null;
    const stop: StopEvent = {
      bpuic,
      schedArr: parseTime(operatingDayDots, f[iSchedArr]),
      schedDep: parseTime(operatingDayDots, f[iSchedDep]),
      actArr,
      actDep,
    };
    if (stop.schedArr == null && stop.schedDep == null) continue;

    const id = f[iId];
    let j = journeys.get(id);
    if (!j) {
      j = { id, line: f[iLine] || '', stops: [] };
      journeys.set(id, j);
    }
    j.stops.push(stop);
    kept++;
  }

  if (header === null) {
    throw new Error('CSV had no header row');
  }

  // Sort stops within each journey by scheduled time and drop singletons.
  const result: Journey[] = [];
  for (const j of journeys.values()) {
    j.stops.sort((a, b) => {
      const ta = a.schedDep ?? a.schedArr ?? 0;
      const tb = b.schedDep ?? b.schedArr ?? 0;
      return ta - tb;
    });
    if (j.stops.length >= 2) result.push(j);
  }

  // Collect station coords for only the BPUICs we actually reference.
  const usedStations: Record<number, [number, number]> = {};
  for (const j of result) {
    for (const s of j.stops) {
      if (!(s.bpuic in usedStations)) {
        usedStations[s.bpuic] = stations.get(s.bpuic)!;
      }
    }
  }

  const output = {
    date,
    stations: usedStations,
    journeys: result,
  };

  await writeFile(OUT, JSON.stringify(output));
  const bytes = (await readFile(OUT)).length;

  console.log('');
  console.log(`Parsed:`);
  console.log(`  kept stop events:   ${kept.toLocaleString()}`);
  console.log(`  skipped non-train:  ${skippedProduct.toLocaleString()}`);
  console.log(`  skipped cancelled:  ${skippedCancel.toLocaleString()}`);
  console.log(`  skipped wrong day:  ${skippedDay.toLocaleString()}`);
  console.log(`  skipped no coords:  ${skippedStation.toLocaleString()}`);
  console.log(`Journeys:             ${result.length.toLocaleString()}`);
  console.log(`Stations referenced:  ${Object.keys(usedStations).length.toLocaleString()}`);
  console.log(`Wrote ${OUT} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
}

const [, , dateArg, urlArg] = process.argv;

async function main() {
  if (dateArg) {
    await buildDay(dateArg, urlArg);
  } else {
    const latest = await findLatestDate();
    await buildDay(latest.date, latest.url);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

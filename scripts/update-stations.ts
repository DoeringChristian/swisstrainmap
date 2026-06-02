/**
 * Refresh data/stations.json — a compact BPUIC → [lon, lat] dict baked
 * into the repo so build-day.ts doesn't depend on data.sbb.ch reachability
 * at CI time. The full service-point list rarely changes; run this only
 * when you want to pick up new stops.
 */
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'data', 'stations.json');

const URL =
  'https://data.sbb.ch/api/explore/v2.1/catalog/datasets/dienststellen-gemass-opentransportdataswiss/exports/json' +
  '?limit=-1&select=number,geopos,isocountrycode&where=isocountrycode%20%3D%20%22CH%22';

type Row = {
  number: number;
  geopos: { lon: number; lat: number } | null;
};

async function main() {
  console.log(`Downloading from ${URL}`);
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'swiss-train-delay-map update-stations' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const rows = (await res.json()) as Row[];
  const out: Record<number, [number, number]> = {};
  for (const r of rows) {
    if (r.geopos && Number.isFinite(r.number)) {
      out[r.number] = [
        +r.geopos.lon.toFixed(5),
        +r.geopos.lat.toFixed(5),
      ];
    }
  }
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT} (${Object.keys(out).length} stations)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

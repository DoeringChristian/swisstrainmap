import { useEffect, useRef } from 'react';
import maplibregl, { Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { delayColor, type Snapshot } from './trains';

const SWISS_CENTER: [number, number] = [8.23, 46.82];

const RASTER_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: {
        // Slight desaturation/dim so train dots pop.
        'raster-saturation': -0.4,
        'raster-brightness-min': 0.2,
        'raster-brightness-max': 0.85,
      },
    },
  ],
};

type Props = {
  snapshots: Snapshot[];
  maxDelay: number;
};

export function MapView({ snapshots, maxDelay }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: RASTER_STYLE,
      center: SWISS_CENTER,
      zoom: 7.2,
      minZoom: 6,
      maxZoom: 14,
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('trains', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'trains',
        type: 'circle',
        source: 'trains',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            2.5,
            10,
            4.5,
            13,
            7,
          ],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#111',
          'circle-stroke-width': 0.6,
          'circle-opacity': 0.95,
        },
      });
      readyRef.current = true;
      // Trigger an initial paint with whatever snapshots prop is current.
      updateSource(map, snapshotsRef.current, maxDelayRef.current);
    });

    return () => {
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep latest props in refs so the map-load callback can read them.
  const snapshotsRef = useRef(snapshots);
  const maxDelayRef = useRef(maxDelay);
  snapshotsRef.current = snapshots;
  maxDelayRef.current = maxDelay;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    updateSource(map, snapshots, maxDelay);
  }, [snapshots, maxDelay]);

  return <div ref={containerRef} className="map" />;
}

function updateSource(map: MLMap, snaps: Snapshot[], maxDelay: number) {
  const features = new Array(snaps.length);
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    const [r, g, b] = delayColor(s.delay, maxDelay);
    features[i] = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        color: `rgb(${r},${g},${b})`,
        delay: s.delay,
        line: s.line,
        id: s.id,
      },
    };
  }
  const src = map.getSource('trains') as maplibregl.GeoJSONSource | undefined;
  src?.setData({ type: 'FeatureCollection', features });
}

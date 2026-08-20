import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import './style.css';
import {
  DEMO_BASEMAP_PMTILES_URL,
  FALLBACK_TERRAIN_RASTER_DEM_URL,
  GLYPHS_URL,
  SPRITE_URL,
} from './config';
import { bootstrapStorage, isStandalone } from './storage';
import { mountOpfsSpike } from './opfs-spike';

// C17: maplibregl.addProtocol must be called exactly once in the app lifecycle.
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="map"></div>
  <div id="status-panel"></div>
`;

const statusPanel = document.querySelector<HTMLDivElement>('#status-panel')!;

const map = new maplibregl.Map({
  container: 'map',
  center: [-0.12, 51.5],
  zoom: 10,
  style: {
    version: 8,
    glyphs: GLYPHS_URL,
    sprite: SPRITE_URL,
    sources: {
      basemap: {
        type: 'vector',
        url: `pmtiles://${DEMO_BASEMAP_PMTILES_URL}`,
        attribution:
          '<a href="https://openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
      },
      'terrain-fallback': {
        type: 'raster-dem',
        tiles: [FALLBACK_TERRAIN_RASTER_DEM_URL],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 15,
        attribution: 'Terrain: AWS Open Data Terrain Tiles',
      },
    },
    layers: [
      ...layers('basemap', namedFlavor('light'), { lang: 'en' }),
      { id: 'hillshade', type: 'hillshade', source: 'terrain-fallback' },
    ],
  },
});

map.addControl(new maplibregl.NavigationControl());

map.on('error', (e) => {
  showStatus(`Map error: ${e.error?.message ?? 'unknown'} — see console`, 'error');
  console.error('MapLibre error', e.error);
});

mountOpfsSpike(statusPanel, { protocol, map });
void renderStorageStatus();

async function renderStorageStatus(): Promise<void> {
  const status = await bootstrapStorage();
  if (!status.supported) {
    showStatus('Storage API unsupported — persistent storage cannot be guaranteed (C1).', 'warn');
  } else if (!status.persisted) {
    showStatus(
      isStandalone()
        ? 'navigator.storage.persist() was denied. Region downloads must stay blocked (C1).'
        : 'Not installed to Home Screen — persist() is unlikely to be granted (C2). Add to Home Screen, then reload.',
      'warn',
    );
  } else {
    showStatus('Persistent storage granted — offline downloads are safe to start.', 'ok');
  }
}

function showStatus(message: string, kind: 'ok' | 'warn' | 'error'): void {
  const el = document.createElement('div');
  el.className = `status-card ${kind}`;
  el.textContent = message;
  statusPanel.prepend(el);
}

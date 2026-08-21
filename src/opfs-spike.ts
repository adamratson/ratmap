import { FileSource, PMTiles, TileType, type Header, type Protocol } from 'pmtiles';
import type { Map as MLMap } from 'maplibre-gl';

// Phase 0 §2 spike harness — not app UI. Exercises:
//   spike 2: OPFS -> getFile() -> FileSource -> Protocol.add() serving a local archive
//   spike 4: sustained OPFS write throughput for a multi-GB-scale download
// Run this on a real iPhone (not desktop Safari or the simulator, per §4 Phase 0.3) with
// a real .pmtiles file to actually validate the spike, then check behavior after
// backgrounding and resuming the app.
//
// On success the camera flies to the archive's own bounds and draws its content in a
// flat, schema-agnostic color (SPIKE_COLOR below) — otherwise there'd be nothing to
// look at: a source with no layers renders invisibly, and the camera never moves
// toward whatever region you just loaded.

const SPIKE_COLOR = '#ff00c8';

function extractVectorLayerIds(metadata: unknown): string[] {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('vector_layers' in metadata) ||
    !Array.isArray((metadata as { vector_layers: unknown }).vector_layers)
  ) {
    return [];
  }
  return (metadata as { vector_layers: Array<{ id?: unknown }> }).vector_layers
    .map((layer) => layer.id)
    .filter((id): id is string => typeof id === 'string');
}

// Schema-agnostic rendering: an arbitrary uploaded archive's real layer names and
// styling are unknown, so this isn't "the" style — it's just enough to prove the
// loaded archive is what's on screen (bright, unmissable color) rather than adding
// a source with nothing visibly drawn from it.
function addGenericLayers(map: MLMap, sourceId: string, tileType: TileType, metadata: unknown): void {
  if (tileType === TileType.Mvt) {
    for (const layerId of extractVectorLayerIds(metadata)) {
      // Outlines only, deliberately no fill: a real extract can have many
      // overlapping vector_layers (buildings, parcels, ...), and even a low-opacity
      // fill on each stacks into a solid block that buries the base map's labels.
      map.addLayer({
        id: `${sourceId}-line-${layerId}`,
        type: 'line',
        source: sourceId,
        'source-layer': layerId,
        paint: { 'line-color': SPIKE_COLOR, 'line-width': 1, 'line-opacity': 0.7 },
      });
      map.addLayer({
        id: `${sourceId}-circle-${layerId}`,
        type: 'circle',
        source: sourceId,
        'source-layer': layerId,
        paint: { 'circle-color': SPIKE_COLOR, 'circle-radius': 3 },
      });
    }
  } else {
    // Png/Jpeg/Webp/Avif: assume terrarium-encoded terrain and render real hillshade,
    // not a flat raster preview. This project only ever ships raster PMTiles as DEM
    // (see config.ts / FALLBACK_TERRAIN_RASTER_DEM_URL) — a non-DEM raster archive
    // would just hillshade into visual noise here, which is an acceptable trade-off
    // for what this spike exists to prove (§2 spike 1: raster-dem fed by pmtiles://,
    // rendering hillshade in iOS Safari). SPIKE_COLOR tint keeps this visually
    // distinct from any other hillshade layer already on the map (e.g. the AWS
    // fallback), so it's unambiguous that what's rendering came from the loaded file.
    map.addLayer({
      id: `${sourceId}-hillshade`,
      type: 'hillshade',
      source: sourceId,
      paint: {
        'hillshade-shadow-color': SPIKE_COLOR,
        'hillshade-accent-color': SPIKE_COLOR,
      },
    });
  }
}

function flyToArchive(map: MLMap, header: Header): void {
  map.fitBounds(
    [
      [header.minLon, header.minLat],
      [header.maxLon, header.maxLat],
    ],
    { padding: 40, duration: 0 },
  );
}

export interface OpfsSpikeDeps {
  protocol: Protocol;
  map: MLMap;
}

export function mountOpfsSpike(container: HTMLElement, deps: OpfsSpikeDeps): void {
  const card = document.createElement('div');
  card.className = 'status-card';
  card.innerHTML = `
    <div>OPFS spike (§2 items 2 &amp; 4): pick a local .pmtiles file</div>
    <input type="file" accept=".pmtiles" />
    <div class="spike-result"></div>
  `;
  container.prepend(card);

  const input = card.querySelector('input')!;
  const result = card.querySelector<HTMLDivElement>('.spike-result')!;

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void runSpike(file, deps, result);
  });
}

export async function runSpike(
  file: File,
  deps: OpfsSpikeDeps,
  result: HTMLDivElement,
): Promise<void> {
  result.textContent = 'Writing to OPFS…';
  try {
    const { key, ms, bytesPerSecond } = await writeToOpfs(file);
    result.textContent = `Wrote ${(file.size / 1e6).toFixed(1)} MB in ${(ms / 1000).toFixed(1)}s (${(bytesPerSecond / 1e6).toFixed(1)} MB/s). Loading…`;

    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(key);
    const opfsFile = await handle.getFile();

    // C3: FileSource.getKey() returns file.name — this is the registration key.
    const pmtiles = new PMTiles(new FileSource(opfsFile));
    deps.protocol.add(pmtiles);
    const header = await pmtiles.getHeader();

    const sourceId = `opfs-${key}`;
    const isNewSource = !deps.map.getSource(sourceId);
    if (isNewSource) {
      if (header.tileType === TileType.Mvt) {
        deps.map.addSource(sourceId, { type: 'vector', url: `pmtiles://${key}` });
      } else {
        // See addGenericLayers: raster PMTiles are assumed to be terrarium DEM.
        deps.map.addSource(sourceId, {
          type: 'raster-dem',
          url: `pmtiles://${key}`,
          encoding: 'terrarium',
        });
      }
      const metadata = await pmtiles.getMetadata();
      addGenericLayers(deps.map, sourceId, header.tileType, metadata);
    }
    flyToArchive(deps.map, header);

    result.textContent =
      `OK — registered as pmtiles://${key} (source "${sourceId}", generic layers in ${SPIKE_COLOR}). ` +
      `zoom ${header.minZoom}-${header.maxZoom}. Write throughput: ${(bytesPerSecond / 1e6).toFixed(1)} MB/s.`;
  } catch (err) {
    result.textContent = `Failed: ${(err as Error).message}`;
    console.error('OPFS spike failed', err);
  }
}

export async function writeToOpfs(
  file: File,
): Promise<{ key: string; ms: number; bytesPerSecond: number }> {
  if (!navigator.storage?.getDirectory) {
    throw new Error('OPFS (navigator.storage.getDirectory) unsupported in this browser');
  }
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(file.name, { create: true });
  const writable = await handle.createWritable();

  // Chunked rather than a single write(file) call, both to get a throughput
  // reading (spike 4) and because this is the shape a resumable downloader
  // (C12, Phase 4) will need.
  const chunkSize = 8 * 1024 * 1024;
  const start = performance.now();
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    await writable.write(file.slice(offset, offset + chunkSize));
  }
  await writable.close();
  const ms = performance.now() - start;

  return { key: file.name, ms, bytesPerSecond: ms > 0 ? (file.size / ms) * 1000 : 0 };
}

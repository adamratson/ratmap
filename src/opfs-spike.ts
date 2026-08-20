import { FileSource, PMTiles, type Protocol } from 'pmtiles';
import type { Map as MLMap } from 'maplibre-gl';

// Phase 0 §2 spike harness — not app UI. Exercises:
//   spike 2: OPFS -> getFile() -> FileSource -> Protocol.add() serving a local archive
//   spike 4: sustained OPFS write throughput for a multi-GB-scale download
// Run this on a real iPhone (not desktop Safari or the simulator, per §4 Phase 0.3) with
// a real .pmtiles file to actually validate the spike, then check behavior after
// backgrounding and resuming the app.

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
    if (!deps.map.getSource(sourceId)) {
      deps.map.addSource(sourceId, { type: 'vector', url: `pmtiles://${key}` });
    }
    // Deliberately not adding style layers: an arbitrary uploaded archive's schema
    // is unknown, and wiring real layers is Phase 1/2 work once our own pinned
    // archives exist. This only proves the OPFS -> FileSource -> Protocol.add() ->
    // registered-source path (spike 2).
    result.textContent =
      `OK — registered as pmtiles://${key} (source "${sourceId}" added, no layers). ` +
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

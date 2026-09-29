import type { Region } from '../regions/manifest';
import { getArtifactFile } from '../regions/opfs-store';
import type { RegionIndex } from './search';

/**
 * The search indexes of the regions on this device, read from OPFS on demand.
 *
 * `regions` should be what is actually downloaded (RegionCoverage.downloadedRegions),
 * whose artifacts are narrowed to the files present — so a region downloaded before its
 * index existed simply contributes none until it is updated.
 */
export function regionSearchIndexes(regions: Region[]): RegionIndex[] {
  return regions.flatMap((region) =>
    region.artifacts
      .filter((artifact) => artifact.kind === 'places')
      .map((artifact) => ({
        filename: artifact.filename,
        read: async () => (await getArtifactFile(artifact.filename))?.arrayBuffer() ?? null,
      })),
  );
}

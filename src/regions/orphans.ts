import type { Region } from './manifest';
import { deleteArtifact, getArtifactFile, listArtifactNames, partialName } from './opfs-store';

// Archives in OPFS that the catalogue no longer lists.
//
// Every other path in this app reaches a downloaded region through the manifest: the sheet
// renders manifest regions, `regionStatus` asks whether a manifest region's files are
// present, and `deleteRegion` walks a manifest region's artifacts. So an archive whose
// region has been withdrawn from the catalogue becomes unreachable — it keeps its hundreds
// of MB of the storage this whole feature exists to manage, and there is no way to get rid
// of it short of clearing site data, which also takes every route the user has saved.
//
// Withdrawal is a normal event, not a corruption: regions get renamed, superseded by a
// finer subdivision, or dropped when a catalogue is regenerated. The app has to be able to
// clean up after that.

const ARCHIVE_SUFFIX = '.pmtiles';

export interface OrphanRegion {
  /** Region id recovered from the filename — there is no display name to recover. */
  id: string;
  /** Every file in OPFS belonging to it, complete or partial. */
  files: string[];
  bytes: number;
}

/**
 * The region id a downloaded artifact belongs to, or null if the name isn't ours.
 *
 * Filenames are `<region-id>-<kind>.pmtiles` (C3), and ids themselves contain hyphens —
 * `far-eastern-fed-district-n40e110-basemap.pmtiles`. The kind is the part after the last
 * hyphen, which holds for every kind the pipeline emits and any future one that is a
 * single word.
 *
 * Anything unrecognised returns null and is left strictly alone. This code deletes files;
 * guessing at names it does not understand is how it would delete something else's.
 */
export function regionIdOf(filename: string): string | null {
  const name = filename.endsWith('.part') ? filename.slice(0, -'.part'.length) : filename;
  if (!name.endsWith(ARCHIVE_SUFFIX)) return null;

  const stem = name.slice(0, -ARCHIVE_SUFFIX.length);
  const split = stem.lastIndexOf('-');
  if (split <= 0 || split === stem.length - 1) return null;

  return stem.slice(0, split);
}

/**
 * Group the OPFS files no catalogue region claims, by the region id in their name.
 *
 * Pure, so the grouping can be tested without an OPFS: `present` is what the directory
 * holds, `regions` is what the catalogue offers.
 */
export function groupOrphans(present: Iterable<string>, regions: Region[]): Map<string, string[]> {
  const claimed = new Set<string>();
  for (const region of regions) {
    for (const artifact of region.artifacts) {
      claimed.add(artifact.filename);
      claimed.add(partialName(artifact.filename));
    }
  }

  const byRegion = new Map<string, string[]>();
  for (const name of present) {
    if (claimed.has(name)) continue;
    const id = regionIdOf(name);
    if (id === null) continue;
    const files = byRegion.get(id);
    if (files) files.push(name);
    else byRegion.set(id, [name]);
  }
  return byRegion;
}

/**
 * Orphaned regions in OPFS, largest first, with their real sizes.
 *
 * Never throws. This is a cleanup aid at the bottom of the sheet, and the sheet's real job
 * — showing which regions exist and letting them be downloaded — must not fail with it. A
 * browser with no OPFS has no downloads to orphan in the first place, so the empty answer
 * is also the correct one.
 */
export async function findOrphans(regions: Region[]): Promise<OrphanRegion[]> {
  let present: Set<string>;
  try {
    present = await listArtifactNames();
  } catch {
    return [];
  }
  const grouped = groupOrphans(present, regions);

  const orphans: OrphanRegion[] = [];
  for (const [id, files] of grouped) {
    let bytes = 0;
    for (const name of files) {
      try {
        bytes += (await getArtifactFile(name))?.size ?? 0;
      } catch {
        // Unreadable but present: still worth offering to delete, just without a size.
      }
    }
    orphans.push({ id, files: [...files].sort(), bytes });
  }

  // Largest first: the reason to look at this list at all is to reclaim space.
  return orphans.sort((a, b) => b.bytes - a.bytes);
}

export async function deleteOrphan(orphan: OrphanRegion): Promise<void> {
  for (const name of orphan.files) {
    // deleteArtifact removes `<name>` and `<name>.part` together, so a partial file in the
    // list is already handled by its own entry being removed — passing it again is
    // harmless and keeps this loop honest about deleting everything it listed.
    await deleteArtifact(name.endsWith('.part') ? name.slice(0, -'.part'.length) : name);
  }
}

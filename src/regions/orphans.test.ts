import { describe, expect, it } from 'vitest';
import type { Region } from './manifest';
import { groupOrphans, regionIdOf } from './orphans';

function region(id: string, kinds: string[]): Region {
  return {
    id,
    name: id,
    bbox: [0, 0, 1, 1],
    totalBytes: 0,
    artifacts: kinds.map((kind) => ({
      kind,
      filename: `${id}-${kind}.pmtiles`,
      path: `regions/${id}/${id}-${kind}.pmtiles`,
      bytes: 0,
    })),
  };
}

describe('regionIdOf', () => {
  it('recovers the id from an artifact filename', () => {
    expect(regionIdOf('lochaber-basemap.pmtiles')).toBe('lochaber');
    expect(regionIdOf('montenegro-contours.pmtiles')).toBe('montenegro');
  });

  it('keeps hyphens that belong to the id', () => {
    // The catalogue is full of these — grid cells and compass splits both hyphenate.
    expect(regionIdOf('far-eastern-fed-district-n40e110-basemap.pmtiles')).toBe(
      'far-eastern-fed-district-n40e110',
    );
    expect(regionIdOf('us-alaska-e-terrain.pmtiles')).toBe('us-alaska-e');
  });

  it('reads a partial download as its region', () => {
    expect(regionIdOf('scotland-terrain.pmtiles.part')).toBe('scotland');
  });

  it('refuses anything it does not understand', () => {
    // This module deletes files. A name it cannot parse must not be attributed to some
    // region and swept up with it.
    expect(regionIdOf('places.sqlite')).toBeNull();
    expect(regionIdOf('peaks-global.pmtiles.1.crswap')).toBeNull();
    expect(regionIdOf('nokind.pmtiles')).toBeNull();
    expect(regionIdOf('-basemap.pmtiles')).toBeNull();
    expect(regionIdOf('trailing-.pmtiles')).toBeNull();
  });
});

describe('groupOrphans', () => {
  const catalogue = [region('montenegro-region', ['basemap', 'terrain'])];

  it('groups files no catalogue region claims', () => {
    const orphans = groupOrphans(
      [
        'montenegro-region-basemap.pmtiles',
        'montenegro-region-terrain.pmtiles',
        'lochaber-basemap.pmtiles',
        'lochaber-terrain.pmtiles',
        'lochaber-contours.pmtiles',
      ],
      catalogue,
    );

    expect([...orphans.keys()]).toEqual(['lochaber']);
    expect(orphans.get('lochaber')).toHaveLength(3);
  });

  it('leaves every catalogue artifact alone, downloaded or partial', () => {
    const orphans = groupOrphans(
      ['montenegro-region-basemap.pmtiles', 'montenegro-region-terrain.pmtiles.part'],
      catalogue,
    );

    expect(orphans.size).toBe(0);
  });

  it('ignores files that are not region archives', () => {
    const orphans = groupOrphans(['places.sqlite', 'something.1.crswap'], catalogue);
    expect(orphans.size).toBe(0);
  });

  it('collects a half-downloaded withdrawn region too', () => {
    // The case that motivated this: a region withdrawn mid-download leaves a .part file
    // holding just as much space as a finished one, and is just as unreachable.
    const orphans = groupOrphans(['scotland-basemap.pmtiles.part'], catalogue);
    expect(orphans.get('scotland')).toEqual(['scotland-basemap.pmtiles.part']);
  });

  it('treats an empty catalogue as claiming nothing', () => {
    // Not the same as "the catalogue could not be fetched" — the sheet never gets here
    // without a manifest, because everything would look orphaned.
    const orphans = groupOrphans(['lochaber-basemap.pmtiles'], []);
    expect(orphans.get('lochaber')).toEqual(['lochaber-basemap.pmtiles']);
  });
});

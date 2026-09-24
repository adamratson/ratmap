import type { Map as MLMap } from 'maplibre-gl';
import { BASEMAP_MAX_ZOOM } from '../app/config';
import { describeDetailLimit } from '../map/detail-limit';
import { applyAllStoredVisibility } from '../map/layers';
import type { TileSourceRegistry } from '../map/tile-source-registry';
import type { Theme } from '../ui/theme';
import { bestAvailableZoom, fetchManifest, loadCachedManifest, type Region } from './manifest';
import { regionAt, renderFootprints, visibleFootprints, type Footprint } from './region-footprints';
import { restoreDownloadedRegions } from './regions-ui';

// What detail the map has, and where more could come from: the downloaded regions restored
// onto the map, the coverage outlines, and the notice that says when the map is being
// stretched past its data (§8.2 catalog-only makes that reachable).

export interface RegionCoverageOptions {
  map: MLMap;
  registry: TileSourceRegistry;
  theme: () => Theme;
  /** The "Limited detail here" button over the map. */
  notice: HTMLButtonElement;
  /** Tapping the notice. */
  onOpenRegions: () => void;
  /**
   * What went wrong restoring downloaded regions, in words for the user — or null once a
   * restore has gone cleanly. A standing condition rather than a toast: it stays true
   * until something changes it.
   */
  onRestoreProblem?: (message: string | null) => void;
}

export class RegionCoverage {
  private readonly map: MLMap;
  private readonly registry: TileSourceRegistry;
  private readonly theme: () => Theme;
  private readonly notice: HTMLButtonElement;
  private readonly onRestoreProblem?: (message: string | null) => void;

  /**
   * Regions whose archives are actually present in OPFS.
   *
   * The route planner reads its network and its elevation data straight out of these
   * archives (Phase 4), so it needs to know which ones are live — not which ones the
   * catalogue lists.
   */
  private downloaded: Region[] = [];

  /**
   * Everything the catalogue offers, downloaded or not.
   *
   * Kept alongside {@link downloaded} so the map can show where detail *could* come
   * from, not only where it already has some.
   */
  private catalogue: Region[] = [];

  /**
   * The one region the detail notice is currently offering, if any.
   *
   * Drawn alongside the downloaded ones so "get Lochaber" has a visible extent — otherwise
   * the notice names a place without showing how much of the screen it would cover.
   */
  private offeredRegionId: string | null = null;

  // Raised once a downloaded region is loaded: the notice must reflect the best data
  // actually available, not the global catalogue's ceiling, or it would keep claiming
  // "limited detail" over a region the user has just downloaded.
  //
  // Derived from the artifacts' real PMTiles zoom ranges rather than a constant — a
  // hardcoded guess drifts from whatever the pipeline last built and made the notice fire
  // over a fully-downloaded region.
  private maxDataZoom = BASEMAP_MAX_ZOOM;

  /**
   * Whether the style is installed, i.e. whether it will accept sources and layers.
   *
   * Deliberately not `map.isStyleLoaded()`: that is also false while *tiles* are still
   * arriving, which is the normal state for a second or so after every pan, zoom and
   * download. Anything that gated on it and then deferred to `map.once('load', …)` was
   * waiting for an event that had already fired — see drawFootprints, where that combination
   * meant the coverage outlines were never drawn at all on a cold start. What `addSource`
   * actually requires is a ready style, which is precisely when main.ts's installAppLayers
   * marks it.
   */
  private styleReady = false;

  constructor(options: RegionCoverageOptions) {
    this.map = options.map;
    this.registry = options.registry;
    this.theme = options.theme;
    this.notice = options.notice;
    this.onRestoreProblem = options.onRestoreProblem;

    // `move`, not `zoom`: the notice names whichever region covers the map's *centre*
    // (`covering` below), so it has to be re-evaluated on a pure pan too, not only when the
    // zoom level changes — `zoom` alone left the suggested region stuck on whatever was
    // centred when the last zoom happened, silently wrong after any drag. `move` fires for
    // zoom changes as well (they are a movement), so this also replaces the old listener
    // rather than adding a second one beside it.
    this.map.on('move', this.renderDetailLimit);
    this.map.on('load', this.renderDetailLimit);

    this.notice.addEventListener('click', () => options.onOpenRegions());
  }

  /** The regions actually on this device. */
  downloadedRegions(): Region[] {
    return this.downloaded;
  }

  /** Set false when the style is being replaced, and true once it will accept layers. */
  setStyleReady(ready: boolean): void {
    this.styleReady = ready;
  }

  /**
   * Redraw every downloaded region from OPFS, and the coverage around them.
   *
   * Never rejects. It runs at startup and after every download, fire-and-forget, so a
   * rejection here was an unhandled one: no regions on the map, and nothing on screen to
   * say why.
   */
  async restore(): Promise<void> {
    try {
      await this.restoreRegions();
    } catch (err) {
      this.onRestoreProblem?.(
        `Couldn’t restore downloaded regions: ${(err as Error)?.message ?? 'unknown error'}`,
      );
    }
  }

  private async restoreRegions(): Promise<void> {
    const regions = await this.catalogueRegions();
    if (!regions) return;

    const failed: string[] = [];
    let restored: Region[];
    try {
      restored = await restoreDownloadedRegions(this.map, this.registry, regions, this.theme(), (region) =>
        failed.push(region.name),
      );
    } catch (err) {
      // Before any region was drawn: reading what is on disk failed outright.
      this.onRestoreProblem?.(
        `Couldn’t read downloaded regions from storage: ${(err as Error)?.message ?? 'unknown error'}`,
      );
      return;
    }

    this.downloaded = restored;
    this.catalogue = regions;
    this.applyAvailableDetail(restored);
    this.drawFootprints();
    this.onRestoreProblem?.(
      failed.length > 0
        ? `Couldn’t draw ${failed.join(', ')} from storage. The rest of the map is unaffected; deleting and downloading ${failed.length === 1 ? 'it' : 'them'} again should fix it.`
        : null,
    );
  }

  /**
   * The catalogue's regions: fetched, or the copy cached from the last fetch.
   *
   * Only a failed *fetch* falls back to the cache — the cold offline start, which is the
   * scenario Phase 3 exists for: no signal, relaunch, expect your downloaded region. This
   * used to wrap the restore as well, so any restore error was mistaken for being offline
   * and retried from the cache, and a second failure escaped as an unhandled rejection.
   */
  private async catalogueRegions(): Promise<Region[] | null> {
    try {
      return (await fetchManifest()).regions;
    } catch {
      // Offline, or a catalogue newer than this build (the regions sheet says which):
      // either way, what is on disk still needs drawing.
      return loadCachedManifest()?.regions ?? null;
    }
  }

  /**
   * Set the detail ceiling from whatever regions are actually present.
   *
   * Assigned unconditionally rather than only raised: deleting a region has to lower it
   * again, or the app would keep claiming detail it no longer has.
   */
  private applyAvailableDetail(regions: Region[]): void {
    this.maxDataZoom = bestAvailableZoom(regions, BASEMAP_MAX_ZOOM);
    this.renderDetailLimit();
  }

  /** Current coverage, downloaded state and all. */
  private footprints(): Footprint[] {
    const have = new Set(this.downloaded.map((region) => region.id));
    return this.catalogue.map((region) => ({ region, downloaded: have.has(region.id) }));
  }

  /** An arrow, so the same reference can be handed to `map.once` as a retry. */
  private readonly drawFootprints = (): void => {
    // The style has to exist first — this runs from a restore that can finish before the
    // map has loaded, and addSource throws on a style that is not ready.
    if (!this.styleReady) {
      // `styledata` rather than `load`: it fires on the way to a ready style *and* on every
      // theme swap, so a retry registered after load has already gone by still gets its
      // chance. Re-entering here simply re-arms it.
      this.map.once('styledata', this.drawFootprints);
      return;
    }
    renderFootprints(this.map, visibleFootprints(this.footprints(), this.offeredRegionId));
    applyAllStoredVisibility(this.map);
  };

  private readonly renderDetailLimit = (): void => {
    const state = describeDetailLimit(this.map.getZoom(), this.maxDataZoom);
    this.notice.hidden = !state.overzoomed;
    if (!state.overzoomed) return;

    // Naming the region turns a complaint into an instruction. The notice reports that the
    // map is stretched here; the thing that fixes it is a specific download, and until now
    // nothing connected the two — you had to open a list of four names and work out for
    // yourself which one you were looking at.
    const centre = this.map.getCenter();
    const covering = regionAt(this.footprints(), [centre.lng, centre.lat], { downloaded: false });

    this.notice.textContent = covering
      ? `Limited detail here — get ${covering.name}`
      : (state.label ?? '');
    this.notice.title = state.detail ?? '';

    // Only when it changes: this runs on every zoom frame, and re-feeding the source on
    // each one would be work for an identical result.
    if ((covering?.id ?? null) !== this.offeredRegionId) {
      this.offeredRegionId = covering?.id ?? null;
      this.drawFootprints();
    }
  };
}

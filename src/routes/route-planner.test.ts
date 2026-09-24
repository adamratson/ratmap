import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { MapMouseEvent, Map as MLMap } from 'maplibre-gl';
import type { Region } from '../regions/manifest';
import type { TileSourceRegistry } from '../map/tile-source-registry';
import { fakeStyleMap } from '../test-support/fake-map';
import { distanceMetres, pathLengthMetres, type LngLat } from './geo';
import type { ComputedLeg, RouteRequest } from './router';
import type { RoutePlannerOptions, RouteSummary } from './route-planner';

// The planner is the glue between the draft, the router, the samplers, the map and the
// markers. The router and samplers have their own tests; here they are stood in for, so
// what is under test is the planner's own promises: a waypoint commits before any routing
// (C11), a superseded computation never lands, a loaded route is never re-routed (C10),
// and following holds the screen awake.

const fakes = vi.hoisted(() => ({
  markers: [] as Array<{
    options: { element: HTMLElement; draggable: boolean };
    lngLat: [number, number];
    removed: boolean;
    handlers: Record<string, () => void>;
  }>,
  computeLeg: vi.fn(),
  clearCache: vi.fn(),
  terrainSample: vi.fn(),
  wakeLock: { acquire: vi.fn(async () => {}), release: vi.fn(async () => {}) },
}));

vi.mock('maplibre-gl', () => {
  class Marker {
    options: { element: HTMLElement; draggable: boolean };
    lngLat: [number, number] = [0, 0];
    removed = false;
    handlers: Record<string, () => void> = {};
    constructor(options: { element: HTMLElement; draggable: boolean }) {
      this.options = options;
      fakes.markers.push(this);
    }
    setLngLat(lngLat: [number, number]) {
      this.lngLat = lngLat;
      return this;
    }
    addTo() {
      return this;
    }
    on(event: string, handler: () => void) {
      this.handlers[event] = handler;
      return this;
    }
    getLngLat() {
      return { lng: this.lngLat[0], lat: this.lngLat[1] };
    }
    remove() {
      this.removed = true;
    }
  }
  return { default: { Marker }, Marker };
});

vi.mock('./router', () => ({
  OfflineRouter: class {
    computeLeg = fakes.computeLeg;
    clearCache = fakes.clearCache;
  },
}));

vi.mock('./terrain-sampler', () => ({
  TerrainSampler: class {
    sample = fakes.terrainSample;
  },
}));

vi.mock('../app/wake-lock', () => ({
  WakeLock: class {
    acquire = fakes.wakeLock.acquire;
    release = fakes.wakeLock.release;
  },
}));

const { RoutePlanner } = await import('./route-planner');

const ACHINTEE: LngLat = [-5.0930, 56.8110];
const SUMMIT: LngLat = [-5.0036, 56.7969];
const CIC_HUT: LngLat = [-5.0180, 56.8120];

/** A routed leg that follows the straight line — enough geometry for the planner. */
function snapped(from: LngLat, to: LngLat): ComputedLeg {
  return { coords: [from, to], distanceM: distanceMetres(from, to), kind: 'snapped', wayNames: [] };
}

function planMap() {
  const map = fakeStyleMap();
  return Object.assign(map, {
    getCanvas: () => ({ style: { cursor: '' } }),
    queryRenderedFeatures: vi.fn((): unknown[] => []),
    fitBounds: vi.fn(),
  });
}

function click(at: LngLat, target: Element = document.createElement('canvas')): MapMouseEvent {
  return {
    lngLat: { lng: at[0], lat: at[1] },
    point: { x: 0, y: 0 },
    originalEvent: { target },
  } as unknown as MapMouseEvent;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let map: ReturnType<typeof planMap>;
let summaries: RouteSummary[];
let onStatus: Mock<NonNullable<RoutePlannerOptions['onStatus']>>;
let regions: Region[];
let registry: { get: Mock };
let describePoint: Mock<NonNullable<RoutePlannerOptions['describePoint']>>;
let planner: InstanceType<typeof RoutePlanner>;

const last = () => summaries[summaries.length - 1];

beforeEach(() => {
  fakes.markers = [];
  fakes.computeLeg.mockReset();
  fakes.computeLeg.mockImplementation(async (from: LngLat, to: LngLat) => snapped(from, to));
  fakes.clearCache.mockReset();
  fakes.terrainSample.mockReset();
  fakes.wakeLock.acquire.mockClear();
  fakes.wakeLock.release.mockClear();

  map = planMap();
  summaries = [];
  onStatus = vi.fn();
  regions = [];
  registry = { get: vi.fn() };
  describePoint = vi.fn(() => null);
  planner = new RoutePlanner({
    map: map as unknown as MLMap,
    registry: registry as unknown as TileSourceRegistry,
    downloadedRegions: () => regions,
    describePoint,
    onChange: (summary) => summaries.push(summary),
    onStatus,
    theme: () => 'dark',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('placing waypoints', () => {
  it('ignores map taps until planning is switched on', () => {
    expect(planner.handleMapClick(click(ACHINTEE))).toBe(false);
    expect(planner.getDraft().waypointCount).toBe(0);
  });

  it('commits a waypoint at once, before any route is computed (C11)', () => {
    fakes.computeLeg.mockImplementation(() => new Promise(() => {})); // never answers
    planner.activate();

    planner.handleMapClick(click(ACHINTEE));
    planner.handleMapClick(click(SUMMIT));

    expect(last()).toMatchObject({ waypointCount: 2, pendingLegs: 1 });
    expect(fakes.markers.filter((m) => !m.removed)).toHaveLength(2);
  });

  it('fills the leg in once the router answers', async () => {
    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    planner.handleMapClick(click(SUMMIT));
    await settle();

    expect(fakes.computeLeg).toHaveBeenCalledWith(ACHINTEE, SUMMIT, expect.anything());
    expect(last()).toMatchObject({ pendingLegs: 0, hasStraightLegs: false });
    expect(last().distanceM).toBeCloseTo(distanceMetres(ACHINTEE, SUMMIT));
  });

  it('names a waypoint dropped on a summit, and the route after it', async () => {
    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    describePoint.mockReturnValueOnce({ name: 'Ben Nevis', ele: 1345 });
    planner.handleMapClick(click(SUMMIT));

    expect(planner.getDraft().getWaypoints()[1]).toMatchObject({ name: 'Ben Nevis', ele: 1345 });
    expect(planner.getName()).toBe('Ben Nevis');
  });

  it('does not drop a second waypoint on top of one that was tapped', () => {
    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    const marker = fakes.markers[0].options.element;

    expect(planner.handleMapClick(click(ACHINTEE, marker.firstElementChild!))).toBe(true);
    expect(planner.getDraft().waypointCount).toBe(1);
  });

  it('inserts into the route, rather than appending, when the tap lands on the line', async () => {
    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    planner.handleMapClick(click(SUMMIT));
    await settle();

    map.queryRenderedFeatures.mockReturnValue([{}]);
    planner.handleMapClick(click(CIC_HUT));

    const order = planner.getDraft().getWaypoints().map((w) => [w.lng, w.lat]);
    expect(order).toEqual([ACHINTEE, CIC_HUT, SUMMIT]);
  });

  it('removes a waypoint on right-click, and undoes that', () => {
    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    planner.handleMapClick(click(SUMMIT));

    fakes.markers.at(-1)!.options.element.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
    expect(planner.getDraft().waypointCount).toBe(1);

    planner.undo();
    expect(planner.getDraft().waypointCount).toBe(2);
  });

  it('re-routes a waypoint dragged somewhere new', async () => {
    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    planner.handleMapClick(click(SUMMIT));
    await settle();
    fakes.computeLeg.mockClear();

    const dragged = fakes.markers.at(-1)!;
    dragged.lngLat = CIC_HUT;
    dragged.handlers.dragend();
    await settle();

    expect(fakes.computeLeg).toHaveBeenCalledWith(ACHINTEE, CIC_HUT, expect.anything());
  });

  it('lets markers be dragged only while planning', () => {
    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    expect(fakes.markers.at(-1)!.options.draggable).toBe(true);

    planner.deactivate();
    expect(fakes.markers.at(-1)!.options.draggable).toBe(false);
  });
});

describe('routing', () => {
  it('drops a result that an edit has already superseded', async () => {
    // A drag fires an edit per frame; a slower earlier answer must not overwrite a newer one.
    let answerFirst!: (leg: ComputedLeg) => void;
    let firstSignal: AbortSignal | undefined;
    fakes.computeLeg.mockImplementationOnce((_from: LngLat, _to: LngLat, request: RouteRequest) => {
      firstSignal = request.signal;
      return new Promise<ComputedLeg>((resolve) => (answerFirst = resolve));
    });
    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    planner.handleMapClick(click(SUMMIT));

    planner.handleMapClick(click(CIC_HUT)); // supersedes the first computation
    expect(firstSignal?.aborted).toBe(true);
    await settle();

    answerFirst({ ...snapped(ACHINTEE, SUMMIT), distanceM: 999_999 });
    await settle();

    expect(last().distanceM).toBeLessThan(999_999);
  });

  it('says so when a leg cannot be planned, rather than failing silently', async () => {
    fakes.computeLeg.mockRejectedValue(new Error('archive unreadable'));
    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    planner.handleMapClick(click(SUMMIT));
    await settle();

    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('archive unreadable'), 'error');
  });

  it('forgets cached tiles when regions change', () => {
    planner.invalidateRegions();
    expect(fakes.clearCache).toHaveBeenCalled();
  });
});

describe('opening a saved or imported route', () => {
  const coords: LngLat[] = [ACHINTEE, CIC_HUT, SUMMIT];

  it('shows the geometry as it was saved, without re-routing it (C10)', () => {
    planner.load({ id: 'r1', name: 'Pony track', coords });

    expect(fakes.computeLeg).not.toHaveBeenCalled();
    expect(planner.getDraft().coordinates()).toEqual(coords);
    expect(last().distanceM).toBeCloseTo(pathLengthMetres(coords));
    expect(planner.getLoadedRouteId()).toBe('r1');
    expect(planner.getName()).toBe('Pony track');
    expect(map.fitBounds).toHaveBeenCalled();
  });

  it('restores the waypoints and legs of a route planned here, so it can be edited', () => {
    const waypoints = [
      { id: 'a', lng: ACHINTEE[0], lat: ACHINTEE[1] },
      { id: 'b', lng: CIC_HUT[0], lat: CIC_HUT[1] },
      { id: 'c', lng: SUMMIT[0], lat: SUMMIT[1] },
    ];
    const legs = [snapped(ACHINTEE, CIC_HUT), snapped(CIC_HUT, SUMMIT)];

    planner.load({ name: 'Edited', coords, waypoints, legs });

    expect(planner.getDraft().getWaypoints()).toEqual(waypoints);
    expect(fakes.computeLeg).not.toHaveBeenCalled();
  });

  it('forgets which saved route it was once cleared, so Save makes a new one', () => {
    planner.load({ id: 'r1', name: 'Pony track', coords });
    planner.clear();

    expect(planner.getLoadedRouteId()).toBeNull();
    expect(planner.getName()).toBe('Untitled route');
  });
});

describe('the elevation profile', () => {
  const coords: LngLat[] = [ACHINTEE, SUMMIT];

  it('says why there is none without a downloaded region, rather than drawing a guess', async () => {
    planner.load({ name: 'x', coords });
    await settle();

    expect(last().profile).toBeNull();
    expect(last().profileNote).toMatch(/needs a downloaded region/);
  });

  it('measures from the region’s terrain when the whole route is inside it', async () => {
    regions = [
      {
        id: 'lochaber',
        name: 'Lochaber',
        bbox: [-5.6, 56.5, -4.6, 57.1],
        totalBytes: 1,
        artifacts: [{ kind: 'terrain', filename: 'lochaber-terrain.pmtiles', path: 'x', bytes: 1, maxzoom: 11 }],
      },
    ];
    registry.get.mockReturnValue({});
    fakes.terrainSample.mockImplementation(async (samples: LngLat[]) =>
      samples.map((_, i) => 50 + i * 5),
    );

    planner.load({ name: 'x', coords });
    await settle();

    expect(last().profile).not.toBeNull();
    expect(last().profile!.ascentM).toBeGreaterThan(0);
    expect(last().profileNote).toBeNull();
  });

  it('will not measure a route that runs out of the region — it would understate the climb', async () => {
    regions = [
      {
        id: 'tiny',
        name: 'Tiny',
        bbox: [-5.05, 56.79, -5.0, 56.8],
        totalBytes: 1,
        artifacts: [{ kind: 'terrain', filename: 'tiny-terrain.pmtiles', path: 'x', bytes: 1 }],
      },
    ];
    registry.get.mockReturnValue({});

    planner.load({ name: 'x', coords });
    await settle();

    expect(fakes.terrainSample).not.toHaveBeenCalled();
    expect(last().profileNote).toMatch(/needs a downloaded region/);
  });
});

describe('following a route', () => {
  const coords: LngLat[] = [ACHINTEE, SUMMIT];

  it('refuses with nothing to follow', () => {
    planner.startFollowing();

    expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/Nothing to follow/), 'warn');
    expect(planner.isFollowing()).toBe(false);
  });

  it('keeps the screen awake while following, and lets it sleep after', () => {
    planner.load({ name: 'x', coords });

    planner.startFollowing();
    expect(fakes.wakeLock.acquire).toHaveBeenCalled();
    expect(last().following).toBe(true);

    planner.stopFollowing();
    expect(fakes.wakeLock.release).toHaveBeenCalled();
    expect(last().following).toBe(false);
  });

  it('draws the way back when a fix is off the route, and clears it on stopping', () => {
    planner.load({ name: 'x', coords });
    planner.startFollowing();

    planner.updatePosition([-5.05, 56.83]); // well north of the line

    const offRoute = map.sources.get('route-off-route')!.data as { features: unknown[] };
    expect(last().follow?.isOffRoute).toBe(true);
    expect(offRoute.features).toHaveLength(1);

    planner.stopFollowing();
    expect((map.sources.get('route-off-route')!.data as { features: unknown[] }).features).toEqual([]);
  });

  it('places a nearby fix on the profile even when only viewing the plan', () => {
    planner.load({ name: 'x', coords });

    planner.updatePosition(ACHINTEE);
    expect(last().currentDistanceM).toBeCloseTo(0, 0);

    // Planning from across town is not "here" on the route.
    planner.updatePosition([-4.2, 57.5]);
    expect(last().currentDistanceM).toBeNull();
  });

  it('stops following when the route is cleared', () => {
    planner.load({ name: 'x', coords });
    planner.startFollowing();

    planner.clear();

    expect(planner.isFollowing()).toBe(false);
    expect(fakes.wakeLock.release).toHaveBeenCalled();
  });
});

describe('suggested names', () => {
  it('falls back from a named waypoint, to the distance, to "Untitled route"', async () => {
    expect(planner.getName()).toBe('Untitled route');

    planner.activate();
    planner.handleMapClick(click(ACHINTEE));
    planner.handleMapClick(click(SUMMIT));
    await settle();

    expect(planner.getName()).toMatch(/ route$/);
  });
});

import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

// Foreground-only location. §7: there is no background geolocation on any platform — not
// iOS, not Android — so this deliberately makes no attempt at track recording. The UI must
// say so rather than implying a capability that does not exist.

export type LocationState =
  | { status: 'idle' }
  | { status: 'locating' }
  | { status: 'tracking'; position: GeolocationPosition }
  | { status: 'denied' }
  | { status: 'unavailable'; message: string };

export interface LocationControllerOptions {
  map: MLMap;
  onStateChange?(state: LocationState): void;
}

export class LocationController {
  private readonly map: MLMap;
  private readonly onStateChange?: (state: LocationState) => void;
  private watchId: number | null = null;
  private marker: maplibregl.Marker | null = null;
  private accuracyCircleId = 'user-location-accuracy';
  /** Degrees clockwise from true north, or null when the compass has nothing to say. */
  private heading: number | null = null;
  /** When true the camera recentres on each fix; any user pan cancels it. */
  private follow = false;
  private state: LocationState = { status: 'idle' };

  constructor(options: LocationControllerOptions) {
    this.map = options.map;
    this.onStateChange = options.onStateChange;
  }

  getState(): LocationState {
    return this.state;
  }

  isFollowing(): boolean {
    return this.follow;
  }

  /** Begin watching. Safe to call repeatedly — re-centres instead of stacking watches. */
  start(): void {
    if (!navigator.geolocation) {
      this.setState({ status: 'unavailable', message: 'Geolocation unsupported on this device' });
      return;
    }

    this.follow = true;
    if (this.watchId !== null) {
      // Already watching: just recentre on the last known fix.
      if (this.state.status === 'tracking') this.centreOn(this.state.position);
      this.onStateChange?.(this.state);
      return;
    }

    this.setState({ status: 'locating' });
    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.handlePosition(position),
      (error) => this.handleError(error),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
  }

  stop(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.follow = false;
    this.marker?.remove();
    this.marker = null;
    this.heading = null;
    this.removeAccuracyCircle();
    this.setState({ status: 'idle' });
  }

  /**
   * Point the dot's cone. Null hides it.
   *
   * Rendered as a marker rotation with `rotationAlignment: 'map'`, so the cone keeps
   * pointing at the real bearing when the map itself is rotated — otherwise turning the
   * map would swing the arrow with it and quietly make it wrong.
   */
  setHeading(heading: number | null): void {
    this.heading = heading;
    if (!this.marker) return;
    this.marker.getElement().classList.toggle('has-heading', heading !== null);
    this.marker.setRotation(heading ?? 0);
  }

  /** Stop recentring but keep the dot live — what a user pan should do. */
  cancelFollow(): void {
    if (!this.follow) return;
    this.follow = false;
    this.onStateChange?.(this.state);
  }

  private handlePosition(position: GeolocationPosition): void {
    this.setState({ status: 'tracking', position });
    this.renderMarker(position);
    if (this.follow) this.centreOn(position);
  }

  private handleError(error: GeolocationPositionError): void {
    if (error.code === error.PERMISSION_DENIED) {
      this.setState({ status: 'denied' });
      // Keep the watch registered: on some browsers permission can be granted later
      // without a reload, and re-registering would prompt again.
      return;
    }
    this.setState({ status: 'unavailable', message: error.message || 'Position unavailable' });
  }

  private centreOn(position: GeolocationPosition): void {
    this.map.easeTo({
      center: [position.coords.longitude, position.coords.latitude],
      duration: 500,
    });
  }

  private renderMarker(position: GeolocationPosition): void {
    const lngLat: [number, number] = [position.coords.longitude, position.coords.latitude];

    if (!this.marker) {
      const el = document.createElement('div');
      el.className = 'user-dot';
      // The cone is a child rather than a pseudo-element so it can be hidden
      // independently of the dot, which is always meaningful even when the compass is not.
      el.innerHTML = '<span class="user-dot-cone" aria-hidden="true"></span>';
      this.marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
        .setLngLat(lngLat)
        .addTo(this.map);
      this.setHeading(this.heading);
    } else {
      this.marker.setLngLat(lngLat);
    }

    this.renderAccuracyCircle(lngLat, position.coords.accuracy);
  }

  /**
   * Accuracy halo as a GeoJSON circle. Drawn in metres via circle-radius stops so it
   * stays geographically honest across zooms — a fixed pixel radius would imply far
   * better precision than the fix actually has when zoomed in.
   */
  private renderAccuracyCircle(lngLat: [number, number], accuracyM: number): void {
    if (!Number.isFinite(accuracyM) || accuracyM <= 0) return;
    if (!this.map.isStyleLoaded()) return;

    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: lngLat },
          properties: { accuracy: accuracyM },
        },
      ],
    };

    const existing = this.map.getSource(this.accuracyCircleId);
    if (existing && existing.type === 'geojson') {
      (existing as maplibregl.GeoJSONSource).setData(data);
      return;
    }

    this.map.addSource(this.accuracyCircleId, { type: 'geojson', data });
    this.map.addLayer({
      id: this.accuracyCircleId,
      type: 'circle',
      source: this.accuracyCircleId,
      paint: {
        'circle-color': '#2563eb',
        'circle-opacity': 0.12,
        'circle-stroke-color': '#2563eb',
        'circle-stroke-opacity': 0.35,
        'circle-stroke-width': 1,
        // metres -> pixels: 156543 * cos(lat) / 2^zoom m-per-pixel at the equator.
        // Approximated with zoom stops; exact enough for an accuracy halo.
        'circle-radius': [
          'interpolate',
          ['exponential', 2],
          ['zoom'],
          0,
          0,
          20,
          ['/', ['get', 'accuracy'], 0.15],
        ],
      },
    });
  }

  private removeAccuracyCircle(): void {
    if (this.map.getLayer(this.accuracyCircleId)) this.map.removeLayer(this.accuracyCircleId);
    if (this.map.getSource(this.accuracyCircleId)) this.map.removeSource(this.accuracyCircleId);
  }

  private setState(state: LocationState): void {
    this.state = state;
    this.onStateChange?.(state);
  }
}

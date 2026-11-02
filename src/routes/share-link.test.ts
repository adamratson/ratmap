import { describe, expect, it } from 'vitest';
import { distanceMetres, pathLengthMetres, type LngLat } from './geo';
import {
  LinkDamaged,
  LinkTooLong,
  LinkTooNew,
  decodeRouteLink,
  encodeRouteLink,
  payloadFromHash,
  payloadFromText,
  routeLinkUrl,
  simplify,
  type LinkRoute,
} from './share-link';

const ACHINTEE: LngLat = [-5.093012, 56.811034];
const HALFWAY: LngLat = [-5.0555, 56.8033];
const SUMMIT: LngLat = [-5.003611, 56.796891];

/** A wiggly line between two points, every vertex well off the straight chord. */
function wiggle(from: LngLat, to: LngLat, vertices: number): LngLat[] {
  return Array.from({ length: vertices }, (_, i) => {
    const t = i / (vertices - 1);
    const off = i === 0 || i === vertices - 1 ? 0 : 0.0004 * Math.sin(t * 40);
    return [from[0] + (to[0] - from[0]) * t + off, from[1] + (to[1] - from[1]) * t - off] as LngLat;
  });
}

function route(overrides: Partial<LinkRoute> = {}): LinkRoute {
  const first = wiggle(ACHINTEE, HALFWAY, 120);
  return {
    name: 'Ben Nevis by the Mountain Path',
    waypoints: [
      { lng: ACHINTEE[0], lat: ACHINTEE[1], name: 'Achintee' },
      { lng: HALFWAY[0], lat: HALFWAY[1] },
      { lng: SUMMIT[0], lat: SUMMIT[1], name: 'Ben Nevis' },
    ],
    legs: [
      { coords: first, distanceM: pathLengthMetres(first), kind: 'snapped' },
      { coords: [HALFWAY, SUMMIT], distanceM: distanceMetres(HALFWAY, SUMMIT), kind: 'straight' },
    ],
    stats: { ascentM: 1340, descentM: 12 },
    ...overrides,
  };
}

/** Flip the payload's bytes through a function and re-seal the checksum — a forged link. */
function forge(payload: string, edit: (bytes: Uint8Array) => Uint8Array): string {
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')), (c) =>
    c.charCodeAt(0),
  );
  const body = edit(bytes.subarray(0, bytes.length - 4));
  const table = Array.from({ length: 256 }, (_, n) => {
    let v = n;
    for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    return v >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of body) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  new DataView(out.buffer).setUint32(body.length, (crc ^ 0xffffffff) >>> 0, true);
  let binary = '';
  for (const byte of out) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('round trip', () => {
  it('brings back the waypoints to within the format’s precision', () => {
    const back = decodeRouteLink(encodeRouteLink(route()));
    expect(back.waypoints).toHaveLength(3);
    expect(back.waypoints[0].lng).toBeCloseTo(ACHINTEE[0], 6);
    expect(back.waypoints[0].lat).toBeCloseTo(ACHINTEE[1], 6);
    expect(back.waypoints[2].lng).toBeCloseTo(SUMMIT[0], 6);
  });

  it('keeps names, the route’s and the waypoints’', () => {
    const back = decodeRouteLink(encodeRouteLink(route()));
    expect(back.name).toBe('Ben Nevis by the Mountain Path');
    expect(back.waypoints.map((w) => w.name)).toEqual(['Achintee', undefined, 'Ben Nevis']);
  });

  it('shows the distance that was measured, not the simplified line’s', () => {
    const original = route();
    const back = decodeRouteLink(encodeRouteLink(original));
    expect(back.legs[0].distanceM).toBeCloseTo(original.legs[0].distanceM, 1);
    expect(back.legs[1].distanceM).toBeCloseTo(original.legs[1].distanceM, 1);
  });

  it('keeps a straight leg straight (C11)', () => {
    const back = decodeRouteLink(encodeRouteLink(route()));
    expect(back.legs.map((leg) => leg.kind)).toEqual(['snapped', 'straight']);
    expect(back.legs[1].coords).toHaveLength(2);
  });

  it('keeps a freehand leg freehand, on the leg and the waypoint it arrives at', () => {
    const original = route();
    original.legs[1] = { ...original.legs[1], freehand: true };
    const back = decodeRouteLink(encodeRouteLink(original));
    expect(back.legs[1].freehand).toBe(true);
    expect(back.waypoints[2].freehand).toBe(true);
    expect(back.waypoints[1].freehand).toBeUndefined();
    expect(back.legs[0].freehand).toBeUndefined();
  });

  it('joins the legs into one line, end to end', () => {
    const back = decodeRouteLink(encodeRouteLink(route()));
    const vertices = back.legs.reduce((total, leg) => total + leg.coords.length - 1, 1);
    expect(back.coords).toHaveLength(vertices);
    expect(back.coords[0]).toEqual([back.waypoints[0].lng, back.waypoints[0].lat]);
    expect(back.coords.at(-1)).toEqual([back.waypoints[2].lng, back.waypoints[2].lat]);
  });

  it('carries the sender’s climb, or says it has none', () => {
    expect(decodeRouteLink(encodeRouteLink(route())).stats).toEqual({ ascentM: 1340, descentM: 12 });
    expect(decodeRouteLink(encodeRouteLink(route({ stats: null }))).stats).toBeNull();
  });

  it('stays close to the real line after simplifying', () => {
    const original = route();
    const back = decodeRouteLink(encodeRouteLink(original));
    const length = pathLengthMetres(back.legs[0].coords);
    expect(Math.abs(length - original.legs[0].distanceM) / original.legs[0].distanceM).toBeLessThan(0.02);
    expect(back.legs[0].coords.length).toBeLessThanOrEqual(original.legs[0].coords.length);
  });

  it('gives an unnamed route a name', () => {
    expect(decodeRouteLink(encodeRouteLink(route({ name: '' }))).name).toBe('Shared route');
  });

  it('cuts an over-long name between characters, not through one', () => {
    const back = decodeRouteLink(encodeRouteLink(route({ name: 'é'.repeat(200) })));
    expect(back.name).toBe('é'.repeat(60));
  });
});

describe('a link that has been damaged', () => {
  const payload = encodeRouteLink(route());

  it('refuses every truncation rather than decoding a shorter route', () => {
    for (let keep = 0; keep < payload.length; keep++) {
      expect(() => decodeRouteLink(payload.slice(0, keep))).toThrow(LinkDamaged);
    }
  });

  it('refuses a single changed character', () => {
    const swapped = payload.slice(0, 40) + (payload[40] === 'A' ? 'B' : 'A') + payload.slice(41);
    expect(() => decodeRouteLink(swapped)).toThrow(LinkDamaged);
  });

  it('refuses characters that are not base64url', () => {
    expect(() => decodeRouteLink(`${payload.slice(0, 20)}%20${payload.slice(20)}`)).toThrow(LinkDamaged);
  });

  it('refuses anything over the size limit before reading it', () => {
    expect(() => decodeRouteLink('A'.repeat(70_000))).toThrow(LinkDamaged);
  });

  it('never yields out-of-range coordinates from random bytes', () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let run = 0; run < 300; run++) {
      const forged = forge(payload, (bytes) => {
        const copy = Uint8Array.from({ length: 12 + (next() % 200) }, () => next() % 256);
        copy[0] = bytes[0];
        copy[1] = bytes[1];
        return copy;
      });
      try {
        const back = decodeRouteLink(forged);
        for (const [lng, lat] of back.coords) {
          expect(Math.abs(lng)).toBeLessThanOrEqual(180);
          expect(Math.abs(lat)).toBeLessThanOrEqual(90);
        }
      } catch (err) {
        expect(err).toBeInstanceOf(LinkDamaged);
      }
    }
  });
});

describe('a forged link with a valid checksum', () => {
  const payload = encodeRouteLink(route());

  it('refuses a distance that does not belong to its line', () => {
    // Waypoints 2 km apart claiming to be 1 m: one straight leg, built by hand.
    const lie = encodeRouteLink({
      name: 'x',
      waypoints: [
        { lng: ACHINTEE[0], lat: ACHINTEE[1] },
        { lng: SUMMIT[0], lat: SUMMIT[1] },
      ],
      legs: [{ coords: [ACHINTEE, SUMMIT], distanceM: 1, kind: 'straight' }],
      stats: null,
    });
    expect(() => decodeRouteLink(lie)).toThrow(/distance does not match/);
  });

  it('strips control and bidi-override characters from names', () => {
    const back = decodeRouteLink(
      encodeRouteLink(route({ name: 'Safe‮evil\u0000 name' })),
    );
    expect(back.name).toBe('Safeevil name');

    // And on the way in, whatever the sender's encoder did.
    const bidi = new TextEncoder().encode('a‮b');
    const forged = forge(payload, (bytes) => {
      const nameLength = bytes[2];
      const copy = new Uint8Array(bytes.length - nameLength + bidi.length);
      copy.set(bytes.subarray(0, 2));
      copy[2] = bidi.length;
      copy.set(bidi, 3);
      copy.set(bytes.subarray(3 + nameLength), 3 + bidi.length);
      return copy;
    });
    expect(decodeRouteLink(forged).name).toBe('ab');
  });

  it('refuses a waypoint count outside the limits', () => {
    const forged = forge(payload, (bytes) => {
      const copy = Uint8Array.from(bytes);
      copy[3 + bytes[2]] = 1;
      return copy;
    });
    expect(() => decodeRouteLink(forged)).toThrow(LinkDamaged);
  });

  it('refuses bytes left over at the end', () => {
    const forged = forge(payload, (bytes) => {
      const copy = new Uint8Array(bytes.length + 1);
      copy.set(bytes);
      return copy;
    });
    expect(() => decodeRouteLink(forged)).toThrow(LinkDamaged);
  });
});

describe('a link from a later ratmap', () => {
  const payload = encodeRouteLink(route());

  it('refuses a later version as too new, not damaged', () => {
    const forged = forge(payload, (bytes) => {
      const copy = Uint8Array.from(bytes);
      copy[0] = 2;
      return copy;
    });
    expect(() => decodeRouteLink(forged)).toThrow(LinkTooNew);
  });

  it('refuses an unknown flag whole', () => {
    const forged = forge(payload, (bytes) => {
      const copy = Uint8Array.from(bytes);
      copy[1] |= 1 << 5;
      return copy;
    });
    expect(() => decodeRouteLink(forged)).toThrow(LinkTooNew);
  });

  it('refuses a link with no geometry, which needs Stage C’s reader', () => {
    const forged = forge(payload, (bytes) => {
      const copy = Uint8Array.from(bytes);
      copy[1] &= ~1;
      return copy;
    });
    expect(() => decodeRouteLink(forged)).toThrow(LinkTooNew);
  });
});

describe('limits on what can be sent', () => {
  it('will not write more waypoints than a link may hold', () => {
    const waypoints = Array.from({ length: 501 }, (_, i) => ({ lng: i * 0.001, lat: 50 }));
    const legs = waypoints.slice(1).map((_, i) => {
      const from: LngLat = [i * 0.001, 50];
      const to: LngLat = [(i + 1) * 0.001, 50];
      return { coords: [from, to], distanceM: distanceMetres(from, to), kind: 'straight' as const };
    });
    expect(() => encodeRouteLink({ name: 'x', waypoints, legs, stats: null })).toThrow(LinkTooLong);
  });

  it('will not write more vertices than a reader will accept', () => {
    const coords = wiggle(ACHINTEE, SUMMIT, 60_000).map(
      ([lng, lat], i) => [lng + (i % 2) * 0.001, lat] as LngLat,
    );
    expect(() =>
      encodeRouteLink({
        name: 'x',
        waypoints: [
          { lng: ACHINTEE[0], lat: ACHINTEE[1] },
          { lng: SUMMIT[0], lat: SUMMIT[1] },
        ],
        legs: [{ coords, distanceM: pathLengthMetres(coords), kind: 'snapped' }],
        stats: null,
      }),
    ).toThrow(LinkTooLong);
  });
});

describe('simplify', () => {
  it('keeps both ends and drops what is within tolerance', () => {
    const straightish: LngLat[] = [
      [0, 50],
      [0.0001, 50.000001],
      [0.0002, 50],
    ];
    expect(simplify(straightish, 2)).toEqual([straightish[0], straightish[2]]);
  });

  it('keeps a corner', () => {
    const corner: LngLat[] = [
      [0, 50],
      [0.001, 50],
      [0.001, 50.001],
    ];
    expect(simplify(corner, 2)).toEqual(corner);
  });
});

describe('finding a link', () => {
  it('reads the payload from a fragment, beside any other key', () => {
    expect(payloadFromHash('#r=abc')).toBe('abc');
    expect(payloadFromHash('#map=1/2/3&r=abc')).toBe('abc');
    expect(payloadFromHash('#map=1/2/3')).toBeNull();
    expect(payloadFromHash('')).toBeNull();
  });

  it('reads it from pasted text, from any origin', () => {
    expect(payloadFromText('  https://example.org/old/#r=abc\n')).toBe('abc');
    expect(payloadFromText('<gpx></gpx>')).toBeNull();
  });

  it('builds the link from where the app is running', () => {
    expect(routeLinkUrl('abc')).toBe(`${location.origin}${import.meta.env.BASE_URL}#r=abc`);
  });
});

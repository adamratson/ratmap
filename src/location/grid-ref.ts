import { gridFor, nationalGrid, nationalGridSquare, utmGrid, utmZone } from '../print/grid';

// A point written as a walker reads it off a paper map: an OS grid reference in Great
// Britain, a UTM reference everywhere else — the same choice of grid the printed sheet
// makes (src/print/grid.ts, gridFor), so a reference read off the screen can be found on a
// sheet printed from it.

export interface GridReference {
  /** "OS National Grid", "UTM 30N". */
  system: string;
  /** "NN 1667 7129", "31T 384213E 4712345N". */
  text: string;
}

/**
 * The grid reference of a WGS84 point, or null where there is no grid to give one in
 * (UTM stops at 80° S and 84° N).
 *
 * National Grid references are eight figures, to 10 m. More would claim a precision the
 * conversion does not have: grid.ts shifts datum with the OS's Helmert transformation,
 * good to a few metres against OSTN15 (grid.test.ts), and a phone's fix is rarely better
 * than ±5 m either. Figures are truncated, not rounded, as the OS writes them: a reference
 * names the square the point is in, and rounding would name the next square along.
 */
export function gridReference(lng: number, lat: number): GridReference | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  // A longitude past ±180 from a tap on a repeated world copy (§2).
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  if (lat < -80 || lat >= 84) return null;

  const grid = gridFor([wrapped, lat]);
  const [easting, northing] = grid.toGrid([wrapped, lat]);

  if (grid.name === 'OS National Grid') {
    const square = nationalGridSquare(easting, northing);
    // Inside the box gridFor calls Britain but off the grid's own extent: fall through to
    // UTM rather than print a reference with no square.
    if (square) {
      // A centimetre added before truncating. A point exactly on a 10 m line (the centre of
      // a typed six-figure square) comes back from grid → WGS84 → grid 2 mm short, the two
      // Helmert transformations not being exact inverses, and would otherwise be written
      // in the square below. grid.test.ts holds that round trip to the centimetre.
      const figures = (metres: number) =>
        Math.floor(((metres + 0.01) % 100_000) / 10)
          .toString()
          .padStart(4, '0');
      return { system: grid.name, text: `${square} ${figures(easting)} ${figures(northing)}` };
    }
  }

  return utmReference(wrapped, lat);
}

/** Latitude bands C to X, 8° each from 80° S, skipping I and O; X runs 72° to 84° N. */
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

function utmReference(lng: number, lat: number): GridReference {
  const zone = utmZone(lng, lat);
  const south = lat < 0;
  const band = BANDS[Math.min(BANDS.length - 1, Math.floor((lat + 80) / 8))]!;
  // The point's own zone, asked for directly: a point in the box gridFor calls Britain
  // but off the National Grid's extent lands here too.
  const [easting, northing] = utmGrid(zone, south).toGrid([lng, lat]);
  return {
    system: `UTM ${zone}${south ? 'S' : 'N'}`,
    text: `${zone}${band} ${Math.floor(easting)}E ${Math.floor(northing)}N`,
  };
}

/** A typed-in grid reference, read back to a point. */
export interface ParsedGridReference {
  lng: number;
  lat: number;
  /** As written back: "NN 166 712", "32T 334198E 5077670N". */
  text: string;
  system: string;
  /** The side of the square the reference names: 100 m for six figures. */
  precisionM: number;
}

/**
 * Read a grid reference typed into search: an OS reference of 2 to 10 figures ("NN 166
 * 712", "nn166712", "NN 16667 71256"), or a UTM one in the form ratmap writes ("32T
 * 334198E 5077670N", the E and N optional).
 *
 * A reference names a square, not a point — "NN 166 712" is anywhere in a 100 m square —
 * so it is read to the square's centre, which is never more than half a square from the
 * place meant, where its south-west corner can be a whole diagonal away.
 *
 * Anchored to the whole string and strict about its shape, so it never takes a place name.
 */
export function parseGridReference(input: string): ParsedGridReference | null {
  const text = input.trim().toUpperCase();
  return parseNationalGrid(text) ?? parseUtm(text);
}

function parseNationalGrid(text: string): ParsedGridReference | null {
  const match = text.match(/^([A-HJ-Z]{2})\s*(\d+)(?:\s+(\d+))?$/);
  if (!match) return null;
  const [, letters, first, second] = match as unknown as [string, string, string, string | undefined];

  let east: string;
  let north: string;
  if (second === undefined) {
    if (first.length % 2 !== 0) return null;
    east = first.slice(0, first.length / 2);
    north = first.slice(first.length / 2);
  } else {
    if (first.length !== second.length) return null;
    east = first;
    north = second;
  }
  const figures = east.length;
  if (figures < 1 || figures > 5) return null;

  const origin = squareOrigin(letters);
  if (!origin) return null;

  const precisionM = 10 ** (5 - figures);
  const easting = origin[0] + Number(east) * precisionM + precisionM / 2;
  const northing = origin[1] + Number(north) * precisionM + precisionM / 2;
  const grid = nationalGrid();
  const [lng, lat] = grid.toLngLat(easting, northing);
  return { lng, lat, text: `${letters} ${east} ${north}`, system: grid.name, precisionM };
}

/** The south-west corner of a named 100 km square: the inverse of nationalGridSquare. */
function squareOrigin(letters: string): [number, number] | null {
  for (let e = 0; e <= 6; e++) {
    for (let n = 0; n <= 12; n++) {
      if (nationalGridSquare(e * 100_000, n * 100_000) === letters) return [e * 100_000, n * 100_000];
    }
  }
  return null;
}

function parseUtm(text: string): ParsedGridReference | null {
  const match = text.match(/^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d{1,6})\s*E?\s+(\d{1,7})\s*N?$/);
  if (!match) return null;
  const [, zoneText, band, eastText, northText] = match as unknown as [string, string, string, string, string];
  const zone = Number(zoneText);
  const easting = Number(eastText);
  const northing = Number(northText);
  if (zone < 1 || zone > 60) return null;
  // A UTM easting is within a few hundred kilometres of the 500 km false easting.
  if (easting < 100_000 || easting > 900_000 || northing > 10_000_000) return null;

  const south = band < 'N';
  const [lng, lat] = utmGrid(zone, south).toLngLat(easting + 0.5, northing + 0.5);
  // The band is redundant with the northing, so a mistyped one shows: refuse rather than
  // go somewhere else. One band of slack for a point right on a band's edge.
  const bandIndex = BANDS.indexOf(band);
  const actual = Math.min(BANDS.length - 1, Math.floor((lat + 80) / 8));
  if (!Number.isFinite(lat) || Math.abs(actual - bandIndex) > 1) return null;

  return {
    lng,
    lat,
    text: `${zone}${band} ${easting}E ${northing}N`,
    system: `UTM ${zone}${south ? 'S' : 'N'}`,
    precisionM: 1,
  };
}

import { gridFor, nationalGridSquare, utmGrid, utmZone } from '../print/grid';

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
      const figures = (metres: number) =>
        Math.floor((metres % 100_000) / 10)
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

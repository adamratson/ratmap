// Typing a coordinate pair into search is not a places lookup (C9 — no geocoding API, and
// there is nothing to geocode: the numbers already are the answer). This is pure string
// parsing so the search box can recognise one before it ever touches the FTS index.

export interface ParsedLatLng {
  lat: number;
  lng: number;
}

/**
 * Parse a pasted "lat, lng" pair — decimal degrees, comma or whitespace separated. This is
 * the order our own coordinate sheet displays (`${lat}, ${lng}`) and what Google Maps and
 * most GPS units copy out, so a value copied from either place round-trips back in here.
 *
 * Anchored to the whole trimmed string: a named search query never happens to be exactly
 * two numbers, so this never misfires on real place names.
 */
export function parseLatLng(input: string): ParsedLatLng | null {
  const match = input.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  return { lat, lng };
}

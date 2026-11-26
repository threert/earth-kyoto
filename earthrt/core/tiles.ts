// The trunk's tile scheme (SPEC § 2): Web Mercator z/x/y, two polar caps, an n × n grid a tile.
import { geodeticToEcef, toDeg, toRad, WGS84_A, type V3 } from "./geo.ts";

export const MAX_LAT = 85.0511287798066;
export const GRID = 65;

export type TileKey = { z: number; x: number; y: number } | { cap: "n" | "s" };

export const isCap = (k: TileKey): k is { cap: "n" | "s" } => "cap" in k;
export const keyOf = (k: TileKey) => (isCap(k) ? `cap/${k.cap}` : `${k.z}/${k.x}/${k.y}`);
export function parseKey(s: string): TileKey {
  if (s === "cap/n" || s === "cap/s") return { cap: s[4] as "n" | "s" };
  const [z, x, y] = s.split("/").map(Number);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 30 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new Error(`not a tile key: ${s}`);
  return { z, x, y };
}

/** Latitude of a Mercator y in tiles at zoom z (y may be fractional). */
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return toDeg(Math.atan(Math.sinh(n)));
}
export const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
export function latToTileY(lat: number, z: number): number {
  const l = toRad(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)));
  return ((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2) * 2 ** z;
}
export const lonToTileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;

export type LonLatBox = { west: number; south: number; east: number; north: number };

export function tileBounds(k: TileKey): LonLatBox {
  if (isCap(k)) return k.cap === "n" ? { west: -180, south: MAX_LAT, east: 180, north: 90 } : { west: -180, south: -90, east: 180, north: -MAX_LAT };
  return { west: tileXToLon(k.x, k.z), east: tileXToLon(k.x + 1, k.z), north: tileYToLat(k.y, k.z), south: tileYToLat(k.y + 1, k.z) };
}

export function children(k: { z: number; x: number; y: number }) {
  const z = k.z + 1, x = k.x * 2, y = k.y * 2;
  return [{ z, x, y }, { z, x: x + 1, y }, { z, x, y: y + 1 }, { z, x: x + 1, y: y + 1 }];
}
export const parent = (k: { z: number; x: number; y: number }) => ({ z: k.z - 1, x: k.x >> 1, y: k.y >> 1 });

/** The tile at zoom z that holds a point. */
export function tileAt(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  return { z, x: Math.min(n - 1, Math.max(0, Math.floor(lonToTileX(lon, z)))), y: Math.min(n - 1, Math.max(0, Math.floor(latToTileY(lat, z)))) };
}

/**
 * Latitudes of the grid's rows and longitudes of its columns (row 0 the north edge, column 0 the west edge). A cap's
 * grid is polar: rows are rings of latitude from the cap's edge to the pole, columns are longitudes around it.
 */
export function gridLatLon(k: TileKey, n = GRID): { lats: Float64Array; lons: Float64Array } {
  const lats = new Float64Array(n), lons = new Float64Array(n);
  if (isCap(k)) {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      lats[i] = k.cap === "n" ? MAX_LAT + (90 - MAX_LAT) * t : -MAX_LAT - (90 - MAX_LAT) * t;
      lons[i] = -180 + 360 * t;
    }
    return { lats, lons };
  }
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    lats[i] = tileYToLat(k.y + t, k.z);
    lons[i] = tileXToLon(k.x + t, k.z);
  }
  return { lats, lons };
}

/** The tile's centre on the ellipsoid (ECEF): the grid's middle vertex (caps: the pole). */
export function tileCenter(k: TileKey): V3 {
  if (isCap(k)) return geodeticToEcef(k.cap === "n" ? 90 : -90, 0, 0);
  if (k.z === 0) return [0, 0, 0];
  const lat = tileYToLat(k.y + 0.5, k.z), lon = tileXToLon(k.x + 0.5, k.z);
  return geodeticToEcef(lat, lon, 0);
}

/** Width of the tile in metres at its centre's latitude (caps: their diameter). */
export function tileSize(k: TileKey): number {
  if (isCap(k)) return 2 * toRad(90 - MAX_LAT) * WGS84_A;
  const lat = tileYToLat(k.y + 0.5, k.z);
  return ((2 * Math.PI * WGS84_A) / 2 ** k.z) * Math.cos(toRad(lat));
}

/** Geometric error of a terrain tile (SPEC § 2): the spacing of its grid × 1.5. */
export const tileError = (k: TileKey, n = GRID) => (tileSize(k) / (n - 1)) * 1.5;

/** Every tile of zoom z that meets a box (the box may cross the antimeridian: west > east). */
export function tilesInBox(box: LonLatBox, z: number): { z: number; x: number; y: number }[] {
  const out: { z: number; x: number; y: number }[] = [];
  const n = 2 ** z;
  const y0 = Math.max(0, Math.floor(latToTileY(box.north, z))), y1 = Math.min(n - 1, Math.floor(latToTileY(box.south, z)));
  const ranges = box.west <= box.east ? [[box.west, box.east]] : [[box.west, 180], [-180, box.east]];
  for (const [w, e] of ranges) {
    const x0 = Math.max(0, Math.floor(lonToTileX(w, z))), x1 = Math.min(n - 1, Math.floor(lonToTileX(e, z) - 1e-9));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ z, x, y });
  }
  return out;
}

// The generator's working plane: Web Mercator scaled to metres at Kyoto's latitude (conformal: angles true, lengths
// within 0.2 % over the basin). x east, y north, metres from the origin below. Every footprint, road and tree is laid
// out here; 3D comes from `ground.ts` (heights on the trunk's own terrain triangles) and `geo` (ECEF).
import { latToTileY, lonToTileX, tileXToLon, tileYToLat } from "../earthrt/core/tiles.ts";

export const LAT0 = 35.0;
export const LON0 = 135.76;
/** Mercator units of zoom 0 (the world = 1) → metres at LAT0. */
const S = 2 * Math.PI * 6378137 * Math.cos((LAT0 * Math.PI) / 180);
const X0 = lonToTileX(LON0, 0), Y0 = latToTileY(LAT0, 0);

export type P2 = [number, number];

export const toPlane = (lat: number, lon: number): P2 => [(lonToTileX(lon, 0) - X0) * S, -(latToTileY(lat, 0) - Y0) * S];
export const fromPlane = (x: number, y: number): { lat: number; lon: number } => ({ lon: tileXToLon(x / S + X0, 0), lat: tileYToLat(-y / S + Y0, 0) });
/** Plane metres → Mercator tile units at zoom z (x east, y south, as tile keys). */
export const planeToTile = (x: number, y: number, z: number): P2 => [(x / S + X0) * 2 ** z, (-y / S + Y0) * 2 ** z];
export const tileToPlane = (tx: number, ty: number, z: number): P2 => [(tx / 2 ** z - X0) * S, -(ty / 2 ** z - Y0) * S];

// ------------------------------------------------------------------------------------------------ 2D helpers

export function area(r: P2[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // > 0: counter-clockwise
}

export function centroid(r: P2[]): P2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) { let sx = 0, sy = 0; for (const p of r) { sx += p[0]; sy += p[1]; } return [sx / r.length, sy / r.length]; }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInRing(x: number, y: number, r: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const pointInPoly = (x: number, y: number, rings: P2[][]) => pointInRing(x, y, rings[0]) && !rings.slice(1).some((h) => pointInRing(x, y, h));

/** Drops repeated and collinear points; makes the ring counter-clockwise. */
export function cleanRing(r: P2[], ccw = true): P2[] {
  let pts = r.filter((p, i) => { const q = r[(i + 1) % r.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05; });
  for (let pass = 0; pass < 2 && pts.length > 3; pass++) {
    pts = pts.filter((p, i) => {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
      const cr = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      const l = Math.hypot(p[0] - a[0], p[1] - a[1]) * Math.hypot(b[0] - p[0], b[1] - p[1]);
      return Math.abs(cr) > 0.02 * l; // ~1°
    });
  }
  if (pts.length >= 3 && (area(pts) > 0) !== ccw) pts.reverse();
  return pts;
}

/** The minimum-area rectangle around a ring: centre, axis angle (rad, of the long side), length (≥ width), width. */
export interface Obb { cx: number; cy: number; angle: number; length: number; width: number }
export function obb(r: P2[]): Obb {
  let best: Obb | null = null, bestA = Infinity;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(th), s = Math.sin(th);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of r) {
      const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c;
      if (u < x0) x0 = u; if (u > x1) x1 = u; if (v < y0) y0 = v; if (v > y1) y1 = v;
    }
    const A = (x1 - x0) * (y1 - y0);
    if (A < bestA) {
      bestA = A;
      const mu = (x0 + x1) / 2, mv = (y0 + y1) / 2;
      const L = x1 - x0, W = y1 - y0;
      best = L >= W
        ? { cx: mu * c - mv * s, cy: mu * s + mv * c, angle: th, length: L, width: W }
        : { cx: mu * c - mv * s, cy: mu * s + mv * c, angle: th + Math.PI / 2, length: W, width: L };
    }
  }
  return best!;
}

/** Ear-clipping triangulation of a polygon with holes (holes bridged in). Indices into the flattened point list. */
export function triangulate(rings: P2[][]): { pts: P2[]; tris: number[] } {
  // earcut, compact: bridge holes to the outer ring, then clip ears
  const outer = cleanRing(rings[0], true);
  const holes = rings.slice(1).map((h) => cleanRing(h, false)).filter((h) => h.length >= 3);
  let ring = outer.slice();
  holes.sort((a, b) => Math.max(...b.map((p) => p[0])) - Math.max(...a.map((p) => p[0])));
  for (const h of holes) ring = bridge(ring, h);
  const pts = ring;
  const tris: number[] = [];
  const idx = pts.map((_, i) => i);
  let guard = 0;
  while (idx.length > 3 && guard++ < 20000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cr <= 1e-12) continue;
      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = pts[j];
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
        if (inTri(p, a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push(i0, i1, i2);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break; // degenerate: give up on the rest
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return { pts, tris };
}

function inTri(p: P2, a: P2, b: P2, c: P2) {
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  return d1 >= 0 && d2 >= 0 && d3 >= 0;
}

function bridge(ring: P2[], hole: P2[]): P2[] {
  // the hole's rightmost point to the nearest visible outer vertex to its right (good enough for footprints)
  let hi = 0;
  for (let i = 1; i < hole.length; i++) if (hole[i][0] > hole[hi][0]) hi = i;
  const h = hole[hi];
  let best = -1, bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (p[0] < h[0]) continue;
    const d = (p[0] - h[0]) ** 2 + (p[1] - h[1]) ** 2;
    if (d < bd && !crosses(h, p, ring, hole)) { bd = d; best = i; }
  }
  if (best < 0) for (let i = 0; i < ring.length; i++) { const d = (ring[i][0] - h[0]) ** 2 + (ring[i][1] - h[1]) ** 2; if (d < bd) { bd = d; best = i; } }
  const hs = [...hole.slice(hi), ...hole.slice(0, hi), h];
  return [...ring.slice(0, best + 1), ...hs, ring[best], ...ring.slice(best + 1)];
}

function crosses(a: P2, b: P2, r1: P2[], r2: P2[]) {
  for (const r of [r1, r2]) for (let i = 0; i < r.length; i++) {
    const c = r[i], d = r[(i + 1) % r.length];
    if (c === a || c === b || d === a || d === b) continue;
    if (segX(a, b, c, d)) return true;
  }
  return false;
}
export function segX(a: P2, b: P2, c: P2, d: P2) {
  const o = (p: P2, q: P2, r: P2) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Inset a counter-clockwise ring by d (miter), or null if it turns inside out. */
export function inset(r: P2[], d: number): P2[] | null {
  const n = r.length, out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = r[(i + n - 1) % n], b = r[i], c = r[(i + 1) % n];
    let e1x = b[0] - a[0], e1y = b[1] - a[1], e2x = c[0] - b[0], e2y = c[1] - b[1];
    const l1 = Math.hypot(e1x, e1y), l2 = Math.hypot(e2x, e2y);
    e1x /= l1; e1y /= l1; e2x /= l2; e2y /= l2;
    // inward normals (left of a ccw edge)
    const n1x = -e1y, n1y = e1x, n2x = -e2y, n2y = e2x;
    let mx = n1x + n2x, my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) return null;
    mx /= ml; my /= ml;
    const cosh = mx * n1x + my * n1y;
    if (cosh < 0.25) return null;
    out.push([b[0] + (mx * d) / cosh, b[1] + (my * d) / cosh]);
  }
  // still the same orientation, every edge the same direction, no crossings
  if (area(out) <= 0) return null;
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n], p = out[i], q = out[(i + 1) % n];
    if ((b[0] - a[0]) * (q[0] - p[0]) + (b[1] - a[1]) * (q[1] - p[1]) <= 0) return null;
  }
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segX(out[i], out[(i + 1) % n], out[j], out[(j + 1) % n])) return null;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ randomness

/** A deterministic hash of a string → [0, 1). */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// Which tiles a view shows and which it asks for (SPEC § 2): replacement refinement by screen-space error, frustum
// and horizon culling. A tile is replaced by its children only when all its visible children are there, so the
// globe never has a hole; what is missing is asked for, the largest error first.
import { cross, dot, geodeticToEcef, norm, type V3 } from "./geo.ts";
import { children, isCap, keyOf, tileBounds, tileError, type TileKey } from "./tiles.ts";

export interface View {
  /** Camera position, ECEF. */
  position: V3;
  /** Unit forward and up, ECEF. */
  forward: V3;
  up: V3;
  /** Vertical field of view, radians. */
  fov: number;
  aspect: number;
  /** Viewport height, pixels. */
  height: number;
}

export interface TileInfo {
  /** Loaded and ready to show. */
  ready: boolean;
  minH?: number;
  maxH?: number;
}

export interface Selection {
  /** Tiles to show (no two overlap). */
  show: TileKey[];
  /** Tiles to fetch, most wanted first. */
  want: { key: TileKey; priority: number }[];
  /** Every tile the view touched (shown, their ancestors, wanted): what a cache keeps. */
  touched: Set<string>;
  /** Screen-space error of each shown tile. */
  sse: Map<string, number>;
}

export interface SelectOptions {
  /** Refine while the error is over this many pixels. */
  threshold: number;
  maxZoom: number;
  /** Known heights of tiles (loaded ones) and whether a tile is ready. */
  info: (key: string) => TileInfo | undefined;
}

/** Conservative radius for horizon culling: the polar radius less the Dead Sea's depth. */
const R_HORIZON = 6356752 - 500;

export function selectTiles(view: View, opt: SelectOptions): Selection {
  const sel: Selection = { show: [], want: [], touched: new Set(), sse: new Map() };
  const planes = frustumPlanes(view);
  const camDist = Math.hypot(...view.position);
  const horizonDot = (R_HORIZON * R_HORIZON) / Math.max(camDist, R_HORIZON + 1);
  const camDir: V3 = [view.position[0] / camDist, view.position[1] / camDist, view.position[2] / camDist];
  const k2 = view.height / (2 * Math.tan(view.fov / 2));
  const cam = cameraLatLonH(view.position);

  const measure = (k: TileKey) => {
    const b = tileBounds(k);
    const inf = opt.info(keyOf(k));
    const lo = inf?.minH ?? -500, hi = inf?.maxH ?? 9000;
    // closest point: the camera's latitude and longitude clamped into the tile, its height into the tile's range
    const lat = Math.min(b.north, Math.max(b.south, cam.lat));
    let lon = cam.lon;
    if (!isCap(k)) lon = clampLon(cam.lon, b.west, b.east);
    const h = Math.min(hi, Math.max(lo, cam.h));
    const p = geodeticToEcef(lat, lon, h);
    const d = Math.max(1, Math.hypot(view.position[0] - p[0], view.position[1] - p[1], view.position[2] - p[2]));
    return { d, b, lo, hi };
  };

  const visible = (k: TileKey, b: ReturnType<typeof tileBounds>, lo: number, hi: number) => {
    if (!isCap(k) && k.z < 2) return true;
    const s = boundingSphere(b, lo, hi);
    // horizon: every point of the sphere is past the plane where the Earth hides what is behind it
    if (dot(s.c, camDir) + s.r < horizonDot && camDist > R_HORIZON) return false;
    for (const pl of planes) if (dot(pl.n, s.c) - pl.d < -s.r) return false;
    return true;
  };

  const visit = (k: TileKey) => {
    const key = keyOf(k);
    sel.touched.add(key);
    const m = measure(k);
    if (!visible(k, m.b, m.lo, m.hi)) return;
    const sse = (tileError(k) * k2) / m.d;
    const inf = opt.info(key);
    if (!inf?.ready) {
      sel.want.push({ key: k, priority: sse });
      return;
    }
    const refine = !isCap(k) && sse > opt.threshold && k.z < opt.maxZoom;
    if (!refine) {
      sel.show.push(k);
      sel.sse.set(key, sse);
      return;
    }
    const kids = children(k as { z: number; x: number; y: number }).filter((c) => {
      const mc = measure(c);
      return visible(c, mc.b, mc.lo, mc.hi);
    });
    if (kids.every((c) => opt.info(keyOf(c))?.ready)) {
      for (const c of kids) visit(c);
      return;
    }
    sel.show.push(k);
    sel.sse.set(key, sse);
    for (const c of kids) {
      const ck = keyOf(c);
      sel.touched.add(ck);
      if (!opt.info(ck)?.ready) sel.want.push({ key: c, priority: (tileError(c) * k2) / measure(c).d });
    }
  };

  visit({ z: 0, x: 0, y: 0 });
  visit({ cap: "n" });
  visit({ cap: "s" });
  sel.want.sort((a, b) => b.priority - a.priority);
  return sel;
}

function clampLon(lon: number, w: number, e: number) {
  if (lon >= w && lon <= e) return lon;
  const dw = Math.abs(((lon - w + 540) % 360) - 180), de = Math.abs(((lon - e + 540) % 360) - 180);
  return dw < de ? w : e;
}

function cameraLatLonH(p: V3) {
  const lon = (Math.atan2(p[1], p[0]) * 180) / Math.PI;
  const r = Math.hypot(p[0], p[1]);
  const lat = (Math.atan2(p[2], r * (1 - 0.0066943799901413165)) * 180) / Math.PI;
  const h = Math.hypot(...p) - 6371000;
  return { lat, lon, h };
}

/** A sphere around a lat/lon box between two heights (its corners, edge middles and middle). */
export function boundingSphere(b: { west: number; south: number; east: number; north: number }, lo: number, hi: number): { c: V3; r: number } {
  const lats = [b.south, (b.south + b.north) / 2, b.north], lons = [b.west, (b.west + b.east) / 2, b.east];
  const pts: V3[] = [];
  for (const la of lats) for (const lo2 of lons) for (const h of [lo, hi]) pts.push(geodeticToEcef(la, lo2, h));
  const c: V3 = [0, 0, 0];
  for (const p of pts) { c[0] += p[0] / pts.length; c[1] += p[1] / pts.length; c[2] += p[2] / pts.length; }
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  // the box bulges between the probes: a margin of its diagonal's sagitta
  return { c, r: r * 1.05 + 10 };
}

/** The view's four side planes and the near plane, normals inward: a point p is inside when n·p ≥ d. */
function frustumPlanes(v: View): { n: V3; d: number }[] {
  const f = norm(v.forward);
  const r = norm(cross(f, v.up));
  const u = cross(r, f);
  const ty = Math.tan(v.fov / 2), tx = ty * v.aspect;
  const make = (n: V3) => ({ n: norm(n), d: dot(norm(n), v.position) });
  // each side's normal is perpendicular to its edge direction (e.g. f + r·tx) and to the other axis, toward f
  return [
    make([f[0] * tx - r[0], f[1] * tx - r[1], f[2] * tx - r[2]]), // right
    make([f[0] * tx + r[0], f[1] * tx + r[1], f[2] * tx + r[2]]), // left
    make([f[0] * ty - u[0], f[1] * ty - u[1], f[2] * ty - u[2]]), // top
    make([f[0] * ty + u[0], f[1] * ty + u[1], f[2] * ty + u[2]]), // bottom
  ];
}

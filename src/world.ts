// What every part of the generator shares: the OSM data in the plane, spatial lookups, the tiles being filled, and
// the map from the plane (+ height) to ECEF.
import { geodeticToEcef, enu, type Frame, type V3 } from "../earthrt/core/geo.ts";
import { keyOf } from "../earthrt/core/tiles.ts";
import { Ground } from "./ground.ts";
import { TileMesh, type RGB } from "./mesh.ts";
import { fromPlane, planeToTile, pointInRing, toPlane, type P2 } from "./plane.ts";

export interface Feature { id: string; t: Record<string, string>; rings: P2[][][] }
export interface Line { id: string; t: Record<string, string>; pts: P2[] }
export interface Node { id: string; t: Record<string, string>; p: P2 }

/** A grid hash of things by their bounding boxes. */
export class Grid<T> {
  private cells = new Map<number, T[]>();
  constructor(private size: number) {}
  private k(i: number, j: number) { return (i + 50000) * 100000 + (j + 50000); }
  add(x0: number, y0: number, x1: number, y1: number, v: T) {
    const s = this.size;
    for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++) {
      const key = this.k(i, j);
      let c = this.cells.get(key);
      if (!c) this.cells.set(key, (c = []));
      c.push(v);
    }
  }
  near(x: number, y: number, r = 0): T[] {
    const s = this.size, out = new Set<T>();
    for (let i = Math.floor((x - r) / s); i <= Math.floor((x + r) / s); i++) for (let j = Math.floor((y - r) / s); j <= Math.floor((y + r) / s); j++) {
      const c = this.cells.get(this.k(i, j));
      if (c) for (const v of c) out.add(v);
    }
    return [...out];
  }
}


export class World {
  tiles = new Map<string, TileMesh>();
  boundsRing: P2[];
  /** footprints (outer rings) of what was built, for keeping trees and areas off them */
  footprints = new Grid<P2[]>(40);
  /** road and rail centre lines with their half-widths */
  roads = new Grid<{ a: P2; b: P2; hw: number; cls: string }>(40);
  water = new Grid<P2[][]>(100);
  /** temple and shrine grounds */
  precincts: { rings: P2[][]; religion: string; name?: string }[] = [];
  precinctGrid = new Grid<{ rings: P2[][]; religion: string; name?: string }>(100);
  stats = { buildings: 0, instanced: 0, unique: 0, temples: 0, shrines: 0, pagodas: 0, trees: 0, skipped: 0 };

  /** 0: the detailed level (z15 tiles); 1: the far level (z13 tiles: no small roads, fewer trees, no rooftop plant) */
  constructor(public ground: Ground, bounds: [number, number][], public frame: Frame, public zoom = 15, public lod = 0) {
    this.boundsRing = bounds.map(([lat, lon]) => toPlane(lat, lon));
  }

  inBounds(x: number, y: number) { return pointInRing(x, y, this.boundsRing); }

  /** The tile (of this level's zoom) holding a plane point (made on first use). */
  tileAt(x: number, y: number): TileMesh {
    const [tx, ty] = planeToTile(x, y, this.zoom);
    const key = keyOf({ z: this.zoom, x: Math.floor(tx), y: Math.floor(ty) });
    let t = this.tiles.get(key);
    if (!t) this.tiles.set(key, (t = new TileMesh(key, this.frame)));
    return t;
  }

  /** ECEF of a plane point at a height above the ellipsoid. */
  P(x: number, y: number, h: number): V3 {
    const g = fromPlane(x, y);
    return geodeticToEcef(g.lat, g.lon, h);
  }
  enuAt(x: number, y: number) { const g = fromPlane(x, y); return enu(g.lat, g.lon); }

  /** On a road (within its half-width + margin)? */
  onRoad(x: number, y: number, margin = 0.5): boolean {
    for (const s of this.roads.near(x, y, 30)) if (distSeg(x, y, s.a, s.b) < s.hw + margin) return true;
    return false;
  }
  nearestRoad(x: number, y: number, r = 40): { d: number; s: { a: P2; b: P2; hw: number; cls: string } } | null {
    let best: { d: number; s: { a: P2; b: P2; hw: number; cls: string } } | null = null;
    for (const s of this.roads.near(x, y, r)) {
      const d = distSeg(x, y, s.a, s.b) - s.hw;
      if (!best || d < best.d) best = { d, s };
    }
    return best;
  }
  inBuilding(x: number, y: number, margin = 0): boolean {
    for (const r of this.footprints.near(x, y, margin + 1)) if (pointInRing(x, y, r)) return true;
    if (margin > 0) for (const r of this.footprints.near(x, y, margin)) for (let i = 0; i < r.length; i++) if (distSeg(x, y, r[i], r[(i + 1) % r.length]) < margin) return true;
    return false;
  }
  inWater(x: number, y: number): boolean {
    for (const w of this.water.near(x, y)) if (pointInRing(x, y, w[0]) && !w.slice(1).some((h) => pointInRing(x, y, h))) return true;
    return false;
  }
  precinctAt(x: number, y: number) {
    for (const p of this.precinctGrid.near(x, y)) if (pointInRing(x, y, p.rings[0])) return p;
    return null;
  }
}

export function distSeg(x: number, y: number, a: P2, b: P2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

export const jitter = (c: RGB, j: number, r: () => number): RGB => {
  const k = 1 + (r() - 0.5) * 2 * j;
  return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
};
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

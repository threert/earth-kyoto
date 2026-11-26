// PLATEAU (Kyoto city's 3D city model, CityGML 2025: © MLIT Project PLATEAU, CC BY 4.0 compatible terms) as the
// buildings' primary source: every footprint with its measured height, storeys, usage, structure and year, and, where
// it has LOD2, its roof faces, read here into a roof form (flat, gabled, hipped), the ridge's direction and the eaves'
// and ridge's heights. tools/plateau.py makes data/plateau/bldg/*.json from the CityGML.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toPlane, type P2 } from "./plane.ts";

export interface Lod2Fit {
  form: "flat" | "gable" | "hip" | "complex";
  /** ridge direction, plane radians (gable, hip) */
  ridge: number;
  /** above the building's own ground (z0), m */
  eaves: number;
  top: number;
  /** sloped share of the roof area */
  sloped: number;
}

export interface PlateauBuilding {
  id: string;
  rings: P2[][];
  /** ground elevation in PLATEAU's heights (the lowest of its LOD1 solid) */
  z0: number | null;
  h: number;
  storeys: number;
  usage: string;
  structure: string;
  year: number;
  /** LOD2 surfaces in the plane, heights relative to z0: [kind (R roof, W wall, …), ring of [x, y, z]] */
  lod2?: [string, [number, number, number][]][];
  fit?: Lod2Fit;
}

type Raw = { fp: [number, number][][]; z0: number | null; h?: string; st?: string; use?: string; yr?: string; str?: string; id?: string; lod2?: [string, [number, number, number][]][] };

export function loadPlateau(dir: string, keep: (p: P2) => boolean): PlateauBuilding[] {
  if (!existsSync(dir)) return [];
  const out: PlateauBuilding[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const recs = JSON.parse(readFileSync(join(dir, f), "utf8")) as Raw[];
    for (const r of recs) {
      const rings = r.fp.map((ring) => ring.map(([la, lo]) => toPlane(la, lo)));
      if (rings[0].length > 1) { const a = rings[0][0], b = rings[0][rings[0].length - 1]; if (a[0] === b[0] && a[1] === b[1]) for (const ring of rings) ring.pop(); }
      if (!keep(rings[0][0])) continue;
      const z0 = r.z0;
      const b: PlateauBuilding = {
        id: r.id ?? `${f}:${out.length}`, rings, z0,
        h: Number(r.h ?? NaN), storeys: Number(r.st ?? NaN), usage: r.use ?? "461", structure: r.str ?? "611", year: Number(r.yr ?? NaN),
      };
      if (r.lod2 && z0 !== null) {
        b.lod2 = r.lod2.map(([k, ring]) => [k, ring.map(([la, lo, z]) => { const p = toPlane(la, lo); return [p[0], p[1], z - z0] as [number, number, number]; })]);
        b.fit = fitRoof(b.lod2);
      }
      if (!Number.isFinite(b.year) || b.year < 600) b.year = NaN;
      if (!(b.storeys > 0)) b.storeys = NaN;
      out.push(b);
    }
  }
  return out;
}

/** The roof's form from its LOD2 faces. */
export function fitRoof(lod2: [string, [number, number, number][]][]): Lod2Fit | undefined {
  let flatA = 0, slopeA = 0, sxx = 0, sxy = 0, zmin = Infinity, zmax = -Infinity, slopedMin = Infinity;
  const faces: { nx: number; ny: number; a: number }[] = [];
  for (const [k, ring] of lod2) {
    if (k !== "R" || ring.length < 3) continue;
    // Newell normal and area
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      x += (a[1] - b[1]) * (a[2] + b[2]);
      y += (a[2] - b[2]) * (a[0] + b[0]);
      z += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const l = Math.hypot(x, y, z);
    if (l < 1e-6) continue;
    const area = l / 2;
    const nz = Math.abs(z / l);
    for (const p of ring) { zmin = Math.min(zmin, p[2]); zmax = Math.max(zmax, p[2]); }
    if (nz > 0.985) { flatA += area; continue; }
    slopeA += area;
    for (const p of ring) slopedMin = Math.min(slopedMin, p[2]);
    const sgn = z < 0 ? -1 : 1;
    const nx = (sgn * x) / l, ny = (sgn * y) / l;
    const th = Math.atan2(ny, nx);
    // the slopes' axis (doubled angles: opposite slopes agree)
    sxx += Math.cos(2 * th) * area; sxy += Math.sin(2 * th) * area;
    faces.push({ nx, ny, a: area });
  }
  const total = flatA + slopeA;
  if (!(total > 0)) return undefined;
  const sloped = slopeA / total;
  if (sloped < 0.3) return { form: "flat", ridge: 0, eaves: zmax, top: zmax, sloped };
  const axis = Math.atan2(sxy, sxx) / 2; // the main slopes' direction (down-slope, ±)
  let main = 0, ends = 0, other = 0;
  for (const f of faces) {
    const c = Math.abs(f.nx * Math.cos(axis) + f.ny * Math.sin(axis)) / (Math.hypot(f.nx, f.ny) || 1);
    if (c > 0.8) main += f.a; else if (c < 0.35) ends += f.a; else other += f.a;
  }
  const form = other > 0.3 * slopeA ? "complex" : ends > 0.08 * slopeA ? "hip" : "gable";
  return { form, ridge: axis + Math.PI / 2, eaves: Number.isFinite(slopedMin) ? slopedMin : zmin, top: zmax, sloped };
}

// ------------------------------------------------------------------------------------------------ attributes

export const USAGE: Record<string, string> = {
  "401": "office", "402": "commercial", "403": "hotel", "404": "commercial-mixed", "411": "house", "412": "apartments",
  "413": "shop-house", "414": "shop-apartments", "415": "workshop-house", "421": "civic", "422": "school", "431": "warehouse",
  "441": "factory", "451": "farm", "452": "utility", "453": "defence", "454": "other", "461": "unknown",
};
export const WOODEN = (s: string) => s === "601";
export const CONCRETE = (s: string) => s === "602" || s === "603" || s === "606";
export const STEEL = (s: string) => s === "604" || s === "605";

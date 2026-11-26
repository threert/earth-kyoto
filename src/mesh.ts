// A tile's content as it is written (SPEC § 5, `earthrt/tileset@2`): meshes by material, vertices relative to the
// tile's centre in ECEF axes, and copies of the kit's pieces (instances). Everything in doubles until written.
import { encodeErt } from "../earthrt/core/ert.ts";
import { enu, type V3 } from "../earthrt/core/geo.ts";

export type RGB = [number, number, number];

/** sRGB 0..255 → linear. */
export const lin = (c: RGB): RGB => c.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }) as RGB;

class Arr {
  a: Float32Array;
  n = 0;
  constructor(cap = 1024) { this.a = new Float32Array(cap); }
  push3(x: number, y: number, z: number) { this.grow(3); this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; }
  push2(x: number, y: number) { this.grow(2); this.a[this.n++] = x; this.a[this.n++] = y; }
  grow(k: number) { if (this.n + k > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + k)); b.set(this.a); this.a = b; } }
  get out() { return this.a.slice(0, this.n); }
}

class Part {
  pos = new Arr(); nrm = new Arr(); uv = new Arr(); col = new Arr();
  idx: number[] = [];
  get v() { return this.pos.n / 3; }
}

export class TileMesh {
  parts = new Map<string, Part>();
  /** kit piece → matrices (12 floats: the 3 axes then the translation, column-major as three.js) and colours */
  inst = new Map<string, { m: number[]; c: number[] }>();
  tris = 0;
  constructor(public key: string, public center: V3) {}

  part(material: string) {
    let p = this.parts.get(material);
    if (!p) this.parts.set(material, (p = new Part()));
    return p;
  }

  /** A flat polygon (convex or a triangle fan from its first vertex) in ECEF; normal from its winding (or `up` to
   *  orient it: the side facing `up` is the front). */
  poly(material: string, pts: V3[], col: RGB, uvs?: [number, number][], up?: V3) {
    if (pts.length < 3) return;
    let n = newell(pts);
    if (up && n[0] * up[0] + n[1] * up[1] + n[2] * up[2] < 0) {
      pts = pts.slice().reverse();
      if (uvs) uvs = uvs.slice().reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const p = this.part(material), C = this.center, base = p.v;
    for (let i = 0; i < pts.length; i++) {
      p.pos.push3(pts[i][0] - C[0], pts[i][1] - C[1], pts[i][2] - C[2]);
      p.nrm.push3(n[0], n[1], n[2]);
      p.col.push3(col[0], col[1], col[2]);
      if (uvs) p.uv.push2(uvs[i][0], uvs[i][1]); else p.uv.push2(0, 0);
    }
    for (let i = 1; i + 1 < pts.length; i++) p.idx.push(base, base + i, base + i + 1);
    this.tris += pts.length - 2;
  }

  /** Smooth-shaded triangles (own normals). */
  tri(material: string, pts: V3[], nrms: V3[], col: RGB) {
    const p = this.part(material), C = this.center, base = p.v;
    for (let i = 0; i < 3; i++) {
      p.pos.push3(pts[i][0] - C[0], pts[i][1] - C[1], pts[i][2] - C[2]);
      p.nrm.push3(nrms[i][0], nrms[i][1], nrms[i][2]);
      p.col.push3(col[0], col[1], col[2]);
      p.uv.push2(0, 0);
    }
    p.idx.push(base, base + 1, base + 2);
    this.tris++;
  }

  /** A copy of a kit piece: its unit space (x, y up, z) mapped by axes X, Y, Z and placed at T (ECEF). */
  instance(piece: string, X: V3, Y: V3, Z: V3, T: V3, col: RGB) {
    let e = this.inst.get(piece);
    if (!e) this.inst.set(piece, (e = { m: [], c: [] }));
    const C = this.center;
    e.m.push(X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2], T[0] - C[0], T[1] - C[1], T[2] - C[2]);
    e.c.push(col[0], col[1], col[2]);
  }

  get empty() { return this.parts.size === 0 && this.inst.size === 0; }

  /** The ERT file (layer "mesh", SPEC § 5) and its stats. */
  encode(extra: Record<string, unknown> = {}): { bytes: Uint8Array; radius: number; tris: number; instances: number } {
    const chunks: Record<string, Float32Array | Uint32Array | Uint16Array> = {};
    const meshes: unknown[] = [];
    let r2 = 0, k = 0, instances = 0;
    for (const [material, p] of [...this.parts].sort((a, b) => a[0].localeCompare(b[0]))) {
      const pos = p.pos.out;
      for (let i = 0; i < pos.length; i += 3) r2 = Math.max(r2, pos[i] ** 2 + pos[i + 1] ** 2 + pos[i + 2] ** 2);
      const name = `m${k++}`;
      chunks[`${name}.pos`] = pos;
      chunks[`${name}.nrm`] = p.nrm.out;
      chunks[`${name}.uv`] = p.uv.out;
      chunks[`${name}.col`] = p.col.out;
      chunks[`${name}.idx`] = Uint32Array.from(p.idx);
      meshes.push({ material, chunk: name, v: p.v, t: p.idx.length / 3 });
    }
    const insts: unknown[] = [];
    k = 0;
    for (const [piece, e] of [...this.inst].sort((a, b) => a[0].localeCompare(b[0]))) {
      const name = `i${k++}`;
      chunks[`${name}.m`] = Float32Array.from(e.m);
      chunks[`${name}.col`] = Float32Array.from(e.c);
      for (let i = 9; i < e.m.length; i += 12) r2 = Math.max(r2, e.m[i] ** 2 + e.m[i + 1] ** 2 + e.m[i + 2] ** 2);
      insts.push({ piece, chunk: name, n: e.c.length / 3 });
      instances += e.c.length / 3;
    }
    const radius = Math.sqrt(r2) + 60; // (instances: their pieces reach beyond their origins; trees and roofs < 60 m)
    const bytes = encodeErt({ v: 1, layer: "mesh", key: this.key, enc: "expanded", center: this.center, radius, meshes, instances: insts, ...extra }, chunks);
    return { bytes, radius, tris: this.tris, instances };
  }
}

export function newell(pts: V3[]): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** The local frame at a geodetic point: east, north, up (ECEF unit vectors). */
export const frameAt = (lat: number, lon: number) => enu(lat, lon);

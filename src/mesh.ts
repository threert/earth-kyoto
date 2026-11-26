// A tile's content (SPEC § 5, `earthrt/tileset@2`): meshes by material with vertex colours, and copies of the kit's
// pieces, all in the place's frame (east-up-south at the anchor: x east, y up, z south, metres). The generator works
// in ECEF (doubles); what is kept is in the frame, as float32 (within 10 km of the anchor: millimetres).
import type { Frame, V3 } from "../earthrt/core/geo.ts";

export type RGB = [number, number, number];

/** sRGB 0..255 → linear. */
export const lin = (c: RGB): RGB => c.map((v) => { const x = Math.max(0, Math.min(255, v)) / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }) as RGB;

class Arr {
  a: Float32Array;
  n = 0;
  constructor(cap = 1024) { this.a = new Float32Array(cap); }
  push(...v: number[]) { if (this.n + v.length > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + v.length)); b.set(this.a); this.a = b; } for (const x of v) this.a[this.n++] = x; }
  get out() { return this.a.slice(0, this.n); }
}

export class Part {
  pos = new Arr(); uv = new Arr(); col: number[] = [];
  idx: number[] = [];
  private seen = new Map<string, number>();
  hasUv = false;
  get v() { return this.pos.n / 3; }
  /** A vertex (flat-shaded meshes: no normal of its own; glTF hosts make the faces' normals), shared with an
   *  identical one already in the part. Colours are kept as bytes (linear). */
  vertex(p: V3, c: RGB, uv: [number, number] | null): number {
    const cb = [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
    const k = `${Math.round(p[0] * 500)},${Math.round(p[1] * 500)},${Math.round(p[2] * 500)},${cb[0]},${cb[1]},${cb[2]}${uv ? `,${Math.round(uv[0] * 100)},${Math.round(uv[1] * 100)}` : ""}`;
    const hit = this.seen.get(k);
    if (hit !== undefined) return hit;
    const i = this.v;
    this.pos.push(p[0], p[1], p[2]); this.col.push(cb[0], cb[1], cb[2], 255);
    this.uv.push(uv ? uv[0] : 0, uv ? uv[1] : 0);
    if (uv) this.hasUv = true;
    this.seen.set(k, i);
    return i;
  }
  /** Frees the lookup once the part is complete. */
  seal() { this.seen.clear(); }
}

/** Materials whose surfaces use uv (metres): façade windows. Others go without. */
export const UV_MATERIALS = new Set(["facade"]);

export interface Copies { t: number[]; r: number[]; s: number[]; c: number[] }

export class TileMesh {
  parts = new Map<string, Part>();
  /** kit piece → its copies: translation, rotation (quaternion), scale, colour (linear) */
  inst = new Map<string, Copies>();
  tris = 0;
  /** bounds in the frame */
  lo: V3 = [Infinity, Infinity, Infinity];
  hi: V3 = [-Infinity, -Infinity, -Infinity];
  constructor(public key: string, public frame: Frame) {}

  part(material: string) {
    let p = this.parts.get(material);
    if (!p) this.parts.set(material, (p = new Part()));
    return p;
  }

  private grow(p: V3, r = 0) {
    for (let k = 0; k < 3; k++) { this.lo[k] = Math.min(this.lo[k], p[k] - r); this.hi[k] = Math.max(this.hi[k], p[k] + r); }
  }

  /** A flat polygon (convex, or a fan from its first vertex) of ECEF points; its normal from its winding, or turned
   *  to face `up` (ECEF) when given. */
  poly(material: string, ecef: V3[], col: RGB, uvs?: [number, number][], up?: V3) {
    if (ecef.length < 3) return;
    let pts = ecef.map((q) => this.frame.point(q));
    let n = newell(pts);
    if (up) {
      const u = this.frame.dir(up);
      if (n[0] * u[0] + n[1] * u[1] + n[2] * u[2] < 0) { pts = pts.reverse(); if (uvs) uvs = uvs.slice().reverse(); n = [-n[0], -n[1], -n[2]]; }
    }
    if (!Number.isFinite(n[0])) return;
    const p = this.part(material);
    const keepUv = uvs && UV_MATERIALS.has(material);
    const ids = pts.map((q, i) => { this.grow(q); return p.vertex(q, col, keepUv ? uvs![i] : null); });
    for (let i = 1; i + 1 < ids.length; i++) if (ids[0] !== ids[i] && ids[i] !== ids[i + 1] && ids[0] !== ids[i + 1]) { p.idx.push(ids[0], ids[i], ids[i + 1]); this.tris++; }
  }

  /** A copy of a kit piece: its unit space mapped by the ECEF axes X, Y, Z (orthogonal, any lengths) and placed at T. */
  instance(piece: string, X: V3, Y: V3, Z: V3, T: V3, col: RGB) {
    let e = this.inst.get(piece);
    if (!e) this.inst.set(piece, (e = { t: [], r: [], s: [], c: [] }));
    const x = this.frame.dir(X), y = this.frame.dir(Y), z = this.frame.dir(Z), t = this.frame.point(T);
    const sx = Math.hypot(...x), sy = Math.hypot(...y), sz = Math.hypot(...z);
    const q = quatOfAxes([x[0] / sx, x[1] / sx, x[2] / sx], [y[0] / sy, y[1] / sy, y[2] / sy], [z[0] / sz, z[1] / sz, z[2] / sz]);
    e.t.push(t[0], t[1], t[2]); e.r.push(...q); e.s.push(sx, sy, sz); e.c.push(col[0], col[1], col[2]);
    this.grow(t, Math.max(sx, sy, sz) * 0.75);
  }

  get empty() { return this.parts.size === 0 && this.inst.size === 0; }
  get instances() { let n = 0; for (const e of this.inst.values()) n += e.c.length / 3; return n; }
}

/** The rotation whose columns are the unit vectors a, b, c (a right-handed basis), as a quaternion [x, y, z, w]. */
export function quatOfAxes(a: V3, b: V3, c: V3): [number, number, number, number] {
  // re-orthonormalise (Gram–Schmidt) against rounding
  const dot = (u: V3, v: V3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const nb = norm([b[0] - a[0] * dot(a, b), b[1] - a[1] * dot(a, b), b[2] - a[2] * dot(a, b)]);
  const nc: V3 = [a[1] * nb[2] - a[2] * nb[1], a[2] * nb[0] - a[0] * nb[2], a[0] * nb[1] - a[1] * nb[0]];
  void c;
  const m00 = a[0], m01 = nb[0], m02 = nc[0], m10 = a[1], m11 = nb[1], m12 = nc[1], m20 = a[2], m21 = nb[2], m22 = nc[2];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; }
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export function newell(pts: V3[]): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

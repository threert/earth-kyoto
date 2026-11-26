// Buildings tiles (SPEC § 4): footprints with heights (compact), extruded into walls and roofs (expanded). The same
// extrusion runs in the service (expanded files for the client) and in the web's workers.
import earcut from "earcut";
import { enu, geodeticToEcef, type V3 } from "./geo.ts";
import { decodeErt, encodeErt, srgbToLinear, type Ert } from "./ert.ts";
import { keyOf, tileCenter, type TileKey } from "./tiles.ts";

export interface Building {
  /** Rings of [lat, lon]; the first is the outer ring, the rest holes. Not closed. */
  rings: [number, number][][];
  /** Ground under it, m above the ellipsoid. */
  base: number;
  /** Roof above base, m. */
  height: number;
  /** Walls start at, m above base. */
  minHeight?: number;
  kind?: number;
  roof?: number;
  wall?: [number, number, number];
  roofColor?: [number, number, number];
}

const Q = 8; // eighths of a metre

/** A compact buildings tile. Buildings whose footprint reaches further than 4 km from the centre are dropped. */
export function encodeBuildingsCompact(key: TileKey, list: Building[], src: string[]): Uint8Array {
  const center = tileCenter(key);
  const c = centerLatLon(key);
  const { e, n } = enu(c.lat, c.lon);
  const kept: { rings: Int16Array[]; b: Building }[] = [];
  const p: V3 = [0, 0, 0];
  for (const b of list) {
    const rings: Int16Array[] = [];
    let ok = true;
    for (const ring of b.rings) {
      if (ring.length < 3) { if (!rings.length) ok = false; continue; }
      const out = new Int16Array(ring.length * 2);
      for (let i = 0; i < ring.length; i++) {
        geodeticToEcef(ring[i][0], ring[i][1], 0, p);
        const dx = p[0] - center[0], dy = p[1] - center[1], dz = p[2] - center[2];
        const x = Math.round((dx * e[0] + dy * e[1] + dz * e[2]) * Q), y = Math.round((dx * n[0] + dy * n[1] + dz * n[2]) * Q);
        if (Math.abs(x) > 32767 || Math.abs(y) > 32767) { ok = false; break; }
        out[2 * i] = x; out[2 * i + 1] = y;
      }
      if (!ok) break;
      rings.push(out);
    }
    if (ok && rings.length && b.height > 0) kept.push({ rings, b });
  }
  const count = kept.length;
  const rb = new Uint32Array(count + 1);
  let ringCount = 0, vertCount = 0;
  for (let i = 0; i < count; i++) {
    rb[i] = ringCount;
    ringCount += kept[i].rings.length;
    for (const r of kept[i].rings) vertCount += r.length / 2;
  }
  rb[count] = ringCount;
  const rn = new Uint32Array(ringCount), xy = new Int16Array(vertCount * 2);
  const base = new Float32Array(count), hgt = new Uint16Array(count), minh = new Uint16Array(count);
  const kind = new Uint8Array(count), roof = new Uint8Array(count), wall = new Uint8Array(3 * count), rcol = new Uint8Array(3 * count);
  let r = 0, v = 0;
  for (let i = 0; i < count; i++) {
    const { rings, b } = kept[i];
    for (const ring of rings) { rn[r++] = ring.length / 2; xy.set(ring, v); v += ring.length; }
    base[i] = b.base;
    hgt[i] = Math.min(65535, Math.round(b.height * 10));
    minh[i] = Math.min(65535, Math.round((b.minHeight ?? 0) * 10));
    kind[i] = b.kind ?? 0;
    roof[i] = b.roof ?? 0;
    wall.set(b.wall ?? [200, 196, 188], 3 * i);
    rcol.set(b.roofColor ?? [150, 148, 145], 3 * i);
  }
  let radius = 0;
  for (let i = 0; i < vertCount; i++) radius = Math.max(radius, Math.hypot(xy[2 * i], xy[2 * i + 1]) / Q);
  let maxTop = 0, minBase = Infinity;
  for (let i = 0; i < count; i++) { maxTop = Math.max(maxTop, base[i] + hgt[i] / 10); minBase = Math.min(minBase, base[i]); }
  radius = Math.hypot(radius, Math.max(Math.abs(maxTop), Math.abs(minBase === Infinity ? 0 : minBase))) + 1;
  return encodeErt(
    { v: 1, layer: "buildings", key: keyOf(key), enc: "compact", center, radius, count, src },
    { rb, rn, xy, base, hgt, minh, kind, roof, wall, rcol },
  );
}

function centerLatLon(key: TileKey) {
  const c = tileCenter(key);
  const lon = (Math.atan2(c[1], c[0]) * 180) / Math.PI;
  const lat = (Math.atan2(c[2], Math.hypot(c[0], c[1]) * (1 - 0.0066943799901413165)) * 180) / Math.PI;
  return { lat, lon };
}

export interface BuildingsMesh {
  key: string;
  center: V3;
  radius: number;
  count: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  index: Uint32Array;
}

/** Compact → walls and flat roofs (v1 draws every roof flat), in ECEF axes relative to the tile's centre. */
export function expandBuildings(compact: Ert): BuildingsMesh {
  const hd = compact.header;
  if (hd.layer !== "buildings" || hd.enc !== "compact") throw new Error(`expandBuildings: ${hd.layer}/${hd.enc}`);
  const ch = compact.chunks;
  const rb = ch.rb as Uint32Array, rn = ch.rn as Uint32Array, xy = ch.xy as Int16Array;
  const base = ch.base as Float32Array, hgt = ch.hgt as Uint16Array, minh = ch.minh as Uint16Array;
  const wall = ch.wall as Uint8Array, rcol = ch.rcol as Uint8Array;
  const count = hd.count ?? 0;
  const center = hd.center;
  const g = Math.atan2(center[2], Math.hypot(center[0], center[1]) * (1 - 0.0066943799901413165));
  const { e, n, u } = enu((g * 180) / Math.PI, (Math.atan2(center[1], center[0]) * 180) / Math.PI);
  // the tile's centre is on the ellipsoid (height 0): a point's height is along u from it
  // (the curvature over a 2.4 km tile is 0.1 m at its edge: left out)
  let V = 0, T = 0;
  const ringOf = new Uint32Array(rn.length + 1);
  for (let r = 0; r < rn.length; r++) ringOf[r + 1] = ringOf[r] + rn[r];
  for (let b = 0; b < count; b++) {
    let verts = 0;
    for (let r = rb[b]; r < rb[b + 1]; r++) verts += rn[r];
    // walls: 4 vertices and 2 triangles an edge; the roof: its vertices, n − 2 + 2·holes triangles
    V += verts * 5;
    T += verts * 2 + Math.max(0, verts - 2 + 2 * (rb[b + 1] - rb[b] - 1));
  }
  const positions = new Float32Array(V * 3), normals = new Float32Array(V * 3), colors = new Float32Array(V * 3), uvs = new Float32Array(V * 2);
  const index = new Uint32Array(T * 3);
  let vi = 0, ti = 0;
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: [number, number, number], uu: number, vv: number) => {
    positions[3 * vi] = e[0] * x + n[0] * y + u[0] * z;
    positions[3 * vi + 1] = e[1] * x + n[1] * y + u[1] * z;
    positions[3 * vi + 2] = e[2] * x + n[2] * y + u[2] * z;
    normals[3 * vi] = e[0] * nx + n[0] * ny + u[0] * nz;
    normals[3 * vi + 1] = e[1] * nx + n[1] * ny + u[1] * nz;
    normals[3 * vi + 2] = e[2] * nx + n[2] * ny + u[2] * nz;
    colors[3 * vi] = c[0]; colors[3 * vi + 1] = c[1]; colors[3 * vi + 2] = c[2];
    uvs[2 * vi] = uu; uvs[2 * vi + 1] = vv;
    return vi++;
  };
  for (let b = 0; b < count; b++) {
    const z0 = base[b] + minh[b] / 10, z1 = base[b] + hgt[b] / 10;
    if (z1 <= z0) continue;
    const wc: [number, number, number] = [srgbToLinear(wall[3 * b]), srgbToLinear(wall[3 * b + 1]), srgbToLinear(wall[3 * b + 2])];
    const rc: [number, number, number] = [srgbToLinear(rcol[3 * b]), srgbToLinear(rcol[3 * b + 1]), srgbToLinear(rcol[3 * b + 2])];
    const flat: number[] = [], holes: number[] = [];
    for (let r = rb[b]; r < rb[b + 1]; r++) {
      const at = ringOf[r], m = rn[r];
      // the outer ring counter-clockwise seen from above, holes clockwise
      let area = 0;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        area += xy[2 * (at + i)] * xy[2 * (at + j) + 1] - xy[2 * (at + j)] * xy[2 * (at + i) + 1];
      }
      const wantCcw = r === rb[b];
      const flip = (area > 0) !== wantCcw;
      if (r !== rb[b]) holes.push(flat.length / 2);
      let along = 0;
      for (let k = 0; k < m; k++) {
        const i = flip ? m - 1 - k : k, j = flip ? (m - 2 - k + m) % m : (k + 1) % m;
        const ax = xy[2 * (at + i)] / Q, ay = xy[2 * (at + i) + 1] / Q, bx = xy[2 * (at + j)] / Q, by = xy[2 * (at + j) + 1] / Q;
        flat.push(ax, ay);
        const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
        const nx = dy / l, ny = -dx / l;
        const a0 = put(ax, ay, z0, nx, ny, 0, wc, along, z0 - base[b]);
        const b0 = put(bx, by, z0, nx, ny, 0, wc, along + l, z0 - base[b]);
        const b1 = put(bx, by, z1, nx, ny, 0, wc, along + l, z1 - base[b]);
        const a1 = put(ax, ay, z1, nx, ny, 0, wc, along, z1 - base[b]);
        index[ti++] = a0; index[ti++] = b0; index[ti++] = b1;
        index[ti++] = a0; index[ti++] = b1; index[ti++] = a1;
        along += l;
      }
    }
    // the roof
    const tris = earcut(flat, holes.length ? holes : undefined, 2);
    const first = vi;
    for (let k = 0; k < flat.length / 2; k++) put(flat[2 * k], flat[2 * k + 1], z1, 0, 0, 1, rc, flat[2 * k], flat[2 * k + 1]);
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k], bb = tris[k + 1], c = tris[k + 2];
      const cr = (flat[2 * bb] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * bb + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
      if (cr >= 0) { index[ti++] = first + a; index[ti++] = first + bb; index[ti++] = first + c; }
      else { index[ti++] = first + a; index[ti++] = first + c; index[ti++] = first + bb; }
    }
  }
  return {
    key: hd.key, center, radius: hd.radius, count,
    positions: positions.subarray(0, vi * 3), normals: normals.subarray(0, vi * 3), colors: colors.subarray(0, vi * 3), uvs: uvs.subarray(0, vi * 2),
    index: index.subarray(0, ti),
  };
}

export function encodeBuildingsExpanded(m: BuildingsMesh, src: string[]): Uint8Array {
  return encodeErt(
    { v: 1, layer: "buildings", key: m.key, enc: "expanded", center: m.center, radius: m.radius, count: m.count, src },
    { pos: m.positions, nrm: m.normals, col: m.colors, uv: m.uvs, idx: m.index },
  );
}

export function readBuildingsExpanded(buf: ArrayBuffer | Uint8Array): BuildingsMesh {
  const e = decodeErt(buf);
  const hd = e.header;
  if (hd.layer !== "buildings" || hd.enc !== "expanded") throw new Error(`readBuildingsExpanded: ${hd.layer}/${hd.enc}`);
  return {
    key: hd.key, center: hd.center, radius: hd.radius, count: hd.count ?? 0,
    positions: e.chunks.pos as Float32Array, normals: e.chunks.nrm as Float32Array, colors: e.chunks.col as Float32Array,
    uvs: e.chunks.uv as Float32Array, index: e.chunks.idx as Uint32Array,
  };
}

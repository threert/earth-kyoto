// Terrain tiles: the shared index, compact → expanded (SPEC § 4), and what the service needs to make a compact tile.
import { geodeticToEcef, enu, type V3 } from "./geo.ts";
import { encodeErt, decodeErt, octDecode, octEncode, srgbToLinear, type Ert, type ErtHeader } from "./ert.ts";
import { gridLatLon, keyOf, parseKey, tileCenter, type TileKey } from "./tiles.ts";

const indexCache = new Map<number, Uint32Array>();

/**
 * The triangles of every terrain tile of grid n: the grid's (counter-clockwise seen from above) and the skirt's
 * (facing outward). Vertices: the grid row-major, then the skirt (north edge W→E, east N→S, south E→W, west S→N).
 */
export function terrainIndex(n: number): Uint32Array {
  const hit = indexCache.get(n);
  if (hit) return hit;
  const quads = (n - 1) * (n - 1) + 4 * (n - 1);
  const idx = new Uint32Array(quads * 6);
  let k = 0;
  // Row r is further south than r − 1, column c further east. Seen from above (north up, east right), a cell's
  // corners a (r, c), b (r, c+1), c (r+1, c), d (r+1, c+1): a→c→d→b is counter-clockwise.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const a = r * n + c, b = a + 1, cc = a + n, d = cc + 1;
      idx[k++] = a; idx[k++] = cc; idx[k++] = d;
      idx[k++] = a; idx[k++] = d; idx[k++] = b;
    }
  }
  // Skirts: each edge's vertices (in the skirt's order) and the skirt copies beside them, wall facing outward.
  const g = n * n;
  const edge = (side: number, i: number) => {
    // grid vertex of the side's i-th skirt vertex
    if (side === 0) return i;                         // north, W→E
    if (side === 1) return i * n + (n - 1);           // east, N→S
    if (side === 2) return (n - 1) * n + (n - 1 - i); // south, E→W
    return (n - 1 - i) * n;                           // west, S→N
  };
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < n - 1; i++) {
      const top0 = edge(side, i), top1 = edge(side, i + 1);
      const low0 = g + side * n + i, low1 = low0 + 1;
      // the walk goes clockwise seen from above (N edge W→E, …); seen from outside, top0 → top1 → low1 is
      // counter-clockwise
      idx[k++] = top0; idx[k++] = top1; idx[k++] = low1;
      idx[k++] = top0; idx[k++] = low1; idx[k++] = low0;
    }
  }
  indexCache.set(n, idx);
  return idx;
}

/** Grid vertex of the skirt vertex `s` (0 .. 4n − 1). */
export function skirtSource(n: number, s: number): number {
  const side = Math.floor(s / n), i = s % n;
  if (side === 0) return i;
  if (side === 1) return i * n + (n - 1);
  if (side === 2) return (n - 1) * n + (n - 1 - i);
  return (n - 1 - i) * n;
}

export interface TerrainSource {
  key: TileKey;
  n: number;
  /** Heights above the ellipsoid, m, n × n row-major (row 0 north). Water vertices: the water's surface. */
  heights: Float32Array;
  /** Land classes (SPEC § 4), n × n. */
  cls: Uint8Array;
  /** Albedo, sRGB, 3 × n × n. */
  rgb: Uint8Array;
  /** 0 land … 255 water, n × n. */
  water: Uint8Array;
  /** Unit normals in ECEF axes, 3 × n × n (computed with the neighbours' data, so edges match). */
  normals: Float32Array;
  skirt: number;
  src: string[];
}

/** A compact terrain tile (the service's output). */
export function encodeTerrainCompact(t: TerrainSource): Uint8Array {
  const n = t.n, nn = n * n;
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < nn; i++) {
    minH = Math.min(minH, t.heights[i]);
    maxH = Math.max(maxH, t.heights[i]);
  }
  minH = Math.floor(minH * 4) / 4;
  maxH = Math.ceil(maxH * 4) / 4;
  const range = maxH - minH;
  const h = new Uint16Array(nn);
  for (let i = 0; i < nn; i++) h[i] = range > 0 ? Math.round(((t.heights[i] - minH) / range) * 65535) : 0;
  const nrm = new Int8Array(2 * nn);
  for (let i = 0; i < nn; i++) octEncode(t.normals[3 * i], t.normals[3 * i + 1], t.normals[3 * i + 2], nrm, 2 * i);
  const center = tileCenter(t.key);
  const radius = boundingRadius(t.key, n, minH - t.skirt, maxH, center);
  return encodeErt(
    { v: 1, layer: "terrain", key: keyOf(t.key), enc: "compact", center, radius, minH, maxH, n, skirt: t.skirt, src: t.src },
    { h, nrm, cls: t.cls, rgb: t.rgb, water: t.water },
  );
}

/** Radius about `center` that holds the tile's surface between two heights (corners, edge midpoints and middle). */
function boundingRadius(key: TileKey, n: number, lo: number, hi: number, center: V3): number {
  const { lats, lons } = gridLatLon(key, n);
  let r = 0;
  const probe = [0, (n - 1) >> 2, (n - 1) >> 1, (3 * (n - 1)) >> 2, n - 1];
  for (const i of probe) for (const j of probe) for (const h of [lo, hi]) {
    const p = geodeticToEcef(lats[i], lons[j], h);
    r = Math.max(r, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]));
  }
  return r * 1.02 + 1;
}

export interface TerrainMesh {
  key: string;
  center: V3;
  radius: number;
  minH: number;
  maxH: number;
  n: number;
  /** relative to center, ECEF axes */
  positions: Float32Array;
  normals: Float32Array;
  /** linear albedo */
  colors: Float32Array;
  /** u = water, v = class / 255 */
  uvs: Float32Array;
  index: Uint32Array;
  /** heights of the grid (n × n), for picking and the camera's floor */
  heights: Float32Array;
}

/** Compact → the vertex arrays (the web's worker; the service, for expanded tiles). */
export function expandTerrain(compact: Ert): TerrainMesh {
  const hd = compact.header;
  if (hd.layer !== "terrain" || hd.enc !== "compact") throw new Error(`expandTerrain: ${hd.layer}/${hd.enc}`);
  const n = hd.n!, nn = n * n, V = nn + 4 * n;
  const key = parseKey(hd.key);
  const { lats, lons } = gridLatLon(key, n);
  const center = hd.center;
  const h = compact.chunks.h as Uint16Array, nrm = compact.chunks.nrm as Int8Array;
  const cls = compact.chunks.cls as Uint8Array, rgb = compact.chunks.rgb as Uint8Array, water = compact.chunks.water as Uint8Array;
  const minH = hd.minH!, range = hd.maxH! - hd.minH!, skirt = hd.skirt ?? 0;
  const positions = new Float32Array(3 * V), normals = new Float32Array(3 * V), colors = new Float32Array(3 * V), uvs = new Float32Array(2 * V);
  const heights = new Float32Array(nn);
  const p: V3 = [0, 0, 0];
  // per-column sin/cos and per-row prime vertical radius: geodeticToEcef without its trigonometry per vertex
  const cosL = new Float64Array(n), sinL = new Float64Array(n);
  for (let j = 0; j < n; j++) { cosL[j] = Math.cos((lons[j] * Math.PI) / 180); sinL[j] = Math.sin((lons[j] * Math.PI) / 180); }
  const E2 = 0.0066943799901413165, A = 6378137;
  for (let i = 0; i < n; i++) {
    const phi = (lats[i] * Math.PI) / 180, sp = Math.sin(phi), cp = Math.cos(phi);
    const N = A / Math.sqrt(1 - E2 * sp * sp);
    for (let j = 0; j < n; j++) {
      const v = i * n + j;
      const hv = minH + (h[v] / 65535) * range;
      heights[v] = hv;
      positions[3 * v] = (N + hv) * cp * cosL[j] - center[0];
      positions[3 * v + 1] = (N + hv) * cp * sinL[j] - center[1];
      positions[3 * v + 2] = (N * (1 - E2) + hv) * sp - center[2];
      octDecode(nrm[2 * v], nrm[2 * v + 1], normals, 3 * v);
      colors[3 * v] = srgbToLinear(rgb[3 * v]);
      colors[3 * v + 1] = srgbToLinear(rgb[3 * v + 1]);
      colors[3 * v + 2] = srgbToLinear(rgb[3 * v + 2]);
      uvs[2 * v] = water[v] / 255;
      uvs[2 * v + 1] = cls[v] / 255;
    }
  }
  for (let s = 0; s < 4 * n; s++) {
    const g = skirtSource(n, s), v = nn + s;
    const i = Math.floor(g / n), j = g % n;
    geodeticToEcef(lats[i], lons[j], heights[g] - skirt, p);
    positions[3 * v] = p[0] - center[0]; positions[3 * v + 1] = p[1] - center[1]; positions[3 * v + 2] = p[2] - center[2];
    for (let c = 0; c < 3; c++) { normals[3 * v + c] = normals[3 * g + c]; colors[3 * v + c] = colors[3 * g + c]; }
    uvs[2 * v] = uvs[2 * g]; uvs[2 * v + 1] = uvs[2 * g + 1];
  }
  return { key: hd.key, center, radius: hd.radius, minH, maxH: hd.maxH!, n, positions, normals, colors, uvs, index: terrainIndex(n), heights };
}

/** An expanded terrain file of a mesh (what the client downloads). */
export function encodeTerrainExpanded(m: TerrainMesh, header: Pick<ErtHeader, "skirt" | "src">): Uint8Array {
  return encodeErt(
    { v: 1, layer: "terrain", key: m.key, enc: "expanded", center: m.center, radius: m.radius, minH: m.minH, maxH: m.maxH, n: m.n, skirt: header.skirt, src: header.src },
    { pos: m.positions, nrm: m.normals, col: m.colors, uv: m.uvs },
  );
}

/** An expanded file → the mesh, its arrays views of the file (the client's script: no loop over vertices). */
export function readTerrainExpanded(buf: ArrayBuffer | Uint8Array): TerrainMesh {
  const e = decodeErt(buf);
  const hd = e.header;
  if (hd.layer !== "terrain" || hd.enc !== "expanded") throw new Error(`readTerrainExpanded: ${hd.layer}/${hd.enc}`);
  const n = hd.n!;
  return {
    key: hd.key, center: hd.center, radius: hd.radius, minH: hd.minH!, maxH: hd.maxH!, n,
    positions: e.chunks.pos as Float32Array, normals: e.chunks.nrm as Float32Array, colors: e.chunks.col as Float32Array,
    uvs: e.chunks.uv as Float32Array, index: terrainIndex(n), heights: new Float32Array(0),
  };
}

/** Height of the terrain at a point of a decoded tile (bilinear in the grid; NaN outside it). */
export function heightIn(mesh: TerrainMesh, key: TileKey, lat: number, lon: number): number {
  if (!mesh.heights.length) return NaN;
  const n = mesh.n;
  const { lats, lons } = gridLatLon(key, n);
  const fj = ((lon - lons[0]) / (lons[n - 1] - lons[0])) * (n - 1);
  // rows are uniform in Mercator, not latitude: search
  let i = 0;
  while (i < n - 2 && lats[i + 1] > lat) i++;
  const fi = i + (lats[i] - lat) / (lats[i] - lats[i + 1]);
  if (fi < 0 || fi > n - 1 || fj < 0 || fj > n - 1) return NaN;
  const i0 = Math.min(n - 2, Math.floor(fi)), j0 = Math.min(n - 2, Math.floor(fj));
  const ti = fi - i0, tj = fj - j0, H = mesh.heights;
  const a = H[i0 * n + j0], b = H[i0 * n + j0 + 1], c = H[(i0 + 1) * n + j0], d = H[(i0 + 1) * n + j0 + 1];
  return (a * (1 - tj) + b * tj) * (1 - ti) + (c * (1 - tj) + d * tj) * ti;
}

/** Normals of a height grid from central differences, the grid extended by a one-vertex border (n+2)² so edges match
 *  their neighbours. `heights` is (n+2) × (n+2), row 0 the border north of the tile. */
export function gridNormals(key: TileKey, n: number, bordered: Float32Array): Float32Array {
  const { lats, lons } = gridLatLon(key, n);
  // the border's latitudes and longitudes: one step beyond each edge
  const lat = (i: number) => (i < 0 ? 2 * lats[0] - lats[1] : i >= n ? 2 * lats[n - 1] - lats[n - 2] : lats[i]);
  const lon = (j: number) => (j < 0 ? 2 * lons[0] - lons[1] : j >= n ? 2 * lons[n - 1] - lons[n - 2] : lons[j]);
  const at = (i: number, j: number) => bordered[(i + 1) * (n + 2) + (j + 1)];
  const out = new Float32Array(3 * n * n);
  const pa: V3 = [0, 0, 0], pb: V3 = [0, 0, 0], pc: V3 = [0, 0, 0], pd: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      geodeticToEcef(lat(i), lon(j - 1), at(i, j - 1), pa);
      geodeticToEcef(lat(i), lon(j + 1), at(i, j + 1), pb);
      geodeticToEcef(lat(i - 1), lon(j), at(i - 1, j), pc);
      geodeticToEcef(lat(i + 1), lon(j), at(i + 1, j), pd);
      // east = b − a, north = c − d; normal = east × north
      const ex = pb[0] - pa[0], ey = pb[1] - pa[1], ez = pb[2] - pa[2];
      const nx = pc[0] - pd[0], ny = pc[1] - pd[1], nz = pc[2] - pd[2];
      let x = ey * nz - ez * ny, y = ez * nx - ex * nz, z = ex * ny - ey * nx;
      const l = Math.hypot(x, y, z);
      if (!(l > 0)) {
        const u = enu(lats[i], lons[j]).u;
        [x, y, z] = u;
      } else { x /= l; y /= l; z /= l; }
      const v = 3 * (i * n + j);
      out[v] = x; out[v + 1] = y; out[v + 2] = z;
    }
  }
  return out;
}

// The ground the city stands on: the trunk's own terrain (SPEC § 2, z14, n = 65, the gen in tileset.json `ground`),
// read from the service and evaluated on the very triangles the hosts draw, so a road or a building's foot is on the
// surface that shows, not on a finer DEM that does not.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeErt } from "../earthrt/core/ert.ts";
import { geodeticToEcef, enu, type V3 } from "../earthrt/core/geo.ts";
import { tileXToLon, tileYToLat } from "../earthrt/core/tiles.ts";
import { planeToTile, type P2 } from "./plane.ts";

export const GROUND_ZOOM = 14;
const N = 65, CELLS = N - 1;
const API = process.env.EARTHRT_SERVICE ?? "https://earth.threert.dev";

interface GTile { h: Float32Array; ecef: Float64Array }

export class Ground {
  private tiles = new Map<string, GTile>();
  constructor(public gen: string, private cacheDir: string) {}

  /** Downloads (curl, cached) every z14 tile meeting a plane box. */
  async load(box: { x0: number; y0: number; x1: number; y1: number }) {
    const [ax, ay] = planeToTile(box.x0, box.y1, GROUND_ZOOM), [bx, by] = planeToTile(box.x1, box.y0, GROUND_ZOOM);
    const jobs: Promise<void>[] = [];
    for (let ty = Math.floor(ay); ty <= Math.floor(by); ty++) for (let tx = Math.floor(ax); tx <= Math.floor(bx); tx++) jobs.push(this.fetchTile(tx, ty));
    for (let i = 0; i < jobs.length; i += 16) await Promise.all(jobs.slice(i, i + 16));
  }

  private async fetchTile(tx: number, ty: number) {
    const path = join(this.cacheDir, this.gen, `${GROUND_ZOOM}/${tx}/${ty}.c.ert`);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const url = `${API}/tiles/v1/${this.gen}/terrain/${GROUND_ZOOM}/${tx}/${ty}.c.ert`;
      for (let attempt = 0; ; attempt++) {
        const p = Bun.spawn(["curl", "-sfL", "--max-time", "60", ...(process.env.HTTPS_PROXY ? ["-x", process.env.HTTPS_PROXY] : []), "-o", path + ".part", url]);
        if ((await p.exited) === 0) break;
        if (attempt > 4) throw new Error(`terrain ${url}: failed`);
        await Bun.sleep(1000 * (attempt + 1));
      }
      writeFileSync(path, readFileSync(path + ".part"));
    }
    const e = decodeErt(readFileSync(path));
    const hd = e.header, h16 = e.chunks.h as Uint16Array, water = e.chunks.water as Uint8Array;
    const h = new Float32Array(N * N), ecef = new Float64Array(N * N * 3);
    const p: V3 = [0, 0, 0];
    for (let r = 0; r < N; r++) {
      const lat = tileYToLat(ty + r / CELLS, GROUND_ZOOM);
      for (let c = 0; c < N; c++) {
        const v = r * N + c;
        h[v] = hd.minH! + (h16[v] / 65535) * (hd.maxH! - hd.minH!);
        geodeticToEcef(lat, tileXToLon(tx + c / CELLS, GROUND_ZOOM), h[v], p);
        ecef[3 * v] = p[0]; ecef[3 * v + 1] = p[1]; ecef[3 * v + 2] = p[2];
      }
    }
    void water;
    this.tiles.set(`${tx}/${ty}`, { h, ecef });
  }

  /** Global grid coordinates (cells of z14 tiles; x east, y south). */
  grid(x: number, y: number): P2 {
    const [tx, ty] = planeToTile(x, y, GROUND_ZOOM);
    return [tx * CELLS, ty * CELLS];
  }

  /** The point of the drawn terrain at global grid coordinates, ECEF, lifted `lift` m along the local up. */
  atGrid(gx: number, gy: number, lift = 0, out: V3 = [0, 0, 0]): V3 {
    let cx = Math.floor(gx), cy = Math.floor(gy);
    const tx = Math.floor(cx / CELLS), ty = Math.floor(cy / CELLS);
    const t = this.tiles.get(`${tx}/${ty}`);
    if (!t) throw new Error(`no terrain tile ${tx}/${ty}`);
    const c = cx - tx * CELLS, r = cy - ty * CELLS;
    const fc = gx - cx, fr = gy - cy;
    const E = t.ecef, a = r * N + c, b = a + 1, cc = a + N, d = cc + 1;
    // the tile's triangles (core terrainIndex): (a, cc, d) south-west of the diagonal a–d, (a, d, b) north-east
    for (let k = 0; k < 3; k++) {
      out[k] = fc <= fr
        ? E[3 * a + k] + fr * (E[3 * cc + k] - E[3 * a + k]) + fc * (E[3 * d + k] - E[3 * cc + k])
        : E[3 * a + k] + fc * (E[3 * b + k] - E[3 * a + k]) + fr * (E[3 * d + k] - E[3 * b + k]);
    }
    if (lift) {
      const lat = tileYToLat(gy / CELLS, GROUND_ZOOM), lon = tileXToLon(gx / CELLS, GROUND_ZOOM);
      const u = enu(lat, lon).u;
      out[0] += u[0] * lift; out[1] += u[1] * lift; out[2] += u[2] * lift;
    }
    return out;
  }

  /** Height of the drawn terrain under a plane point (bilinear on the same triangles). */
  height(x: number, y: number): number {
    const [gx, gy] = this.grid(x, y);
    const cx = Math.floor(gx), cy = Math.floor(gy);
    const tx = Math.floor(cx / CELLS), ty = Math.floor(cy / CELLS);
    const t = this.tiles.get(`${tx}/${ty}`);
    if (!t) return NaN;
    const c = cx - tx * CELLS, r = cy - ty * CELLS, fc = gx - cx, fr = gy - cy;
    const H = t.h, a = r * N + c, b = a + 1, cc = a + N, d = cc + 1;
    return fc <= fr ? H[a] + fr * (H[cc] - H[a]) + fc * (H[d] - H[cc]) : H[a] + fc * (H[b] - H[a]) + fr * (H[d] - H[b]);
  }

  /** Lowest terrain under a ring (its vertices and centre). */
  lowest(ring: P2[]): number {
    let lo = Infinity;
    for (const p of ring) lo = Math.min(lo, this.height(p[0], p[1]));
    return lo;
  }

  /**
   * Drapes plane triangles on the terrain: each is cut by the terrain's cells and their diagonals, so every piece lies
   * in one terrain triangle and is flat on it. Calls `emit` with each piece's corners in grid coordinates (a convex
   * polygon, counter-clockwise seen from above).
   */
  drape(a: P2, b: P2, c: P2, emit: (poly: P2[]) => void) {
    const g = [this.grid(a[0], a[1]), this.grid(b[0], b[1]), this.grid(c[0], c[1])];
    const x0 = Math.floor(Math.min(g[0][0], g[1][0], g[2][0])), x1 = Math.floor(Math.max(g[0][0], g[1][0], g[2][0]));
    const y0 = Math.floor(Math.min(g[0][1], g[1][1], g[2][1])), y1 = Math.floor(Math.max(g[0][1], g[1][1], g[2][1]));
    // grid y is south: a plane-ccw triangle is clockwise in grid space; work in grid space and flip back at the end
    if (x0 === x1 && y0 === y1) {
      const fc = (p: P2) => p[0] - x0 - (p[1] - y0);
      const s = [fc(g[0]), fc(g[1]), fc(g[2])];
      if (s.every((v) => v <= 1e-9) || s.every((v) => v >= -1e-9)) { emit(g); return; }
    }
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      let poly: P2[] = g;
      poly = clip(poly, (p) => p[0] - cx);
      poly = clip(poly, (p) => cx + 1 - p[0]);
      poly = clip(poly, (p) => p[1] - cy);
      poly = clip(poly, (p) => cy + 1 - p[1]);
      if (poly.length < 3) continue;
      const lo = clip(poly, (p) => p[1] - cy - (p[0] - cx)); // fc <= fr
      const hi = clip(poly, (p) => p[0] - cx - (p[1] - cy));
      if (lo.length >= 3 && Math.abs(area2(lo)) > 1e-10) emit(lo);
      if (hi.length >= 3 && Math.abs(area2(hi)) > 1e-10) emit(hi);
    }
  }
}

function area2(r: P2[]) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a;
}

/** Sutherland–Hodgman against f(p) ≥ 0. */
function clip(poly: P2[], f: (p: P2) => number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = f(p), fq = f(q);
    if (fp >= 0) out.push(p);
    if ((fp >= 0) !== (fq >= 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}

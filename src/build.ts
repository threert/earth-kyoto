// bun run build [--around lat,lon,metres] [--out out/tiles] [--levels 15,13]
// data/osm.json (bun run extract) + data/plateau/bldg (tools/plateau.py) + the trunk's terrain →
// out/tiles: tileset.json and tiles/{z}/{x}/{y}.glb (SPEC § 5, earthrt/tileset@2).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Frame } from "../earthrt/core/geo.ts";
import { KIT, type Piece } from "./kit.ts";
import { Ground } from "./ground.ts";
import { tileGlb } from "./glb.ts";
import { toPlane, type P2 } from "./plane.ts";
import { World, type Feature, type Line, type Node } from "./world.ts";
import { buildBuildings } from "./buildings.ts";
import { buildAreas, buildLines, indexAreas, indexLines } from "./surface.ts";
import { buildTrees } from "./trees.ts";
import { loadPlateau } from "./plateau.ts";
import { ANCHOR, BOUNDS, MATERIALS, terrainGen } from "./config.ts";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const root = join(import.meta.dir, "..");
const out = join(root, opt("--out") ?? "out/tiles");
const around = opt("--around")?.split(",").map(Number);
const levels = (opt("--levels") ?? "15,13").split(",").map(Number);
/** geometric error of a level's tiles, m (what the far level leaves out: small roads, two trees in three, plant) */
const ERROR: Record<number, number> = { 15: 0.6, 14: 3, 13: 8 };

const t0 = Date.now();
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${s}`);
const TERRAIN_GEN = await terrainGen();

const osm = JSON.parse(readFileSync(join(root, "data/osm.json"), "utf8"));
log(`osm: ${osm.buildings.length} buildings, ${osm.areas.length} areas, ${osm.lines.length} lines, ${osm.nodes.length} nodes; terrain ${TERRAIN_GEN}`);
const P = (c: [number, number]): P2 => toPlane(c[0], c[1]);
let keep = (_p: P2) => true;
if (around) {
  const [cx, cy] = toPlane(around[0], around[1]), R = around[2];
  keep = (p) => Math.hypot(p[0] - cx, p[1] - cy) < R;
}
const feat = (r: { id: string; t: Record<string, string>; p: [number, number][][][] }): Feature => ({ id: r.id, t: r.t, rings: r.p.map((poly) => poly.map((ring) => ring.map(P))) });
const buildings: Feature[] = osm.buildings.map(feat).filter((f: Feature) => keep(f.rings[0][0][0]));
const areas: Feature[] = osm.areas.map(feat).filter((f: Feature) => f.rings.some((poly) => poly[0].some(keep)));
const lines: Line[] = osm.lines.map((l: { id: string; t: Record<string, string>; c: [number, number][] }) => ({ id: l.id, t: l.t, pts: l.c.map(P) })).filter((l: Line) => l.pts.some(keep));
const nodes: Node[] = osm.nodes.map((n: { id: string; t: Record<string, string>; c: [number, number] }) => ({ id: n.id, t: n.t, p: P(n.c) })).filter((n: Node) => keep(n.p));
osm.buildings = osm.areas = osm.lines = osm.nodes = null;
log(`in play: ${buildings.length} buildings, ${areas.length} areas, ${lines.length} lines, ${nodes.length} nodes`);
const plateau = loadPlateau(join(root, "data/plateau/bldg"), keep);
log(`plateau: ${plateau.length} buildings, ${plateau.filter((b) => b.lod2).length} with LOD2 (${["flat", "gable", "hip", "complex"].map((f) => `${f} ${plateau.filter((b) => b.fit?.form === f).length}`).join(", ")})`);

const ground = new Ground(TERRAIN_GEN, join(root, "data/terrain"));
const ring = BOUNDS.map(([la, lo]) => toPlane(la, lo));
await ground.load({ x0: Math.min(...ring.map((p) => p[0])) - 500, y0: Math.min(...ring.map((p) => p[1])) - 500, x1: Math.max(...ring.map((p) => p[0])) + 500, y1: Math.max(...ring.map((p) => p[1])) + 500 });
log("terrain loaded");

const frame = new Frame(ANCHOR.lat, ANCHOR.lon, 0, 0);
const kit = new Map<string, Piece>(KIT.map((p) => [p.name, p]));
rmSync(join(out, "tiles"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const list: { key: string; uri: string; center: number[]; radius: number; error: number; bytes: number; tris: number; instances: number; children?: string[] }[] = [];
const totals: Record<number, { tiles: number; bytes: number; tris: number; instances: number; stats: unknown }> = {};
for (const z of levels) {
  const lod = z >= 15 ? 0 : 1;
  const w = new World(ground, BOUNDS, frame, z, lod);
  indexAreas(w, areas);
  indexLines(w, lines);
  buildBuildings(w, buildings, plateau);
  log(`z${z} buildings: ${JSON.stringify(w.stats)}`);
  buildAreas(w, areas);
  buildLines(w, lines);
  buildTrees(w, areas, nodes, lines);
  let bytes = 0, tris = 0, instances = 0, n = 0;
  for (const [key, t] of [...w.tiles].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (t.empty) continue;
    const glb = tileGlb(t, kit, MATERIALS);
    const path = join(out, `tiles/${key}.glb`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, glb);
    const c = t.lo.map((v, k) => (v + t.hi[k]) / 2);
    const radius = Math.hypot(t.hi[0] - c[0], t.hi[1] - c[1], t.hi[2] - c[2]);
    list.push({ key, uri: `tiles/${key}.glb`, center: c.map((v) => Math.round(v * 10) / 10), radius: Math.round(radius * 10) / 10, error: ERROR[z] ?? 1, bytes: glb.length, tris: t.tris, instances: t.instances });
    bytes += glb.length; tris += t.tris; instances += t.instances; n++;
  }
  totals[z] = { tiles: n, bytes, tris, instances, stats: w.stats };
  log(`z${z}: ${n} tiles, ${(bytes / 1e6).toFixed(1)} MB, ${(tris / 1e6).toFixed(2)} M triangles, ${instances} copies`);
}
// the far level's tiles name their children (replaced by them: all of them, or the parent)
for (const t of list) {
  const [z, x, y] = t.key.split("/").map(Number);
  const below = levels.filter((l) => l > z).sort((a, b) => a - b)[0];
  if (below === undefined) continue;
  const d = 2 ** (below - z);
  t.children = list.filter((c) => { const [cz, cx, cy] = c.key.split("/").map(Number); return cz === below && Math.floor(cx / d) === x && Math.floor(cy / d) === y; }).map((c) => c.key);
}
const tileset = {
  format: "earthrt/tileset@2",
  frame: "place",
  ground: { layer: "terrain", gen: TERRAIN_GEN, zoom: 14 },
  materials: MATERIALS,
  levels: levels.slice().sort((a, b) => a - b).map((z) => ({ zoom: z, error: ERROR[z] ?? 1 })),
  root: list.filter((t) => Number(t.key.split("/")[0]) === Math.min(...levels)).map((t) => t.key),
  tiles: list,
  stats: totals,
};
writeFileSync(join(out, "tileset.json"), JSON.stringify(tileset, null, 1));
log(`→ ${out}`);

// bun run build [--around lat,lon,metres] [--out out/tiles]
// data/osm.json (bun run extract) + the trunk's terrain → out/tiles: tileset.json, kit.ert, tiles/15/x/y.ert.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeKit, KIT } from "./kit.ts";
import { Ground } from "./ground.ts";
import { toPlane, type P2 } from "./plane.ts";
import { World, type Feature, type Line, type Node } from "./world.ts";
import { buildBuildings } from "./buildings.ts";
import { buildAreas, buildLines, indexAreas, indexLines } from "./surface.ts";
import { buildTrees } from "./trees.ts";
import { tileError } from "../earthrt/core/tiles.ts";
import { parseKey } from "../earthrt/core/tiles.ts";
import { BOUNDS, MATERIALS, terrainGen } from "./config.ts";
const TERRAIN_GEN = await terrainGen();

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const root = join(import.meta.dir, "..");
const out = join(root, opt("--out") ?? "out/tiles");
const around = opt("--around")?.split(",").map(Number);

const t0 = Date.now();
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${s}`);

const osm = JSON.parse(readFileSync(join(root, "data/osm.json"), "utf8"));
log(`osm: ${osm.buildings.length} buildings, ${osm.areas.length} areas, ${osm.lines.length} lines, ${osm.nodes.length} nodes`);
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
log(`in play: ${buildings.length} buildings, ${areas.length} areas, ${lines.length} lines, ${nodes.length} nodes`);

const ground = new Ground(TERRAIN_GEN, join(root, "data/terrain"));
const ring = BOUNDS.map(([la, lo]) => toPlane(la, lo));
await ground.load({ x0: Math.min(...ring.map((p) => p[0])) - 500, y0: Math.min(...ring.map((p) => p[1])) - 500, x1: Math.max(...ring.map((p) => p[0])) + 500, y1: Math.max(...ring.map((p) => p[1])) + 500 });
log("terrain loaded");

const w = new World(ground, BOUNDS);
indexAreas(w, areas);
indexLines(w, lines);
log(`indexed: ${w.precincts.length} precincts`);
buildBuildings(w, buildings);
log(`buildings: ${JSON.stringify(w.stats)}`);
const nAreas = buildAreas(w, areas);
log(`areas: ${nAreas}`);
buildLines(w, lines);
log("lines");
buildTrees(w, areas, nodes, lines);
log(`trees: ${w.stats.trees}`);

rmSync(join(out, "tiles"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const list: unknown[] = [];
let bytes = 0, tris = 0, instances = 0;
for (const [key, t] of [...w.tiles].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (t.empty) continue;
  const e = t.encode();
  const path = join(out, `tiles/${key}.ert`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, e.bytes);
  bytes += e.bytes.length; tris += e.tris; instances += e.instances;
  list.push({ key, center: t.center.map((v) => Math.round(v * 1000) / 1000), radius: Math.round(e.radius * 10) / 10, error: Math.round(tileError(parseKey(key)) * 100) / 100, bytes: e.bytes.length, tris: e.tris, instances: e.instances });
}
const kit = encodeKit();
writeFileSync(join(out, "kit.ert"), kit);
const tileset = {
  format: "earthrt/tileset@2",
  layer: "city",
  ground: { layer: "terrain", gen: TERRAIN_GEN, zoom: 14 },
  kit: "kit.ert",
  materials: MATERIALS,
  tiles: "tiles/{z}/{x}/{y}.ert",
  zoom: [15, 15],
  list,
  stats: { tiles: list.length, bytes, tris, instances, kitPieces: KIT.length, ...w.stats },
};
writeFileSync(join(out, "tileset.json"), JSON.stringify(tileset, null, 1));
log(`${list.length} tiles, ${(bytes / 1e6).toFixed(1)} MB, ${(tris / 1e6).toFixed(2)} M triangles, ${instances} instances → ${out}`);

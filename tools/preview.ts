// Offline stills of Kyoto with the engine, before (the trunk's boxes) and after (this place), side by side.
//   bun tools/preview.ts kyoto-3km kyoto-1km [--tiles out/tiles] [--out out/s6] [--spp 64] [--only after]
//   bun tools/preview.ts --at lat,lon,alt,heading,pitch --time 15 --name close
// The trunk's tiles come from the service (curl, cached in data/trunk); the engine is THREERT_ROOT's (a ThreeRT
// checkout with a built threert-render); the GPU is shared: its lock is taken around each render.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeErt, encodeErt } from "../earthrt/core/ert.ts";
import { ecefToGeodetic, Frame, geodeticToEcef, type V3 } from "../earthrt/core/geo.ts";
import { keyOf, tileCenter, tileSize, tilesInBox, children, type TileKey } from "../earthrt/core/tiles.ts";
import { sunDirection, solarTime } from "../earthrt/core/sun.ts";
import { ANCHOR, BOUNDS, MATERIALS, terrainGen } from "../src/config.ts";
import { encodeKit } from "../src/kit.ts";
import { selectCityTiles } from "../earthrt/core/tileset.ts";
import { glbToErt } from "./preview/glb2ert.ts";
import { pointInRing, toPlane } from "../src/plane.ts";

const root = resolve(import.meta.dir, "..");
const ENGINE = process.env.THREERT_ROOT ?? resolve(root, "../ThreeRT-earth");
const BIN = join(ENGINE, "renderer/target/release/threert-render");
const API = process.env.EARTHRT_SERVICE ?? "https://earth.threert.dev";
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const outDir = resolve(root, opt("--out") ?? "out/s6");
const tilesDir = resolve(root, opt("--tiles") ?? "out/tiles");
const spp = Number(opt("--spp") ?? 64);
const only = opt("--only");
const gen = await terrainGen();

type Pose = { name: string; lat: number; lon: number; alt: number; heading: number; pitch: number; time?: number };
const poses: Pose[] = JSON.parse(readFileSync(join(root, "tools/poses.json"), "utf8")).poses;
const jobs: Pose[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) { i++; continue; }
  const p = poses.find((x) => x.name === args[i]);
  if (!p) throw new Error(`no pose ${args[i]}`);
  jobs.push(p);
}
if (opt("--at")) {
  const [lat, lon, alt, heading, pitch] = opt("--at")!.split(",").map(Number);
  jobs.push({ name: opt("--name") ?? "at", lat, lon, alt, heading: heading ?? 0, pitch: pitch ?? -30, time: Number(opt("--time") ?? 15) });
}

async function curl(url: string, path: string): Promise<boolean> {
  if (existsSync(path)) return readFileSync(path).length > 0;
  mkdirSync(dirname(path), { recursive: true });
  for (let a = 0; a < 5; a++) {
    const p = Bun.spawn(["curl", "-sL", "--max-time", "600", "-w", "%{http_code}", ...(process.env.HTTPS_PROXY ? ["-x", process.env.HTTPS_PROXY] : []), "-o", path + ".part", url], { stdout: "pipe" });
    const code = (await new Response(p.stdout).text()).trim();
    const exit = await p.exited;
    if (code === "200" && exit === 0) {
      const body = existsSync(path + ".part") ? readFileSync(path + ".part") : new Uint8Array(0);
      writeFileSync(path, body);
      return body.length > 0;
    }
    if (code === "204" || code === "404") { writeFileSync(path, new Uint8Array(0)); return false; }
    await Bun.sleep(1500 * (a + 1));
  }
  throw new Error(`${url}: failed`);
}

const FOV = 45, H = 720;
/** Terrain tiles the view needs (screen-space error, as the hosts refine: SPEC § 2). */
function selectTerrain(cam: V3, fwd: V3): TileKey[] {
  const g = ecefToGeodetic(...cam);
  const out: TileKey[] = [];
  const k = Math.tan((FOV * Math.PI) / 360);
  const visit = (t: { z: number; x: number; y: number }) => {
    const c = tileCenter(t), s = tileSize(t);
    const d = Math.max(1, Math.hypot(c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]) - s * 0.75);
    const ahead = (c[0] - cam[0]) * fwd[0] + (c[1] - cam[1]) * fwd[1] + (c[2] - cam[2]) * fwd[2];
    if (ahead < -s) return;
    // beyond the horizon (and the hills that rise over it)
    const horizon = Math.sqrt(2 * 6371000 * Math.max(10, g.h)) + 60000;
    if (Math.hypot(c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]) - s > horizon) return;
    const err = (s / 64) * 1.5;
    if (t.z < 14 && (err * H) / (2 * d * k) > 3) { for (const ch of children(t)) visit(ch); return; }
    out.push(t);
  };
  const span = 4;
  for (const t of tilesInBox({ west: g.lon - span, east: g.lon + span, south: g.lat - span, north: g.lat + span }, 6)) visit(t);
  return out;
}

const bounds = BOUNDS.map(([la, lo]) => toPlane(la, lo));
/** A trunk buildings tile without what stands inside the city's bounds (the place `replaces` them). */
function cutBuildings(src: string, dst: string) {
  const e = decodeErt(readFileSync(src));
  const pos = e.chunks.pos as Float32Array, idx = e.chunks.idx as Uint32Array, C = e.header.center;
  const keep: number[] = [];
  for (let i = 0; i < idx.length; i += 3) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { x += pos[3 * idx[i + k]]; y += pos[3 * idx[i + k] + 1]; z += pos[3 * idx[i + k] + 2]; }
    const g = ecefToGeodetic(C[0] + x / 3, C[1] + y / 3, C[2] + z / 3);
    const p = toPlane(g.lat, g.lon);
    if (!pointInRing(p[0], p[1], bounds)) keep.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  const { chunks: _c, ...hd } = e.header;
  writeFileSync(dst, encodeErt(hd, { ...e.chunks, idx: Uint32Array.from(keep) } as Record<string, Float32Array | Uint32Array>));
}

const bundle = join(root, "out/preview/scene.js");
{
  const { bundleGame } = await import(join(ENGINE, "tools/bundle-game.ts"));
  await bundleGame(join(root, "tools/preview/scene.ts"), bundle);
}
const { waitGpuLock, releaseGpuLock } = await import(join(ENGINE, "tools/lib/bench.ts"));

mkdirSync(outDir, { recursive: true });
for (const pose of jobs) {
  const frame = new Frame(pose.lat, pose.lon, 0);
  const h = (pose.heading * Math.PI) / 180, p = (pose.pitch * Math.PI) / 180;
  const fwdLocal: V3 = [Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)];
  const cam = geodeticToEcef(pose.lat, pose.lon, pose.alt);
  const fwd = frame.dirToEcef(fwdLocal);
  const terrain = selectTerrain(cam, fwd);
  const assets = join(root, "out/preview/assets");
  mkdirSync(assets, { recursive: true });
  const tFiles: string[] = [], bKeys: string[] = [];
  await Promise.all(terrain.map(async (t, i) => {
    await Bun.sleep((i % 24) * 20);
    const rel = `trunk/${gen}/terrain/${keyOf(t)}.x.ert`;
    if (await curl(`${API}/tiles/v1/${gen}/terrain/${keyOf(t)}.x.ert`, join(root, "data", rel))) tFiles.push(rel);
    if ("z" in t && t.z === 14 && Math.hypot(...(tileCenter(t).map((v, j) => v - cam[j]) as V3)) < 10000) bKeys.push(keyOf(t));
  }));
  const bFiles: string[] = [];
  await Promise.all(bKeys.map(async (k) => {
    const rel = `trunk/${gen}/buildings/${k}.x.ert`;
    if (await curl(`${API}/tiles/v1/${gen}/buildings/${k}.x.ert`, join(root, "data", rel))) bFiles.push(rel);
  }));
  // the asset root: links to the cached files (copies: the engine reads under its root)
  const link = (rel: string, from: string) => { const d = join(assets, rel); mkdirSync(dirname(d), { recursive: true }); if (!existsSync(d)) copyFileSync(from, d); return rel; };
  for (const f of tFiles) link(f, join(root, "data", f));
  const cut: string[] = [];
  for (const f of bFiles) {
    link(f, join(root, "data", f));
    const c = f.replace("/buildings/", "/buildings-cut/");
    if (!existsSync(join(assets, c))) { mkdirSync(dirname(join(assets, c)), { recursive: true }); cutBuildings(join(root, "data", f), join(assets, c)); }
    cut.push(c);
  }
  // the city's tiles within 20 km, ahead
  const ts = JSON.parse(readFileSync(join(tilesDir, "tileset.json"), "utf8"));
  const city: string[] = [];
  // as a host picks them: by screen-space error from the roots (core selectCityTiles), in the place's frame
  const pf = new Frame(ANCHOR.lat, ANCHOR.lon, 0, 0);
  const camP = pf.point(cam), fwdP = pf.dir(fwd);
  const sel = selectCityTiles(ts, { position: camP as V3, fov: (FOV * Math.PI) / 180, height: H, sse: 2, visible: (c, r) => (c[0] - camP[0]) * fwdP[0] + (c[1] - camP[1]) * fwdP[1] + (c[2] - camP[2]) * fwdP[2] > -r });
  for (const t of sel.show) {
    const rel = `city/${ts.stats ? "" : ""}${t.key}.ert`, dst = join(assets, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, glbToErt(readFileSync(join(tilesDir, t.uri)), t.key));
    city.push(rel);
  }
  writeFileSync(join(assets, "city/kit.ert"), encodeKit());
  const utc = solarTime(Date.UTC(2026, 5, 21), pose.lon, pose.time ?? 15);
  const sun = frame.dir(sunDirection(utc));
  const ground = 50;
  const shots: string[] = [];
  for (const mode of ["before", "after"]) {
    if (only && only !== mode) continue;
    const cfg = {
      frame: { lat: pose.lat, lon: pose.lon },
      camera: { position: [0, pose.alt, 0], target: [fwdLocal[0] * 1000, pose.alt + fwdLocal[1] * 1000, fwdLocal[2] * 1000], fov: FOV, altitude: pose.alt - ground },
      sun,
      terrain: tFiles,
      buildings: mode === "before" ? bFiles : cut,
      city: mode === "after" ? { kit: "city/kit.ert", tiles: city, materials: MATERIALS, anchor: ANCHOR } : null,
      exposure: null,
    };
    writeFileSync(join(assets, "preview.json"), JSON.stringify(cfg));
    const png = join(outDir, `${pose.name}-${mode}.png`);
    await waitGpuLock("earth-kyoto preview");
    const t0 = Date.now();
    try {
      const r = Bun.spawnSync([BIN, "render", bundle, "-o", png, "--assets", assets, "--spp", String(spp), "--width", "1280", "--height", String(H)], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`render: ${r.stderr.toString().slice(-3000)}`);
      const errs = r.stderr.toString().split("\n").filter((l) => /error|warn/i.test(l)).slice(0, 5);
      if (errs.length) console.log(errs.join("\n"));
    } finally {
      releaseGpuLock();
    }
    console.log(`${png}: ${tFiles.length} terrain, ${mode === "before" ? bFiles.length : cut.length} trunk buildings, ${mode === "after" ? city.length : 0} city tiles (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    shots.push(png);
  }
  if (shots.length === 2) {
    const jpg = join(outDir, `${pose.name}-before-after.jpg`);
    const r = Bun.spawnSync(["python3", "-I", join(root, "tools/preview/side-by-side.py"), shots[0], shots[1], jpg, pose.name]);
    if (r.exitCode !== 0) console.log(r.stderr.toString());
    else console.log(jpg);
  }
}

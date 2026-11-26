// bun tools/publish.ts <tag> [--tiles out/tiles] [--no-upload] [--no-register]
// Publishes a build: its GLBs as the assets of GitHub release <tag> (`<z>-<x>-<y>.glb`), tileset.json at the
// repository's root naming them `@release/<tag>/…` (SPEC § 5, § 8), committed and pushed; then registers the place
// with EarthRT's index (or refreshes it: a new commit is a new version).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateTileset } from "../earthrt/core/tileset.ts";
import { validatePlace } from "../earthrt/core/places.ts";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const tag = args[0];
if (!tag || tag.startsWith("--")) throw new Error("usage: bun tools/publish.ts <tag>");
const tilesDir = resolve(root, opt("--tiles") ?? "out/tiles");
const API = process.env.EARTHRT_API ?? "https://earth.threert.dev/api/v1";
const REPO = "threert/earth-kyoto";
const proxy = process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {};

function run(cmd: string[], allowFail = false): string {
  const r = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...proxy } });
  if (r.exitCode !== 0 && !allowFail) throw new Error(`${cmd.slice(0, 4).join(" ")}: ${r.stderr.toString().trim().slice(-800)}`);
  return r.stdout.toString().trim();
}

const ts = JSON.parse(readFileSync(join(tilesDir, "tileset.json"), "utf8"));
const files: string[] = [];
for (const t of ts.tiles) {
  const asset = `${t.key.replaceAll("/", "-")}.glb`;
  files.push(join(tilesDir, t.uri));
  t.uri = `@release/${tag}/${asset}`;
}
const problems = validateTileset(ts);
if (problems.length) throw new Error(`tileset: ${problems.join("; ")}`);
const manifest = JSON.parse(readFileSync(join(root, "earthrt.json"), "utf8"));
const mp = validatePlace(manifest);
if (mp.length) throw new Error(`earthrt.json: ${mp.join("; ")}`);

if (!args.includes("--no-upload")) {
  // the release, then its assets (named <z>-<x>-<y>.glb: copies under those names, uploaded a batch at a time)
  const exists = run(["gh", "release", "view", tag, "--repo", REPO, "--json", "tagName"], true);
  if (!exists) run(["gh", "release", "create", tag, "--repo", REPO, "--title", `Kyoto tiles ${tag}`, "--notes", `The city's tiles (${ts.tiles.length} GLB, ${(ts.tiles.reduce((s: number, t: { bytes: number }) => s + t.bytes, 0) / 1e6).toFixed(0)} MB) for tileset.json at the commit that names ${tag}. Made by \`bun run build\`; see README.`]);
  const have = new Set(run(["gh", "release", "view", tag, "--repo", REPO, "--json", "assets", "-q", ".assets[].name"], true).split("\n").filter(Boolean));
  const stage = join(root, "out/publish", tag);
  Bun.spawnSync(["mkdir", "-p", stage]);
  const todo: string[] = [];
  ts.tiles.forEach((t: { uri: string }, i: number) => {
    const name = t.uri.split("/").pop()!;
    if (have.has(name)) return;
    const dst = join(stage, name);
    writeFileSync(dst, readFileSync(files[i]));
    todo.push(dst);
  });
  for (let i = 0; i < todo.length; i += 12) {
    const batch = todo.slice(i, i + 12);
    for (let attempt = 0; ; attempt++) {
      try { run(["gh", "release", "upload", tag, "--repo", REPO, "--clobber", ...batch]); break; }
      catch (e) { if (attempt > 4) throw e; console.log(`  retry (${(e as Error).message.slice(0, 120)})`); await Bun.sleep(3000 * (attempt + 1)); }
    }
    console.log(`uploaded ${Math.min(i + 12, todo.length)} / ${todo.length}`);
  }
}
writeFileSync(join(root, "tileset.json"), JSON.stringify(ts, null, 1) + "\n");
run(["git", "add", "tileset.json", "earthrt.json"]);
if (run(["git", "status", "--porcelain", "tileset.json", "earthrt.json"])) run(["git", "commit", "-m", `Tiles ${tag}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`]);
run(["git", "push", "-q", "origin", "HEAD"]);
console.log(`tileset.json → ${tag} (${run(["git", "rev-parse", "--short", "HEAD"])})`);

if (!args.includes("--no-register")) {
  const token = process.env.GITHUB_TOKEN || run(["gh", "auth", "token"]);
  const call = async (method: string, path: string, body?: unknown) => {
    const p = Bun.spawnSync(["curl", "-s", "-X", method, "-H", `authorization: Bearer ${token}`, "-H", "content-type: application/json", ...(process.env.HTTPS_PROXY ? ["-x", process.env.HTTPS_PROXY] : []), ...(body ? ["--data", JSON.stringify(body)] : []), `${API}${path}`]);
    return p.stdout.toString();
  };
  const refreshed = await call("POST", `/places/${REPO}/${manifest.id}/refresh`);
  if (/"error"/.test(refreshed) && /404|not registered|no such/i.test(refreshed)) console.log(await call("POST", "/places", { repo: REPO }));
  else console.log(refreshed.slice(0, 400));
}

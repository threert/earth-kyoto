// bun tools/glb-stats.ts <tile.glb>...: bytes by mesh/material and by attribute
import { readFileSync } from "node:fs";
const by = new Map<string, number>(), attr = new Map<string, number>();
for (const f of process.argv.slice(2)) {
  const b = readFileSync(f);
  const jl = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jl).toString());
  const size = (a: number) => j.bufferViews[j.accessors[a].bufferView].byteLength;
  for (const m of j.meshes) for (const p of m.primitives) {
    const name = m.name === "ground and buildings" ? j.materials[p.material].name : `kit:${m.name}`;
    let s = size(p.indices); attr.set("indices", (attr.get("indices") ?? 0) + size(p.indices));
    for (const [k, a] of Object.entries(p.attributes) as [string, number][]) { s += size(a); attr.set(k, (attr.get(k) ?? 0) + size(a)); }
    by.set(name, (by.get(name) ?? 0) + s);
  }
  for (const n of j.nodes) { const e = n.extensions?.EXT_mesh_gpu_instancing; if (!e) continue; let s = 0; for (const a of Object.values(e.attributes) as number[]) s += size(a); by.set("copies", (by.get("copies") ?? 0) + s); }
}
const tot = [...by.values()].reduce((a, b) => a + b, 0);
for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(k.padEnd(28), (v / 1e6).toFixed(2), "MB", ((100 * v) / tot).toFixed(1) + "%");
console.log("by attribute:", [...attr].map(([k, v]) => `${k} ${(v / 1e6).toFixed(1)}`).join(", "));

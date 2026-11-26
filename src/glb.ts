// A tile as glTF 2.0 binary (SPEC § 5, `earthrt/tileset@2`): one node of meshes by material (POSITION, NORMAL,
// TEXCOORD_0 where the material has metres in it, COLOR_0 linear, indices), and a node a kit piece with its copies
// (EXT_mesh_gpu_instancing: TRANSLATION, ROTATION, SCALE, _COLOR_0). Materials are named (tileset.json's
// `materials`), metallic-roughness with a white base: the colour is the vertices' or the copies'.
import type { Piece } from "./kit.ts";
import type { TileMesh } from "./mesh.ts";

export type MaterialDef = { roughness: number; metalness?: number; doubleSided?: boolean; surface?: Record<string, unknown>; note?: string };

const F32 = 5126, U16 = 5123, U32 = 5125, U8 = 5121, I16 = 5122;
const ARRAY = 34962, ELEMENTS = 34963;

class Bin {
  chunks: Uint8Array[] = [];
  length = 0;
  views: object[] = [];
  accessors: object[] = [];
  add(a: Float32Array | Uint16Array | Uint32Array | Uint8Array | Int16Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length, ...(target ? { target } : {}) });
    this.chunks.push(bytes.slice());
    this.length += bytes.length;
    return this.views.length - 1;
  }
  accessor(a: Float32Array | Uint16Array | Uint32Array | Uint8Array | Int16Array, type: "SCALAR" | "VEC2" | "VEC3" | "VEC4", target?: number, minmax = false, normalized = false): number {
    const view = this.add(a, target);
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const acc: Record<string, unknown> = { bufferView: view, componentType: a instanceof Float32Array ? F32 : a instanceof Uint16Array ? U16 : a instanceof Uint8Array ? U8 : a instanceof Int16Array ? I16 : U32, count: a.length / n, type, ...(normalized ? { normalized: true } : {}) };
    if (minmax) {
      const lo = new Array(n).fill(Infinity), hi = new Array(n).fill(-Infinity);
      for (let i = 0; i < a.length; i++) { const k = i % n; if (a[i] < lo[k]) lo[k] = a[i]; if (a[i] > hi[k]) hi[k] = a[i]; }
      acc.min = lo; acc.max = hi;
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }
}

const index = (idx: number[], v: number) => (v < 65536 ? Uint16Array.from(idx) : Uint32Array.from(idx));

export function tileGlb(t: TileMesh, kit: Map<string, Piece>, materials: Record<string, MaterialDef>): Uint8Array {
  const bin = new Bin();
  const mats: object[] = [], matIndex = new Map<string, number>();
  const mat = (name: string) => {
    let i = matIndex.get(name);
    if (i === undefined) {
      const d = materials[name] ?? { roughness: 0.8 };
      mats.push({
        name,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: d.metalness ?? 0, roughnessFactor: d.roughness },
        ...(d.doubleSided ? { doubleSided: true } : {}),
        ...(d.surface ? { extras: { earthrt: d.surface } } : {}),
      });
      matIndex.set(name, (i = mats.length - 1));
    }
    return i;
  };
  const meshes: object[] = [], nodes: object[] = [];
  // the tile's own meshes: one primitive a material
  const prims: object[] = [];
  for (const [name, p] of [...t.parts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!p.idx.length) continue;
    const attributes: Record<string, number> = {
      POSITION: bin.accessor(p.pos.out, "VEC3", ARRAY, true),
      COLOR_0: bin.accessor(Uint8Array.from(p.col), "VEC4", ARRAY, false, true),
    };
    if (p.hasUv) attributes.TEXCOORD_0 = bin.accessor(p.uv.out, "VEC2", ARRAY);
    prims.push({ attributes, indices: bin.accessor(index(p.idx, p.v), "SCALAR", ELEMENTS), material: mat(name) });
  }
  if (prims.length) { meshes.push({ name: "ground and buildings", primitives: prims }); nodes.push({ name: t.key, mesh: meshes.length - 1 }); }
  // the kit's pieces and their copies
  for (const [name, e] of [...t.inst].sort((a, b) => a[0].localeCompare(b[0]))) {
    const piece = kit.get(name);
    if (!piece) throw new Error(`no kit piece ${name}`);
    const pos = Float32Array.from(piece.pos);
    meshes.push({
      name,
      primitives: [{ attributes: { POSITION: bin.accessor(pos, "VEC3", ARRAY, true), NORMAL: bin.accessor(Float32Array.from(piece.nrm), "VEC3", ARRAY), ...(piece.col ? { COLOR_0: bin.accessor(Float32Array.from(piece.col), "VEC3", ARRAY) } : {}) }, indices: bin.accessor(index(piece.idx, pos.length / 3), "SCALAR", ELEMENTS), material: mat(piece.material) }],
    });
    nodes.push({
      name: `${name} ×${e.c.length / 3}`,
      mesh: meshes.length - 1,
      extensions: {
        EXT_mesh_gpu_instancing: {
          attributes: {
            TRANSLATION: bin.accessor(Float32Array.from(e.t), "VEC3"),
            ROTATION: bin.accessor(Int16Array.from(e.r, (v) => Math.round(v * 32767)), "VEC4", undefined, false, true),
            SCALE: bin.accessor(Float32Array.from(e.s), "VEC3"),
            _COLOR_0: bin.accessor(Float32Array.from(e.c), "VEC3"),
          },
        },
      },
    });
  }
  const json = {
    asset: { version: "2.0", generator: "threert/earth-kyoto" },
    extensionsUsed: t.inst.size ? ["EXT_mesh_gpu_instancing"] : undefined,
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes, materials: mats,
    accessors: bin.accessors, bufferViews: bin.views,
    buffers: [{ byteLength: bin.length }],
    extras: { earthrt: { tile: t.key, frame: "place" } },
  };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (js.length % 4)) % 4;
  if (jpad) { const b = new Uint8Array(js.length + jpad).fill(0x20); b.set(js); js = b; }
  const bpad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + js.length + 8 + bin.length + bpad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(js, 20);
  let at = 20 + js.length;
  dv.setUint32(at, bin.length + bpad, true); dv.setUint32(at + 4, 0x004e4942, true);
  at += 8;
  for (const c of bin.chunks) { out.set(c, at); at += c.length; }
  return out;
}

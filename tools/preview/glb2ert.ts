// The preview's reading of a city tile (GLB, tileset@2) into the arrays the preview's scene takes (an ERT file):
// meshes flat-shaded (each triangle its own corners and face normal, as a glTF host makes them without NORMAL),
// colours as floats, copies as 3 × 4 matrices with their colours. What the traced view will do in its own way.
import { encodeErt } from "../../earthrt/core/ert.ts";

export function glbToErt(buf: Uint8Array, key: string): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jl = dv.getUint32(12, true);
  const j = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jl)));
  const binAt = 20 + jl + 8;
  const read = (a: number): { data: ArrayLike<number>; n: number; size: number; norm: boolean; type: number } => {
    const acc = j.accessors[a], view = j.bufferViews[acc.bufferView];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type as string]!;
    const off = buf.byteOffset + binAt + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const C = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array, 5122: Int16Array }[acc.componentType as 5126]!;
    return { data: new C(buf.buffer.slice(off, off + acc.count * size * C.BYTES_PER_ELEMENT)), n: acc.count, size, norm: !!acc.normalized, type: acc.componentType };
  };
  const value = (r: ReturnType<typeof read>, i: number) => { const v = r.data[i]; return !r.norm ? v : r.type === 5121 ? v / 255 : r.type === 5123 ? v / 65535 : r.type === 5122 ? Math.max(-1, v / 32767) : v; };
  const chunks: Record<string, Float32Array | Uint32Array> = {};
  const meshes: unknown[] = [], instances: unknown[] = [];
  let k = 0;
  for (const node of j.nodes) {
    const mesh = j.meshes[node.mesh];
    const inst = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
    if (inst) {
      const T = read(inst.TRANSLATION), R = read(inst.ROTATION), S = read(inst.SCALE), Cc = read(inst._COLOR_0);
      const m = new Float32Array(T.n * 12), col = new Float32Array(T.n * 3);
      for (let i = 0; i < T.n; i++) {
        const x = value(R, 4 * i), y = value(R, 4 * i + 1), z = value(R, 4 * i + 2), w = value(R, 4 * i + 3);
        const l = Math.hypot(x, y, z, w);
        const qx = x / l, qy = y / l, qz = z / l, qw = w / l;
        const sx = value(S, 3 * i), sy = value(S, 3 * i + 1), sz = value(S, 3 * i + 2);
        // columns of R·S
        const r = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw), 2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw), 2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy)];
        m.set([r[0] * sx, r[1] * sx, r[2] * sx, r[3] * sy, r[4] * sy, r[5] * sy, r[6] * sz, r[7] * sz, r[8] * sz, value(T, 3 * i), value(T, 3 * i + 1), value(T, 3 * i + 2)], i * 12);
        col.set([value(Cc, 3 * i), value(Cc, 3 * i + 1), value(Cc, 3 * i + 2)], i * 3);
      }
      const name = `i${k++}`;
      chunks[`${name}.m`] = m; chunks[`${name}.col`] = col;
      instances.push({ piece: mesh.name, chunk: name, n: T.n });
      continue;
    }
    for (const p of mesh.primitives) {
      const P = read(p.attributes.POSITION), C = read(p.attributes.COLOR_0), I = read(p.indices);
      const U = p.attributes.TEXCOORD_0 !== undefined ? read(p.attributes.TEXCOORD_0) : null;
      const nt = I.n / 3;
      const pos = new Float32Array(nt * 9), nrm = new Float32Array(nt * 9), col = new Float32Array(nt * 9), uv = new Float32Array(nt * 6);
      for (let t = 0; t < nt; t++) {
        const ids = [I.data[3 * t], I.data[3 * t + 1], I.data[3 * t + 2]];
        const v = ids.map((i) => [P.data[3 * i], P.data[3 * i + 1], P.data[3 * i + 2]]);
        const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
        let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        for (let c = 0; c < 3; c++) {
          const o = 9 * t + 3 * c, i = ids[c];
          pos.set(v[c], o); nrm.set([nx, ny, nz], o);
          col.set([value(C, C.size * i), value(C, C.size * i + 1), value(C, C.size * i + 2)], o);
          if (U) uv.set([U.data[2 * i], U.data[2 * i + 1]], 6 * t + 2 * c);
        }
      }
      const name = `m${k++}`;
      chunks[`${name}.pos`] = pos; chunks[`${name}.nrm`] = nrm; chunks[`${name}.uv`] = uv; chunks[`${name}.col`] = col;
      chunks[`${name}.idx`] = Uint32Array.from({ length: nt * 3 }, (_, i) => i);
      meshes.push({ material: j.materials[p.material].name, chunk: name });
    }
  }
  return encodeErt({ v: 1, layer: "mesh", key, enc: "expanded", center: [0, 0, 0], radius: 0, meshes, instances }, chunks);
}

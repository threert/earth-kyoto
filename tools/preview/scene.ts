// The preview's scene (ThreeRT scene module): the trunk's terrain and buildings and the city's tiles, as tools/preview.ts
// laid them out under the asset root (preview.json), seen from a pose. Placed as the app places them (SPEC § 1): a
// frame at the ground under the camera, every tile at R·(C − O) turned by R.
import {
  BufferAttribute, BufferGeometry, DirectionalLight, InstancedBufferAttribute, InstancedMesh, Mesh, MeshStandardMaterial,
  PerspectiveCamera, readAsset, Scene, SkyAtmosphere, type Material,
} from "@threert/scene";
import { decodeErt } from "../../earthrt/core/ert.ts";
import { Frame, type V3 } from "../../earthrt/core/geo.ts";
import { terrainIndex } from "../../earthrt/core/terrain.ts";
import { BUILDING_FN, TERRAIN_FN } from "./trunk-materials.ts";

interface Config {
  frame: { lat: number; lon: number };
  camera: { position: V3; target: V3; fov: number; altitude: number };
  sun: V3;
  terrain: string[];
  buildings: string[];
  city: { kit: string; tiles: string[]; materials: Record<string, { roughness: number; metalness?: number }> } | null;
  exposure: number | null;
}

const ascii = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };

export default function build() {
  const cfg = JSON.parse(ascii(new Uint8Array(readAsset("preview.json")))) as Config;
  const frame = new Frame(cfg.frame.lat, cfg.frame.lon, 0);
  const scene = new Scene();
  const sun = new DirectionalLight(0xfff4e8, 100_000);
  sun.position.set(cfg.sun[0] * 100, cfg.sun[1] * 100, cfg.sun[2] * 100);
  scene.add(sun);
  const sky = new SkyAtmosphere({ sun, aerialPerspective: 1 }) as SkyAtmosphere & { altitude?: number };
  if ("altitude" in sky) sky.altitude = cfg.camera.altitude;
  scene.environment = sky;

  const place = (o: { position: { set(x: number, y: number, z: number): void }; quaternion: { set(x: number, y: number, z: number, w: number): void } }, c: V3) => {
    const p = frame.point(c), q = frame.quat;
    o.position.set(p[0], p[1], p[2]);
    o.quaternion.set(q[0], q[1], q[2], q[3]);
  };

  const terrainMat = new MeshStandardMaterial({ name: "earth-terrain", color: 0xffffff, roughness: 0.9, vertexColors: true });
  terrainMat.shader = TERRAIN_FN.with();
  for (const path of cfg.terrain) {
    const e = decodeErt(readAsset(path));
    const g = new BufferGeometry();
    g.positions = e.chunks.pos as Float32Array;
    g.normals = e.chunks.nrm as Float32Array;
    g.uvs = e.chunks.uv as Float32Array;
    g.setAttribute("color", new BufferAttribute(e.chunks.col as Float32Array, 3));
    g.index = terrainIndex(e.header.n!);
    const m = new Mesh(g, terrainMat);
    place(m, e.header.center);
    scene.add(m);
  }
  const bMat = new MeshStandardMaterial({ name: "earth-buildings", color: 0xffffff, roughness: 0.85, vertexColors: true });
  bMat.shader = BUILDING_FN.with();
  for (const path of cfg.buildings) {
    const e = decodeErt(readAsset(path));
    if (!(e.chunks.idx as Uint32Array).length) continue;
    const g = new BufferGeometry();
    g.positions = e.chunks.pos as Float32Array;
    g.normals = e.chunks.nrm as Float32Array;
    g.uvs = e.chunks.uv as Float32Array;
    g.setAttribute("color", new BufferAttribute(e.chunks.col as Float32Array, 3));
    g.index = e.chunks.idx as Uint32Array;
    const m = new Mesh(g, bMat);
    place(m, e.header.center);
    scene.add(m);
  }

  if (cfg.city) {
    // materials: one with vertex colours (meshes), one without (copies: the copy's colour)
    const mats = new Map<string, Material>();
    const mat = (name: string, inst: boolean) => {
      const k = name + (inst ? "#i" : "");
      let m = mats.get(k);
      if (!m) {
        const d = cfg.city!.materials[name] ?? { roughness: 0.8 };
        const sm = new MeshStandardMaterial({ name: `kyoto-${k}`, color: 0xffffff, roughness: d.roughness, metalness: d.metalness ?? 0, vertexColors: !inst });
        mats.set(k, (m = sm));
      }
      return m;
    };
    const kit = decodeErt(readAsset(cfg.city.kit));
    const pieces = new Map<string, { g: BufferGeometry; material: string }>();
    for (const p of kit.header.pieces as { name: string; material: string; chunk: string }[]) {
      const g = new BufferGeometry();
      g.positions = kit.chunks[`${p.chunk}.pos`] as Float32Array;
      g.normals = kit.chunks[`${p.chunk}.nrm`] as Float32Array;
      g.index = kit.chunks[`${p.chunk}.idx`] as Uint32Array;
      pieces.set(p.name, { g, material: p.material });
    }
    for (const path of cfg.city.tiles) {
      const e = decodeErt(readAsset(path));
      const h = e.header as typeof e.header & { meshes: { material: string; chunk: string }[]; instances: { piece: string; chunk: string; n: number }[] };
      for (const m of h.meshes) {
        const g = new BufferGeometry();
        g.positions = e.chunks[`${m.chunk}.pos`] as Float32Array;
        g.normals = e.chunks[`${m.chunk}.nrm`] as Float32Array;
        g.uvs = e.chunks[`${m.chunk}.uv`] as Float32Array;
        g.setAttribute("color", new BufferAttribute(e.chunks[`${m.chunk}.col`] as Float32Array, 3));
        g.index = e.chunks[`${m.chunk}.idx`] as Uint32Array;
        const mesh = new Mesh(g, mat(m.material, false));
        place(mesh, h.center);
        scene.add(mesh);
      }
      for (const i of h.instances) {
        const p = pieces.get(i.piece);
        if (!p) continue;
        const src = e.chunks[`${i.chunk}.m`] as Float32Array;
        const inst = new InstancedMesh(p.g, mat(p.material, true), i.n);
        const m16 = new Float32Array(i.n * 16);
        for (let k = 0; k < i.n; k++) {
          const a = k * 12, o = k * 16;
          m16[o] = src[a]; m16[o + 1] = src[a + 1]; m16[o + 2] = src[a + 2];
          m16[o + 4] = src[a + 3]; m16[o + 5] = src[a + 4]; m16[o + 6] = src[a + 5];
          m16[o + 8] = src[a + 6]; m16[o + 9] = src[a + 7]; m16[o + 10] = src[a + 8];
          m16[o + 12] = src[a + 9]; m16[o + 13] = src[a + 10]; m16[o + 14] = src[a + 11]; m16[o + 15] = 1;
        }
        inst.instanceMatrix.array.set(m16);
        inst.instanceColor = new InstancedBufferAttribute(new Float32Array(e.chunks[`${i.chunk}.col`] as Float32Array), 3);
        place(inst, h.center);
        scene.add(inst);
      }
    }
  }

  const camera = new PerspectiveCamera(cfg.camera.fov, 16 / 9, 0.5, 1e8);
  camera.position.set(...cfg.camera.position);
  camera.lookAt(...cfg.camera.target);
  if (cfg.exposure !== null) camera.setManualExposure(cfg.exposure);
  else camera.setAutoExposure(0, 11, 17);
  scene.add(camera);
  return { scene, camera, options: { name: "kyoto-preview" } };
}

// The kit (SPEC § 5, tileset@2 `kit`): pieces every tile places copies of. Each piece is one material and lives in a
// unit space a copy's matrix stretches: houses' walls and roofs (x along the ridge, y up, z across; x, z in
// −0.5..0.5, walls y 0..1, roofs from the eaves y = 0 to the ridge y = 1, so one piece serves every pitch and size),
// and trees (metres of a 1 m tree, y up, scaled by the tree's height).
import { encodeErt } from "../earthrt/core/ert.ts";
import type { V3 } from "../earthrt/core/geo.ts";
import { newell } from "./mesh.ts";

export interface Piece { name: string; material: string; pos: number[]; nrm: number[]; idx: number[]; smooth?: boolean }

const pieces: Piece[] = [];
function piece(name: string, material: string): Piece {
  const p: Piece = { name, material, pos: [], nrm: [], idx: [] };
  pieces.push(p);
  return p;
}
function quad(p: Piece, pts: V3[]) {
  const n = newell(pts), b = p.pos.length / 3;
  for (const q of pts) { p.pos.push(...q); p.nrm.push(...n); }
  for (let i = 1; i + 1 < pts.length; i++) p.idx.push(b, b + i, b + i + 1);
}

/** Eave overhang as a fraction of the roof's size (copies stretch it with the roof). */
export const OVERHANG = 0.07;
const O = 0.5 * (1 + OVERHANG);

// walls: the four sides of the unit box (no top, no bottom)
{
  const w = piece("walls", "wall");
  quad(w, [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]]);
  quad(w, [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]]);
  quad(w, [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]]);
  quad(w, [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]]);
}
// a flat roof: the top, with a low parapet (a copy's y scale is the parapet's height)
{
  const f = piece("flat", "roof-flat");
  quad(f, [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5]]);
  const p = piece("parapet", "wall");
  const i = 0.47;
  // the parapet ring: outer and inner faces and its top
  const ring: [number, number][] = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];
  const inner: [number, number][] = [[-i, i], [i, i], [i, -i], [-i, -i]];
  for (let k = 0; k < 4; k++) {
    const a = ring[k], b = ring[(k + 1) % 4], ai = inner[k], bi = inner[(k + 1) % 4];
    quad(p, [[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], 1, b[1]], [a[0], 1, a[1]]]);       // outer
    quad(p, [[bi[0], 0, bi[1]], [ai[0], 0, ai[1]], [ai[0], 1, ai[1]], [bi[0], 1, bi[1]]]); // inner
    quad(p, [[a[0], 1, a[1]], [b[0], 1, b[1]], [bi[0], 1, bi[1]], [ai[0], 1, ai[1]]]);     // top
  }
}
// a gabled roof: two slopes (ridge along x) and the two gable ends (wall)
{
  const g = piece("gable", "roof-tile");
  quad(g, [[-O, 0, O], [O, 0, O], [O, 1, 0], [-O, 1, 0]]);
  quad(g, [[O, 0, -O], [-O, 0, -O], [-O, 1, 0], [O, 1, 0]]);
  const e = piece("gable-ends", "wall");
  quad(e, [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0]]);
  quad(e, [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0]]);
}
// hipped roofs: the ridge's half-length r in unit x (0: a pyramid); a copy picks the one nearest 0.5 − width / (2 length)
export const HIPS = [0, 0.12, 0.2, 0.27, 0.33, 0.38, 0.42];
for (const r of HIPS) {
  const h = piece(`hip-${r}`, "roof-tile");
  if (r === 0) {
    quad(h, [[-O, 0, O], [O, 0, O], [0, 1, 0]]);
    quad(h, [[O, 0, O], [O, 0, -O], [0, 1, 0]]);
    quad(h, [[O, 0, -O], [-O, 0, -O], [0, 1, 0]]);
    quad(h, [[-O, 0, -O], [-O, 0, O], [0, 1, 0]]);
  } else {
    quad(h, [[-O, 0, O], [O, 0, O], [r, 1, 0], [-r, 1, 0]]);
    quad(h, [[O, 0, -O], [-O, 0, -O], [-r, 1, 0], [r, 1, 0]]);
    quad(h, [[O, 0, O], [O, 0, -O], [r, 1, 0]]);
    quad(h, [[-O, 0, -O], [-O, 0, O], [-r, 1, 0]]);
  }
}
// a shed (skillion) roof: one slope rising toward −z, its two side triangles
{
  const s = piece("shed", "roof-metal");
  quad(s, [[-O, 0, O], [O, 0, O], [O, 1, -O], [-O, 1, -O]]);
  const e = piece("shed-ends", "wall");
  quad(e, [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5]]);
  quad(e, [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, -0.5]]);
}

// the roofs again in the other roof materials: `<piece>:<material>`
for (const p of pieces.slice()) {
  if (p.material !== "roof-tile") continue;
  for (const m of ["roof-metal", "roof-copper", "roof-bark"]) pieces.push({ ...p, name: `${p.name}:${m}`, material: m });
}

// ------------------------------------------------------------------------------------------------ trees
// A 1 m tree: crown and trunk as two pieces (two materials). Smooth normals on crowns.

function blob(p: Piece, cy: number, rx: number, ry: number, seed: number, detail = 1) {
  // a lumpy subdivided icosahedron
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: V3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  verts = verts.map((v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; });
  for (let d = 0; d < detail; d++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      let i = mid.get(k);
      if (i === undefined) {
        const va = verts[a], vb = verts[b];
        const v: V3 = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
        const l = Math.hypot(...v);
        verts.push([v[0] / l, v[1] / l, v[2] / l]);
        mid.set(k, (i = verts.length - 1));
      }
      return i;
    };
    faces = faces.flatMap(([a, b, c]) => { const ab = m(a, b), bc = m(b, c), ca = m(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
  }
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const bump = verts.map(() => 0.82 + 0.3 * rnd());
  const base = p.pos.length / 3;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    p.pos.push(v[0] * rx * bump[i], cy + v[1] * ry * bump[i], v[2] * rx * bump[i]);
    const n: V3 = [v[0] / rx, v[1] / ry, v[2] / rx];
    const l = Math.hypot(...n);
    p.nrm.push(n[0] / l, n[1] / l, n[2] / l);
  }
  for (const f of faces) p.idx.push(base + f[0], base + f[2], base + f[1]);
}
function cone(p: Piece, y0: number, y1: number, r: number, sides: number) {
  const base = p.pos.length / 3;
  const slope = r / (y1 - y0);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const nx = Math.cos(a), nz = Math.sin(a), l = Math.hypot(1, slope);
    p.pos.push(nx * r, y0, nz * r); p.nrm.push(nx / l, slope / l, nz / l);
    p.pos.push(0, y1, 0); p.nrm.push(nx / l, slope / l, nz / l);
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    p.idx.push(base + 2 * i, base + 2 * i + 1, base + 2 * j);
  }
  // the underside
  const c = p.pos.length / 3;
  p.pos.push(0, y0, 0); p.nrm.push(0, -1, 0);
  for (let i = 0; i < sides; i++) { const a = (i / sides) * Math.PI * 2; p.pos.push(Math.cos(a) * r, y0, Math.sin(a) * r); p.nrm.push(0, -1, 0); }
  for (let i = 0; i < sides; i++) p.idx.push(c, c + 1 + i, c + 1 + ((i + 1) % sides));
}
function prism(p: Piece, y0: number, y1: number, r: number, sides: number) {
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2, b = ((i + 1) / sides) * Math.PI * 2;
    quad(p, [[Math.cos(b) * r, y0, Math.sin(b) * r], [Math.cos(a) * r, y0, Math.sin(a) * r], [Math.cos(a) * r * 0.7, y1, Math.sin(a) * r * 0.7], [Math.cos(b) * r * 0.7, y1, Math.sin(b) * r * 0.7]]);
  }
}

// broadleaf (camphor, zelkova, cherry, maple): a round crown on a short trunk
{ const c = piece("tree-broad", "foliage"); c.smooth = true; blob(c, 0.62, 0.36, 0.34, 7); blob(c, 0.72, 0.22, 0.2, 11, 0); }
{ const t = piece("trunk-broad", "bark"); prism(t, 0, 0.5, 0.035, 5); }
// cedar / cypress (sugi, hinoki): a tall narrow cone
{ const c = piece("tree-conifer", "foliage"); c.smooth = true; cone(c, 0.18, 0.72, 0.2, 7); cone(c, 0.45, 1.0, 0.15, 7); }
{ const t = piece("trunk-conifer", "bark"); prism(t, 0, 0.3, 0.03, 5); }
// Japanese black pine: flat clumps on a leaning trunk
{ const c = piece("tree-pine", "foliage"); c.smooth = true; blob(c, 0.78, 0.34, 0.13, 3, 1); blob(c, 0.95, 0.2, 0.08, 5, 0); blob(c, 0.6, 0.22, 0.09, 9, 0); }
{ const t = piece("trunk-pine", "bark"); prism(t, 0, 0.85, 0.03, 5); }

export const KIT = pieces;

/** kit.ert: a piece a mesh (its own chunks), unit space as above. */
export function encodeKit(): Uint8Array {
  const chunks: Record<string, Float32Array | Uint32Array> = {};
  const list = pieces.map((p, i) => {
    chunks[`p${i}.pos`] = Float32Array.from(p.pos);
    chunks[`p${i}.nrm`] = Float32Array.from(p.nrm);
    chunks[`p${i}.idx`] = Uint32Array.from(p.idx);
    return { name: p.name, material: p.material, chunk: `p${i}`, v: p.pos.length / 3, t: p.idx.length / 3 };
  });
  return encodeErt({ v: 1, layer: "kit", key: "kit", enc: "expanded", center: [0, 0, 0], radius: 1, pieces: list }, chunks);
}

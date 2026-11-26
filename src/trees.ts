// Trees: OSM's own (natural=tree), then woods, parks, gardens and temple grounds filled at their densities, and rows
// along the main streets. Copies of the kit's trees (crown and trunk), each with its own size, turn and colour.
import type { V3 } from "../earthrt/core/geo.ts";
import { lin, type RGB } from "./mesh.ts";
import { hash01, pointInPoly, rng, type P2 } from "./plane.ts";
import { roadWidth } from "./surface.ts";
import { jitter, type Feature, type Line, type Node, type World } from "./world.ts";

type Form = "broad" | "conifer" | "pine";
const CROWN: Record<Form, RGB[]> = {
  broad: [[62, 88, 46], [74, 98, 50], [54, 78, 42], [86, 104, 56], [66, 92, 40], [94, 112, 58]],
  conifer: [[42, 62, 40], [50, 68, 44], [46, 66, 36]],
  pine: [[48, 70, 44], [56, 76, 46]],
};
const TRUNK: RGB = [84, 68, 54];

function plant(w: World, x: number, y: number, form: Form, h: number, r: () => number, tint = 0) {
  const t = w.tileAt(x, y);
  const { e, n, u } = w.enuAt(x, y);
  const a = r() * Math.PI * 2, c = Math.cos(a) * h, s = Math.sin(a) * h;
  // pines lean
  const lean = form === "pine" ? (r() - 0.5) * 0.35 : 0;
  const X: V3 = [e[0] * c + n[0] * s, e[1] * c + n[1] * s, e[2] * c + n[2] * s];
  const Z: V3 = [(-e[0] * s + n[0] * c), (-e[1] * s + n[1] * c), (-e[2] * s + n[2] * c)];
  // y = up, with the lean toward X
  const Y: V3 = [u[0] * h + (X[0] * lean), u[1] * h + (X[1] * lean), u[2] * h + (X[2] * lean)];
  // Z must be X × Y's direction for a proper rotation: (e, n) turned by a, so Z = −(the turned north)
  const Zr: V3 = [-Z[0], -Z[1], -Z[2]];
  const g = w.ground.height(x, y) - 0.2;
  const T = w.P(x, y, g);
  let col = jitter(CROWN[form][Math.floor(r() * CROWN[form].length)], 0.12, r);
  if (tint) col = [col[0] * (1 + tint), col[1] * (1 + tint * 0.6), col[2]];
  t.instance(`tree-${form}`, X, Y, Zr, T, lin(col));
  t.instance(`trunk-${form}`, X, Y, Zr, T, lin(TRUNK));
  w.stats.trees++;
}

interface Fill { density: number; h: [number, number]; forms: [Form, number][]; margin: number }

function fillOf(t: Record<string, string>, w: World, x: number, y: number): Fill | null {
  const lu = t.landuse, le = t.leisure, na = t.natural, am = t.amenity;
  if (lu === "forest" || na === "wood") return { density: 1 / 48, h: [11, 19], forms: [["broad", 0.5], ["conifer", 0.4], ["pine", 0.1]], margin: 1 };
  if (na === "scrub" || na === "heath") return { density: 1 / 110, h: [3.5, 6], forms: [["broad", 1]], margin: 1 };
  if (le === "garden") return { density: w.precinctAt(x, y) ? 1 / 70 : 1 / 120, h: [4, 10], forms: [["broad", 0.55], ["pine", 0.35], ["conifer", 0.1]], margin: 1.5 };
  if (le === "park") return { density: 1 / 150, h: [7, 14], forms: [["broad", 0.8], ["pine", 0.1], ["conifer", 0.1]], margin: 1.5 };
  if (am === "place_of_worship" || lu === "religious") return { density: 1 / 170, h: [9, 20], forms: [["broad", 0.6], ["conifer", 0.25], ["pine", 0.15]], margin: 2 };
  if (lu === "cemetery" || am === "grave_yard") return { density: 1 / 500, h: [5, 10], forms: [["conifer", 0.5], ["broad", 0.5]], margin: 1 };
  if (am === "university" || am === "college") return { density: 1 / 350, h: [8, 14], forms: [["broad", 1]], margin: 3 };
  if (am === "school") return { density: 1 / 1200, h: [7, 11], forms: [["broad", 0.7], ["conifer", 0.3]], margin: 3 };
  if (lu === "grass" || na === "grassland" || le === "recreation_ground") return { density: 1 / 1500, h: [6, 11], forms: [["broad", 1]], margin: 2 };
  return null;
}

const formOf = (forms: [Form, number][], u: number): Form => { let acc = 0; for (const [f, p] of forms) { acc += p; if (u < acc) return f; } return forms[0][0]; };

export function buildTrees(w: World, areas: Feature[], nodes: Node[], lines: Line[]) {
  // 1. OSM's trees
  for (const n of nodes) {
    if (n.t.natural !== "tree") continue;
    const [x, y] = n.p;
    if (!w.inBounds(x, y) || w.inBuilding(x, y)) continue;
    const r = rng(Math.floor(hash01(n.id) * 1e9));
    const lt = n.t.leaf_type, h = Number(n.t.height);
    const form: Form = lt === "needleleaved" ? (r() < 0.5 ? "pine" : "conifer") : "broad";
    plant(w, x, y, form, Number.isFinite(h) && h > 2 && h < 40 ? h : 7 + r() * 6, r);
  }
  // 2. areas at their densities (jittered grid)
  for (const f of areas) {
    for (const poly of f.rings) {
      const c = poly[0][0];
      const fill = fillOf(f.t, w, c[0], c[1]);
      if (!fill) continue;
      const xs = poly[0].map((p) => p[0]), ys = poly[0].map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const step = Math.sqrt(1 / fill.density);
      const r = rng(Math.floor(hash01(f.id) * 1e9));
      for (let y = y0 + step * r(); y < y1; y += step) for (let x = x0 + step * r(); x < x1; x += step) {
        const px = x + (r() - 0.5) * step * 0.9, py = y + (r() - 0.5) * step * 0.9;
        if (!w.inBounds(px, py) || !pointInPoly(px, py, poly as P2[][])) continue;
        // a gap now and then: clearings, paths
        if (r() < 0.08) continue;
        if (w.inBuilding(px, py, fill.margin) || w.onRoad(px, py, 1) || w.inWater(px, py)) continue;
        const form = formOf(fill.forms, r());
        const h = fill.h[0] + (fill.h[1] - fill.h[0]) * Math.pow(r(), 0.8) * (form === "conifer" ? 1.15 : 1);
        plant(w, px, py, form, h, r);
      }
    }
  }
  // 3. rows along the main streets (ginkgo and zelkova), both sides
  for (const l of lines) {
    const hw0 = l.t.highway && ["primary", "secondary", "tertiary", "trunk"].includes(l.t.highway) ? roadWidth(l.t) : null;
    if (!hw0 || l.t.tunnel === "yes" || l.t.bridge === "yes") continue;
    const r = rng(Math.floor(hash01(l.id) * 1e9));
    if (r() < 0.35) continue; // not every street has them
    const spacing = 9 + r() * 4;
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const a = l.pts[i], b = l.pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], ll = Math.hypot(dx, dy);
      if (ll < 1) continue;
      const nx = -dy / ll, ny = dx / ll;
      for (let s = spacing / 2; s < ll; s += spacing) for (const side of [-1, 1]) {
        const off = hw0 + 1.6;
        const x = a[0] + (dx * s) / ll + nx * off * side, y = a[1] + (dy * s) / ll + ny * off * side;
        if (!w.inBounds(x, y) || w.inBuilding(x, y, 1.5) || w.onRoad(x, y, 0.8)) continue;
        plant(w, x, y, "broad", 7 + r() * 3.5, r);
      }
    }
  }
}

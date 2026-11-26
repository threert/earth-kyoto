// The ground's dressing: land use, parks, temple courts, water, roads, rails, laid on the trunk's terrain triangles
// (`Ground.drape`), a few centimetres above it in a fixed order; bridges and viaducts as decks on piers; the earthen
// walls (tsuiji-bei) around temples.
import earcut from "earcut";
import type { V3 } from "../earthrt/core/geo.ts";
import { lin, type RGB } from "./mesh.ts";
import { hash01, rng, tileToPlane, type P2 } from "./plane.ts";
import { GROUND_ZOOM } from "./ground.ts";
import type { Feature, Line, World } from "./world.ts";

const CELLS = 64;

/** Lays a plane polygon (with holes) on the terrain, `lift` m above it. */
export function drapePolygon(w: World, rings: P2[][], material: string, col: RGB, lift: number) {
  const flat: number[] = [], holes: number[] = [];
  for (const r of rings) { if (flat.length) holes.push(flat.length / 2); for (const p of r) flat.push(p[0], p[1]); }
  if (flat.length < 6) return;
  const tri = earcut(flat, holes.length ? holes : undefined);
  const c = lin(col);
  for (let i = 0; i < tri.length; i += 3) {
    const a: P2 = [flat[2 * tri[i]], flat[2 * tri[i] + 1]], b: P2 = [flat[2 * tri[i + 1]], flat[2 * tri[i + 1] + 1]], d: P2 = [flat[2 * tri[i + 2]], flat[2 * tri[i + 2] + 1]];
    drapeTri(w, a, b, d, material, c, lift);
  }
}

function drapeTri(w: World, a: P2, b: P2, c: P2, material: string, col: RGB, lift: number) {
  w.ground.drape(a, b, c, (poly) => {
    let sx = 0, sy = 0;
    for (const p of poly) { sx += p[0]; sy += p[1]; }
    const [px, py] = tileToPlane(sx / poly.length / CELLS, sy / poly.length / CELLS, GROUND_ZOOM);
    if (!w.inBounds(px, py)) return;
    const t = w.tileAt(px, py);
    const pts: V3[] = poly.map((p) => w.ground.atGrid(p[0], p[1], lift));
    const uvs = poly.map((p) => { const q = tileToPlane(p[0] / CELLS, p[1] / CELLS, GROUND_ZOOM); return [q[0], q[1]] as [number, number]; });
    t.poly(material, pts, col, uvs, w.enuAt(px, py).u);
  });
}

// ------------------------------------------------------------------------------------------------ areas

interface AreaStyle { material: string; col: RGB; lift: number }

function areaStyle(t: Record<string, string>, w: World, x: number, y: number): AreaStyle | null {
  const lu = t.landuse, le = t.leisure, na = t.natural, am = t.amenity;
  if (na === "water" || t.water || t.waterway === "riverbank" || lu === "reservoir" || lu === "basin") {
    if (t.water === "wastewater") return { material: "water", col: [52, 66, 60], lift: 0.18 };
    return { material: "water", col: [30, 46, 50], lift: 0.18 };
  }
  if (am === "place_of_worship" || lu === "religious") {
    // temple courts are raked gravel, shrine grounds packed earth
    return { material: "gravel", col: t.religion === "shinto" ? [176, 162, 136] : [204, 198, 184], lift: 0.1 };
  }
  if (le === "garden") return { material: "grass", col: w.precinctAt(x, y) ? [80, 104, 58] : [96, 122, 66], lift: 0.13 };
  if (le === "park" || le === "recreation_ground" || lu === "recreation_ground" || lu === "village_green") return { material: "grass", col: [104, 126, 70], lift: 0.12 };
  if (le === "pitch" || le === "track") return t.surface === "grass" || t.surface === "artificial_turf" ? { material: "grass", col: [96, 134, 72], lift: 0.14 } : { material: "gravel", col: [186, 162, 124], lift: 0.14 };
  if (le === "golf_course") return { material: "grass", col: [110, 140, 74], lift: 0.12 };
  if (le === "swimming_pool") return { material: "water", col: [70, 140, 160], lift: 0.2 };
  if (lu === "grass" || na === "grassland" || lu === "meadow" || lu === "flowerbed") return { material: "grass", col: [108, 130, 72], lift: 0.11 };
  if (lu === "forest" || na === "wood" || na === "scrub" || na === "heath") return { material: "grass", col: [54, 72, 42], lift: 0.08 };
  if (lu === "farmland" || lu === "orchard" || lu === "allotments") return { material: "grass", col: lu === "farmland" ? [124, 132, 84] : [96, 116, 64], lift: 0.08 };
  if (lu === "cemetery" || am === "grave_yard") return { material: "gravel", col: [160, 156, 148], lift: 0.12 };
  if (am === "school" || am === "kindergarten") return { material: "gravel", col: [194, 176, 140], lift: 0.09 };
  if (am === "university" || am === "college" || am === "hospital") return { material: "paving", col: [160, 156, 146], lift: 0.09 };
  if (am === "parking") return { material: "asphalt", col: [116, 116, 114], lift: 0.15 };
  if (lu === "railway") return { material: "gravel", col: [126, 118, 106], lift: 0.09 };
  if (t["area:highway"] || t.highway === "pedestrian") return { material: "paving", col: [170, 164, 150], lift: 0.27 };
  if (t.railway === "platform") return { material: "paving", col: [176, 174, 168], lift: 0.6 };
  if (lu === "construction" || lu === "brownfield") return { material: "gravel", col: [160, 146, 124], lift: 0.08 };
  if (na === "sand" || na === "shingle" || na === "stone" || na === "bare_rock") return { material: "gravel", col: [184, 178, 166], lift: 0.16 };
  return null;
}

export function buildAreas(w: World, areas: Feature[]) {
  let n = 0;
  for (const f of areas) {
    for (const poly of f.rings) {
      const c = poly[0][0];
      const st = areaStyle(f.t, w, c[0], c[1]);
      if (!st) continue;
      drapePolygon(w, poly, st.material, st.col, st.lift);
      n++;
    }
  }
  return n;
}

/** Water polygons and temple precincts are looked up by the other passes: index them first. */
export function indexAreas(w: World, areas: Feature[]) {
  for (const f of areas) {
    const t = f.t;
    for (const poly of f.rings) {
      const xs = poly[0].map((p) => p[0]), ys = poly[0].map((p) => p[1]);
      const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
      if (t.natural === "water" || t.water || t.waterway === "riverbank" || t.landuse === "reservoir") w.water.add(...box, poly);
      if (t.amenity === "place_of_worship" || t.landuse === "religious") {
        const p = { rings: poly, religion: t.religion ?? (/神社|宮$/.test(t.name ?? "") ? "shinto" : "buddhist"), name: t.name };
        w.precincts.push(p);
        w.precinctGrid.add(...box, p);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ lines

const ROAD: Record<string, [number, RGB, number, string]> = {
  // half-width m, colour, lift, material
  motorway: [7.5, [70, 70, 72], 0.34, "asphalt"],
  trunk: [8, [72, 72, 74], 0.33, "asphalt"],
  primary: [9, [76, 76, 78], 0.32, "asphalt"],
  secondary: [7, [80, 80, 82], 0.31, "asphalt"],
  tertiary: [4.5, [86, 86, 86], 0.3, "asphalt"],
  motorway_link: [4, [72, 72, 74], 0.33, "asphalt"],
  trunk_link: [4, [72, 72, 74], 0.33, "asphalt"],
  primary_link: [4, [76, 76, 78], 0.32, "asphalt"],
  secondary_link: [3.5, [80, 80, 82], 0.31, "asphalt"],
  tertiary_link: [3, [86, 86, 86], 0.3, "asphalt"],
  unclassified: [2.8, [100, 98, 94], 0.29, "asphalt"],
  residential: [2.6, [104, 102, 98], 0.29, "asphalt"],
  living_street: [2.2, [118, 114, 106], 0.29, "asphalt"],
  service: [1.8, [112, 110, 106], 0.28, "asphalt"],
  busway: [3.5, [80, 80, 82], 0.31, "asphalt"],
  pedestrian: [2.5, [172, 164, 148], 0.27, "paving"],
  footway: [0.9, [176, 170, 156], 0.26, "paving"],
  cycleway: [1.0, [150, 120, 110], 0.26, "paving"],
  path: [0.7, [150, 136, 112], 0.25, "gravel"],
  track: [1.4, [150, 136, 112], 0.25, "gravel"],
};

export function roadWidth(t: Record<string, string>): number | null {
  const st = ROAD[t.highway];
  if (!st) return null;
  const w = Number(t.width), lanes = Number(t.lanes);
  if (Number.isFinite(w) && w > 1 && w < 80) return w / 2;
  if (Number.isFinite(lanes) && lanes > 0 && st[0] > 2.5) return Math.max(st[0] * 0.6, (lanes * 3.2 + 3) / 2);
  return st[0];
}

const underground = (t: Record<string, string>) => t.tunnel === "yes" || t.tunnel === "building_passage" || t.location === "underground" || t.railway === "subway" || Number(t.layer) < 0 || t.highway === "corridor" || t.covered === "yes";

/** Road and rail centre lines into the lookup grid (for houses facing streets, trees off roads). */
export function indexLines(w: World, lines: Line[]) {
  for (const l of lines) {
    if (underground(l.t)) continue;
    let hw = roadWidth(l.t);
    let cls = l.t.highway;
    if (hw === null && (l.t.railway === "rail" || l.t.railway === "light_rail" || l.t.railway === "tram")) { hw = 2; cls = "rail"; }
    if (hw === null) continue;
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const a = l.pts[i], b = l.pts[i + 1];
      w.roads.add(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), { a, b, hw, cls });
    }
  }
}

export function buildLines(w: World, lines: Line[]) {
  // bridges' ends that meet another bridge (no ramp there)
  const bridgeEnds = new Map<string, number>();
  const ek = (p: P2) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  for (const l of lines) if (l.t.bridge && l.t.bridge !== "no") for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) bridgeEnds.set(ek(p), (bridgeEnds.get(ek(p)) ?? 0) + 1);

  for (const l of lines) {
    const t = l.t;
    if (underground(t)) continue;
    if (t.barrier === "wall" || t.barrier === "city_wall") { wallLine(w, l); continue; }
    let hw: number | null = null, col: RGB = [0, 0, 0], lift = 0.3, material = "asphalt";
    if (t.highway) {
      if (t.highway === "steps" || t.highway === "proposed" || t.highway === "construction" || t.highway === "elevator") continue;
      const st = ROAD[t.highway];
      if (!st) continue;
      hw = roadWidth(t)!; col = st[1]; lift = st[2]; material = st[3];
      if (t.highway === "path" && t.surface && /paved|asphalt|concrete/.test(t.surface)) { col = [170, 164, 150]; material = "paving"; }
    } else if (t.railway === "rail" || t.railway === "light_rail" || t.railway === "tram" || t.railway === "funicular") {
      if (t.usage === undefined && t.service === "spur") continue;
      hw = 1.8; col = [104, 96, 88]; lift = 0.35; material = "gravel";
    } else if (t.waterway) {
      const ww = t.waterway;
      const width = Number(t.width);
      hw = Number.isFinite(width) ? width / 2 : ww === "river" ? 8 : ww === "canal" ? 4 : ww === "stream" ? 1.2 : ww === "ditch" || ww === "drain" ? 0.7 : 0;
      if (!hw) continue;
      // a river drawn as an area too: the area is the water
      const mid = l.pts[Math.floor(l.pts.length / 2)];
      if (w.inWater(mid[0], mid[1])) continue;
      col = [30, 46, 50]; lift = 0.17; material = "water";
    } else continue;

    const bridge = t.bridge && t.bridge !== "no";
    if (bridge && (t.highway || t.railway)) { deck(w, l, hw, col, material, bridgeEnds, ek); continue; }
    ribbon(w, l.pts, hw, material, col, lift);
  }
}

/** A polyline as a strip on the ground: a quad a segment, a polygon at each bend. */
function ribbon(w: World, pts: P2[], hw: number, material: string, col: RGB, lift: number) {
  const c = lin(col);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    if (l < 0.05) continue;
    const nx = (-dy / l) * hw, ny = (dx / l) * hw;
    const q: P2[] = [[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
    drapeTri(w, q[0], q[1], q[2], material, c, lift);
    drapeTri(w, q[0], q[2], q[3], material, c, lift);
  }
  // joins: an octagon at every inner vertex (and the ends, for wide roads)
  if (hw < 1.2) return;
  for (let i = 1; i + 1 < pts.length; i++) {
    const p = pts[i];
    const o: P2[] = Array.from({ length: 8 }, (_, k) => [p[0] + Math.cos((k * Math.PI) / 4) * hw * 1.04, p[1] + Math.sin((k * Math.PI) / 4) * hw * 1.04]);
    for (let k = 1; k + 1 < 8; k++) drapeTri(w, o[0], o[k], o[k + 1], material, c, lift);
  }
}

/** A bridge or a viaduct: a deck along the line at a height over the ground, sides, piers; ramps where it lands. */
function deck(w: World, l: Line, hw: number, col: RGB, material: string, ends: Map<string, number>, ek: (p: P2) => string) {
  const t = l.t;
  // resample every ~12 m
  const pts: P2[] = [];
  for (let i = 0; i + 1 < l.pts.length; i++) {
    const a = l.pts[i], b = l.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 12));
    for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  pts.push(l.pts[l.pts.length - 1]);
  const s: number[] = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const len = s[s.length - 1];
  const overWater = pts.some((p) => w.inWater(p[0], p[1]));
  const layer = Number(t.layer);
  const H = overWater && !(layer >= 2) ? 2.4 : Math.max(6, (Number.isFinite(layer) ? layer : 1) * 7);
  const ramp = Math.min(60, len / 3);
  const rampA = (ends.get(ek(l.pts[0])) ?? 0) > 1 ? 0 : ramp, rampB = (ends.get(ek(l.pts[l.pts.length - 1])) ?? 0) > 1 ? 0 : ramp;
  const hAt = (i: number) => {
    const g = w.ground.height(pts[i][0], pts[i][1]);
    let f = 1;
    if (rampA && s[i] < rampA) f = s[i] / rampA;
    if (rampB && len - s[i] < rampB) f = Math.min(f, (len - s[i]) / rampB);
    return g + 0.3 + H * f;
  };
  const hs = pts.map((_, i) => hAt(i));
  const c = lin(col), side = lin([150, 148, 142]);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], ll = Math.hypot(dx, dy);
    if (ll < 0.05) continue;
    const nx = (-dy / ll) * hw, ny = (dx / ll) * hw;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (!w.inBounds(mx, my)) continue;
    const tile = w.tileAt(mx, my);
    const up = w.enuAt(mx, my).u;
    const A0 = w.P(a[0] - nx, a[1] - ny, hs[i]), B0 = w.P(b[0] - nx, b[1] - ny, hs[i + 1]), B1 = w.P(b[0] + nx, b[1] + ny, hs[i + 1]), A1 = w.P(a[0] + nx, a[1] + ny, hs[i]);
    tile.poly(material, [A0, B0, B1, A1], c, undefined, up);
    const d = Math.min(1.4, hs[i] - w.ground.height(a[0], a[1]));
    if (d > 0.3) {
      tile.poly("concrete", [w.P(a[0] - nx, a[1] - ny, hs[i] - d), w.P(b[0] - nx, b[1] - ny, hs[i + 1] - d), B0, A0], side);
      tile.poly("concrete", [w.P(b[0] + nx, b[1] + ny, hs[i + 1] - d), w.P(a[0] + nx, a[1] + ny, hs[i] - d), A1, B1], side);
      tile.poly("concrete", [w.P(a[0] - nx, a[1] - ny, hs[i] - d), w.P(a[0] + nx, a[1] + ny, hs[i] - d), w.P(b[0] + nx, b[1] + ny, hs[i + 1] - d), w.P(b[0] - nx, b[1] - ny, hs[i + 1] - d)], side);
    }
    // a pier every ~24 m under a viaduct
    if (!overWater && i % 2 === 0 && hs[i] - w.ground.height(a[0], a[1]) > 3) {
      const g = w.ground.height(a[0], a[1]) - 0.5, top = hs[i] - 1.4, r = Math.min(1.2, hw * 0.3);
      const ux = (dx / ll) * r, uy = (dy / ll) * r, vx = (-dy / ll) * r, vy = (dx / ll) * r;
      const q: P2[] = [[a[0] - ux - vx, a[1] - uy - vy], [a[0] + ux - vx, a[1] + uy - vy], [a[0] + ux + vx, a[1] + uy + vy], [a[0] - ux + vx, a[1] - uy + vy]];
      for (let k = 0; k < 4; k++) { const p = q[k], n2 = q[(k + 1) % 4]; tile.poly("concrete", [w.P(p[0], p[1], g), w.P(n2[0], n2[1], g), w.P(n2[0], n2[1], top), w.P(p[0], p[1], top)], side); }
    }
  }
}

/** An earthen wall with a tiled cap (tsuiji-bei) along temple grounds; a plain wall elsewhere. */
function wallLine(w: World, l: Line) {
  const mid = l.pts[Math.floor(l.pts.length / 2)];
  const pre = w.precinctAt(mid[0], mid[1]);
  const r = rng(Math.floor(hash01(l.id) * 1e9));
  const tsuiji = !!pre || l.t.barrier === "city_wall";
  const H = tsuiji ? 2.6 + r() * 0.6 : 1.8, hw = tsuiji ? 0.5 : 0.15;
  const wallCol = lin(tsuiji ? (r() < 0.55 ? [226, 206, 150] : [232, 228, 218]) : [176, 172, 164]);
  const capCol = lin([66, 69, 74]);
  for (let i = 0; i + 1 < l.pts.length; i++) {
    const a = l.pts[i], b = l.pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], ll = Math.hypot(dx, dy);
    if (ll < 0.1) continue;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (!w.inBounds(mx, my)) continue;
    const tile = w.tileAt(mx, my);
    const nx = (-dy / ll) * hw, ny = (dx / ll) * hw;
    const ga = w.ground.height(a[0], a[1]), gb = w.ground.height(b[0], b[1]);
    tile.poly("wall", [w.P(a[0] - nx, a[1] - ny, ga - 0.4), w.P(b[0] - nx, b[1] - ny, gb - 0.4), w.P(b[0] - nx, b[1] - ny, gb + H), w.P(a[0] - nx, a[1] - ny, ga + H)], wallCol);
    tile.poly("wall", [w.P(b[0] + nx, b[1] + ny, gb - 0.4), w.P(a[0] + nx, a[1] + ny, ga - 0.4), w.P(a[0] + nx, a[1] + ny, ga + H), w.P(b[0] + nx, b[1] + ny, gb + H)], wallCol);
    if (tsuiji) {
      // the cap: a little gabled roof over the wall
      const ox = nx * 1.9, oy = ny * 1.9, up = w.enuAt(mx, my).u;
      tile.poly("roof-tile", [w.P(a[0] - ox, a[1] - oy, ga + H - 0.1), w.P(b[0] - ox, b[1] - oy, gb + H - 0.1), w.P(b[0], b[1], gb + H + 0.45), w.P(a[0], a[1], ga + H + 0.45)], capCol, undefined, up);
      tile.poly("roof-tile", [w.P(b[0] + ox, b[1] + oy, gb + H - 0.1), w.P(a[0] + ox, a[1] + oy, ga + H - 0.1), w.P(a[0], a[1], ga + H + 0.45), w.P(b[0], b[1], gb + H + 0.45)], capCol, undefined, up);
    } else tile.poly("wall", [w.P(a[0] - nx, a[1] - ny, ga + H), w.P(b[0] - nx, b[1] - ny, gb + H), w.P(b[0] + nx, b[1] + ny, gb + H), w.P(a[0] + nx, a[1] + ny, ga + H)], wallCol, undefined, w.enuAt(mx, my).u);
  }
}

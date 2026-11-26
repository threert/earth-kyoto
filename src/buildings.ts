// Buildings: each OSM footprint classified (house, machiya, apartments, offices and shops, industry, temple hall,
// shrine, pagoda, Kyoto Tower) and given a height, a roof and colours. Near-rectangular houses and blocks are copies
// of the kit's pieces (walls, gabled and hipped roofs, flat roofs); other shapes, temples and pagodas are meshes.
import earcut from "earcut";
import { cross, type V3 } from "../earthrt/core/geo.ts";
import { lin, type RGB, type TileMesh } from "./mesh.ts";
import { FAR_ROOF_LINEAR, HIPS, HOUSE_K } from "./kit.ts";
import { area, centroid, cleanRing, hash01, inset, obb, pointInRing, rng, toPlane, type Obb, type P2 } from "./plane.ts";
import { Grid, jitter, mix, type Feature, type World } from "./world.ts";
import { CONCRETE, STEEL, WOODEN, type PlateauBuilding } from "./plateau.ts";

// ------------------------------------------------------------------------------------------------ palettes (sRGB)

const KAWARA: RGB[] = [[74, 77, 82], [86, 89, 95], [64, 66, 71], [96, 99, 104], [70, 72, 76]];
const SLATE: RGB[] = [[52, 54, 58], [60, 58, 56], [48, 54, 64], [74, 66, 60]];
const METAL: RGB[] = [[128, 128, 124], [92, 66, 52], [66, 82, 94], [104, 92, 80], [150, 150, 146]];
const HOUSE_WALL: RGB[] = [[226, 220, 204], [212, 202, 182], [190, 186, 178], [200, 192, 176], [168, 150, 128], [232, 230, 222]];
const MACHIYA_WALL: RGB[] = [[86, 62, 44], [104, 76, 54], [70, 52, 38], [218, 210, 192]];
const MODERN_WALL: RGB[] = [[196, 190, 178], [176, 172, 166], [214, 210, 202], [168, 132, 104], [140, 138, 134], [200, 184, 160], [226, 224, 218], [120, 112, 104]];
const FLAT_ROOF: RGB[] = [[158, 156, 150], [128, 136, 126], [110, 110, 108], [176, 174, 168], [96, 112, 104], [140, 128, 116]];
const TEMPLE_ROOF: RGB[] = [[66, 69, 74], [74, 77, 82], [58, 60, 64]];
const TEMPLE_WOOD: RGB = [96, 64, 44];
const VERMILION: RGB = [200, 72, 42];
const COPPER: RGB = [92, 138, 116];
const BARK_ROOF: RGB = [96, 66, 48];
const STONE: RGB = [168, 162, 150];
const PLASTER: RGB = [230, 226, 214];

const pick = <T>(a: T[], u: number) => a[Math.min(a.length - 1, Math.floor(u * a.length))];
const L = (c: RGB) => lin(c);

// ------------------------------------------------------------------------------------------------ where in Kyoto

const SHIJO_KARASUMA = toPlane(35.0037, 135.7596);
const STATION = toPlane(34.9858, 135.7588);
/** 1 downtown (Shijō–Karasuma, the station), 0 away from it. */
function downtown(x: number, y: number) {
  const d1 = Math.hypot(x - SHIJO_KARASUMA[0], (y - SHIJO_KARASUMA[1]) * 0.8) / 1400;
  const d2 = Math.hypot(x - STATION[0], y - STATION[1]) / 700;
  return Math.max(0, 1 - Math.min(d1, d2) ** 2);
}
/** The old town where townhouses (machiya) stand in rows: Rakuchū between Horikawa and Kawaramachi, Nishijin, Gion. */
const MACHIYA_AREAS: P2[][] = [
  [[35.0185, 135.7495], [35.0185, 135.7705], [34.9945, 135.7705], [34.9945, 135.7495]],
  [[35.0360, 135.7360], [35.0360, 135.7530], [35.0185, 135.7530], [35.0185, 135.7360]],
  [[35.0080, 135.7700], [35.0080, 135.7840], [34.9930, 135.7840], [34.9930, 135.7700]],
].map((r) => r.map(([la, lo]) => toPlane(la, lo)));
const inMachiyaArea = (x: number, y: number) => MACHIYA_AREAS.some((r) => pointInRing(x, y, r));

const KYOTO_TOWER = toPlane(34.98756, 135.75933);

// ------------------------------------------------------------------------------------------------ the tags

const num = (s: string | undefined) => { if (!s) return NaN; const m = /^\s*([0-9.]+)/.exec(s); return m ? Number(m[1]) : NaN; };

type Kind = "house" | "machiya" | "apartments" | "commercial" | "industrial" | "civic" | "temple" | "shrine" | "pagoda" | "gate" | "shed" | "station" | "roof";

function kindOf(t: Record<string, string>, precinct: { religion: string } | null, a: number, x: number, y: number): Kind {
  const b = t.building ?? t["building:part"] ?? "yes", rel = t.religion ?? precinct?.religion;
  const name = t.name ?? "";
  if (b === "pagoda" || t["tower:type"] === "pagoda" || /[三五七九]重.*塔|多宝塔|五重塔|三重塔/.test(name)) return "pagoda";
  if (b === "roof" || b === "carport") return "roof";
  if (b === "train_station" || t.public_transport === "station") return "station";
  if (b === "gatehouse" || b === "gate" || /門$/.test(name)) return precinct || t.historic ? "gate" : "commercial";
  if (b === "temple" || ((b === "shrine" || t.amenity === "place_of_worship") && rel === "buddhist")) return "temple";
  if (b === "shrine" || rel === "shinto") return "shrine";
  if (precinct && a > 30 && !["apartments", "house", "detached", "school", "hotel", "office", "retail", "commercial", "parking"].includes(b)) return precinct.religion === "shinto" ? "shrine" : "temple";
  if (["shed", "garage", "garages", "greenhouse", "hut", "storage_tank", "toilets", "kiosk"].includes(b)) return "shed";
  if (["house", "detached", "semidetached_house", "terrace", "residential", "bungalow", "farm"].includes(b)) return a > 260 && b === "residential" ? "apartments" : "house";
  if (["apartments", "dormitory"].includes(b)) return "apartments";
  if (["retail", "commercial", "office", "hotel", "supermarket", "parking"].includes(b)) return "commercial";
  if (["industrial", "warehouse", "factory", "manufacture", "service"].includes(b)) return "industrial";
  if (["school", "university", "college", "hospital", "public", "civic", "government", "kindergarten", "fire_station", "sports_hall", "library"].includes(b)) return "civic";
  // building=yes: by size and where
  const dt = downtown(x, y);
  if (a < 160) return dt > 0.5 && hash01(t.name ?? `${x},${y}`, 3) < 0.35 ? "commercial" : "house";
  if (a < 400) return dt > 0.25 ? "commercial" : hash01(`${x},${y}`, 4) < 0.45 ? "apartments" : "house";
  if (a < 3000) return dt > 0.2 ? "commercial" : hash01(`${x},${y}`, 5) < 0.6 ? "apartments" : "industrial";
  return dt > 0.2 ? "commercial" : "industrial";
}

/** A PLATEAU building's kind from its usage and structure (OSM's tags win where they say more). */
function kindFromPlateau(pl: PlateauBuilding, a: number, x: number, y: number): Kind {
  const u = pl.usage, wooden = WOODEN(pl.structure), low = !(pl.storeys > 2) && !(pl.h > 9.5);
  if (u === "411" || u === "415" || u === "451") return wooden || low ? "house" : "apartments";
  if (u === "413") return wooden || (low && a < 200) ? "house" : "commercial";
  if (u === "412" || u === "414") return wooden && low ? "house" : "apartments";
  if (u === "401" || u === "402" || u === "403" || u === "404") return wooden && low ? "house" : "commercial";
  if (u === "421" || u === "422") return "civic";
  if (u === "431" || u === "441" || u === "452") return a < 40 ? "shed" : "industrial";
  // unknown: by structure and size
  if (wooden) return a < 25 ? "shed" : "house";
  if (CONCRETE(pl.structure)) return downtown(x, y) > 0.3 || a > 300 ? "commercial" : "apartments";
  if (STEEL(pl.structure)) return a > 400 ? "industrial" : a < 30 ? "shed" : low ? "house" : "commercial";
  return a < 25 ? "shed" : a < 160 && low ? "house" : "apartments";
}

/** A building's LOD2 surfaces as they are (its roofs and walls), on our ground. */
function lod2Mesh(w: World, t: TileMesh, pl: PlateauBuilding, ground: number, base: number, wallMat: string, wallCol: RGB, roofMat: string, roofCol: RGB) {
  const [cx, cy] = centroid(pl.rings[0]);
  const up = w.enuAt(cx, cy).u;
  for (const [k, raw] of pl.lod2!) {
    const ring = raw.slice();
    if (ring.length > 1) { const a = ring[0], b = ring[ring.length - 1]; if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) ring.pop(); }
    if (ring.length < 3) continue;
    // Newell normal in the plane
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (ax + ay + az < 1e-6) continue;
    const flat: number[] = [];
    for (const p of ring) { if (az >= ax && az >= ay) flat.push(p[0], p[1]); else if (ax >= ay) flat.push(p[1], p[2]); else flat.push(p[0], p[2]); }
    const tri = earcut(flat);
    const roof = k === "R";
    const pts = ring.map((p) => w.P(p[0], p[1], p[2] < 0.05 ? base : ground + p[2]));
    // walls: u along the wall, v up (metres)
    const hx = ax + ay > 1e-6 ? -ny / Math.hypot(nx, ny) : 1, hy = ax + ay > 1e-6 ? nx / Math.hypot(nx, ny) : 0;
    const uvs = ring.map((p) => [p[0] * hx + p[1] * hy, Math.max(0, p[2])] as [number, number]);
    for (let i = 0; i < tri.length; i += 3) {
      const ids = [tri[i], tri[i + 1], tri[i + 2]];
      if (roof) t.poly(roofMat, ids.map((j) => pts[j]), L(roofCol), undefined, up);
      else t.poly(wallMat, ids.map((j) => pts[j]), L(wallCol), ids.map((j) => uvs[j]), nz > 0.5 * Math.hypot(nx, ny, nz) ? up : undefined);
    }
  }
}

// ------------------------------------------------------------------------------------------------ emitting

/** The axes of a box in ECEF: X along `angle` (plane radians, from east toward north) × length, Y up × height,
 *  Z = X × up × width. */
function axes(w: World, x: number, y: number, angle: number, length: number, height: number, width: number): [V3, V3, V3] {
  const { e, n, u } = w.enuAt(x, y);
  const c = Math.cos(angle), s = Math.sin(angle);
  const X: V3 = [e[0] * c + n[0] * s, e[1] * c + n[1] * s, e[2] * c + n[2] * s];
  const Z = cross(X, u);
  return [[X[0] * length, X[1] * length, X[2] * length], [u[0] * height, u[1] * height, u[2] * height], [Z[0] * width, Z[1] * width, Z[2] * width]];
}

interface BoxRoof { type: "gable" | "hip" | "flat" | "shed"; rise: number; material: string; color: RGB }

/** A box house or block as copies: walls from `base` to `eaves`, then its roof (ridge along `angle`). */
function boxBuilding(w: World, t: TileMesh, cx: number, cy: number, angle: number, length: number, width: number, base: number, eaves: number, wall: RGB, roof: BoxRoof, r: () => number) {
  const [X, Y, Z] = axes(w, cx, cy, angle, length, eaves - base, width);
  // the far level: a pitched house is one copy (walls and roof), tinted by its roof's colour
  if (w.lod && (roof.type === "gable" || roof.type === "hip")) {
    const k0 = roof.rise / Math.max(1, eaves - base);
    let k = HOUSE_K[0];
    for (const v of HOUSE_K) if (Math.abs(v - k0) < Math.abs(k - k0)) k = v;
    let name = `house-gable-${k}`;
    if (roof.type === "hip") {
      const want = Math.max(0, 0.5 - width / (2 * length));
      let best = HIPS[0];
      for (const h of HIPS) if (Math.abs(h - want) < Math.abs(best - want)) best = h;
      name = `house-hip-${best}-${k}`;
    }
    const rc = L(roof.color);
    const tint = rc.map((v, i) => Math.max(0.5, Math.min(2.2, v / FAR_ROOF_LINEAR[i]))) as RGB;
    t.instance(name, X, Y, Z, w.P(cx, cy, base), tint);
    return;
  }
  t.instance("walls", X, Y, Z, w.P(cx, cy, base), L(wall));
  const T = w.P(cx, cy, eaves);
  const mat = roof.material === "roof-tile" ? "" : `:${roof.material}`;
  if (roof.type === "flat") {
    const [Xf, Yf, Zf] = axes(w, cx, cy, angle, length, 0.6 + r() * 0.5, width);
    t.instance("flat", Xf, Yf, Zf, w.P(cx, cy, eaves + 0.15), L(roof.color));
    if (!w.lod) t.instance("parapet", Xf, Yf, Zf, T, L(wall));
    return;
  }
  const [Xr, Yr, Zr] = axes(w, cx, cy, angle, length, roof.rise, width);
  if (roof.type === "gable") {
    t.instance(`gable${mat}`, Xr, Yr, Zr, T, L(roof.color));
    if (!w.lod) t.instance("gable-ends", Xr, Yr, Zr, T, L(wall));
  } else if (roof.type === "shed") {
    t.instance(`shed`, Xr, Yr, Zr, T, L(roof.color));
    if (!w.lod) t.instance("shed-ends", Xr, Yr, Zr, T, L(wall));
  } else {
    const want = Math.max(0, 0.5 - width / (2 * length));
    let best = HIPS[0];
    for (const h of HIPS) if (Math.abs(h - want) < Math.abs(best - want)) best = h;
    t.instance(`hip-${best}${mat}`, Xr, Yr, Zr, T, L(roof.color));
  }
}

/** Plane ring → ECEF ring at a height. */
const ringAt = (w: World, ring: P2[], h: number) => ring.map((p) => w.P(p[0], p[1], h));

/** Walls along every ring (outer and holes) from base to top; u = metres along, v = metres above base. */
function walls(w: World, t: TileMesh, rings: P2[][], base: number, top: number, material: string, col: RGB, vFrom = 0) {
  for (const ring of rings) {
    let u = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      t.poly(material, [w.P(a[0], a[1], base), w.P(b[0], b[1], base), w.P(b[0], b[1], top), w.P(a[0], a[1], top)], L(col), [[u, vFrom], [u + len, vFrom], [u + len, vFrom + top - base], [u, vFrom + top - base]]);
      u += len;
    }
  }
}

/** A flat polygon (with holes) at height h, facing up. */
function cap(w: World, t: TileMesh, rings: P2[][], h: number, material: string, col: RGB) {
  const flat: number[] = [], holes: number[] = [];
  for (const r of rings) { if (flat.length) holes.push(flat.length / 2); for (const p of r) flat.push(p[0], p[1]); }
  const tri = earcut(flat, holes.length ? holes : undefined);
  const up = w.enuAt(flat[0], flat[1]).u;
  for (let i = 0; i < tri.length; i += 3) {
    const pts = [tri[i], tri[i + 1], tri[i + 2]].map((k) => w.P(flat[2 * k], flat[2 * k + 1], h));
    t.poly(material, pts, L(col), [[flat[2 * tri[i]], flat[2 * tri[i] + 1]], [flat[2 * tri[i + 1]], flat[2 * tri[i + 1] + 1]], [flat[2 * tri[i + 2]], flat[2 * tri[i + 2] + 1]]], up);
  }
}

/** A hipped roof over any ring: inset rings rising at `pitch`, a flat top where the inset stops. */
function insetRoof(w: World, t: TileMesh, ring: P2[], eaves: number, pitch: number, material: string, col: RGB, maxD: number): boolean {
  for (const f of [1, 0.7, 0.45, 0.3]) {
    const d = maxD * f;
    const inner = inset(ring, d);
    if (!inner) continue;
    const top = eaves + d * Math.tan(pitch);
    const up = w.enuAt(ring[0][0], ring[0][1]).u;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      t.poly(material, [w.P(ring[i][0], ring[i][1], eaves), w.P(ring[j][0], ring[j][1], eaves), w.P(inner[j][0], inner[j][1], top), w.P(inner[i][0], inner[i][1], top)], L(col), undefined, up);
    }
    cap(w, t, [inner], top, material, col);
    return true;
  }
  return false;
}

/** Plant rooms and tanks on a flat roof: kit boxes inside the footprint. */
function rooftop(w: World, t: TileMesh, ring: P2[], o: Obb, top: number, a: number, r: () => number, wallCol: RGB) {
  if (w.lod) return;
  const n = a < 200 ? (r() < 0.6 ? 1 : 0) : a < 800 ? 1 + Math.floor(r() * 2) : 2 + Math.floor(r() * 3);
  const c = Math.cos(o.angle), s = Math.sin(o.angle);
  for (let k = 0; k < n; k++) {
    const bl = Math.min(o.length * 0.45, 2.5 + r() * 7), bw = Math.min(o.width * 0.45, 2 + r() * 5), bh = 2.2 + r() * 1.8;
    const u = (r() - 0.5) * (o.length - bl - 2), v = (r() - 0.5) * (o.width - bw - 2);
    const x = o.cx + u * c - v * s, y = o.cy + u * s + v * c;
    if (!pointInRing(x, y, ring)) continue;
    const col = k === 0 ? mix(wallCol, [200, 200, 196], 0.5) : pick([[180, 180, 176], [120, 124, 128], [200, 200, 200], [90, 96, 100]] as RGB[], r());
    const [X, Y, Z] = axes(w, x, y, o.angle, bl, bh, bw);
    t.instance("walls", X, Y, Z, w.P(x, y, top), L(col));
    const [Xf, , Zf] = axes(w, x, y, o.angle, bl, 1, bw);
    t.instance("flat", Xf, Y, Zf, w.P(x, y, top + bh), L(mix(col, [150, 150, 150], 0.5)));
  }
}

// ------------------------------------------------------------------------------------------------ temples, pagodas

/** A hip-and-gable (irimoya) roof on a rectangle, with eaves that sweep up toward the corners (sori). */
function irimoya(w: World, t: TileMesh, o: Obb, eaves: number, total: number, overhang: number, material: string, roofCol: RGB, gableCol: RGB) {
  const hl = o.length / 2 + overhang, hw = o.width / 2 + overhang;
  const lift = 0.05 * o.width + 0.2; // sori at the corners
  const bz = hw * 0.42, bx = hl - (hw - bz);
  const breakH = eaves + (hw - bz) * Math.tan((27 * Math.PI) / 180);
  const ridgeH = Math.max(breakH + 0.5, Math.min(total, breakH + bz * Math.tan((45 * Math.PI) / 180)));
  const c = Math.cos(o.angle), s = Math.sin(o.angle);
  const at = (u: number, v: number, h: number) => w.P(o.cx + u * c - v * s, o.cy + u * s + v * c, h);
  const up = w.enuAt(o.cx, o.cy).u;
  const SEG = 6;
  const eaveH = (f: number) => eaves + lift * Math.abs(f) ** 3; // f in −1..1 along an edge
  // the four lower slopes: from the eave edge (lifted at its ends) to the break rectangle
  const edges: [number, number, number, number, number, number, number, number][] = [
    // eave from (u0,v0) to (u1,v1); break from (p0,q0) to (p1,q1)
    [-hl, -hw, hl, -hw, -bx, -bz, bx, -bz],
    [hl, -hw, hl, hw, bx, -bz, bx, bz],
    [hl, hw, -hl, hw, bx, bz, -bx, bz],
    [-hl, hw, -hl, -hw, -bx, bz, -bx, -bz],
  ];
  for (const [u0, v0, u1, v1, p0, q0, p1, q1] of edges) {
    for (let k = 0; k < SEG; k++) {
      const f0 = k / SEG, f1 = (k + 1) / SEG;
      const e0 = at(u0 + (u1 - u0) * f0, v0 + (v1 - v0) * f0, eaveH(f0 * 2 - 1)), e1 = at(u0 + (u1 - u0) * f1, v0 + (v1 - v0) * f1, eaveH(f1 * 2 - 1));
      const b0 = at(p0 + (p1 - p0) * f0, q0 + (q1 - q0) * f0, breakH), b1 = at(p0 + (p1 - p0) * f1, q0 + (q1 - q0) * f1, breakH);
      t.poly(material, [e0, e1, b1, b0], L(roofCol), undefined, up);
    }
  }
  // the upper gable roof: two slopes to the ridge, the two gable triangles (wood and plaster)
  t.poly(material, [at(-bx, -bz, breakH), at(bx, -bz, breakH), at(bx, 0, ridgeH), at(-bx, 0, ridgeH)], L(roofCol), undefined, up);
  t.poly(material, [at(bx, bz, breakH), at(-bx, bz, breakH), at(-bx, 0, ridgeH), at(bx, 0, ridgeH)], L(roofCol), undefined, up);
  t.poly("wood", [at(bx * 0.97, -bz, breakH), at(bx * 0.97, bz, breakH), at(bx * 0.97, 0, ridgeH)], L(gableCol));
  t.poly("wood", [at(-bx * 0.97, bz, breakH), at(-bx * 0.97, -bz, breakH), at(-bx * 0.97, 0, ridgeH)], L(gableCol));
  // the ridge: a dark beam with raised ends
  const rw = Math.max(0.3, o.width * 0.025), rh = Math.max(0.4, o.width * 0.035);
  const rb = (u: number) => [at(u, -rw, ridgeH - 0.05), at(u, rw, ridgeH - 0.05), at(u, rw, ridgeH + rh), at(u, -rw, ridgeH + rh)];
  const A = rb(-bx - 0.3), B = rb(bx + 0.3);
  const ridgeCol = mix(roofCol, [40, 40, 44], 0.5);
  t.poly(material, [A[3], A[2], B[2], B[3]], L(ridgeCol), undefined, up);
  t.poly(material, [A[0], A[3], B[3], B[0]], L(ridgeCol));
  t.poly(material, [B[1], B[2], A[2], A[1]], L(ridgeCol));
  return ridgeH + rh;
}

/** A pagoda of `tiers` storeys: shrinking bodies under wide sweeping roofs, the finial (sōrin) on top. */
function pagoda(w: World, t: TileMesh, cx: number, cy: number, angle: number, side: number, base: number, height: number, tiers: number, bodyCol: RGB) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const at = (u: number, v: number, h: number) => w.P(cx + u * c - v * s, cy + u * s + v * c, h);
  const up = w.enuAt(cx, cy).u;
  const spire = height * 0.27, bodyTop = height - spire;
  // a stone platform
  const ph = 1.0, pw = side * 0.75;
  boxMesh(t, at, -pw, -pw, pw, pw, base - 1, base + ph, "stone", STONE);
  const tierH = (bodyTop - base - ph) / tiers;
  let h = base + ph;
  for (let k = 0; k < tiers; k++) {
    const b = (side / 2) * (1 - (0.38 * k) / Math.max(1, tiers - 1)); // half-side of this storey's body
    const bodyH = tierH * 0.55;
    boxMesh(t, at, -b, -b, b, b, h, h + bodyH, "lacquer", bodyCol, true);
    // the roof: from a wide eave square (corners lifted) up to the next body
    const r = b + side * 0.42, rise = tierH * 0.45, lift = side * 0.08;
    const top = (side / 2) * (1 - (0.38 * Math.min(tiers - 1, k + 1)) / Math.max(1, tiers - 1)) * 0.8;
    const eh = h + bodyH;
    const SEG = 4;
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let e = 0; e < 4; e++) {
      const [a0, a1] = corners[e], [b0, b1] = corners[(e + 1) % 4];
      for (let q = 0; q < SEG; q++) {
        const f0 = q / SEG, f1 = (q + 1) / SEG;
        const lf = (f: number) => lift * Math.abs(f * 2 - 1) ** 2.5;
        const E0 = at(r * (a0 + (b0 - a0) * f0), r * (a1 + (b1 - a1) * f0), eh + lf(f0)), E1 = at(r * (a0 + (b0 - a0) * f1), r * (a1 + (b1 - a1) * f1), eh + lf(f1));
        const T0 = at(top * (a0 + (b0 - a0) * f0), top * (a1 + (b1 - a1) * f0), eh + rise), T1 = at(top * (a0 + (b0 - a0) * f1), top * (a1 + (b1 - a1) * f1), eh + rise);
        t.poly("roof-tile", [E0, E1, T1, T0], L(TEMPLE_ROOF[0]), undefined, up);
        // the eave's thickness, seen from the side
        t.poly("wood", [at(r * (a0 + (b0 - a0) * f0), r * (a1 + (b1 - a1) * f0), eh + lf(f0) - 0.45), at(r * (a0 + (b0 - a0) * f1), r * (a1 + (b1 - a1) * f1), eh + lf(f1) - 0.45), E1, E0], L(mix(bodyCol, [40, 30, 25], 0.5)));
      }
    }
    h = eh + rise;
    if (k === tiers - 1) cap(w, t, [[[-top, -top], [top, -top], [top, top], [-top, top]].map(([u, v]) => { const p = at(u, v, 0); void p; return [cx + u * c - v * s, cy + u * s + v * c] as P2; })], h, "roof-tile", TEMPLE_ROOF[0]);
  }
  // the finial: a bronze mast with rings
  const m = Math.max(0.25, side * 0.035);
  boxMesh(t, at, -m, -m, m, m, h, h + spire, "bronze", [150, 120, 70]);
  for (let k = 0; k < 9; k++) {
    const rr = m * 3.2 * (1 - k * 0.04), hh = h + spire * (0.15 + k * 0.07);
    boxMesh(t, at, -rr, -rr, rr, rr, hh, hh + spire * 0.02, "bronze", [150, 120, 70]);
  }
}

/** A box as a mesh (sides and top) between two corners in a local (u, v) frame. */
function boxMesh(t: TileMesh, at: (u: number, v: number, h: number) => V3, u0: number, v0: number, u1: number, v1: number, h0: number, h1: number, material: string, col: RGB, noTop = false) {
  const q = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  const cl = L(col);
  for (let i = 0; i < 4; i++) {
    const [a, b] = [q[i], q[(i + 1) % 4]];
    t.poly(material, [at(a[0], a[1], h0), at(b[0], b[1], h0), at(b[0], b[1], h1), at(a[0], a[1], h1)], cl);
  }
  if (!noTop) {
    const c0 = at(u0, v0, h1), c1 = at(u1, v0, h1), c2 = at(u1, v1, h1), c3 = at(u0, v1, h1);
    const up = sub(at((u0 + u1) / 2, (v0 + v1) / 2, h1 + 1), at((u0 + u1) / 2, (v0 + v1) / 2, h1));
    t.poly(material, [c0, c1, c2, c3], cl, undefined, up);
  }
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Kyoto Tower: a white tapering cylinder from the hotel's roof to 131 m, the observation deck, the red top. */
function kyotoTower(w: World, t: TileMesh, cx: number, cy: number, base: number) {
  const SIDES = 20, up = w.enuAt(cx, cy).u;
  const ring = (r: number, h: number) => Array.from({ length: SIDES }, (_, i) => { const a = (i / SIDES) * Math.PI * 2; return w.P(cx + Math.cos(a) * r, cy + Math.sin(a) * r, h); });
  const band = (r0: number, h0: number, r1: number, h1: number, material: string, col: RGB) => {
    const A = ring(r0, h0), B = ring(r1, h1);
    for (let i = 0; i < SIDES; i++) { const j = (i + 1) % SIDES; t.poly(material, [A[i], A[j], B[j], B[i]], L(col)); }
  };
  const disc = (r: number, h: number, material: string, col: RGB) => { const A = ring(r, h); t.poly(material, A, L(col), undefined, up); };
  const white: RGB = [238, 238, 232], red: RGB = [200, 40, 36];
  // the shaft, flared at its foot (the hotel's roof at base)
  band(8.5, base, 6.2, base + 12, "paint", white);
  band(6.2, base + 12, 4.6, base + 58, "paint", white);
  // the observation deck: a drum with a band of glass
  band(4.6, base + 58, 7.6, base + 63, "paint", white);
  band(7.6, base + 63, 7.6, base + 66, "paint", white);
  band(7.8, base + 66, 7.8, base + 71, "glass", [40, 52, 60]);
  band(7.6, base + 71, 7.2, base + 74, "paint", white);
  disc(7.2, base + 74, "paint", white);
  // the top: a slimmer drum, a red band, the antenna
  band(3.6, base + 74, 3.4, base + 86, "paint", white);
  band(3.4, base + 86, 3.2, base + 89, "paint", red);
  band(3.2, base + 89, 1.0, base + 92, "paint", white);
  band(0.5, base + 92, 0.25, base + 100.5, "paint", red);
}

// ------------------------------------------------------------------------------------------------ the pass

export function buildBuildings(w: World, features: Feature[], plateau: PlateauBuilding[] = []) {
  // OSM outlines, to give PLATEAU's buildings their tags (names, temples, shrines, pagodas) and to fill in where
  // PLATEAU has nothing (outside Kyoto city)
  type O = { f: Feature; poly: P2[][]; ring: P2[]; c: P2; used: boolean };
  const osm: O[] = [];
  const og = new Grid<O>(60);
  for (const f of features) {
    if (f.t["building:part"] && !f.t.building) continue;
    for (const poly of f.rings) {
      const ring = cleanRing(poly[0]);
      if (ring.length < 3) continue;
      const o: O = { f, poly, ring, c: centroid(ring), used: false };
      osm.push(o);
      og.add(Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1])), o);
    }
  }
  const pg = new Grid<PlateauBuilding>(60);
  for (const pl of plateau) {
    const r = pl.rings[0];
    pg.add(Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1])), Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1])), pl);
  }
  for (const pl of plateau) {
    const c = centroid(pl.rings[0]);
    let tags: Record<string, string> | null = null, best = Infinity;
    for (const o of og.near(c[0], c[1])) {
      if (!pointInRing(c[0], c[1], o.ring)) continue;
      o.used = true;
      // the smallest outline holding it (a part before the whole)
      const a = Math.abs(area(o.ring));
      if (a < best) { best = a; tags = o.f.t; }
    }
    one(w, { id: pl.id, t: tags ?? { building: "yes" }, rings: [pl.rings] }, pl.rings, undefined, pl);
  }
  for (const o of osm) {
    if (o.used) continue;
    if (pg.near(o.c[0], o.c[1]).some((pl) => pointInRing(o.c[0], o.c[1], pl.rings[0]))) continue;
    o.used = true;
    one(w, o.f, o.poly);
  }
}

function one(w: World, f: Feature, poly: P2[][], parent?: Record<string, string>, pl?: PlateauBuilding) {
  const ring = cleanRing(poly[0]);
  if (ring.length < 3) return;
  const holes = poly.slice(1).map((h) => cleanRing(h, false)).filter((h) => h.length >= 3);
  const a = Math.abs(area(ring));
  if (a < (w.lod ? 20 : 6)) return;
  const [cx, cy] = centroid(ring);
  if (!w.inBounds(cx, cy)) return;
  const t0 = { ...(parent ?? {}), ...f.t };
  if (t0.location === "underground" || Number(t0.layer) < 0) return;
  const r = rng(Math.floor(hash01(f.id + ring.length) * 4294967296));
  const precinct = w.precinctAt(cx, cy);
  let kind = kindOf(t0, precinct, a, cx, cy);
  if (pl && (!t0.building || t0.building === "yes" || t0.building === "residential" || t0.building === "house" || t0.building === "apartments" || t0.building === "commercial" || t0.building === "retail") && ["house", "apartments", "commercial", "industrial", "civic", "shed"].includes(kind)) kind = kindFromPlateau(pl, a, cx, cy);
  const o = obb(ring);
  const fill = a / (o.length * o.width);
  const base = w.ground.lowest(ring) - 0.3;
  const ground = w.ground.height(cx, cy);
  const t = w.tileAt(cx, cy);
  w.footprints.add(Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1])), ring);
  w.stats.buildings++;

  let lv = num(t0["building:levels"]), tagH = num(t0.height);
  const minH = num(t0.min_height);
  if (pl) {
    if (pl.h > 1.5 && pl.h < 300) tagH = pl.h;
    if (!Number.isFinite(lv) && pl.storeys > 0) lv = pl.storeys;
  }
  const roofShape = t0["roof:shape"];
  const dt = downtown(cx, cy);
  const rectish = fill > 0.86 && holes.length === 0;

  // ---- Kyoto Tower, on its hotel
  if (Math.hypot(cx - KYOTO_TOWER[0], cy - KYOTO_TOWER[1]) < 25 && /京都タワーホテル|Kyoto Tower Hotel$/.test(t0.name ?? t0["name:en"] ?? "")) {
    const top = ground + 31;
    walls(w, t, [ring], base, top, "facade", [228, 228, 222]);
    cap(w, t, [ring], top, "roof-flat", [180, 180, 176]);
    kyotoTower(w, t, KYOTO_TOWER[0], KYOTO_TOWER[1], top);
    w.stats.unique++;
    return;
  }
  // ---- pagodas
  if (kind === "pagoda") {
    const name = t0.name ?? "";
    const tiers = /五重/.test(name) ? 5 : /三重/.test(name) ? 3 : /多宝/.test(name) ? 2 : Number.isFinite(lv) ? Math.max(2, Math.min(7, lv)) : 3;
    const H = Number.isFinite(tagH) ? tagH : tiers === 5 ? 38 : tiers === 3 ? 25 : 16;
    const body: RGB = /清水|Kiyomizu|子安/.test(name + (t0["name:en"] ?? "")) || (precinct?.name && /清水/.test(precinct.name)) ? VERMILION : [92, 60, 42];
    pagoda(w, t, cx, cy, o.angle, Math.max(4, Math.min(o.width, o.length) * 0.95), ground, ground + H, tiers, body);
    w.stats.pagodas++; w.stats.unique++;
    return;
  }
  // ---- temple halls and gates
  if (kind === "temple" || kind === "gate" || (kind === "shrine" && a > 250 && precinct?.religion !== "shinto")) {
    const H = Number.isFinite(tagH) ? tagH : Math.min(34, Math.max(6, 3 + Math.sqrt(a) * 0.55));
    const big = a > 350;
    const eaves = ground + (Number.isFinite(lv) && lv >= 2 && kind === "gate" ? H * 0.5 : H * (big ? 0.36 : 0.44));
    const ov = Math.min(5, Math.max(1, 0.1 * o.width + 0.6));
    const wallCol: RGB = r() < 0.5 ? TEMPLE_WOOD : mix(TEMPLE_WOOD, PLASTER, 0.25);
    if (fill > 0.7 && a > 25) {
      const p = 0.4 + Math.min(0.6, a / 2000);
      // stone platform, walls, then the roof
      boxMeshPlane(w, t, o, base, ground + p, 0.6, "stone", STONE);
      boxMeshPlane(w, t, o, ground + p, eaves, 0, "wood", wallCol, true);
      irimoya(w, t, o, eaves, ground + H, ov, "roof-tile", pick(TEMPLE_ROOF, r()), wallCol);
    } else {
      walls(w, t, [ring], base, eaves, "wood", wallCol);
      if (!insetRoof(w, t, ring, eaves, (32 * Math.PI) / 180, "roof-tile", pick(TEMPLE_ROOF, r()), Math.min(o.width * 0.45, 6))) cap(w, t, [ring], eaves, "roof-tile", pick(TEMPLE_ROOF, r()));
    }
    w.stats.temples++; w.stats.unique++;
    return;
  }
  // ---- shrines: vermilion and wood under bark or copper roofs
  if (kind === "shrine") {
    const H = Number.isFinite(tagH) ? tagH : Math.min(16, Math.max(4.5, 2.5 + Math.sqrt(a) * 0.5));
    const eaves = ground + H * 0.5;
    const roofCol = a > 120 && r() < 0.5 ? COPPER : r() < 0.6 ? BARK_ROOF : COPPER;
    const roofMat = roofCol === COPPER ? "roof-copper" : "roof-bark";
    const wallCol = r() < 0.65 ? VERMILION : [120, 84, 58] as RGB;
    if (fill > 0.7) {
      const ov = Math.min(3, 0.12 * o.width + 0.5);
      boxMeshPlane(w, t, o, base, eaves, 0, "lacquer", wallCol, true);
      if (a > 150) irimoya(w, t, o, eaves, ground + H, ov, roofMat, roofCol, wallCol);
      else boxBuilding(w, t, o.cx, o.cy, o.angle, o.length + ov * 2, o.width + ov * 2, eaves, eaves, wallCol, { type: "gable", rise: H - (eaves - ground), material: roofMat, color: roofCol }, r);
    } else {
      walls(w, t, [ring], base, eaves, "lacquer", wallCol);
      if (!insetRoof(w, t, ring, eaves, (30 * Math.PI) / 180, roofMat, roofCol, Math.min(o.width * 0.45, 4))) cap(w, t, [ring], eaves, roofMat, roofCol);
    }
    w.stats.shrines++; w.stats.unique++;
    return;
  }

  // ---- everything else: height and roof
  let levels = Number.isFinite(lv) ? lv : NaN;
  let roof: "gable" | "hip" | "flat" | "shed" | "inset" = "flat";
  let wallCol: RGB, roofCol: RGB, roofMat = "roof-tile";
  let wallMat = "wall";
  let H: number;
  switch (kind) {
    case "house":
    case "machiya": {
      if (!Number.isFinite(levels)) levels = r() < (dt > 0.3 ? 0.1 : 0.22) ? 1 : r() < 0.93 ? 2 : 3;
      H = Number.isFinite(tagH) ? tagH : levels * 2.9 + 0.4;
      const u = r();
      if (inMachiyaArea(cx, cy)) { roofCol = u < 0.82 ? pick(KAWARA, r()) : u < 0.94 ? pick(SLATE, r()) : pick(METAL, r()); }
      else { roofCol = u < 0.55 ? pick(KAWARA, r()) : u < 0.85 ? pick(SLATE, r()) : pick(METAL, r()); }
      if (METAL.includes(roofCol)) roofMat = "roof-metal";
      wallCol = pick(HOUSE_WALL, r());
      roof = roofShape === "flat" || levels >= 4 ? "flat" : roofShape === "hipped" || roofShape === "pyramidal" ? "hip" : roofShape === "gabled" ? "gable" : roofShape === "skillion" ? "shed" : r() < 0.62 ? "gable" : "hip";
      if (a > 220 && roof !== "flat" && r() < 0.3) roof = "flat";
      break;
    }
    case "apartments":
      if (!Number.isFinite(levels)) levels = Math.round(3 + r() * 3 + dt * 5);
      H = Number.isFinite(tagH) ? tagH : levels * 3.0 + 0.6;
      wallCol = pick(MODERN_WALL, r()); roofCol = pick(FLAT_ROOF, r()); roof = "flat"; wallMat = "facade";
      if (levels <= 2 && a < 300) { roof = r() < 0.5 ? "gable" : "hip"; roofCol = pick(SLATE, r()); wallMat = "wall"; }
      break;
    case "commercial":
    case "station":
      if (!Number.isFinite(levels)) levels = Math.max(2, Math.round(2 + r() * 2 + dt * (4 + r() * 5)));
      H = Number.isFinite(tagH) ? tagH : levels * 3.6 + 0.8;
      wallCol = pick(MODERN_WALL, r()); roofCol = pick(FLAT_ROOF, r()); roof = "flat"; wallMat = levels >= 3 ? "facade" : "wall";
      if (levels <= 2 && a < 160 && dt < 0.6) { roof = "gable"; roofCol = pick(KAWARA.concat(SLATE), r()); }
      break;
    case "civic":
      if (!Number.isFinite(levels)) levels = 3 + Math.floor(r() * 2);
      H = Number.isFinite(tagH) ? tagH : levels * 3.8 + 0.8;
      wallCol = pick([[222, 218, 208], [200, 196, 188], [190, 170, 150]] as RGB[], r()); roofCol = pick(FLAT_ROOF, r()); roof = "flat"; wallMat = "facade";
      break;
    case "industrial":
      if (!Number.isFinite(levels)) levels = 1 + Math.floor(r() * 2);
      H = Number.isFinite(tagH) ? tagH : Math.max(6, levels * 4.5);
      wallCol = pick([[180, 182, 180], [150, 156, 160], [200, 198, 190], [120, 130, 140]] as RGB[], r()); roofCol = pick(METAL, r()); roofMat = "roof-metal";
      roof = a > 500 && r() < 0.6 ? "gable" : "flat";
      break;
    case "shed":
      H = Number.isFinite(tagH) ? tagH : 2.6;
      wallCol = pick([[160, 160, 156], [120, 110, 100], [190, 190, 186]] as RGB[], r()); roofCol = pick(METAL, r()); roofMat = "roof-metal";
      roof = r() < 0.5 ? "shed" : "gable";
      break;
    case "roof":
      // a roof on posts (car ports, station canopies): the roof alone, high
      H = Number.isFinite(tagH) ? tagH : 3.2;
      cap(w, t, [ring, ...holes], ground + H, "roof-metal", pick(METAL, r()));
      w.stats.unique++;
      return;
  }
  // ---- PLATEAU: the structure says pitched or flat where LOD2 does not; LOD2's roof where it does
  const fit = pl?.fit;
  if (pl) {
    const wooden = WOODEN(pl.structure);
    const old = pl.year < 1960;
    if (fit && fit.form === "flat") roof = "flat";
    else if (fit && (fit.form === "gable" || fit.form === "hip")) roof = fit.form;
    else if (!fit && wooden && roof === "flat" && !(levels > 3)) roof = r() < 0.6 ? "gable" : "hip";
    else if (!fit && CONCRETE(pl.structure) && roof !== "flat" && a > 80) roof = "flat";
    const pitched = roof !== "flat";
    if (pitched && FLAT_ROOF.includes(roofCol!)) {
      roofCol = wooden ? (old || r() < 0.6 ? pick(KAWARA, r()) : pick(SLATE, r())) : STEEL(pl.structure) ? pick(METAL, r()) : pick(SLATE.concat(KAWARA), r());
      roofMat = METAL.includes(roofCol) ? "roof-metal" : "roof-tile";
      if (wooden) { wallCol = pick(HOUSE_WALL, r()); wallMat = "wall"; }
    }
    if (pitched && wooden && old && roofMat === "roof-tile" && !KAWARA.includes(roofCol!)) roofCol = pick(KAWARA, r());
    if (pitched && wooden && old && inMachiyaArea(cx, cy) && r() < 0.6) wallCol = pick(MACHIYA_WALL, r());
    if (!pitched && FLAT_ROOF.indexOf(roofCol!) < 0) { roofCol = pick(FLAT_ROOF, r()); roofMat = "roof-tile"; }
  }
  const top = ground + H!;
  const bottom = Number.isFinite(minH) ? ground + minH : base;

  // ---- LOD2 roofs too complex for the kit: the surfaces themselves
  if (pl?.lod2 && fit && !w.lod && (fit.form === "complex" || ((fit.form === "gable" || fit.form === "hip") && !rectish))) {
    lod2Mesh(w, t, pl, ground, base, wallMat, wallCol!, roof === "flat" ? "roof-flat" : roofMat, roofCol!);
    w.stats.unique++;
    return;
  }
  // ---- LOD2's gabled and hipped roofs on near-rectangles: kit copies along the real ridge, at the real heights
  if (fit && (fit.form === "gable" || fit.form === "hip") && (rectish || w.lod)) {
    const c = Math.cos(fit.ridge), s = Math.sin(fit.ridge);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) { const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
    const eaves = Math.max(bottom + 2.2, ground + fit.eaves);
    const rise = Math.max(0.4, Math.min(u1 - u0, v1 - v0, ground + fit.top - eaves));
    boxBuilding(w, t, mu * c - mv * s, mu * s + mv * c, fit.ridge, u1 - u0, v1 - v0, bottom, eaves, wallCol!, { type: fit.form, rise, material: roofMat, color: roofCol! }, r);
    w.stats.instanced++;
    return;
  }

  // ---- machiya: a deep narrow townhouse in the old town, its ridge along the street
  if ((kind === "house" || kind === "machiya") && rectish && o.width < 9 && o.length / o.width > 1.6 && inMachiyaArea(cx, cy) && !roofShape && levels <= 2 && !fit) {
    const c = Math.cos(o.angle), s = Math.sin(o.angle);
    // which short end faces the street
    const endA: P2 = [o.cx + (c * o.length) / 2, o.cy + (s * o.length) / 2], endB: P2 = [o.cx - (c * o.length) / 2, o.cy - (s * o.length) / 2];
    const ra = w.nearestRoad(endA[0], endA[1], 30), rb = w.nearestRoad(endB[0], endB[1], 30);
    const dir = (ra?.d ?? 99) <= (rb?.d ?? 99) ? 1 : -1;
    const frontD = Math.min(o.length * 0.55, 10 + r() * 2);
    const backD = o.length - frontD;
    const wc = r() < 0.7 ? pick(MACHIYA_WALL, r()) : wallCol!;
    const kaw = pick(KAWARA, r());
    // the front house: two low storeys, the ridge across the lot (along the street)
    const fx = o.cx + dir * c * (o.length / 2 - frontD / 2), fy = o.cy + dir * s * (o.length / 2 - frontD / 2);
    const fe = ground + (r() < 0.6 ? 5.4 : 6.2);
    boxBuilding(w, t, fx, fy, o.angle + Math.PI / 2, o.width, frontD, base, fe, wc, { type: "gable", rise: frontD * 0.5 * 0.42, material: "roof-tile", color: kaw }, r);
    // the back: a lower wing (and a garden between, sometimes)
    if (backD > 2.5) {
      const gap = backD > 9 && r() < 0.5 ? 3 + r() * 2 : 0;
      const bd = backD - gap;
      const bx = o.cx - dir * c * (o.length / 2 - bd / 2), by = o.cy - dir * s * (o.length / 2 - bd / 2);
      const be = ground + (r() < 0.5 ? 3.4 : 5.6);
      boxBuilding(w, t, bx, by, o.angle + Math.PI / 2, o.width, bd, base, be, wc, { type: "gable", rise: Math.min(bd, o.width) * 0.5 * 0.4, material: "roof-tile", color: jitter(kaw, 0.06, r) }, r);
    }
    w.stats.instanced++;
    return;
  }

  // ---- box houses and blocks: kit copies
  const rise = (roof === "gable" || roof === "hip" ? o.width * 0.5 * (0.38 + r() * 0.14) : roof === "shed" ? o.width * 0.18 : 0);
  if (rectish && roof !== "inset") {
    const eaves = roof === "flat" ? top : Math.max(bottom + 2.2, top - rise * 0.4);
    if (roof === "flat") {
      boxBuilding(w, t, o.cx, o.cy, o.angle, o.length, o.width, bottom, eaves, wallCol!, { type: "flat", rise: 0, material: "roof-flat", color: roofCol! }, r);
      if (H! > 7 && a > 60) rooftop(w, t, ring, o, eaves + 0.15, a, r, wallCol!);
    } else boxBuilding(w, t, o.cx, o.cy, o.angle, o.length, o.width, bottom, eaves, wallCol!, { type: roof, rise, material: roofMat, color: roofCol! }, r);
    w.stats.instanced++;
    return;
  }
  // ---- other shapes: meshes
  const all = [ring, ...holes];
  if (roof === "flat" || holes.length || a > 600) {
    walls(w, t, all, bottom, top + (w.lod ? 0 : 0.9), wallMat, wallCol!);
    cap(w, t, all, top, "roof-flat", roofCol!);
    const inner = w.lod ? null : inset(ring, 0.35);
    if (inner) {
      walls(w, t, [inner.slice().reverse()], top, top + 0.9, "wall", wallCol!);
      // the parapet's top
      const up = w.enuAt(cx, cy).u;
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        t.poly("wall", [w.P(ring[i][0], ring[i][1], top + 0.9), w.P(ring[j][0], ring[j][1], top + 0.9), w.P(inner[j][0], inner[j][1], top + 0.9), w.P(inner[i][0], inner[i][1], top + 0.9)], L(mix(wallCol!, [200, 200, 200], 0.3)), undefined, up);
      }
    }
    if (H! > 7 && a > 60) rooftop(w, t, ring, o, top, a, r, wallCol!);
  } else {
    const eaves = top - Math.min(o.width * 0.45, 4) * 0.45 * 0.6;
    walls(w, t, [ring], bottom, eaves, wallMat, wallCol!);
    if (!insetRoof(w, t, ring, eaves, (24 * Math.PI) / 180, roofMat, roofCol!, Math.min(o.width * 0.45, 4.5))) cap(w, t, [ring], eaves, roofMat, roofCol!);
  }
  w.stats.unique++;
}

/** A box on an OBB as a mesh (optionally grown by `grow` m), sides and (unless noTop) top. */
function boxMeshPlane(w: World, t: TileMesh, o: Obb, h0: number, h1: number, grow: number, material: string, col: RGB, noTop = false) {
  const c = Math.cos(o.angle), s = Math.sin(o.angle);
  const at = (u: number, v: number, h: number) => w.P(o.cx + u * c - v * s, o.cy + u * s + v * c, h);
  const hl = o.length / 2 + grow, hw = o.width / 2 + grow;
  boxMesh(t, at, -hl, -hw, hl, hw, h0, h1, material, col, noTop);
}

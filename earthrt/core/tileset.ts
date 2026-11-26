// A city's tiles (SPEC § 5, `tiles` content): `earthrt/tileset@2`, GLB tiles in the place's frame, a quadtree of
// levels refined by screen-space error (replace: a tile, or all of its children). Its type, its check, and which
// tiles a view shows.

export interface TilesetMaterial {
  roughness: number;
  metalness?: number;
  doubleSided?: boolean;
  /** what a host may add: `windows` (façade windows by storey, uv in metres), `water`, `foliage` (SPEC § 5) */
  surface?: Record<string, unknown>;
  note?: string;
}

export interface TilesetTile {
  /** the tile's quadtree key, `z/x/y` (Web Mercator) */
  key: string;
  /** the GLB, relative to tileset.json (or `@release/<tag>/<asset>`) */
  uri: string;
  /** bounding sphere in the place's frame (x east, y up, z south, m) */
  center: [number, number, number];
  radius: number;
  /** geometric error, m: what the tile leaves out of its children */
  error: number;
  bytes?: number;
  tris?: number;
  instances?: number;
  /** keys of the tiles that replace it when the view asks for more */
  children?: string[];
}

export interface Tileset {
  format: "earthrt/tileset@2";
  frame: "place";
  /** the trunk terrain the tiles stand on (draped on its triangles at this zoom) */
  ground?: { layer: "terrain"; gen: string; zoom: number };
  levels?: { zoom: number; error: number }[];
  /** the coarsest tiles: shown first */
  root: string[];
  materials: Record<string, TilesetMaterial>;
  tiles: TilesetTile[];
  [extra: string]: unknown;
}

const KEY = /^\d{1,2}\/\d{1,9}\/\d{1,9}$/;
const REL = (p: unknown) => typeof p === "string" && p.length > 0 && p.length < 512 && !p.startsWith("/") && !p.split("/").includes("..") && !/^[a-z]+:/i.test(p) && !p.includes("\\");
const num = (v: unknown, lo = -Infinity, hi = Infinity) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** Problems with a tileset (empty: it is valid). */
export function validateTileset(t: unknown): string[] {
  const e: string[] = [];
  const o = t as Partial<Tileset> | null;
  if (!o || typeof o !== "object") return ["not an object"];
  if (o.format !== "earthrt/tileset@2") e.push(`format must be "earthrt/tileset@2"`);
  if (o.frame !== "place") e.push(`frame must be "place"`);
  if (!o.materials || typeof o.materials !== "object") e.push("materials: { name: { roughness, … } }");
  else for (const [k, m] of Object.entries(o.materials)) if (!m || !num(m.roughness, 0, 1) || (m.metalness !== undefined && !num(m.metalness, 0, 1))) e.push(`materials.${k}: roughness (and metalness) 0..1`);
  if (!Array.isArray(o.tiles) || o.tiles.length === 0 || o.tiles.length > 100_000) { e.push("tiles: 1-100000 entries"); return e; }
  const keys = new Set<string>();
  o.tiles.forEach((x, i) => {
    if (!x || typeof x.key !== "string" || !KEY.test(x.key)) { e.push(`tiles[${i}].key: z/x/y`); return; }
    if (keys.has(x.key)) e.push(`tiles[${i}].key: ${x.key} twice`);
    keys.add(x.key);
    if (!REL(x.uri) || !/\.glb$/i.test(x.uri)) e.push(`tiles[${i}].uri: a relative path to a .glb`);
    if (!Array.isArray(x.center) || x.center.length !== 3 || !x.center.every((v) => num(v, -1e6, 1e6))) e.push(`tiles[${i}].center: [x, y, z] in the place's frame`);
    if (!num(x.radius, 0, 1e6)) e.push(`tiles[${i}].radius: m`);
    if (!num(x.error, 0, 1e5)) e.push(`tiles[${i}].error: m`);
  });
  for (const x of o.tiles) for (const c of x.children ?? []) if (!keys.has(c)) e.push(`${x.key}: child ${c} is not a tile`);
  if (!Array.isArray(o.root) || o.root.length === 0) e.push("root: the coarsest tiles' keys");
  else for (const r of o.root) if (!keys.has(r)) e.push(`root: ${r} is not a tile`);
  return e;
}

export interface TileView {
  /** the camera in the place's frame */
  position: [number, number, number];
  /** vertical field of view, radians */
  fov: number;
  /** viewport height, px */
  height: number;
  /** refinement threshold, px (SPEC § 2: web 2.5, app 2) */
  sse: number;
  /** optional: a frustum test on a bounding sphere (frame coordinates) */
  visible?: (center: [number, number, number], radius: number) => boolean;
}

/**
 * The tiles a view wants (replace refinement): from the roots down, a tile is refined while its screen-space error
 * exceeds the threshold and it has children. `loaded(key)` says whether a tile is in: a tile is replaced only when
 * all of its children are in, else it shows (and its children are wanted, to come in).
 */
export function selectCityTiles(ts: Tileset, v: TileView, loaded: (key: string) => boolean = () => true): { show: TilesetTile[]; want: TilesetTile[] } {
  const byKey = new Map(ts.tiles.map((t) => [t.key, t]));
  const show: TilesetTile[] = [], want: TilesetTile[] = [];
  const k = 2 * Math.tan(v.fov / 2);
  const visit = (t: TilesetTile) => {
    if (v.visible && !v.visible(t.center, t.radius)) return;
    const d = Math.max(1e-3, Math.hypot(t.center[0] - v.position[0], t.center[1] - v.position[1], t.center[2] - v.position[2]) - t.radius);
    const sse = (t.error * v.height) / (d * k);
    const kids = (t.children ?? []).map((c) => byKey.get(c)!).filter(Boolean);
    if (sse > v.sse && kids.length) {
      for (const c of kids) if (!loaded(c.key)) want.push(c);
      if (kids.every((c) => loaded(c.key))) { for (const c of kids) visit(c); return; }
    }
    if (!loaded(t.key)) want.push(t);
    show.push(t);
  };
  for (const r of ts.root) { const t = byKey.get(r); if (t) visit(t); }
  return { show, want };
}

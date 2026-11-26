// Kyoto: where the place reaches, which trunk it stands on, and its materials.

/** The trunk generation whose z14 terrain the tiles are draped on (tileset.json `ground`): the service's current one. */
export async function terrainGen(): Promise<string> {
  if (process.env.EARTHRT_GEN) return process.env.EARTHRT_GEN;
  const p = Bun.spawnSync(["curl", "-sfL", "--max-time", "30", ...(process.env.HTTPS_PROXY ? ["-x", process.env.HTTPS_PROXY] : []), `${process.env.EARTHRT_SERVICE ?? "https://earth.threert.dev"}/tiles/v1/meta.json`]);
  if (p.exitCode !== 0) throw new Error("meta.json: failed");
  return JSON.parse(p.stdout.toString()).gen;
}

/** The place's anchor: its frame (east-up-south here, on the ellipsoid) is the tiles' frame. Shijō Karasuma. */
export const ANCHOR = { lat: 35.0, lon: 135.76 };

/** The built-up basin and the near slopes around it, [lat, lon], counter-clockwise from the north. */
export const BOUNDS: [number, number][] = [
  [35.0690, 135.7350], [35.0600, 135.7240], [35.0460, 135.7140], [35.0360, 135.6960], [35.0220, 135.6700],
  [34.9960, 135.6640], [34.9600, 135.6740], [34.9300, 135.6900], [34.9150, 135.7250], [34.9150, 135.7750],
  [34.9350, 135.7900], [34.9550, 135.7860], [34.9750, 135.7860], [34.9930, 135.7930], [35.0100, 135.8010],
  [35.0280, 135.8060], [35.0450, 135.8060], [35.0600, 135.7960], [35.0670, 135.7760],
];

/**
 * The tiles' materials (tileset@2 `materials`). Colours are in the vertices and copies (linear); a material says how a
 * surface reflects. `surface` names what a host may add (the app: ThreeRT's SurfaceMaterial / facadeWindows; the web:
 * its own shader or nothing): uv is in metres (walls: along, up; ground: east, north).
 */
export const MATERIALS: Record<string, { roughness: number; metalness?: number; doubleSided?: boolean; surface?: Record<string, unknown>; note?: string }> = {
  wall: { roughness: 0.85, note: "plaster, siding, painted walls" },
  facade: { roughness: 0.7, surface: { windows: { floorHeight: 3.3, bayWidth: 3.6, windowWidth: 0.55, windowHeight: 0.55, groundHeight: 4.0 } }, note: "walls of flats and offices: windows by storey (uv metres)" },
  wood: { doubleSided: true, roughness: 0.75, note: "dark timber of temples and townhouses" },
  lacquer: { doubleSided: true, roughness: 0.4, note: "vermilion of shrines and pagodas" },
  paint: { roughness: 0.35, note: "Kyoto Tower" },
  glass: { roughness: 0.08, metalness: 0.6, note: "the tower's deck" },
  "roof-tile": { doubleSided: true, roughness: 0.42, metalness: 0.12, note: "kawara (smoked clay tiles, a silvery sheen)" },
  "roof-metal": { doubleSided: true, roughness: 0.35, metalness: 0.55, note: "sheet steel, galvalume" },
  "roof-copper": { doubleSided: true, roughness: 0.55, metalness: 0.25, note: "green copper" },
  "roof-bark": { doubleSided: true, roughness: 0.95, note: "cypress bark (hiwadabuki)" },
  "roof-flat": { roughness: 0.9, note: "concrete, membranes" },
  "far-house": { roughness: 0.6, metalness: 0.05, note: "the far level's houses: walls and roof in one piece, coloured in it" },
  stone: { roughness: 0.85 },
  bronze: { roughness: 0.4, metalness: 0.9 },
  concrete: { roughness: 0.85 },
  asphalt: { roughness: 0.92 },
  paving: { roughness: 0.85 },
  gravel: { roughness: 0.95 },
  grass: { roughness: 0.95 },
  water: { roughness: 0.04, surface: { water: true }, note: "rivers, ponds, moats: a host may draw its own water" },
  foliage: { doubleSided: true, roughness: 0.8, surface: { foliage: true } },
  bark: { roughness: 0.9 },
};

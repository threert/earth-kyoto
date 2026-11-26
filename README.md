# Kyoto for EarthRT

[EarthRT](https://github.com/threert/EarthRT)'s first-party Kyoto: a **city place** (`earthrt.json`, `kind: "city"`,
`topic: "city:kyoto"`) generated from open data. It replaces the trunk's flat-roofed boxes inside the basin with the
city as it reads from the air and from its streets: dark kawara roofs on low wooden houses, townhouses (machiya) in rows
in the old town, temple halls under hip-and-gable roofs, pagodas, shrines in vermilion, modern blocks downtown with
flat roofs and plant, Kyoto Tower on its hotel, the Kamo and its banks, roads and the grid, trees in temple grounds,
parks and on the hills.

The tiles follow EarthRT's `earthrt/tileset@2` (SPEC § 5): GLB in the place's frame, two levels (z13 for the view
from kilometres away, z15 down to the street), drawn by the map engine (three.js) from the air and by the traced view
(ThreeRT) at street level. They are this repository's release assets; `tileset.json` names them (`@release/<tag>/…`).

## How it is made

| step | what | |
| --- | --- | --- |
| `bun run fetch` | Geofabrik's Kansai extract (OSM) and PLATEAU's Kyoto city CityGML (`tools/fetch.sh`, curl) | data/raw |
| `bun run extract` | OSM cropped to the basin: buildings, land use, roads, rail, water, trees (`tools/extract.py`, pyosmium) | data/osm.json |
| `tools/plateau.py` | PLATEAU's buildings: footprint, measured height, storeys, usage, structure, year, LOD2 roof and wall faces | data/plateau/bldg |
| `bun run build` | the tiles (`src/`): below | out/tiles |
| `bun run preview <pose>` | stills with ThreeRT, before (the trunk) and after, side by side (`tools/poses.json`) | out/s6 |
| `bun tools/publish.ts <tag>` | release assets, tileset.json, register with EarthRT's index | |

The generator (`src/`):

- **Ground** (`ground.ts`): the trunk's own z14 terrain, read from the service and evaluated on the very triangles the
  hosts draw. Roads, water, parks and courts are cut along those triangles and laid a few centimetres above them, so
  nothing floats or sinks where the map shows it.
- **Buildings** (`buildings.ts`, `plateau.ts`): PLATEAU's footprints and heights first (OSM's tags give the names,
  temples, shrines and pagodas; OSM alone where PLATEAU has nothing). A roof's form comes from PLATEAU's LOD2 faces
  where there are some (flat, gabled or hipped, the real ridge, eaves and ridge heights), else from the structure
  (wooden: pitched; concrete: flat) and OSM's `roof:shape`. Near-rectangular houses and blocks are copies of a few
  pieces (`kit.ts`: walls, gabled and hipped roofs whose unit space every size and pitch stretches, flat roofs with
  parapets, rooftop plant); other shapes are meshes, LOD2's own faces for roofs too complex for the pieces. Temples get
  hip-and-gable (irimoya) roofs with eaves that sweep up at the corners on stone platforms, pagodas their storeys and
  finial, shrines vermilion under bark or copper, the old town's narrow deep houses a front house with its ridge along
  the street and a lower wing behind.
- **Surface** (`surface.ts`): land use, parks, gardens, temple gravel, cemeteries, school yards, water, roads by class
  and width, rail, bridges and viaducts on piers, the tiled earthen walls (tsuiji-bei) around temples.
- **Trees** (`trees.ts`): OSM's own, then woods, parks, gardens and temple grounds at their densities, rows along the
  main streets: broadleaf, cedar and pine pieces, each copy its own size, turn and colour.

## Data and licences

- Code: MIT, © Meshy LLC (LICENSE).
- The tiles are made from: **© OpenStreetMap contributors**, under the Open Database Licence (ODbL 1.0);
  **Project PLATEAU** 3D city model of Kyoto city (2025), Ministry of Land, Infrastructure, Transport and Tourism of
  Japan (PLATEAU's terms of use, compatible with CC BY 4.0); the terrain of EarthRT's trunk (GSI elevation data,
  Mapzen Terrain Tiles). No photographs, scans or textures of anyone's.

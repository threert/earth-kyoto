# OSM → data/osm.json: what the generator reads, cropped to the Kyoto basin's box.
#   .venv/bin/python -I tools/extract.py data/raw/kansai-latest.osm.pbf data/osm.json
# Areas (closed ways and multipolygons) come from osmium's area assembler; lines and nodes as they are.
import json
import sys

import osmium

SOUTH, WEST, NORTH, EAST = 34.90, 135.64, 35.08, 135.84

BUILDING_KEYS = (
    "building", "building:part", "building:levels", "building:min_level", "height", "min_height", "roof:shape",
    "roof:levels", "roof:height", "roof:colour", "roof:material", "roof:direction", "roof:orientation",
    "building:colour", "building:material", "amenity", "religion", "denomination", "historic", "name", "name:en",
    "man_made", "tower:type", "layer", "location", "shop", "tourism", "railway", "public_transport", "heritage",
)
AREA_KEYS = ("landuse", "leisure", "natural", "amenity", "water", "waterway", "highway", "area:highway", "religion",
             "historic", "name", "name:en", "parking", "surface", "place", "tourism", "man_made", "bridge", "layer",
             "wetland", "landcover", "garden:type", "railway")
LINE_KEYS = ("highway", "railway", "waterway", "width", "lanes", "tunnel", "bridge", "layer", "name", "name:en",
             "service", "oneway", "surface", "usage", "covered", "intermittent", "barrier", "location", "level")
NODE_KEYS = ("natural", "historic", "amenity", "religion", "name", "name:en", "man_made", "tower:type", "height",
             "leaf_type", "species", "genus", "tourism")


def inside(lat, lon):
    return SOUTH <= lat <= NORTH and WEST <= lon <= EAST


def tags(o, keys):
    return {k: o.tags[k] for k in keys if k in o.tags}


def ring(r):
    return [[round(n.lat, 7), round(n.lon, 7)] for n in r]


out = {"bbox": [WEST, SOUTH, EAST, NORTH], "buildings": [], "areas": [], "lines": [], "nodes": []}


class H(osmium.SimpleHandler):
    def area(self, a):
        t = a.tags
        is_b = "building" in t or "building:part" in t
        is_a = any(k in t for k in ("landuse", "leisure", "natural", "water", "waterway", "area:highway", "place")) or \
            t.get("amenity") in ("place_of_worship", "grave_yard", "parking", "school", "university", "college",
                                 "kindergarten", "hospital") or t.get("highway") in ("pedestrian", "footway", "service") \
            or t.get("man_made") in ("bridge", "pier") or "historic" in t or t.get("tourism") in ("attraction",) \
            or t.get("railway") in ("platform", "station")
        if not (is_b or is_a):
            return
        polys = []
        for outer in a.outer_rings():
            pts = ring(outer)
            if not any(inside(p[0], p[1]) for p in pts):
                continue
            holes = [ring(i) for i in a.inner_rings(outer)]
            polys.append([pts] + holes)
        if not polys:
            return
        rec = {"id": ("w" if a.from_way() else "r") + str(a.orig_id()), "p": polys}
        if is_b:
            rec["t"] = tags(a, BUILDING_KEYS)
            out["buildings"].append(rec)
        if is_a and not is_b:
            rec["t"] = tags(a, AREA_KEYS)
            out["areas"].append(rec)

    def way(self, w):
        t = w.tags
        if not ("highway" in t or "railway" in t or "waterway" in t or t.get("barrier") in ("wall", "city_wall")):
            return
        try:
            pts = [[round(n.lat, 7), round(n.lon, 7)] for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2 or not any(inside(p[0], p[1]) for p in pts):
            return
        out["lines"].append({"id": "w" + str(w.id), "t": tags(w, LINE_KEYS), "c": pts})

    def node(self, n):
        t = n.tags
        if not len(t) or not inside(n.location.lat, n.location.lon):
            return
        if t.get("natural") == "tree" or "historic" in t or t.get("man_made") in ("tower", "torii") or \
                t.get("amenity") == "place_of_worship" or t.get("tourism") == "attraction":
            out["nodes"].append({"id": "n" + str(n.id), "t": tags(n, NODE_KEYS), "c": [round(n.location.lat, 7), round(n.location.lon, 7)]})


src, dst = sys.argv[1], sys.argv[2]
# crop first: an in-memory location index of all Kansai is fine (a few GB at most), but a box keeps it quick
H().apply_file(src, locations=True, idx="flex_mem")
for k in ("buildings", "areas", "lines", "nodes"):
    print(k, len(out[k]))
with open(dst, "w") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

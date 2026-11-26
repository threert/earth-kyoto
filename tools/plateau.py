# PLATEAU (Kyoto city, CityGML 2025) → data/plateau/bldg/<mesh>.json: per building its footprint, height, storeys,
# usage, structure, year, ground elevation, and its LOD2 roof and wall surfaces where it has them.
#   .venv/bin/python -I tools/plateau.py data/plateau/udx/bldg data/plateau/bldg
import json
import os
import sys
from multiprocessing import Pool

from lxml import etree

NS = {
    "bldg": "http://www.opengis.net/citygml/building/2.0",
    "gml": "http://www.opengis.net/gml",
    "uro": "https://www.geospatial.jp/iur/uro/3.2",
}
B = "{%s}" % NS["bldg"]
G = "{%s}" % NS["gml"]
SOUTH, WEST, NORTH, EAST = 34.90, 135.64, 35.08, 135.84


def poslist(el):
    v = el.text.split()
    return [[round(float(v[i]), 7), round(float(v[i + 1]), 7), round(float(v[i + 2]), 2)] for i in range(0, len(v) - 2, 3)]


def polygons(el):
    out = []
    for poly in el.iter(G + "Polygon"):
        rings = []
        ext = poly.find(G + "exterior")
        if ext is None:
            continue
        pl = ext.find(".//" + G + "posList")
        if pl is None:
            continue
        rings.append(poslist(pl))
        for inner in poly.findall(G + "interior"):
            ipl = inner.find(".//" + G + "posList")
            if ipl is not None:
                rings.append(poslist(ipl))
        out.append(rings)
    return out


def text(el, path):
    e = el.find(path, NS)
    return e.text if e is not None else None


def local(tag):
    return tag.split("}")[-1]


def one(src):
    out = []
    for _, b in etree.iterparse(src, tag=B + "Building", huge_tree=True):
        rec = {}
        fp = None
        for k in ("lod0RoofEdge", "lod0FootPrint"):
            e = b.find(B + k)
            if e is not None:
                ps = polygons(e)
                if ps:
                    fp = ps[0]
                    break
        lod1 = b.find(B + "lod1Solid")
        zs = []
        if lod1 is not None:
            for p in polygons(lod1):
                zs += [q[2] for q in p[0]]
            if fp is None:
                ps = polygons(lod1)
                # the lowest face is the footprint
                ps.sort(key=lambda p: sum(q[2] for q in p[0]) / len(p[0]))
                if ps:
                    fp = ps[0]
        if fp is None:
            b.clear()
            continue
        lat = sum(q[0] for q in fp[0]) / len(fp[0])
        lon = sum(q[1] for q in fp[0]) / len(fp[0])
        if not (SOUTH <= lat <= NORTH and WEST <= lon <= EAST):
            b.clear()
            continue
        rec["fp"] = [[[q[0], q[1]] for q in r] for r in fp]
        rec["z0"] = min(zs) if zs else None
        for k, path in (("h", "bldg:measuredHeight"), ("st", "bldg:storeysAboveGround"), ("use", "bldg:usage"), ("yr", "bldg:yearOfConstruction"),
                        ("roof", "bldg:roofType"), ("cls", "bldg:class"), ("name", "gml:name")):
            v = text(b, path)
            if v is not None:
                rec[k] = v
        v = b.find(".//uro:buildingStructureType", NS)
        if v is not None:
            rec["str"] = v.text
        v = b.find(".//uro:buildingID", NS)
        if v is not None:
            rec["id"] = v.text
        v = b.find(".//uro:detailedUsage", NS)
        if v is not None:
            rec["use2"] = v.text
        # LOD2: the boundary surfaces (roofs, walls; the ground is the footprint)
        surf = []
        for bb in b.findall(B + "boundedBy"):
            for s in bb:
                kind = local(s.tag)
                if kind in ("RoofSurface", "WallSurface", "OuterCeilingSurface", "OuterFloorSurface", "ClosureSurface"):
                    for p in polygons(s):
                        surf.append([kind[0], p[0]])
        if surf:
            rec["lod2"] = surf
        out.append(rec)
        b.clear()
        while b.getprevious() is not None:
            del b.getparent()[0]
    return out


def job(args):
    src, dst = args
    if os.path.exists(dst):
        return dst, -1
    recs = one(src)
    with open(dst + ".part", "w") as f:
        json.dump(recs, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(dst + ".part", dst)
    return dst, len(recs)


if __name__ == "__main__":
    src_dir, dst_dir = sys.argv[1], sys.argv[2]
    os.makedirs(dst_dir, exist_ok=True)
    jobs = [(os.path.join(src_dir, f), os.path.join(dst_dir, f.split("_")[0] + ".json")) for f in sorted(os.listdir(src_dir)) if f.endswith(".gml")]
    with Pool(int(os.environ.get("JOBS", "8"))) as p:
        for dst, n in p.imap_unordered(job, jobs):
            print(dst, n, flush=True)

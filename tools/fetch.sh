#!/usr/bin/env bash
# The sources (curl: PLATEAU's CDN is far slower through Node's fetch): Geofabrik's Kansai extract, cropped to the
# basin with osmium, and PLATEAU's Kyoto city CityGML (2.7 GB; the buildings and vegetation unzipped).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw data/plateau
curl -fL --retry 5 -C - -o data/raw/kansai-latest.osm.pbf https://download.geofabrik.de/asia/japan/kansai-latest.osm.pbf
osmium extract -b 135.64,34.90,135.84,35.08 --strategy=smart -O -o data/raw/kyoto.osm.pbf data/raw/kansai-latest.osm.pbf
until curl -fL --retry 5 -C - -o data/raw/plateau-kyoto-citygml.zip "https://assets.cms.plateau.reearth.io/assets/c8/4c6540-2bcf-4773-b21d-74ad2d9f1ba1/26100_kyoto-shi_city_2025_citygml_1_op.zip"; do sleep 3; done
(cd data/plateau && unzip -q -o ../raw/plateau-kyoto-citygml.zip "udx/bldg/*.gml" "udx/veg/*" "codelists/*")
python3 -m venv .venv && .venv/bin/pip install -q osmium lxml
.venv/bin/python -I tools/extract.py data/raw/kyoto.osm.pbf data/osm.json
.venv/bin/python -I tools/plateau.py data/plateau/udx/bldg data/plateau/bldg

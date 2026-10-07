"""Build the web-map files from Admin Express COG 2026.

Reads the commune layer, keeps the 2023 municipal population already
stored on each feature, and writes:

- data/index.json : names, population, area, centroids, neighbor indexes
- data/communes.geojson : simplified outlines in Lambert-93, encoded so
  MapLibre's Web Mercator displays them without extra distortion
  (Philippe Rivière / Éric Mauvière). Metropolitan France only.
"""

import json
import math
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely
from pyproj import Transformer
from shapely import STRtree

# Lambert-93 metres, then the inverse-Mercator encoding used so a Web Mercator
# map shows those metres without stretching them again.
_TO_L93 = Transformer.from_crs("EPSG:4326", "EPSG:2154", always_xy=True)
_EARTH_RADIUS = 6378137.0
_METRES_PER_DEGREE = _EARTH_RADIUS * math.pi / 180.0

ROOT = Path(__file__).resolve().parent
GPKG = ROOT / "ADE-COG-CARTO_4-0_GPKG_LAMB93_FXX-ED2026-01-01.gpkg"
OUT = ROOT / "data"
# Metres. Bridges river and shoreline gaps without joining Corsica to the mainland.
NEIGHBOR_DISTANCE = 50
# Cartographic simplification in Lambert 93 before reprojecting.
SIMPLIFY_M = 40

DEPS = {
    "01": "Ain",
    "02": "Aisne",
    "03": "Allier",
    "04": "Alpes-de-Haute-Provence",
    "05": "Hautes-Alpes",
    "06": "Alpes-Maritimes",
    "07": "Ardèche",
    "08": "Ardennes",
    "09": "Ariège",
    "10": "Aube",
    "11": "Aude",
    "12": "Aveyron",
    "13": "Bouches-du-Rhône",
    "14": "Calvados",
    "15": "Cantal",
    "16": "Charente",
    "17": "Charente-Maritime",
    "18": "Cher",
    "19": "Corrèze",
    "21": "Côte-d'Or",
    "22": "Côtes-d'Armor",
    "23": "Creuse",
    "24": "Dordogne",
    "25": "Doubs",
    "26": "Drôme",
    "27": "Eure",
    "28": "Eure-et-Loir",
    "29": "Finistère",
    "2A": "Corse-du-Sud",
    "2B": "Haute-Corse",
    "30": "Gard",
    "31": "Haute-Garonne",
    "32": "Gers",
    "33": "Gironde",
    "34": "Hérault",
    "35": "Ille-et-Vilaine",
    "36": "Indre",
    "37": "Indre-et-Loire",
    "38": "Isère",
    "39": "Jura",
    "40": "Landes",
    "41": "Loir-et-Cher",
    "42": "Loire",
    "43": "Haute-Loire",
    "44": "Loire-Atlantique",
    "45": "Loiret",
    "46": "Lot",
    "47": "Lot-et-Garonne",
    "48": "Lozère",
    "49": "Maine-et-Loire",
    "50": "Manche",
    "51": "Marne",
    "52": "Haute-Marne",
    "53": "Mayenne",
    "54": "Meurthe-et-Moselle",
    "55": "Meuse",
    "56": "Morbihan",
    "57": "Moselle",
    "58": "Nièvre",
    "59": "Nord",
    "60": "Oise",
    "61": "Orne",
    "62": "Pas-de-Calais",
    "63": "Puy-de-Dôme",
    "64": "Pyrénées-Atlantiques",
    "65": "Hautes-Pyrénées",
    "66": "Pyrénées-Orientales",
    "67": "Bas-Rhin",
    "68": "Haut-Rhin",
    "69": "Rhône",
    "70": "Haute-Saône",
    "71": "Saône-et-Loire",
    "72": "Sarthe",
    "73": "Savoie",
    "74": "Haute-Savoie",
    "75": "Paris",
    "76": "Seine-Maritime",
    "77": "Seine-et-Marne",
    "78": "Yvelines",
    "79": "Deux-Sèvres",
    "80": "Somme",
    "81": "Tarn",
    "82": "Tarn-et-Garonne",
    "83": "Var",
    "84": "Vaucluse",
    "85": "Vendée",
    "86": "Vienne",
    "87": "Haute-Vienne",
    "88": "Vosges",
    "89": "Yonne",
    "90": "Territoire de Belfort",
    "91": "Essonne",
    "92": "Hauts-de-Seine",
    "93": "Seine-Saint-Denis",
    "94": "Val-de-Marne",
    "95": "Val-d'Oise",
    "971": "Guadeloupe",
    "972": "Martinique",
    "973": "Guyane",
    "974": "La Réunion",
    "976": "Mayotte",
}


def _wgs84_xy_to_map(coords):
    x, y = _TO_L93.transform(coords[:, 0], coords[:, 1])
    out = np.empty_like(coords)
    out[:, 0] = (x - 700000.0) / _METRES_PER_DEGREE
    merc = (y - 6600000.0) / _EARTH_RADIUS
    out[:, 1] = np.degrees(2 * np.arctan(np.exp(merc)) - np.pi / 2)
    if coords.shape[1] == 3:
        out[:, 2] = coords[:, 2]
    return out


def to_map_geometry(geom):
    return shapely.transform(geom, _wgs84_xy_to_map)


def round_coords(coords, digits):
    if isinstance(coords[0], (float, int)):
        return [round(float(coords[0]), digits), round(float(coords[1]), digits)]
    return [round_coords(c, digits) for c in coords]


def grow(seed, neighbors, cx, cy, pop, target):
    selected = {seed}
    total = int(pop[seed])
    frontier = set(neighbors[seed])
    while total < target and (frontier or len(selected) < len(pop)):
        if not frontier:
            best = None
            best_key = None
            for i in range(len(pop)):
                if i in selected:
                    continue
                dx = cx[i] - cx[seed]
                dy = cy[i] - cy[seed]
                key = (dx * dx + dy * dy, i)
                if best_key is None or key < best_key:
                    best_key = key
                    best = i
            if best is None:
                break
        else:
            best = None
            best_key = None
            for i in frontier:
                dx = cx[i] - cx[seed]
                dy = cy[i] - cy[seed]
                key = (dx * dx + dy * dy, i)
                if best_key is None or key < best_key:
                    best_key = key
                    best = i
            frontier.remove(best)
        selected.add(best)
        total += int(pop[best])
        for j in neighbors[best]:
            if j not in selected:
                frontier.add(j)
    return selected, total


def main():
    t0 = time.perf_counter()
    print("reading communes…", flush=True)
    gdf = gpd.read_file(
        GPKG,
        layer="commune",
        columns=[
            "code_insee",
            "nom_officiel",
            "population",
            "superficie_cadastrale",
            "code_insee_du_departement",
        ],
    )
    gdf = gdf.sort_values("code_insee").reset_index(drop=True)
    n = len(gdf)
    print(f"{n} communes in {time.perf_counter() - t0:.1f}s", flush=True)

    geoms = np.asarray(gdf.geometry.values)
    invalid = ~shapely.is_valid(geoms)
    print(f"invalid geometries: {int(invalid.sum())}", flush=True)
    if invalid.any():
        geoms = geoms.copy()
        geoms[invalid] = shapely.make_valid(geoms[invalid])

    centroids = shapely.centroid(geoms)
    cx = shapely.get_x(centroids)
    cy = shapely.get_y(centroids)

    print(f"adjacency within {NEIGHBOR_DISTANCE} m…", flush=True)
    t1 = time.perf_counter()
    tree = STRtree(geoms)
    left, right = tree.query(geoms, predicate="dwithin", distance=NEIGHBOR_DISTANCE)
    mask = left < right
    left = left[mask]
    right = right[mask]
    neighbors = [[] for _ in range(n)]
    for i, j in zip(left.tolist(), right.tolist()):
        neighbors[i].append(int(j))
        neighbors[j].append(int(i))
    for bucket in neighbors:
        bucket.sort()
    degrees = [len(bucket) for bucket in neighbors]
    isolated = [i for i, d in enumerate(degrees) if d == 0]
    print(
        f"edges {len(left)} in {time.perf_counter() - t1:.1f}s, "
        f"degree min/median/max {min(degrees)}/{int(np.median(degrees))}/{max(degrees)}, "
        f"isolated {len(isolated)}",
        flush=True,
    )
    for i in isolated[:12]:
        print(f"  isolated {gdf.at[i, 'code_insee']} {gdf.at[i, 'nom_officiel']}", flush=True)

    print("simplifying for the web map…", flush=True)
    t2 = time.perf_counter()
    simple = shapely.simplify(geoms, SIMPLIFY_M, preserve_topology=True)
    empty = shapely.is_empty(simple)
    if empty.any():
        simple = simple.copy()
        simple[empty] = geoms[empty]
    web = gpd.GeoDataFrame(geometry=simple, crs=gdf.crs).to_crs(4326)
    print(f"simplify+reproject {time.perf_counter() - t2:.1f}s", flush=True)

    web_centroids = shapely.centroid(np.asarray(web.geometry.values))
    lon = shapely.get_x(web_centroids)
    lat = shapely.get_y(web_centroids)

    pop = gdf["population"].astype(int).tolist()
    area = gdf["superficie_cadastrale"].fillna(0).astype(int).tolist()
    total = int(sum(pop))
    target = (total + 1) // 2

    by_code = {code: i for i, code in enumerate(gdf["code_insee"])}
    for code in ("75056", "48095", "2A004"):
        if code not in by_code:
            print("missing sample", code)
            continue
        seed = by_code[code]
        selected, reached = grow(seed, neighbors, cx, cy, pop, target)
        area_km2 = sum(area[i] for i in selected) / 100
        print(
            f"sample {gdf.at[seed, 'nom_officiel']}: "
            f"{len(selected)} communes, {reached} hab, {area_km2:.0f} km²",
            flush=True,
        )

    OUT.mkdir(exist_ok=True)
    index = {
        "total": total,
        "target": target,
        "names": gdf["nom_officiel"].tolist(),
        "codes": gdf["code_insee"].tolist(),
        "dep": gdf["code_insee_du_departement"].tolist(),
        "depNames": DEPS,
        "pop": pop,
        "area": area,
        "cx": [round(float(v), 1) for v in cx],
        "cy": [round(float(v), 1) for v in cy],
        "lon": [round(float(v), 5) for v in lon],
        "lat": [round(float(v), 5) for v in lat],
        "nb": neighbors,
    }
    index_path = OUT / "index.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    features = []
    for i, geom in enumerate(web.geometry.values):
        mapping = shapely.geometry.mapping(to_map_geometry(geom))
        mapping["coordinates"] = round_coords(mapping["coordinates"], 5)
        features.append(
            {
                "type": "Feature",
                "id": i,
                "properties": {"i": i},
                "geometry": mapping,
            }
        )
    geo_path = OUT / "communes.geojson"
    geo_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"wrote {index_path.name} {index_path.stat().st_size / 1e6:.1f} MB, "
        f"{geo_path.name} {geo_path.stat().st_size / 1e6:.1f} MB",
        flush=True,
    )
    print(f"DONE in {time.perf_counter() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()

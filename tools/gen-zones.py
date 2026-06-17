#!/usr/bin/env python3
"""
Génère ../zones-geo.json : la géométrie (contour) de chaque zone du jeu.
À relancer après avoir ajouté une zone (ville / pays / région) dans game.js.

Sources :
- Pays + continents : Natural Earth 110m (continents = pays FUSIONNÉS via shapely).
- Régions de France : gregoiredavid/france-geojson.
- Villes de France : geo.api.gouv.fr (contour de commune, par code INSEE).
- Villes du monde : OpenStreetMap / Nominatim (limites administratives).

Prérequis : pip install shapely   (Nominatim impose ~1 req/s : ne pas paralléliser).
Usage : python3 tools/gen-zones.py
"""
import json, os, time, urllib.request, urllib.parse
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
OUTP = os.path.join(HERE, "..", "zones-geo.json")
UA = {"User-Agent": "GeolocGame/1.0 (axelcourty1@gmail.com)"}

def dl(url, path, headers=None):
    if os.path.exists(path):
        return
    req = urllib.request.Request(url, headers=headers or {})
    open(path, "wb").write(urllib.request.urlopen(req, timeout=60).read())

dl("https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson", "/tmp/countries.json")
dl("https://cdn.jsdelivr.net/gh/gregoiredavid/france-geojson@master/regions-version-simplifiee.geojson", "/tmp/fr.json")

OUT = {}
def simp(geom, tol): return mapping(shape(geom).simplify(tol))

# ---- Natural Earth : continents (fusion) + pays ----
ne = json.load(open("/tmp/countries.json"))
CONT = {"europe": "Europe", "north-america": "North America", "south-america": "South America",
        "asia": "Asia", "oceania": "Oceania", "africa": "Africa"}
for key, cont in CONT.items():
    geoms = [shape(ft["geometry"]) for ft in ne["features"] if ft["properties"].get("CONTINENT") == cont]
    OUT[key] = mapping(unary_union(geoms).simplify(0.25))

COUNTRY = {"france": ["France"], "usa": ["United States of America"], "canada": ["Canada"],
  "uk-ireland": ["United Kingdom", "Ireland"], "spain-portugal": ["Spain", "Portugal"], "italy": ["Italy"],
  "germany": ["Germany"], "japan": ["Japan"], "south-korea": ["South Korea"], "australia": ["Australia"],
  "new-zealand": ["New Zealand"], "brazil": ["Brazil"], "argentina-chile": ["Argentina", "Chile"],
  "south-africa": ["South Africa"], "mexico": ["Mexico"]}
for co, names in COUNTRY.items():
    geoms = [shape(ft["geometry"]) for ft in ne["features"] if ft["properties"].get("ADMIN") in names]
    if geoms: OUT["country:" + co] = mapping(unary_union(geoms).simplify(0.06))
OUT["france-cities"] = OUT.get("country:france")

# ---- Régions de France ----
fr = json.load(open("/tmp/fr.json"))
REG = {"fr-idf": "Île-de-France", "fr-naq": "Nouvelle-Aquitaine", "fr-ara": "Auvergne-Rhône-Alpes",
  "fr-occ": "Occitanie", "fr-hdf": "Hauts-de-France", "fr-ges": "Grand Est", "fr-pac": "Provence-Alpes-Côte d'Azur",
  "fr-pdl": "Pays de la Loire", "fr-nor": "Normandie", "fr-bre": "Bretagne", "fr-bfc": "Bourgogne-Franche-Comté",
  "fr-cvl": "Centre-Val de Loire", "fr-cor": "Corse"}
for key, nom in REG.items():
    for ft in fr["features"]:
        if ft["properties"].get("nom") == nom:
            OUT[key] = simp(ft["geometry"], 0.015); break

# ---- Villes de France (communes) ----
FR_CITIES = {"city-bordeaux": "33063", "city-paris": "75056", "city-lyon": "69123", "city-marseille": "13055",
  "city-toulouse": "31555", "city-nice": "06088", "city-nantes": "44109", "city-strasbourg": "67482",
  "city-lille": "59350", "city-montpellier": "34172", "city-rennes": "35238", "city-grenoble": "38185"}
for key, code in FR_CITIES.items():
    try:
        u = "https://geo.api.gouv.fr/communes?code=%s&fields=contour&format=geojson&geometry=contour" % code
        d = json.load(urllib.request.urlopen(u, timeout=25))
        OUT[key] = simp(d["features"][0]["geometry"], 0.0015)
    except Exception as e: print("FR city KO", key, e)

# ---- Villes du monde (Nominatim, 1 req/s) ----
WORLD = {"city-londres": "London", "city-new-york": "New York City", "city-tokyo": "Tokyo", "city-berlin": "Berlin",
  "city-madrid": "Madrid", "city-rome": "Rome, Italy", "city-amsterdam": "Amsterdam", "city-barcelone": "Barcelona",
  "city-montreal": "Montreal", "city-sydney": "Sydney, Australia", "city-los-angeles": "Los Angeles", "city-singapour": "Singapore"}
for key, q in WORLD.items():
    try:
        u = "https://nominatim.openstreetmap.org/search?q=%s&polygon_geojson=1&format=geojson&limit=1&featureType=city" % urllib.parse.quote(q)
        d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30))
        OUT[key] = simp(d["features"][0]["geometry"], 0.008)
    except Exception as e: print("world city KO", key, e)
    time.sleep(1.2)

json.dump(OUT, open(OUTP, "w"), separators=(",", ":"))
print("ZONES:", len(OUT), "| octets:", os.path.getsize(OUTP))

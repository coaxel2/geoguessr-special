#!/usr/bin/env python3
# RATTRAPAGE des contours manquants : re-tente UNIQUEMENT les villes restées sans contour
# (c[5] is None). Stratégie améliorée vs gen-contours.py :
#   - viewbox borné autour du centre connu (bounded=1) → tue les homonymes lointains,
#   - limit=8 + on scanne le 1er résultat qui EST un polygone (au lieu de limit=1 qui
#     renvoyait souvent un Point pour les petites villes),
#   - critères relâchés (homonyme 0.85°, taille 3.2°).
# Sauvegarde incrémentale. Délai 1.1 s (ToS Nominatim ~1 req/s).
import json, urllib.request, urllib.parse, time, math

UA = {"User-Agent": "GeolocGame/1.0 (axelcourty1@gmail.com)", "Accept-Language": "fr"}
BIG_CC = {
    "france": "fr", "usa": "us", "canada": "ca", "uk-ireland": "gb,ie",
    "spain-portugal": "es,pt", "italy": "it", "germany": "de", "japan": "jp",
    "south-korea": "kr", "australia": "au", "new-zealand": "nz", "brazil": "br",
    "argentina-chile": "ar,cl", "south-africa": "za", "mexico": "mx",
}

def cc_for(key):
    if key in BIG_CC: return BIG_CC[key]
    if key.startswith("c-"): return key[2:]
    return ""

def decimate(geom, maxper=120):
    def thin(ring):
        rnd = lambda p: [round(p[0], 3), round(p[1], 3)]
        if len(ring) <= maxper: return [rnd(p) for p in ring]
        step = math.ceil(len(ring) / maxper)
        out = [rnd(ring[i]) for i in range(0, len(ring), step)]
        out.append(rnd(ring[0]))
        return out
    if geom["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": [thin(r) for r in geom["coordinates"]]}
    return {"type": "MultiPolygon", "coordinates": [[thin(r) for r in poly] for poly in geom["coordinates"]]}

def bbox_of(geom):
    mnx, mny, mxx, mxy = 180, 90, -180, -90
    def scan(r):
        nonlocal mnx, mny, mxx, mxy
        for x, y in r:
            mnx = min(mnx, x); mxx = max(mxx, x); mny = min(mny, y); mxy = max(mxy, y)
    if geom["type"] == "Polygon":
        for r in geom["coordinates"]: scan(r)
    else:
        for poly in geom["coordinates"]:
            for r in poly: scan(r)
    return mnx, mny, mxx, mxy

def geocode_retry(name, cc, lat0, lng0):
    # viewbox ±0.45° autour du centre connu, bounded → seuls les hits proches sont renvoyés
    vb = "%f,%f,%f,%f" % (lng0 - 0.45, lat0 + 0.45, lng0 + 0.45, lat0 - 0.45)
    u = ("https://nominatim.openstreetmap.org/search?format=geojson&polygon_geojson=1"
         "&limit=8&bounded=1&viewbox=%s&q=%s" % (urllib.parse.quote(vb), urllib.parse.quote(name)))
    if cc:
        u += "&countrycodes=" + cc
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30))
    except Exception:
        return None
    best = None
    for f in (d.get("features") or []):
        g = (f or {}).get("geometry")
        if not g or g.get("type") not in ("Polygon", "MultiPolygon"):
            continue                                   # on saute les Points
        small = decimate(g)
        mnx, mny, mxx, mxy = bbox_of(small)
        clat, clng = (mny + mxy) / 2, (mnx + mxx) / 2
        if abs(clat - lat0) > 0.85 or abs(clng - lng0) > 0.85:   # anti-homonyme (relâché)
            continue
        if (mxx - mnx) > 3.2 or (mxy - mny) > 3.2:               # pas une région entière (relâché)
            continue
        return small                                   # 1er polygone plausible = bon
    return best

d = json.load(open("cities-by-country.json"))
todo = [(k, c) for k, pack in d.items() for c in pack["cities"] if len(c) >= 6 and not c[5]]
print("à rattraper : %d villes sans contour" % len(todo), flush=True)
done = got = 0
for key, c in todo:
    cc = cc_for(key)
    g = geocode_retry(c[1], cc, c[2], c[3]) if cc else None
    if g:
        c[5] = g
        got += 1
    done += 1
    time.sleep(1.1)
    if done % 40 == 0:
        print("%d/%d (+%d contours récupérés)" % (done, len(todo), got), flush=True)
        json.dump(d, open("cities-by-country.json", "w"), ensure_ascii=False, separators=(",", ":"))
json.dump(d, open("cities-by-country.json", "w"), ensure_ascii=False, separators=(",", ":"))
print("FINI : %d/%d traitées, +%d contours récupérés" % (done, len(todo), got))

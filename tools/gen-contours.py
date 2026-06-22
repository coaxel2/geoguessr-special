#!/usr/bin/env python3
# Enrichit cities-by-country.json avec le CONTOUR réel (frontière administrative) de chaque
# ville, géocodé via Nominatim/OSM. Chaque ville [slug, nom, lat, lng, rayon] devient
# [slug, nom, lat, lng, rayon, geojson|null]. Reprise + sauvegarde incrémentale (résiste à
# une coupure). Délai 1.1 s entre requêtes (respect du ToS Nominatim ~1 req/s).
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

def geocode(name, cc, lat0, lng0):
    u = ("https://nominatim.openstreetmap.org/search?format=geojson&polygon_geojson=1&limit=1&countrycodes=%s&q=%s"
         % (cc, urllib.parse.quote(name)))
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30))
    except Exception:
        return None
    fs = d.get("features") or []
    if not fs: return None
    g = fs[0].get("geometry")
    if not g or g.get("type") not in ("Polygon", "MultiPolygon"): return None
    small = decimate(g)
    mnx, mny, mxx, mxy = 180, 90, -180, -90
    def scan(r):
        nonlocal mnx, mny, mxx, mxy
        for x, y in r:
            mnx = min(mnx, x); mxx = max(mxx, x); mny = min(mny, y); mxy = max(mxy, y)
    if small["type"] == "Polygon":
        for r in small["coordinates"]: scan(r)
    else:
        for poly in small["coordinates"]:
            for r in poly: scan(r)
    clat, clng = (mny + mxy) / 2, (mnx + mxx) / 2
    if abs(clat - lat0) > 0.5 or abs(clng - lng0) > 0.5: return None   # anti-homonyme
    if (mxx - mnx) > 2 or (mxy - mny) > 2: return None                  # pas une région entière
    return small

d = json.load(open("cities-by-country.json"))
total = sum(len(v["cities"]) for v in d.values())
done = got = 0
for key, pack in d.items():
    cc = cc_for(key)
    for c in pack["cities"]:
        if len(c) >= 6:                      # déjà traité (reprise)
            done += 1
            if c[5]: got += 1
            continue
        g = geocode(c[1], cc, c[2], c[3]) if cc else None
        c.append(g)
        done += 1
        if g: got += 1
        time.sleep(1.1)
        if done % 50 == 0:
            print("%d/%d (%d contours)" % (done, total, got), flush=True)
            json.dump(d, open("cities-by-country.json", "w"), ensure_ascii=False, separators=(",", ":"))
json.dump(d, open("cities-by-country.json", "w"), ensure_ascii=False, separators=(",", ":"))
print("FINI : %d/%d, %d contours" % (done, total, got))

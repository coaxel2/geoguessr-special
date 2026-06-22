#!/usr/bin/env python3
# Génère cities-by-country.json : top 50 villes (par population) de chaque pays présent
# dans le jeu, avec centre + rayon COURT (on veut spawner près du centre-ville).
# Source : GeoNames cities5000 (villes > 5000 hab), domaine public.
import urllib.request, zipfile, io, json, re, unicodedata

# clé de zone du jeu -> code(s) pays ISO GeoNames
TARGETS = {
    "france": ["FR"], "usa": ["US"], "canada": ["CA"], "uk-ireland": ["GB", "IE"],
    "spain-portugal": ["ES", "PT"], "italy": ["IT"], "germany": ["DE"], "japan": ["JP"],
    "south-korea": ["KR"], "australia": ["AU"], "new-zealand": ["NZ"], "brazil": ["BR"],
    "argentina-chile": ["AR", "CL"], "south-africa": ["ZA"], "mexico": ["MX"],
}
TOPN = 50

def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "x"

# rayon COURT (mètres) selon la taille de la ville — on reste proche du centre.
def radius_m(pop):
    if pop >= 3_000_000: return 9000
    if pop >= 1_000_000: return 7000
    if pop >= 300_000:   return 5500
    if pop >= 100_000:   return 4500
    return 3500

print("Téléchargement GeoNames cities5000…")
url = "https://download.geonames.org/export/dump/cities5000.zip"
data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "GeolocGame/1.0 (axelcourty1@gmail.com)"}), timeout=180).read()
txt = zipfile.ZipFile(io.BytesIO(data)).read("cities5000.txt").decode("utf-8")

# index par code pays
by_cc = {}
for line in txt.split("\n"):
    f = line.split("\t")
    if len(f) < 15:
        continue
    cc = f[8]
    if cc not in {c for ccs in TARGETS.values() for c in ccs}:
        continue
    try:
        pop = int(f[14])
    except ValueError:
        pop = 0
    try:
        lat, lng = float(f[4]), float(f[5])
    except ValueError:
        continue
    by_cc.setdefault(cc, []).append((pop, f[1], lat, lng))

OUT = {}
for key, ccs in TARGETS.items():
    rows = []
    for cc in ccs:
        rows += by_cc.get(cc, [])
    rows.sort(key=lambda x: -x[0])   # population décroissante
    seen, top = set(), []
    for pop, name, lat, lng in rows:
        sl = slugify(name)
        if sl in seen:
            continue
        seen.add(sl)
        top.append([sl, name, round(lat, 4), round(lng, 4), radius_m(pop)])
        if len(top) >= TOPN:
            break
    OUT[key] = top
    print(f"  {key:18s} {len(top)} villes")

with open("cities-by-country.json", "w", encoding="utf-8") as fp:
    json.dump(OUT, fp, ensure_ascii=False, separators=(",", ":"))
total = sum(len(v) for v in OUT.values())
print(f"écrit cities-by-country.json — {total} villes au total")

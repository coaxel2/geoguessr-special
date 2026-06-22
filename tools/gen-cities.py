#!/usr/bin/env python3
# Génère cities-by-country.json : villes par pays (centre + rayon COURT, pour spawner près
# du centre-ville). Les 15 « gros » pays du jeu ont leur top 50 ; TOUS les autres pays du
# monde ont leur top 10. La délimitation affichée dans le sélecteur est un cercle (= la zone
# jouable réelle), pas besoin de géocoder des contours.
# Source : GeoNames cities5000 (population) + countryInfo (liste des pays). Domaine public.
import urllib.request, zipfile, io, json, re, unicodedata, math

UA = {"User-Agent": "GeolocGame/1.0 (axelcourty1@gmail.com)"}

# 15 « gros » pays du jeu : clé de zone -> (codes ISO, drapeau, nom FR). Top 50.
BIG = {
    "france": (["FR"], "🇫🇷", "France"), "usa": (["US"], "🇺🇸", "États-Unis"),
    "canada": (["CA"], "🇨🇦", "Canada"), "uk-ireland": (["GB", "IE"], "🇬🇧", "Royaume-Uni / Irlande"),
    "spain-portugal": (["ES", "PT"], "🇪🇸", "Espagne / Portugal"), "italy": (["IT"], "🇮🇹", "Italie"),
    "germany": (["DE"], "🇩🇪", "Allemagne"), "japan": (["JP"], "🇯🇵", "Japon"),
    "south-korea": (["KR"], "🇰🇷", "Corée du Sud"), "australia": (["AU"], "🇦🇺", "Australie"),
    "new-zealand": (["NZ"], "🇳🇿", "Nouvelle-Zélande"), "brazil": (["BR"], "🇧🇷", "Brésil"),
    "argentina-chile": (["AR", "CL"], "🇦🇷", "Argentine / Chili"), "south-africa": (["ZA"], "🇿🇦", "Afrique du Sud"),
    "mexico": (["MX"], "🇲🇽", "Mexique"),
}
BIG_CODES = {c for ccs, _, _ in BIG.values() for c in ccs}

def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower() or "x"

def flag(iso2):
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in iso2.upper() if "A" <= c <= "Z")

# rayon COURT (m) — on reste proche du centre-ville (resserré pour éviter la ville d'à côté)
def radius_m(pop):
    if pop >= 3_000_000: return 6000
    if pop >= 1_000_000: return 4500
    if pop >= 300_000:   return 3500
    if pop >= 100_000:   return 2800
    return 2200

def hav(la1, lo1, la2, lo2):
    dla, dlo = math.radians(la2 - la1), math.radians(lo2 - lo1)
    a = math.sin(dla / 2) ** 2 + math.cos(math.radians(la1)) * math.cos(math.radians(la2)) * math.sin(dlo / 2) ** 2
    return 2 * 6371 * math.asin(min(1, math.sqrt(a)))

# top N villes DISTINCTES : tri par population, on saute les villes à <11 km d'une déjà
# gardée (élimine arrondissements/quartiers/banlieues collés qui faisaient des doublons).
def top_cities(rows, n, min_km=11):
    rows.sort(key=lambda x: -x[0])
    kept = []
    for pop, name, lat, lng in rows:
        sl = slugify(name)
        if any(k[0] == sl for k in kept): continue
        if any(hav(lat, lng, k[2], k[3]) < min_km for k in kept): continue
        kept.append([sl, name, round(lat, 4), round(lng, 4), radius_m(pop)])
        if len(kept) >= n: break
    return kept

print("Téléchargement GeoNames countryInfo…")
ci = urllib.request.urlopen(urllib.request.Request("https://download.geonames.org/export/dump/countryInfo.txt", headers=UA), timeout=120).read().decode("utf-8")
country_name = {}
for line in ci.split("\n"):
    if not line or line.startswith("#"): continue
    f = line.split("\t")
    if len(f) > 4 and f[0]:
        country_name[f[0]] = f[4]   # ISO2 -> nom anglais

print("Téléchargement GeoNames cities5000…")
data = urllib.request.urlopen(urllib.request.Request("https://download.geonames.org/export/dump/cities5000.zip", headers=UA), timeout=180).read()
txt = zipfile.ZipFile(io.BytesIO(data)).read("cities5000.txt").decode("utf-8")

by_cc = {}
for line in txt.split("\n"):
    f = line.split("\t")
    if len(f) < 15: continue
    if f[7] == "PPLX": continue          # section de ville (arrondissement/quartier) → pas une ville à part
    try: pop = int(f[14]); lat = float(f[4]); lng = float(f[5])
    except ValueError: continue
    by_cc.setdefault(f[8], []).append((pop, f[1], lat, lng))

OUT = {}
# 1) gros pays : top 50
for key, (ccs, fl, name) in BIG.items():
    rows = []
    for cc in ccs: rows += by_cc.get(cc, [])
    OUT[key] = {"flag": fl, "name": name, "cities": top_cities(rows, 50)}

# 2) tous les autres pays du monde : top 10
others = 0
for cc, rows in by_cc.items():
    if cc in BIG_CODES or not cc: continue
    cities = top_cities(list(rows), 10)
    if not cities: continue
    OUT["c-" + cc.lower()] = {"flag": flag(cc), "name": country_name.get(cc, cc), "cities": cities}
    others += 1

with open("cities-by-country.json", "w", encoding="utf-8") as fp:
    json.dump(OUT, fp, ensure_ascii=False, separators=(",", ":"))
total = sum(len(v["cities"]) for v in OUT.values())
print("écrit cities-by-country.json — %d groupes (%d gros pays + %d autres), %d villes" % (len(OUT), len(BIG), others, total))

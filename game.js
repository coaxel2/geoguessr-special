/* ===========================================================
   Geoloc — logique de jeu
   - Street View via Google Maps JS API ; cartes de guess via Leaflet
   - Multijoueur P2P via PeerJS (repris du projet d'échecs)
   =========================================================== */

"use strict";

/* ---------- CONFIG ---------- */
const CONFIG = {
  // Clé Google Maps JS API — JAMAIS en dur ici (le dépôt est public).
  // Placeholder remplacé au démarrage du conteneur par docker-entrypoint.sh
  // depuis la variable d'env GMAPS_KEY (définie dans Coolify).
  // ⚠️ Une clé Maps JS est visible côté navigateur de toute façon : la vraie
  // protection est la restriction par référent HTTP (*.planbadge.fr) côté Google Cloud.
  GMAPS_KEY: "__GMAPS_KEY__",
};

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const rand = (min, max) => min + Math.random() * (max - min);
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("show"));
  $(id).classList.add("show");
}
function fmtDist(m) {
  if (m == null) return "— km";
  if (m < 1000) return Math.round(m) + " m";
  if (m < 10000) return (m / 1000).toFixed(1) + " km";
  return Math.round(m / 1000).toLocaleString("fr-FR") + " km";
}
function setMapsState(txt) { const e = $("maps-state"); if (e) e.textContent = txt; }
function cleanName(v) {
  const name = (v || "").trim().replace(/\s+/g, " ").slice(0, 18);
  return /^joueur$/i.test(name) ? "" : name;
}
function savePlayerName() {
  G.playerName = cleanName($("player-name").value);
  $("player-name").value = G.playerName;
  try {
    if (G.playerName) localStorage.setItem("geoq-name", G.playerName);
    else localStorage.removeItem("geoq-name");
  } catch (e) {}
  return !!G.playerName;
}
function requirePlayerName(errorId) {
  if (savePlayerName()) return true;
  const msg = "Entre un pseudo avant de jouer.";
  if (errorId && $(errorId)) $(errorId).textContent = msg;
  else setMapsState(msg);
  $("player-name").focus();
  return false;
}
function labelForSelect(id) {
  const el = $(id);
  return el && el.selectedOptions[0] ? el.selectedOptions[0].textContent : "";
}
function labelForValue(id, value) {
  const el = $(id);
  if (!el) return "";
  const opt = Array.from(el.options).find((o) => o.value === value);
  return opt ? opt.textContent : "";
}
function settingsText() {
  const zone = G.zoneFilter === "country"
    ? (labelForValue("room-country-filter", G.countryFilter) || labelForValue("online-country-filter", G.countryFilter))
    : (labelForValue("room-zone-filter", G.zoneFilter) || labelForValue("online-zone-filter", G.zoneFilter));
  const t = G.timeLimit ? " · " + Math.round(G.timeLimit / 60) + " min/manche" : "";
  return G.rounds + " manches · " + (zone || "Monde entier") + t;
}
/* ---------- avatars « bonhomme » via DiceBear (style avataaars) ----------
   Déterministes : générés depuis le pseudo (+ une graine cyclable au clic).
   En P2P on ne transmet que le pseudo + la graine ; chaque client recompose
   l'avatar de l'autre à l'identique (même seed ⇒ même bonhomme). */
const AV_STYLE = "avataaars";
const AV_BG = "b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf,d1f4d9,ffeeb3";
// Galerie d'avatars à CHOISIR (chaque graine = un bonhomme distinct et fixe).
const AVATARS = ["Felix", "Luna", "Milo", "Zoe", "Oscar", "Nina", "Hugo", "Lea", "Tom", "Emma", "Sam", "Jade"];
function avatarURL(choice) {
  const seed = AVATARS[choice] || AVATARS[0];
  return "https://api.dicebear.com/9.x/" + AV_STYLE + "/svg?seed=" +
         encodeURIComponent(seed) + "&backgroundColor=" + AV_BG;
}
function setAvatar(elId, choice) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = '<img src="' + avatarURL(choice) + '" alt="" draggable="false" />';
}
function buildAvatarGrid() {
  const grid = $("avatar-grid");
  if (!grid) return;
  grid.innerHTML = "";
  AVATARS.forEach((seed, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-opt" + (i === G.avatarChoice ? " on" : "");
    b.dataset.i = i;
    b.setAttribute("aria-label", "Avatar " + (i + 1));
    b.innerHTML = '<img src="' + avatarURL(i) + '" alt="" draggable="false" />';
    grid.appendChild(b);
  });
}
function selectAvatar(i) {
  G.avatarChoice = i;
  try { localStorage.setItem("geoq-av", String(i)); } catch (e) {}
  const grid = $("avatar-grid");
  if (grid) grid.querySelectorAll(".avatar-opt").forEach((b) =>
    b.classList.toggle("on", parseInt(b.dataset.i, 10) === i));
  setAvatar("avatar-current", i);
  // en lobby : mettre à jour mon avatar et prévenir les autres joueurs
  if (G.online.active) {
    const meP = myPlayer(); if (meP) meP.av = i;
    if (G.online.isHost) broadcastRoster();
    else sendToHost({ type: "hello", name: G.playerName, av: i });
  }
  renderLobby();
}
function updatePlayerLabels() { updateMultiHud(); }

/* ---------- état global ---------- */
const G = {
  mode: "solo",
  rounds: 5,
  current: 0,
  locations: [],
  scores: [],
  guess: null,
  submitted: false,
  lastDist: null,
  playerName: "",
  avatarChoice: 0,
  pano: null,
  gmap: null,
  marker: null,
  startPov: null,
  locationWaiters: {},
  locationBatch: 0,
  zoneFilter: "world",
  countryFilter: "france",
  timeLimit: 0,
  timer: null,
  online: {
    active: false, peer: null, isHost: false, code: null, started: false,
    myId: null, hostConn: null, conns: {}, players: {}, order: [],
    revealed: false, iWantReplay: false, ka: null,
  },
};

/* ===========================================================
   Google Maps loader
   =========================================================== */
let mapsReady = false;
function loadMaps() {
  if (!CONFIG.GMAPS_KEY || CONFIG.GMAPS_KEY.indexOf("__GMAPS") === 0) {
    setMapsState("⚠️ Clé Google Maps manquante (à ajouter dans game.js)");
    return;
  }
  const s = document.createElement("script");
  s.src = "https://maps.googleapis.com/maps/api/js?key=" + CONFIG.GMAPS_KEY +
          "&libraries=geometry&loading=async&callback=onMapsReady";
  s.async = true;
  s.onerror = () => setMapsState("⚠️ Échec du chargement de Google Maps");
  document.head.appendChild(s);
}
window.onMapsReady = function () {
  mapsReady = true;
  setMapsState("Prêt à jouer ✓");
};

/* ===========================================================
   Régions à bonne couverture Street View
   [latMin, latMax, lngMin, lngMax, poids]
   =========================================================== */
const REGIONS = [
  [30, 47, -122, -75, 5],   // USA continental
  [43, 55, -4, 15, 5],      // Europe de l'Ouest
  [51, 57, -8, 0, 2],       // Royaume-Uni / Irlande
  [37, 43, -9, 2, 2],       // Espagne / Portugal
  [38, 45, 8, 17, 2],       // Italie
  [55, 64, 5, 25, 2],       // Scandinavie
  [48, 54, 12, 24, 2],      // Pologne / Europe centrale
  [33, 43, 131, 142, 3],    // Japon
  [35, 38, 126, 129, 1],    // Corée du Sud
  [-38, -28, 140, 153, 3],  // Australie SE
  [-46, -36, 167, 178, 1],  // Nouvelle-Zélande
  [-30, -20, -52, -43, 2],  // Brésil S/SE
  [-38, -31, -71, -58, 2],  // Argentine / Chili central
  [-34, -26, 18, 31, 2],    // Afrique du Sud
  [19, 26, -105, -98, 1],   // Mexique
  [43, 50, -123, -73, 2],   // Canada sud
  [37, 41, 27, 40, 1],      // Turquie
  [6, 19, 98, 106, 1],      // Thaïlande / Malaisie
  [52, 60, 30, 50, 1],      // Russie ouest
];
const ZONE_REGIONS = {
  world: REGIONS,
  europe: [[43, 55, -4, 15, 5], [51, 57, -8, 0, 2], [37, 43, -9, 2, 2], [38, 45, 8, 17, 2], [55, 64, 5, 25, 2], [48, 54, 12, 24, 2], [47, 55, 5, 15, 2], [42, 51, -5, 9, 2]],
  "north-america": [[30, 47, -122, -75, 5], [43, 50, -123, -73, 2], [19, 26, -105, -98, 1]],
  "south-america": [[-30, -20, -52, -43, 2], [-38, -31, -71, -58, 2], [-35, -22, -62, -48, 1]],
  asia: [[33, 43, 131, 142, 3], [35, 38, 126, 129, 1], [37, 41, 27, 40, 1], [6, 19, 98, 106, 1], [22, 26, 120, 122, 1]],
  oceania: [[-38, -28, 140, 153, 3], [-46, -36, 167, 178, 1]],
  africa: [[-34, -26, 18, 31, 3], [30, 36, -10, 11, 1]],
};
const COUNTRY_REGIONS = {
  france: [[42.3, 51.1, -5.1, 8.3, 5]],
  usa: [[30, 47, -122, -75, 5]],
  canada: [[43, 50, -123, -73, 4]],
  "uk-ireland": [[51, 57, -8, 0, 4]],
  "spain-portugal": [[37, 43, -9, 2, 4]],
  italy: [[38, 45, 8, 17, 4]],
  germany: [[47, 55, 5, 15, 4]],
  japan: [[33, 43, 131, 142, 4]],
  "south-korea": [[35, 38, 126, 129, 4]],
  australia: [[-38, -28, 140, 153, 4]],
  "new-zealand": [[-46, -36, 167, 178, 4]],
  brazil: [[-30, -20, -52, -43, 4]],
  "argentina-chile": [[-38, -31, -71, -58, 4]],
  "south-africa": [[-34, -26, 18, 31, 4]],
  mexico: [[19, 26, -105, -98, 4]],
};
// Villes précises jouables (zone "city-<clé>") : [clé, label, lat, lng, rayon m]
// [clé, label, lat, lng, rayon m, code INSEE (pour le contour de commune)]
const CITIES_FR = [
  ["city-bordeaux", "Bordeaux", 44.8378, -0.5792, 9000, "33063"],
  ["city-paris", "Paris", 48.8566, 2.3522, 12000, "75056"],
  ["city-lyon", "Lyon", 45.7640, 4.8357, 9000, "69123"],
  ["city-marseille", "Marseille", 43.2965, 5.3698, 9000, "13055"],
  ["city-toulouse", "Toulouse", 43.6047, 1.4442, 8000, "31555"],
  ["city-nice", "Nice", 43.7102, 7.2620, 7000, "06088"],
  ["city-nantes", "Nantes", 47.2184, -1.5536, 8000, "44109"],
  ["city-strasbourg", "Strasbourg", 48.5734, 7.7521, 7000, "67482"],
  ["city-lille", "Lille", 50.6292, 3.0573, 7000, "59350"],
  ["city-montpellier", "Montpellier", 43.6119, 3.8772, 7000, "34172"],
  ["city-rennes", "Rennes", 48.1173, -1.6778, 7000, "35238"],
  ["city-grenoble", "Grenoble", 45.1885, 5.7245, 7000, "38185"],
];
const CITIES_WORLD = [
  ["city-londres", "Londres", 51.5074, -0.1278, 14000],
  ["city-new-york", "New York", 40.7128, -74.0060, 16000],
  ["city-tokyo", "Tokyo", 35.6762, 139.6503, 18000],
  ["city-berlin", "Berlin", 52.5200, 13.4050, 13000],
  ["city-madrid", "Madrid", 40.4168, -3.7038, 12000],
  ["city-rome", "Rome", 41.9028, 12.4964, 11000],
  ["city-amsterdam", "Amsterdam", 52.3676, 4.9041, 9000],
  ["city-barcelone", "Barcelone", 41.3851, 2.1734, 10000],
  ["city-montreal", "Montréal", 45.5019, -73.5674, 12000],
  ["city-sydney", "Sydney", -33.8688, 151.2093, 14000],
  ["city-los-angeles", "Los Angeles", 34.0522, -118.2437, 18000],
  ["city-singapour", "Singapour", 1.3521, 103.8198, 11000],
];
// 13 régions métropolitaines (zone "fr-<clé>") : [clé, label, latMin, latMax, lngMin, lngMax]
const FR_REGIONS = [
  ["fr-idf", "Île-de-France", 48.12, 49.24, 1.45, 3.56],
  ["fr-naq", "Nouvelle-Aquitaine", 42.78, 47.18, -1.79, 2.62],
  ["fr-ara", "Auvergne-Rhône-Alpes", 44.12, 46.80, 2.06, 7.19],
  ["fr-occ", "Occitanie", 42.33, 45.05, -0.33, 4.85],
  ["fr-hdf", "Hauts-de-France", 48.84, 51.09, 1.38, 4.26],
  ["fr-ges", "Grand Est", 47.42, 50.17, 3.39, 8.23],
  ["fr-pac", "Provence-Alpes-Côte d'Azur", 43.00, 45.13, 4.23, 7.72],
  ["fr-pdl", "Pays de la Loire", 46.27, 48.57, -2.55, 0.92],
  ["fr-nor", "Normandie", 48.18, 50.07, -1.95, 1.80],
  ["fr-bre", "Bretagne", 47.28, 48.90, -5.14, -1.02],
  ["fr-bfc", "Bourgogne-Franche-Comté", 46.16, 48.40, 2.84, 7.14],
  ["fr-cvl", "Centre-Val de Loire", 46.35, 48.94, 0.05, 3.13],
  ["fr-cor", "Corse", 41.33, 43.03, 8.53, 9.56],
];
const CITY_ZONES = {};
[].concat(CITIES_FR, CITIES_WORLD).forEach((c) => { CITY_ZONES[c[0]] = [c[2], c[3], c[4]]; });
const FR_REGION_ZONES = {};
FR_REGIONS.forEach((r) => { FR_REGION_ZONES[r[0]] = [[r[2], r[3], r[4], r[5], 1]]; });
const WORLD_CITIES = [
  [40.7128, -74.0060, 23000, 3], [34.0522, -118.2437, 30000, 2], [41.8781, -87.6298, 22000, 2],
  [51.5074, -0.1278, 22000, 3], [48.8566, 2.3522, 18000, 3], [52.5200, 13.4050, 18000, 2],
  [40.4168, -3.7038, 18000, 2], [41.9028, 12.4964, 16000, 2], [52.3676, 4.9041, 14000, 2],
  [35.6762, 139.6503, 26000, 3], [34.6937, 135.5023, 18000, 2], [37.5665, 126.9780, 22000, 2],
  [1.3521, 103.8198, 16000, 2], [13.7563, 100.5018, 22000, 2], [-33.8688, 151.2093, 22000, 2],
  [-37.8136, 144.9631, 20000, 2], [-23.5505, -46.6333, 26000, 2], [-34.6037, -58.3816, 22000, 2],
  [-33.9249, 18.4241, 18000, 2], [45.5019, -73.5674, 18000, 2], [43.6532, -79.3832, 20000, 2],
];
const FRANCE_CITIES = [
  [48.8566, 2.3522, 15000, 4], [45.7640, 4.8357, 12000, 3], [43.2965, 5.3698, 12000, 3],
  [43.6047, 1.4442, 11000, 2], [43.7102, 7.2620, 10000, 2], [47.2184, -1.5536, 10000, 2],
  [48.5734, 7.7521, 9000, 2], [43.6119, 3.8772, 9000, 2], [44.8378, -0.5792, 10000, 2],
  [50.6292, 3.0573, 10000, 2], [48.1173, -1.6778, 9000, 1], [45.1885, 5.7245, 9000, 1],
  [47.3220, 5.0415, 8000, 1], [49.2583, 4.0317, 8000, 1], [49.4944, 0.1079, 8000, 1],
  [43.1242, 5.9280, 8000, 1], [47.4784, -0.5632, 8000, 1], [45.4397, 4.3872, 8000, 1],
];
function weightedPick(items) {
  const total = items.reduce((t, r) => t + (r[3] && r.length === 4 ? r[3] : r[4] || 1), 0);
  let x = Math.random() * total;
  for (const r of items) {
    x -= (r[3] && r.length === 4 ? r[3] : r[4] || 1);
    if (x <= 0) return r;
  }
  return items[0];
}
function randomPointNear(lat, lng, meters) {
  const d = Math.sqrt(Math.random()) * meters;
  const a = Math.random() * Math.PI * 2;
  return {
    lat: lat + (Math.cos(a) * d) / 111320,
    lng: lng + (Math.sin(a) * d) / (111320 * Math.cos(lat * Math.PI / 180)),
  };
}
function activePool() {
  if (G.zoneFilter === "world-cities") return { type: "city", items: WORLD_CITIES };
  if (G.zoneFilter === "france-cities") return { type: "city", items: FRANCE_CITIES };
  if (CITY_ZONES[G.zoneFilter]) return { type: "city", items: [CITY_ZONES[G.zoneFilter]] };
  if (FR_REGION_ZONES[G.zoneFilter]) return { type: "region", items: FR_REGION_ZONES[G.zoneFilter] };
  if (G.zoneFilter === "country") return { type: "region", items: COUNTRY_REGIONS[G.countryFilter] || COUNTRY_REGIONS.france };
  return { type: "region", items: ZONE_REGIONS[G.zoneFilter] || REGIONS };
}
// Ajoute villes (FR / Monde) et régions de France en sous-groupes, dans les 3 sélecteurs
function fillZoneOptions() {
  const groups = [
    ["Villes de France", CITIES_FR.map((c) => [c[0], "🏙 " + c[1]])],
    ["Villes du monde", CITIES_WORLD.map((c) => [c[0], "🏙 " + c[1]])],
    ["Régions de France", FR_REGIONS.map((r) => [r[0], "📍 " + r[1]])],
  ];
  ["zone-filter", "online-zone-filter", "room-zone-filter"].forEach((id) => {
    const sel = $(id);
    if (!sel || sel.dataset.zonesDone) return;
    groups.forEach(([label, items]) => {
      const og = document.createElement("optgroup");
      og.label = label;
      items.forEach(([val, txt]) => {
        const o = document.createElement("option");
        o.value = val; o.textContent = txt;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.dataset.zonesDone = "1";
  });
}
/* ===========================================================
   Sélecteur de zone visuel (cartes avec aperçu de la carte)
   =========================================================== */
// Tuile CartoDB (sombre, comme le jeu) contenant le point, à un zoom donné.
function tileURL(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = ((Math.floor((lng + 180) / 360 * n)) % n + n) % n;
  const lr = lat * Math.PI / 180;
  let y = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
  y = Math.max(0, Math.min(n - 1, y));
  return "https://a.basemaps.cartocdn.com/dark_all/" + z + "/" + x + "/" + y + ".png";
}
// Catalogue trié par catégorie. {l:label, z:zoneFilter, co:countryFilter?, la,lo:centre, tz:zoom tuile}
function zoneGroups() {
  const byLabel = (a, b) => a.l.localeCompare(b.l, "fr", { sensitivity: "base" });
  const frReg = FR_REGIONS.map((r) => ({ l: r[1], z: r[0], la: (r[2] + r[3]) / 2, lo: (r[4] + r[5]) / 2, tz: 6 })).sort(byLabel);
  const frCity = CITIES_FR.map((c) => ({ l: c[1], z: c[0], la: c[2], lo: c[3], tz: 10 })).sort(byLabel);
  const wCity = CITIES_WORLD.map((c) => ({ l: c[1], z: c[0], la: c[2], lo: c[3], tz: 10 })).sort(byLabel);
  // pays : France en tête (favori), puis ordre alphabétique
  const FR = { l: "France", co: "france", la: 46.6, lo: 2.4, tz: 5 };
  const others = [
    { l: "États-Unis", co: "usa", la: 39, lo: -98, tz: 3 },
    { l: "Canada", co: "canada", la: 56, lo: -100, tz: 3 },
    { l: "Royaume-Uni / Irlande", co: "uk-ireland", la: 54, lo: -4, tz: 5 },
    { l: "Espagne / Portugal", co: "spain-portugal", la: 40, lo: -4, tz: 5 },
    { l: "Italie", co: "italy", la: 42, lo: 12.5, tz: 5 },
    { l: "Allemagne", co: "germany", la: 51, lo: 10, tz: 5 },
    { l: "Japon", co: "japan", la: 37, lo: 138, tz: 5 },
    { l: "Corée du Sud", co: "south-korea", la: 36.5, lo: 127.8, tz: 6 },
    { l: "Australie", co: "australia", la: -25, lo: 134, tz: 4 },
    { l: "Nouvelle-Zélande", co: "new-zealand", la: -41, lo: 173, tz: 5 },
    { l: "Brésil", co: "brazil", la: -12, lo: -50, tz: 3 },
    { l: "Argentine / Chili", co: "argentina-chile", la: -35, lo: -65, tz: 4 },
    { l: "Afrique du Sud", co: "south-africa", la: -30, lo: 24, tz: 5 },
    { l: "Mexique", co: "mexico", la: 23, lo: -102, tz: 4 },
  ].sort(byLabel);
  const countries = [FR, ...others].map((c) => ({ ...c, z: "country" }));
  return [
    ["🌍 Le monde", [
      { l: "Monde entier", z: "world", la: 25, lo: 0, tz: 1 },
    ]],
    ["🧭 Continents", [
      { l: "Europe", z: "europe", la: 50, lo: 10, tz: 3 },
      { l: "Amérique du Nord", z: "north-america", la: 45, lo: -100, tz: 2 },
      { l: "Amérique du Sud", z: "south-america", la: -15, lo: -60, tz: 2 },
      { l: "Asie", z: "asia", la: 35, lo: 100, tz: 2 },
      { l: "Afrique", z: "africa", la: 2, lo: 20, tz: 2 },
      { l: "Océanie", z: "oceania", la: -25, lo: 140, tz: 3 },
    ]],
    ["🏳️ Pays", countries],
    ["🌆 Villes du monde", [
      { l: "Toutes les grandes villes du monde", z: "world-cities", la: 25, lo: 0, tz: 1 },
      ...wCity,
    ]],
    ["🇫🇷 Régions de France", frReg],
    ["🏙️ Villes de France", [
      { l: "Toutes les grandes villes de France", z: "france-cities", la: 46.6, lo: 2.4, tz: 5 },
      ...frCity,
    ]],
  ];
}
function zoneLabel() {
  let label = "Monde entier";
  zoneGroups().forEach((g) => g[1].forEach((e) => {
    if (e.z === G.zoneFilter && (!e.co || e.co === G.countryFilter)) label = e.l;
  }));
  return label;
}
function buildZoneModal() {
  const wrap = $("zone-groups");
  if (!wrap || wrap.dataset.built) return;
  zoneGroups().forEach((g) => {
    const sec = document.createElement("div");
    sec.className = "zone-section";
    const h = document.createElement("div");
    h.className = "zone-cat"; h.textContent = g[0];
    sec.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "zone-grid";
    g[1].forEach((e) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "zone-card";
      b.dataset.z = e.z; b.dataset.co = e.co || "";
      b.innerHTML =
        '<div class="zone-card-map" data-la="' + e.la + '" data-lo="' + e.lo + '" data-lz="' + e.tz + '" data-z="' + e.z + '" data-co="' + (e.co || "") + '"></div>' +
        '<span class="zone-card-label">' + e.l + "</span>";
      grid.appendChild(b);
    });
    sec.appendChild(grid);
    wrap.appendChild(sec);
  });
  wrap.dataset.built = "1";
  highlightZone();
}
// Filtre les zones par texte (recherche). Cache les sections devenues vides.
function filterZones(q) {
  q = (q || "").trim().toLowerCase();
  document.querySelectorAll("#zone-groups .zone-section").forEach((sec) => {
    let any = false;
    sec.querySelectorAll(".zone-card").forEach((b) => {
      const lbl = b.querySelector(".zone-card-label");
      const ok = !q || (lbl && lbl.textContent.toLowerCase().indexOf(q) >= 0);
      b.style.display = ok ? "" : "none";
      if (ok) any = true;
    });
    sec.style.display = any ? "" : "none";
  });
}
function highlightZone() {
  const wrap = $("zone-groups"); if (!wrap) return;
  wrap.querySelectorAll(".zone-card").forEach((b) => {
    b.classList.toggle("on", b.dataset.z === G.zoneFilter &&
      (b.dataset.z !== "country" || b.dataset.co === G.countryFilter));
  });
}
// Contour (frontière) de la zone, si elle a une étendue distincte.
function zoneShape(z, co) {
  if (CITY_ZONES[z]) { const c = CITY_ZONES[z]; return { circle: [c[0], c[1]], r: c[2] }; }
  if (FR_REGION_ZONES[z]) return { boxes: FR_REGION_ZONES[z] };
  if (ZONE_REGIONS[z]) return { boxes: ZONE_REGIONS[z] };
  if (z === "country" && COUNTRY_REGIONS[co]) return { boxes: COUNTRY_REGIONS[co] };
  if (z === "france-cities") return { boxes: [[42.3, 51.1, -5.1, 8.3, 1]] };
  return null; // monde / grandes villes du monde : pas de contour
}
// Frontières réelles (GeoJSON), chargées une seule fois à la demande.
// Géométries des zones (continents fusionnés en un trait, pays, régions, communes FR,
// villes du monde) pré-calculées et embarquées dans zones-geo.json — un seul fetch local.
let ZGEO = null;
function loadZones() {
  if (ZGEO) return Promise.resolve(ZGEO);
  if (loadZones._p) return loadZones._p;
  loadZones._p = fetch("zones-geo.json?v=21").then((r) => r.json())
    .then((j) => { ZGEO = j; return j; }).catch(() => { ZGEO = {}; return ZGEO; });
  return loadZones._p;
}
function zoneFeatures(z, co) {
  if (!ZGEO) return null;
  const g = ZGEO[(z === "country") ? "country:" + co : z];
  return g ? [{ type: "Feature", geometry: g }] : null;
}
// Mini-carte non interactive : tuile + frontière réelle, cadrée sur la bbox "métropole".
function bboxOf(boxes) {
  let a = 90, b2 = -90, c2 = 180, d2 = -180;
  boxes.forEach((bx) => { a = Math.min(a, bx[0]); b2 = Math.max(b2, bx[1]); c2 = Math.min(c2, bx[2]); d2 = Math.max(d2, bx[3]); });
  return L.latLngBounds([[a, c2], [b2, d2]]);
}
function makeMiniMap(el, la, lo, zoom, zoneVal, co) {
  if (!el || el._zmap || typeof L === "undefined") return null;
  const m = L.map(el, {
    zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tap: false,
    inertia: false, fadeAnimation: false,
  });
  L.tileLayer(TILE_URL, TILE_OPT).addTo(m);
  el._zmap = m;
  // Monde entier / grandes villes du monde : aucun trait, dézoom maximal
  if (zoneVal === "world" || zoneVal === "world-cities") {
    m.fitWorld();
    setTimeout(() => { try { m.invalidateSize(); m.fitWorld(); } catch (e) {} }, 60);
    return m;
  }
  const stLine = { color: "#2ee6a6", weight: 2, fillColor: "#2ee6a6", fillOpacity: 0.14 };
  const s = zoneShape(zoneVal, co);
  // Cadrage = bbox "métropole" (pays/continents/régions) pour éviter Guyane/Alaska
  let bounds = (s && s.boxes) ? bboxOf(s.boxes) : null;
  const feats = zoneFeatures(zoneVal, co);
  if (feats && feats.length) {
    const gj = L.geoJSON({ type: "FeatureCollection", features: feats }, { style: stLine }).addTo(m);
    if (!bounds) bounds = gj.getBounds();                 // villes / régions : cadre sur le tracé
  } else if (s && s.circle) {
    L.circle([s.circle[0], s.circle[1]], Object.assign({ radius: s.r }, stLine)).addTo(m);  // villes du monde
    if (!bounds) bounds = L.latLng(s.circle[0], s.circle[1]).toBounds(s.r * 2.2);
  } else if (s && s.boxes) {
    L.rectangle(bounds, stLine).addTo(m);                 // secours si frontières non chargées
  }
  if (bounds) m.fitBounds(bounds, { padding: [8, 8], maxZoom: 12 });
  else m.setView([la, lo], zoom);
  setTimeout(() => { try { m.invalidateSize(); if (bounds) m.fitBounds(bounds, { padding: [8, 8], maxZoom: 12 }); } catch (e) {} }, 60);
  return m;
}
// Crée les mini-cartes des zones à la demande (quand la carte entre dans la vue)
let zoneObserver = null;
function initZoneMaps() {
  const root = document.querySelector("#zone-modal .modal-card");
  if (!root) return;
  if (!zoneObserver) {
    zoneObserver = new IntersectionObserver((ents) => {
      ents.forEach((en) => {
        if (!en.isIntersecting) return;
        const d = en.target.dataset;
        makeMiniMap(en.target, parseFloat(d.la), parseFloat(d.lo), parseInt(d.lz, 10), d.z, d.co);
        zoneObserver.unobserve(en.target);
      });
    }, { root: root, rootMargin: "150px" });
  }
  document.querySelectorAll("#zone-groups .zone-card-map").forEach((el) => {
    if (!el._zmap) zoneObserver.observe(el);
  });
}
// Met à jour les 3 déclencheurs de zone (menu / online / salon) : texte + mini-carte
function updateZoneTrigger() {
  let cur = null;
  zoneGroups().forEach((g) => g[1].forEach((e) => {
    if (e.z === G.zoneFilter && (!e.co || e.co === G.countryFilter)) cur = e;
  }));
  ["zone", "online-zone", "room-zone"].forEach((pre) => {
    const txt = $(pre + "-trigger-txt");
    if (txt) txt.textContent = zoneLabel();
    const el = $(pre + "-trigger-map");
    if (el && cur) {
      if (el._zmap) { try { el._zmap.remove(); } catch (e) {} el._zmap = null; el.innerHTML = ""; }
      makeMiniMap(el, cur.la, cur.lo, cur.tz, cur.z, cur.co);
    }
  });
}
function selectZone(z, co) {
  G.zoneFilter = z;
  if (co) G.countryFilter = co;
  // synchronise les 3 sélecteurs cachés (compat read/mirror)
  ["zone-filter", "online-zone-filter", "room-zone-filter"].forEach((id) => { const s = $(id); if (s) s.value = z; });
  if (co) ["country-filter", "online-country-filter", "room-country-filter"].forEach((id) => { const s = $(id); if (s) s.value = co; });
  highlightZone();
  updateZoneTrigger();
  $("zone-modal").hidden = true;
  if ($("room-settings")) $("room-settings").textContent = settingsText();
  // en salon (hôte) : prévenir le joueur 2 de la nouvelle zone
  if (G.online.active && G.online.isHost && !G.online.started) sendRoomSettings();
}
function setRoundSeg(id, rounds) {
  $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("on", parseInt(b.dataset.r, 10) === rounds));
}
function selectedRounds(id) {
  const selected = $(id).querySelector("button.on");
  return selected ? parseInt(selected.dataset.r, 10) : G.rounds;
}
function selectedTime(id) {
  const sel = $(id) && $(id).querySelector("button.on");
  return sel ? parseInt(sel.dataset.t, 10) * 60 : G.timeLimit;
}
function setTimeSeg(id, seconds) {
  const mins = Math.round((seconds || 0) / 60);
  if ($(id)) $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("on", parseInt(b.dataset.t, 10) === mins));
}
function readMenuSettings() {
  G.zoneFilter = $("zone-filter").value;
  G.countryFilter = $("country-filter").value;
}
function readOnlineSettings() {
  G.rounds = selectedRounds("online-rounds-seg");
  G.timeLimit = selectedTime("online-time-seg");
  G.zoneFilter = $("online-zone-filter").value;
  G.countryFilter = $("online-country-filter").value;
}
function readRoomSettings() {
  G.rounds = selectedRounds("room-rounds-seg");
  G.timeLimit = selectedTime("room-time-seg");
  G.zoneFilter = $("room-zone-filter").value;
  G.countryFilter = $("room-country-filter").value;
}
function mirrorSettingsToOnline() {
  setRoundSeg("online-rounds-seg", G.rounds);
  setTimeSeg("online-time-seg", G.timeLimit);
  $("online-zone-filter").value = G.zoneFilter;
  $("online-country-filter").value = G.countryFilter;
  updateZoneTrigger();
}
function mirrorSettingsToRoom() {
  setRoundSeg("room-rounds-seg", G.rounds);
  setTimeSeg("room-time-seg", G.timeLimit);
  $("room-zone-filter").value = G.zoneFilter;
  $("room-country-filter").value = G.countryFilter;
  $("room-settings").textContent = settingsText();
  updateZoneTrigger();
}
function sendRoomSettings() {
  if (!G.online.isHost || G.online.started) return;
  readRoomSettings();
  $("room-settings").textContent = settingsText();
  broadcast({ type: "settings", rounds: G.rounds, zone: G.zoneFilter, country: G.countryFilter, time: G.timeLimit });
}
function applyRemoteSettings(m) {
  G.rounds = m.rounds || G.rounds;
  if (m.time != null) G.timeLimit = m.time;
  G.zoneFilter = m.zone || G.zoneFilter;
  G.countryFilter = m.country || G.countryFilter;
  mirrorSettingsToOnline();
  mirrorSettingsToRoom();
  $("room-settings").textContent = settingsText();
}
function pickRegion() {
  return weightedPick(activePool().items);
}

/* ===========================================================
   Génération / validation des lieux (StreetViewService)
   =========================================================== */
async function findOneLocation() {
  const sv = new google.maps.StreetViewService();
  for (let attempt = 0; attempt < 40; attempt++) {
    const pool = activePool();
    const r = pickRegion();
    const target = pool.type === "city"
      ? randomPointNear(r[0], r[1], r[2])
      : { lat: rand(r[0], r[1]), lng: rand(r[2], r[3]) };
    const req = {
      location: target,
      radius: pool.type === "city" ? 12000 : 150000,
      // GOOGLE = imagerie officielle des voitures Street View uniquement
      // (exclut les photosphères utilisateur, qui rendent mal / en noir).
      source: google.maps.StreetViewSource.GOOGLE,
    };
    try {
      const res = await sv.getPanorama(req);
      const loc = res.data.location;
      return { lat: loc.latLng.lat(), lng: loc.latLng.lng(), panoId: loc.pano };
    } catch (e) { /* ZERO_RESULTS → on retente ailleurs */ }
  }
  return null;
}
async function makeLocations(n, onProgress) {
  const locs = [];
  let safety = 0;
  while (locs.length < n && safety < n * 50) {
    safety++;
    const loc = await findOneLocation();
    if (loc) { locs.push(loc); if (onProgress) onProgress(locs.length, n); }
  }
  return locs;
}
function resetLocations() {
  G.locations = [];
  G.locationWaiters = {};
  G.locationBatch++;
}
function setLocationAt(index, loc) {
  G.locations[index] = loc;
  (G.locationWaiters[index] || []).forEach((resolve) => resolve(loc));
  delete G.locationWaiters[index];
}
function waitForLocation(index) {
  if (G.locations[index]) return Promise.resolve(G.locations[index]);
  return new Promise((resolve) => {
    if (!G.locationWaiters[index]) G.locationWaiters[index] = [];
    G.locationWaiters[index].push(resolve);
  });
}
async function preloadRemainingLocations(startIndex, sendOnline) {
  const batch = G.locationBatch;
  for (let i = startIndex; i < G.rounds; i++) {
    if (batch !== G.locationBatch) return;
    if (G.locations[i]) continue;
    const loc = await findOneLocation();
    if (batch !== G.locationBatch) return;
    if (!loc) continue;
    setLocationAt(i, loc);
    if (sendOnline) sendMsg({ type: "location", index: i, loc: loc });
  }
}

/* ===========================================================
   Panorama + carte de guess
   =========================================================== */
// (Re)crée le panorama à chaque manche : setPano() sur un panorama existant
// ne rafraîchit pas toujours le rendu WebGL, recréer garantit l'image correcte.
function makePano(loc, pov) {
  G.pano = new google.maps.StreetViewPanorama($("pano"), {
    pano: loc.panoId,
    pov: pov,
    addressControl: false,    // cache le nom du lieu (sinon trop facile)
    showRoadLabels: false,    // cache les noms de rues
    fullscreenControl: false,
    motionTracking: false,
    motionTrackingControl: false,
    enableCloseButton: false,
    linksControl: true, panControl: true, zoomControl: true,
  });
}
// Cartes plates : Leaflet + tuiles sombres CartoDB (raster, sans WebGL ni clé)
const TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILE_OPT = { maxZoom: 19, subdomains: "abcd" };
function ensureGuessMap() {
  if (G.gmap) return;
  G.gmap = L.map("map", { worldCopyJump: true, zoomControl: true, attributionControl: false, minZoom: 1 })
    .setView([20, 0], 1);
  L.tileLayer(TILE_URL, TILE_OPT).addTo(G.gmap);
  G.gmap.on("click", (e) => placeGuess(e.latlng));
}
function placeGuess(latlng) {
  if (G.submitted) return;
  const style = { radius: 7, color: "#fff", weight: 2, fillColor: "#2ee6a6", fillOpacity: 1 };
  if (!G.marker) G.marker = L.circleMarker(latlng, style).addTo(G.gmap);
  else G.marker.setLatLng(latlng);
  G.guess = { lat: latlng.lat, lng: latlng.lng };
  $("btn-guess").disabled = false;
}

/* ===========================================================
   Boucle de jeu
   =========================================================== */
function cover(text) { $("pano-cover").classList.remove("hidden"); $("pano-cover-text").textContent = text; }
function uncover() { $("pano-cover").classList.add("hidden"); }

async function startSolo() {
  if (!mapsReady) { setMapsState("⏳ La carte charge encore…"); return; }
  if (!requirePlayerName()) return;
  readMenuSettings();
  G.mode = "solo"; G.online.active = false;
  showScreen("game");
  resetLocations();
  cover("Recherche du premier lieu…");
  const first = await findOneLocation();
  if (!first) { cover("Impossible de trouver un lieu. Réessaie."); return; }
  setLocationAt(0, first);
  beginRoundsLocal();
  preloadRemainingLocations(1, false);
}

function beginRoundsLocal() {
  G.current = 0; G.scores = []; G.submitted = false;
  playerList().forEach((p) => { p.scores = []; p.guess = null; p.done = false; });
  G.online.revealed = false;
  $("hud-opp").classList.toggle("hidden", !G.online.active);
  updatePlayerLabels();
  showScreen("game");
  loadRound();
}

async function loadRound() {
  const round = G.current;
  G.guess = null; G.submitted = false;
  if (G.online.active) resetRoundFlags();
  if (G.marker && G.gmap) { G.gmap.removeLayer(G.marker); G.marker = null; }
  $("btn-guess").disabled = true;
  $("guess-hint").textContent = "Place ton marqueur sur la carte";
  $("opp-flag").classList.add("hidden");

  $("hud-round").textContent = "Manche " + (round + 1) + "/" + G.rounds;
  $("hud-score").textContent = sum(G.scores) + " pts";
  updateMultiHud();

  ensureGuessMap();
  G.gmap.setView([20, 0], 1);
  setTimeout(() => G.gmap.invalidateSize(), 80);

  if (!G.locations[round]) cover("Préparation de la manche…");
  const loc = await waitForLocation(round);
  if (G.current !== round || !$("game").classList.contains("show")) return;

  cover("Chargement du panorama…");
  G.startPov = { heading: Math.random() * 360, pitch: 0, zoom: 0 };
  makePano(loc, G.startPov);
  let done = false;
  const reveal = () => { if (done) return; done = true; uncover(); startTimer(G.timeLimit); };
  google.maps.event.addListenerOnce(G.pano, "position_changed", reveal);
  setTimeout(reveal, 4000); // filet de sécurité
}

function resetView() {
  if (G.pano && G.startPov) { G.pano.setPov(G.startPov); G.pano.setZoom(0); }
}

function submitGuess() {
  if (!G.guess || G.submitted) return;
  clearTimer();
  G.submitted = true;
  $("btn-guess").disabled = true;
  const loc = G.locations[G.current];
  const d = distM(G.guess, loc);
  G.lastDist = d;
  G.scores[G.current] = scoreFor(d);

  if (G.online.active) {
    const g = { round: G.current, lat: G.guess.lat, lng: G.guess.lng, dist: d, pts: G.scores[G.current] };
    $("guess-hint").textContent = "✔ Deviné — en attente des autres joueurs…";
    registerGuess(meId(), g);
    if (G.online.isHost) hostOnGuess(meId());
    else sendToHost({ type: "guess", round: g.round, lat: g.lat, lng: g.lng, dist: g.dist, pts: g.pts });
  } else {
    revealRound();
  }
}

/* ---- arbitrage de la manche par l'hôte (N joueurs) ---- */
function hostOnGuess(fromId) {
  broadcast({ type: "progress", id: fromId, done: doneCount(), total: activePlayerCount() });
  updateMultiHud();
  if (!G.submitted && fromId !== meId()) shrinkTimerTo30();   // l'hôte n'a pas encore deviné
  if (allDone()) hostReveal();
}
function hostReveal() {
  if (G.online.revealed) return;
  G.online.revealed = true;
  const results = G.online.order.map((id) => {
    const g = G.online.players[id].guess || {};
    return { id, lat: g.lat != null ? g.lat : null, lng: g.lng != null ? g.lng : null, dist: g.dist != null ? g.dist : null, pts: g.pts || 0 };
  });
  broadcast({ type: "reveal", round: G.current, results });
  applyReveal(G.current, results);
}
function applyReveal(round, results) {
  (results || []).forEach((r) => {
    const p = G.online.players[r.id]; if (!p) return;
    p.guess = { lat: r.lat, lng: r.lng, dist: r.dist, pts: r.pts };
    p.done = true; p.scores[round] = r.pts;
  });
  G.online.revealed = true;
  revealRound();
}

function distM(a, b) {
  // distance grand-cercle (Haversine), en mètres
  const R = 6371000, toR = (x) => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function scoreFor(d) {
  const km = d / 1000;
  if (km < 0.15) return 5000;
  return Math.round(5000 * Math.exp(-km / 1500));
}

/* ---------- chrono + son ---------- */
let audioCtx = null;
function beep(freq, dur) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.value = freq || 880;
    g.gain.setValueAtTime(0.14, audioCtx.currentTime);
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + (dur || 0.16));
    o.stop(audioCtx.currentTime + (dur || 0.16));
  } catch (e) {}
}
function fmtTime(s) {
  s = Math.max(0, s | 0);
  const m = Math.floor(s / 60), ss = s % 60;
  return m + ":" + (ss < 10 ? "0" : "") + ss;
}
function clearTimer() {
  if (G.timer && G.timer.id) clearInterval(G.timer.id);
  G.timer = null;
  const el = $("hud-timer");
  if (el) { el.classList.add("hidden"); el.classList.remove("danger"); }
}
function startTimer(seconds) {
  clearTimer();
  if (!seconds || seconds <= 0) return;
  G.timer = { id: null, remaining: seconds, red: false };
  const el = $("hud-timer");
  if (el) { el.classList.remove("hidden", "danger"); el.textContent = "⏱ " + fmtTime(seconds); }
  G.timer.id = setInterval(tickTimer, 1000);
}
function tickTimer() {
  if (!G.timer) return;
  G.timer.remaining--;
  const el = $("hud-timer");
  if (G.timer.remaining <= 30 && !G.timer.red) {            // 30 s restantes : rouge + son
    G.timer.red = true;
    if (el) el.classList.add("danger");
    beep(880, 0.18);
  }
  if (el) el.textContent = "⏱ " + fmtTime(G.timer.remaining);
  if (G.timer.remaining <= 0) { clearTimer(); timeUp(); }
}
function timeUp() {
  if (G.submitted) return;
  beep(440, 0.32);
  if (G.guess) { submitGuess(); return; }
  // temps écoulé sans marqueur → 0 pt pour la manche
  G.submitted = true;
  G.scores[G.current] = 0;
  G.lastDist = null;
  $("btn-guess").disabled = true;
  if (G.online.active) {
    const g = { round: G.current, lat: null, lng: null, dist: null, pts: 0 };
    $("guess-hint").textContent = "⏱ Temps écoulé — en attente des autres…";
    registerGuess(meId(), g);
    if (G.online.isHost) hostOnGuess(meId());
    else sendToHost({ type: "guess", round: g.round, lat: g.lat, lng: g.lng, dist: g.dist, pts: g.pts });
  } else revealRound();
}
// multi : dès que l'adversaire a deviné, 30 s pour conclure (même en illimité)
function shrinkTimerTo30() {
  if (G.submitted) return;
  if (!G.timer) startTimer(30);
  else if (G.timer.remaining > 30) { G.timer.remaining = 30; G.timer.red = false; }
}

/* ---------- résultat de manche ---------- */
let resMap = null, resOverlays = [];
function ensureResultMap() {
  if (resMap) return;
  resMap = L.map("result-map", { worldCopyJump: true, zoomControl: true, attributionControl: false, minZoom: 1 })
    .setView([20, 0], 2);
  L.tileLayer(TILE_URL, TILE_OPT).addTo(resMap);
}
function clearResultOverlays() { resOverlays.forEach((o) => resMap.removeLayer(o)); resOverlays = []; }
function pin(latlng, color, r) {
  return L.circleMarker(latlng, { radius: r || 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 });
}
function drawResult(loc) {
  clearResultOverlays();
  const actual = [loc.lat, loc.lng];
  const pts = [actual];
  resOverlays.push(pin(actual, "#ffd35c", 9).addTo(resMap).bindTooltip("Lieu réel"));
  const drawFor = (la, ln, color, label) => {
    const g = [la, ln]; pts.push(g);
    resOverlays.push(pin(g, color).addTo(resMap).bindTooltip(label));
    resOverlays.push(L.polyline([g, actual], { color: color, weight: 2, dashArray: "4 6" }).addTo(resMap));
  };
  if (G.online.active) {
    playerList().forEach((p) => {
      const g = p.guess;
      if (g && g.lat != null) drawFor(g.lat, g.lng, playerColor(p.id), p.id === meId() ? "Toi" : p.name);
    });
  } else if (G.guess) {
    drawFor(G.guess.lat, G.guess.lng, "#2ee6a6", "Toi");
  }
  if (pts.length > 1) resMap.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 12 });
  else resMap.setView(actual, 5);
}

function revealRound() {
  clearTimer();
  showScreen("result");
  ensureResultMap();
  const loc = G.locations[G.current];
  resMap.invalidateSize();
  drawResult(loc);
  setTimeout(() => { resMap.invalidateSize(); drawResult(loc); }, 160);

  $("result-title").textContent = "Manche " + (G.current + 1) + " / " + G.rounds;
  renderResultRows();

  const last = G.current >= G.rounds - 1;
  $("btn-next").textContent = last ? "Voir le classement ›" : "Manche suivante ›";
  if (G.online.active && !G.online.isHost) {     // l'invité attend que l'hôte lance la suite
    $("btn-next").classList.add("hidden");
    $("next-wait").textContent = "En attente de l'hôte…";
    $("next-wait").classList.remove("hidden");
  } else {
    $("btn-next").classList.remove("hidden");
    $("next-wait").classList.add("hidden");
  }
}
function renderResultRows() {
  const box = $("result-rows"); if (!box) return;
  const round = G.current;
  let rows;
  if (G.online.active) {
    rows = playerList().map((p) => ({
      name: p.id === meId() ? (G.playerName || "Toi") : p.name, av: p.av, me: p.id === meId(),
      color: playerColor(p.id), dist: p.guess ? p.guess.dist : null, pts: (p.scores[round] || 0),
    }));
  } else {
    rows = [{ name: G.playerName || "Toi", av: G.avatarChoice, me: true, color: "#2ee6a6", dist: G.lastDist, pts: (G.scores[round] || 0) }];
  }
  rows.sort((a, b) => b.pts - a.pts);
  box.innerHTML = "";
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "result-row" + (r.me ? " me" : "");
    row.innerHTML =
      '<span class="rank">' + (i + 1) + "</span>" +
      '<span class="dot" style="background:' + r.color + '"></span>' +
      '<img class="rav" src="' + avatarURL(r.av) + '" alt="" draggable="false" />' +
      '<span class="who"></span>' +
      '<span class="dist">' + fmtDist(r.dist) + "</span>" +
      '<span class="pts">' + r.pts + " pts</span>";
    row.querySelector(".who").textContent = r.name;
    box.appendChild(row);
  });
}

function nextRound() {
  if (G.online.active) {
    if (!G.online.isHost) return;          // seul l'hôte (le chef) lance la manche suivante
    sendMsg({ type: "next", round: G.current });
    advance();
  } else advance();
}
function advance() {
  G.current++;
  if (G.current >= G.rounds) showFinal();
  else { showScreen("game"); loadRound(); }
}

function showFinal() {
  showScreen("final");
  const max = G.rounds * 5000;
  let rows;
  if (G.online.active) {
    rows = playerList().map((p) => ({ name: p.id === meId() ? (G.playerName || "Toi") : p.name, av: p.av, me: p.id === meId(), total: sum(p.scores) }));
  } else {
    rows = [{ name: G.playerName || "Toi", av: G.avatarChoice, me: true, total: sum(G.scores) }];
  }
  rows.sort((a, b) => b.total - a.total);
  const myRank = Math.max(0, rows.findIndex((r) => r.me));
  const myTotal = rows[myRank] ? rows[myRank].total : sum(G.scores);

  if (G.online.active) {
    if (myRank === 0) { $("final-emoji").textContent = "🏆"; $("final-title").textContent = "Victoire !"; }
    else if (myRank === 1) { $("final-emoji").textContent = "🥈"; $("final-title").textContent = "2ᵉ place !"; }
    else if (myRank === 2) { $("final-emoji").textContent = "🥉"; $("final-title").textContent = "3ᵉ place"; }
    else { $("final-emoji").textContent = "🎯"; $("final-title").textContent = (myRank + 1) + "ᵉ sur " + rows.length; }
  } else {
    const pct = myTotal / max;
    $("final-emoji").textContent = pct > .8 ? "🌟" : pct > .5 ? "🎯" : "🧭";
    $("final-title").textContent = "Partie terminée";
  }

  const box = $("final-scores");
  if (box) {
    box.innerHTML = "";
    const medals = ["🥇", "🥈", "🥉"];
    rows.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "final-score" + (r.me ? " me" : "");
      row.innerHTML =
        '<span class="frank">' + (G.online.active ? (medals[i] || ((i + 1) + "ᵉ")) : "") + "</span>" +
        '<img class="fav" src="' + avatarURL(r.av) + '" alt="" draggable="false" />' +
        '<span class="who"></span>' +
        '<span class="big">' + r.total.toLocaleString("fr-FR") + "</span>";
      row.querySelector(".who").textContent = r.name;
      box.appendChild(row);
    });
  }
  updateReplayUI();
}

function updateMultiHud(prog) {
  const el = $("hud-opp"); if (!el) return;
  if (!G.online.active) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const total = (prog && prog.total) || activePlayerCount();
  const done = (prog && typeof prog.done === "number") ? prog.done : doneCount();
  const av = $("hud-opp-av"); if (av) av.style.display = "none";
  const txt = $("hud-opp-txt");
  if (txt) txt.textContent = done > 0 ? ("✔ " + done + "/" + total + " ont deviné") : ("👥 " + total + " joueurs");
}
// liste des joueurs du salon : avatar + nom + croix d'exclusion (hôte uniquement)
function renderLobby() {
  const box = $("room-players"); if (!box) return;
  box.innerHTML = "";
  if (!G.online.active) return;
  playerList().forEach((p) => {
    const row = document.createElement("div");
    row.className = "lobby-player" + (p.id === meId() ? " me" : "");
    let html = '<img class="lobby-av" src="' + avatarURL(p.av) + '" alt="" draggable="false" />' +
               '<span class="lobby-name"></span>';
    if (p.isHost) html += '<span class="lobby-tag">hôte</span>';
    if (G.online.isHost && !G.online.started && p.id !== meId())
      html += '<button class="lobby-kick" data-kick="' + p.id + '" title="Exclure ce joueur">✕</button>';
    row.innerHTML = html;
    row.querySelector(".lobby-name").textContent = p.id === meId() ? ((G.playerName || "Toi") + " (toi)") : p.name;
    box.appendChild(row);
  });
}

/* ===========================================================
   MULTIJOUEUR — PeerJS (repris du projet d'échecs)
   =========================================================== */
const ICE = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
]};
function genCode() {
  const c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function onlineReset() {
  try { if (G.online.peer) G.online.peer.destroy(); } catch (e) {}
  clearInterval(G.online.ka);
  G.online = { active: false, peer: null, isHost: false, code: null, started: false,
               myId: null, hostConn: null, conns: {}, players: {}, order: [],
               revealed: false, iWantReplay: false, ka: null };
}
/* ---- réseau N joueurs : topologie en étoile, l'hôte relaie tout ---- */
function meId() { return G.online.myId; }
function myPlayer() { return G.online.players[meId()] || null; }
function playerList() { return G.online.order.map((id) => G.online.players[id]).filter(Boolean); }
function activePlayerCount() { return G.online.order.length; }
// invité → hôte (l'hôte n'envoie pas à lui-même, il applique localement)
function sendToHost(m) { try { if (!G.online.isHost && G.online.hostConn && G.online.hostConn.open) G.online.hostConn.send(m); } catch (e) {} }
// hôte → tous les invités (option : sauf un id)
function broadcast(m, exceptId) {
  if (!G.online.isHost) return;
  Object.keys(G.online.conns).forEach((id) => {
    if (id === exceptId) return;
    try { const c = G.online.conns[id]; if (c && c.open) c.send(m); } catch (e) {}
  });
}
// compat (réglages/hello) : diffuse si hôte, sinon envoie à l'hôte
function sendMsg(m) { if (G.online.isHost) broadcast(m); else sendToHost(m); }
function buildRoster() {
  return G.online.order.map((id) => { const p = G.online.players[id]; return { id, name: p.name, av: p.av, isHost: !!p.isHost }; });
}
function broadcastRoster() { if (G.online.isHost) broadcast({ type: "roster", players: buildRoster() }); renderLobby(); updateMultiHud(); }
function applyRoster(list) {
  const old = G.online.players;
  G.online.players = {}; G.online.order = [];
  (list || []).forEach((p) => {
    const prev = old[p.id] || {};
    G.online.players[p.id] = { id: p.id, name: p.name, av: p.av, isHost: !!p.isHost,
                               scores: prev.scores || [], guess: prev.guess || null, done: prev.done || false };
    G.online.order.push(p.id);
  });
  renderLobby(); updateMultiHud(); updatePlayerLabels();
}
function registerGuess(id, g) {
  const p = G.online.players[id]; if (!p) return;
  p.guess = g; p.done = true; if (Number.isInteger(g.round)) p.scores[g.round] = g.pts;
}
function resetRoundFlags() { playerList().forEach((p) => { p.guess = null; p.done = false; }); G.online.revealed = false; }
function doneCount() { return playerList().filter((p) => p.done).length; }
function allDone() { return activePlayerCount() > 0 && playerList().every((p) => p.done); }
function playerColor(id) {
  if (id === meId()) return "#2ee6a6";
  const PAL = ["#19b7e6", "#ff9f43", "#ee5a9b", "#a77dff", "#ffd35c", "#6be585", "#ff6b6b", "#5fa8ff"];
  const i = G.online.order.filter((x) => x !== meId()).indexOf(id);
  return PAL[((i % PAL.length) + PAL.length) % PAL.length];
}
function roomPeerId(code) {
  return "geoq2-" + location.hostname.replace(/[^a-z0-9-]/gi, "-") + "-" + code;
}
function updateLobbyControls() {
  if (!$("online").classList.contains("show")) return;
  if (!G.online.isHost) return;
  const guests = activePlayerCount() - 1;
  $("btn-start-room").classList.toggle("hidden", G.online.started);
  $("btn-start-room").disabled = guests < 1;
  if (!G.online.started)
    $("online-status").textContent = guests < 1 ? "En attente de joueurs…" : (activePlayerCount() + " joueurs connectés — prêt à lancer");
}
// l'hôte retire un joueur (déconnexion ou exclusion) et rediffuse la liste
function hostDropConn(id) {
  try { const c = G.online.conns[id]; if (c) c.close(); } catch (e) {}
  delete G.online.conns[id];
  if (G.online.players[id]) { delete G.online.players[id]; G.online.order = G.online.order.filter((x) => x !== id); }
  broadcastRoster();
  if (G.online.started) {
    if (!G.online.revealed && allDone()) hostReveal();
    flashStatus("Un joueur a quitté la partie");
  } else updateLobbyControls();
}
function kickPlayer(id) {
  if (!G.online.isHost || G.online.started || id === meId()) return;
  try { const c = G.online.conns[id]; if (c) { c.send({ type: "kick" }); setTimeout(() => { try { c.close(); } catch (e) {} }, 120); } } catch (e) {}
  hostDropConn(id);
}

function createRoom() {
  if (!mapsReady) { $("online-error").textContent = "La carte charge encore, patiente une seconde."; return; }
  if (typeof Peer === "undefined") { $("online-error").textContent = "Module réseau indisponible."; return; }
  if (!requirePlayerName("online-error")) return;
  readOnlineSettings();
  onlineReset();
  const code = genCode();
  G.online.code = code; G.online.isHost = true;
  $("online-error").textContent = "";
  $("online-choice").style.display = "none";
  $("online-wait").classList.add("show");
  $("btn-start-room").classList.add("hidden");
  $("btn-start-room").disabled = true;
  $("room-options").classList.remove("hidden");
  mirrorSettingsToRoom();
  $("room-code").textContent = "----";
  $("btn-copy").textContent = "Copier le lien";
  $("btn-copy").disabled = true;
  $("room-settings").textContent = settingsText();
  $("online-status").textContent = "Création de la salle…";

  const id = roomPeerId(code);
  const peer = new Peer(id, { debug: 0, secure: true, config: ICE });
  G.online.peer = peer;
  G.online.active = true;
  G.online.myId = id;
  G.online.players[id] = { id, name: G.playerName, av: G.avatarChoice, scores: [], guess: null, done: false, isHost: true };
  G.online.order = [id];
  renderLobby();
  peer.on("open", () => {
    if (G.online.peer !== peer || !G.online.isHost) return;
    $("room-code").textContent = code;
    $("btn-copy").disabled = false;
    $("online-status").textContent = "En attente de joueurs…";
  });
  peer.on("connection", (conn) => hostAcceptConn(conn));
  peer.on("error", (e) => {
    $("online-error").textContent = e.type === "unavailable-id" ? "Code déjà pris, réessaie." : "Erreur réseau : " + e.type;
    backToOnlineChoice();
  });
  peer.on("disconnected", () => { try { peer.reconnect(); } catch (e) {} });
  clearInterval(G.online.ka);
  G.online.ka = setInterval(() => broadcast({ type: "ping" }), 12000);
}
// l'hôte accepte une nouvelle connexion entrante (plusieurs invités possibles)
function hostAcceptConn(conn) {
  conn.on("open", () => {
    if (!G.online.isHost) { try { conn.close(); } catch (e) {} return; }
    if (G.online.started) { try { conn.send({ type: "kick", reason: "started" }); setTimeout(() => conn.close(), 120); } catch (e) {} return; }
    G.online.conns[conn.peer] = conn;
    $("online-status").textContent = "Un joueur se connecte…";
    conn.on("data", (m) => onData(m, conn.peer));
    conn.on("close", () => { if (G.online.conns[conn.peer]) hostDropConn(conn.peer); });
    conn.on("error", () => {});
  });
  conn.on("error", () => {});
}

function joinRoom(codeArg) {
  if (!mapsReady) { $("online-error").textContent = "La carte charge encore, patiente une seconde."; return; }
  if (typeof Peer === "undefined") { $("online-error").textContent = "Module réseau indisponible."; return; }
  if (!requirePlayerName("online-error")) return;
  const code = (codeArg || $("join-code").value || "").trim().toUpperCase();
  if (code.length < 4) { $("online-error").textContent = "Entre le code à 4 caractères."; return; }
  onlineReset();
  G.online.code = code; G.online.isHost = false;
  $("online-error").textContent = "";
  $("online-choice").style.display = "none";
  $("online-wait").classList.add("show");
  $("btn-start-room").classList.add("hidden");
  $("btn-start-room").disabled = true;
  $("room-options").classList.add("hidden");
  $("room-code").textContent = code;
  $("btn-copy").textContent = "Copier le lien";
  $("btn-copy").disabled = true;
  $("room-settings").textContent = "";
  $("online-status").textContent = "Connexion à la salle…";

  let attempts = 0;
  const deadline = Date.now() + 25000;
  const failJoin = (text) => {
    if (G.online.active || G.online.isHost) return;
    $("online-error").textContent = text;
    backToOnlineChoice();
  };
  const retryConnect = () => {
    if (G.online.active || G.online.isHost || G.online.code !== code) return;
    if (Date.now() >= deadline) {
      failJoin("Salle introuvable ou connexion impossible. Vérifie le code.");
      return;
    }
    try { if (G.online.peer) G.online.peer.destroy(); } catch (e) {}
    attempts++;
    $("online-status").textContent = attempts > 1 ? "Nouvelle tentative de connexion…" : "Connexion à la salle…";

    const peer = new Peer({ debug: 0, secure: true, config: ICE });
    G.online.peer = peer;
    const scheduleRetry = () => {
      if (!G.online.active && G.online.peer === peer && Date.now() < deadline) setTimeout(retryConnect, 900);
      else if (!G.online.active && G.online.peer === peer) failJoin("Salle introuvable ou connexion impossible. Vérifie le code.");
    };

    peer.on("open", () => {
      if (G.online.peer !== peer || G.online.isHost) return;
      const conn = peer.connect(roomPeerId(code), { reliable: true, serialization: "json" });
      let opened = false;
      const timer = setTimeout(() => { if (!opened) scheduleRetry(); }, 6000);
      conn.on("open", () => {
        opened = true;
        clearTimeout(timer);
        setupGuestConn(conn, peer);
      });
      conn.on("error", () => {
        clearTimeout(timer);
        scheduleRetry();
      });
      conn.on("close", () => {
        clearTimeout(timer);
        if (!G.online.active) scheduleRetry();
      });
    });
    peer.on("error", scheduleRetry);
    peer.on("disconnected", scheduleRetry);
  };
  retryConnect();
}

function setupGuestConn(conn, peer) {
  G.online.hostConn = conn;
  G.online.active = true;
  G.online.started = false;
  G.online.myId = (peer && peer.id) || (G.online.peer && G.online.peer.id);
  clearInterval(G.online.ka);
  G.online.ka = setInterval(() => { try { if (conn.open) conn.send({ type: "ping" }); } catch (e) {} }, 12000);

  // s'inscrire localement, puis se présenter à l'hôte (qui diffuse le roster complet)
  G.online.players = {}; G.online.order = [];
  G.online.players[meId()] = { id: meId(), name: G.playerName, av: G.avatarChoice, scores: [], guess: null, done: false, isHost: false };
  G.online.order = [meId()];

  conn.on("data", (m) => onData(m, "host"));
  conn.on("close", () => {
    clearInterval(G.online.ka);
    if (!G.online.started && $("online").classList.contains("show")) {
      $("online-error").textContent = "La salle a été fermée."; backToOnlineChoice();
    } else flashStatus("⚠️ Hôte déconnecté — partie terminée");
  });
  conn.on("error", () => flashStatus("⚠️ Problème de connexion"));
  sendToHost({ type: "hello", name: G.playerName, av: G.avatarChoice });
  $("online-status").textContent = "Connecté — en attente de l'hôte";
  renderLobby();
}

async function hostStartGame() {
  if (!G.online.active || !G.online.isHost || G.online.started) return;
  if (activePlayerCount() < 2) { $("online-status").textContent = "Il faut au moins un autre joueur pour lancer."; return; }
  readRoomSettings();
  G.online.started = true;
  $("btn-start-room").disabled = true;
  $("btn-start-room").classList.add("hidden");
  $("room-options").classList.add("hidden");
  broadcast({ type: "start", rounds: G.rounds, zone: G.zoneFilter, country: G.countryFilter, time: G.timeLimit });
  $("online-status").textContent = "Recherche des lieux…";
  showScreen("game");
  resetLocations();
  cover("Recherche du premier lieu…");
  const first = await findOneLocation();
  if (!first) { cover("Impossible de trouver un lieu."); return; }
  setLocationAt(0, first);
  broadcast({ type: "init", rounds: G.rounds, locations: G.locations });
  beginRoundsLocal();
  preloadRemainingLocations(1, true);
}

function onData(m, fromId) {
  if (!m || !m.type || m.type === "ping") return;

  if (m.type === "hello") {
    // [hôte] un invité se présente → l'ajouter au roster et le diffuser à tous
    if (G.online.isHost && fromId && fromId !== "host") {
      const exists = !!G.online.players[fromId];
      const prev = G.online.players[fromId] || {};
      G.online.players[fromId] = { id: fromId, name: cleanName(m.name || "Joueur"), av: m.av || 0,
        scores: prev.scores || [], guess: prev.guess || null, done: prev.done || false, isHost: false };
      if (!exists) G.online.order.push(fromId);
      broadcastRoster();
      const c = G.online.conns[fromId];
      try { if (c && c.open) c.send({ type: "settings", rounds: G.rounds, time: G.timeLimit, zone: G.zoneFilter, country: G.countryFilter }); } catch (e) {}
      updateLobbyControls();
    }

  } else if (m.type === "roster") {
    if (!G.online.isHost) applyRoster(m.players);

  } else if (m.type === "settings") {
    if (!G.online.isHost) { applyRemoteSettings(m); $("online-status").textContent = "Connecté — en attente de l'hôte"; }

  } else if (m.type === "start") {
    if (!G.online.isHost) { applyRemoteSettings(m); G.online.started = true; $("online-status").textContent = "L'hôte lance la partie…"; }

  } else if (m.type === "kick") {
    $("online-error").textContent = m.reason === "started" ? "La partie a déjà commencé sans toi." : "Tu as été exclu de la salle.";
    onlineReset(); backToOnlineChoice(); showScreen("online");

  } else if (m.type === "init") {
    if (!G.online.isHost) {
      G.online.started = true; G.rounds = m.rounds; resetLocations();
      (m.locations || []).forEach((loc, i) => { if (loc) setLocationAt(i, loc); });
      beginRoundsLocal();
    }

  } else if (m.type === "location") {
    if (!G.online.isHost && m.loc && Number.isInteger(m.index)) setLocationAt(m.index, m.loc);

  } else if (m.type === "guess") {
    // [hôte] un invité a deviné → enregistrer et arbitrer
    if (G.online.isHost && fromId && fromId !== "host") {
      registerGuess(fromId, { round: m.round, lat: m.lat, lng: m.lng, dist: m.dist, pts: m.pts });
      hostOnGuess(fromId);
    }

  } else if (m.type === "progress") {
    // [invité] l'hôte signale qu'un joueur a deviné → HUD + règle des 30 s
    if (!G.online.isHost) {
      updateMultiHud(m);
      if (!G.submitted) shrinkTimerTo30();
      $("opp-flag").classList.remove("hidden");
      $("opp-flag").textContent = (m.done || 0) + "/" + (m.total || activePlayerCount()) + " ont deviné";
    }

  } else if (m.type === "reveal") {
    if (!G.online.isHost) applyReveal(m.round, m.results);

  } else if (m.type === "next") {
    if (!G.online.isHost && $("result").classList.contains("show")) advance();   // l'hôte a lancé la manche suivante

  } else if (m.type === "replaystart") {
    if (!G.online.isHost) { showScreen("game"); cover("Nouvelle partie — l'hôte prépare les lieux…"); }
  }
}

function flashStatus(txt) {
  // affiche un message non bloquant selon l'écran courant
  if ($("game").classList.contains("show")) $("guess-hint").textContent = txt;
  else if ($("result").classList.contains("show")) $("next-wait").classList.remove("hidden"), ($("next-wait").textContent = txt);
  else $("online-status").textContent = txt;
}

function replay() {
  if (!G.online.active) { startSolo(); return; }
  if (!G.online.isHost) return;     // seul l'hôte relance la partie
  hostReplay();
}
function updateReplayUI() {
  const btn = $("btn-replay");
  if (!btn) return;
  if (!G.online.active || G.online.isHost) { btn.classList.remove("hidden"); btn.disabled = false; btn.textContent = "Rejouer"; }
  else btn.classList.add("hidden");   // l'invité attend que l'hôte relance
  const w = $("final-wait");
  if (w) w.classList.toggle("hidden", !(G.online.active && !G.online.isHost));
}
async function hostReplay() {
  broadcast({ type: "replaystart" });
  showScreen("game"); cover("Nouvelle partie — recherche des lieux…");
  resetLocations();
  const first = await findOneLocation();
  if (!first) { cover("Impossible de trouver un lieu."); return; }
  setLocationAt(0, first);
  broadcast({ type: "init", rounds: G.rounds, locations: G.locations });
  beginRoundsLocal();
  preloadRemainingLocations(1, true);
}

/* ---------- navigation online ---------- */
function backToOnlineChoice() {
  $("online-wait").classList.remove("show");
  $("online-choice").style.display = "flex";
  $("room-options").classList.add("hidden");
  $("btn-start-room").classList.add("hidden");
  $("btn-start-room").disabled = true;
  $("room-settings").textContent = "";
}
function goHome() { clearTimer(); onlineReset(); G.online.active = false; showScreen("menu"); }

/* ===========================================================
   Wiring UI
   =========================================================== */
/* ===========================================================
   Globe terrestre animé (accueil) — canvas, projection orthographique
   dessiné à partir des contours de continents déjà embarqués (ZGEO)
   =========================================================== */
let globeRAF = null;
function initHomeGlobe() {
  const cv = document.getElementById("home-globe");
  if (!cv || globeRAF) return;
  globeRAF = true;   // verrou le temps du chargement
  fetch("globe-land.json?v=1").then((r) => r.json()).then((geo) => startGlobe(cv, geo)).catch(() => { globeRAF = null; });
}
function startGlobe(cv, geo) {
  // côtes détaillées (Natural Earth 50m, masses terrestres fusionnées) → uniquement le littoral, aucune frontière interne
  const rings = [];
  const polys = geo.type === "MultiPolygon" ? geo.coordinates : [geo.coordinates];
  polys.forEach((poly) => poly.forEach((ring) => {
    const pts = [];
    for (let i = 0; i < ring.length; i++) pts.push([ring[i][0] * Math.PI / 180, ring[i][1] * Math.PI / 180]);
    if (pts.length > 2) rings.push(pts);
  }));

  const ctx = cv.getContext("2d");
  const tilt = 16 * Math.PI / 180, sinT = Math.sin(tilt), cosT = Math.cos(tilt);
  let lon0 = -0.2, R = 0, cx = 0, cy = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const box = cv.getBoundingClientRect();
    cv.width = Math.max(2, Math.round((box.width || 400) * dpr));
    cv.height = Math.max(2, Math.round((box.height || 400) * dpr));
    R = Math.min(cv.width, cv.height) / 2 * 0.9; cx = cv.width / 2; cy = cv.height / 2;
  }
  resize();
  window.addEventListener("resize", resize);

  // on fait tourner le globe en cliquant-glissant dessus ; au relâcher, l'élan continue puis revient à la vitesse de base
  const baseSpeed = 0.0026;
  let vel = baseSpeed, dragging = false, lastX = null;
  cv.style.pointerEvents = "auto"; cv.style.cursor = "grab";
  const px = (e) => (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
  function down(e) { dragging = true; lastX = px(e); cv.style.cursor = "grabbing"; }
  function move(e) {
    if (!dragging) return;
    const x = px(e); if (x == null) return;
    if (lastX !== null) { const dx = x - lastX; lon0 -= dx * 0.006; vel = Math.max(-0.15, Math.min(0.15, -dx * 0.006)); }
    lastX = x;
  }
  function up() { if (!dragging) return; dragging = false; lastX = null; cv.style.cursor = "grab"; }
  cv.addEventListener("mousedown", down);
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  cv.addEventListener("touchstart", down, { passive: true });
  window.addEventListener("touchmove", move, { passive: true });
  window.addEventListener("touchend", up);

  let lastT = 0;
  function frame(t) {
    globeRAF = requestAnimationFrame(frame);
    if (t - lastT < 26) return;   // ~38 fps : suffisant et plus léger avec des côtes détaillées
    lastT = t;
    if (!document.getElementById("menu").classList.contains("show")) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    const og = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R * 1.15);
    og.addColorStop(0, "#16406e"); og.addColorStop(.55, "#0e2a52"); og.addColorStop(1, "#071a36");
    ctx.fillStyle = og; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    ctx.lineJoin = "round";
    ctx.fillStyle = "rgba(46,230,166,.48)";
    ctx.strokeStyle = "rgba(125,245,205,.85)";
    ctx.lineWidth = Math.max(1, R * 0.004);
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      // remplissage : entre deux points cachés on longe l'ARC du limbe (jamais une corde) → zéro trait parasite
      ctx.beginPath();
      let anyVisible = false, started = false, prevHidden = false, prevA = 0;
      for (let i = 0; i <= ring.length; i++) {
        const p = ring[i % ring.length];
        const lat = p[1], dl = p[0] - lon0;
        const cosc = sinT * Math.sin(lat) + cosT * Math.cos(lat) * Math.cos(dl);
        const x = R * Math.cos(lat) * Math.sin(dl);
        const y = -R * (cosT * Math.sin(lat) - sinT * Math.cos(lat) * Math.cos(dl));
        if (cosc < 0) {
          const a = Math.atan2(y, x);
          if (prevHidden && started) {
            let da = a - prevA;
            while (da > Math.PI) da -= 2 * Math.PI;
            while (da < -Math.PI) da += 2 * Math.PI;
            const steps = Math.max(1, Math.round(Math.abs(da) / 0.2));
            for (let s = 1; s <= steps; s++) { const aa = prevA + da * s / steps; ctx.lineTo(cx + Math.cos(aa) * R, cy + Math.sin(aa) * R); }
          } else {
            const lx = cx + Math.cos(a) * R, ly = cy + Math.sin(a) * R;
            if (started) ctx.lineTo(lx, ly); else { ctx.moveTo(lx, ly); started = true; }
          }
          prevHidden = true; prevA = a;
        } else {
          anyVisible = true;
          if (started) ctx.lineTo(cx + x, cy + y); else { ctx.moveTo(cx + x, cy + y); started = true; }
          prevHidden = false;
        }
      }
      if (anyVisible) ctx.fill();
      // contour net : uniquement les segments entièrement sur la face visible
      ctx.beginPath(); let pen = false;
      for (let i = 0; i < ring.length; i++) {
        const lng = ring[i][0], lat = ring[i][1], dl = lng - lon0;
        const cosc = sinT * Math.sin(lat) + cosT * Math.cos(lat) * Math.cos(dl);
        if (cosc < 0) { pen = false; continue; }
        const x = cx + R * Math.cos(lat) * Math.sin(dl);
        const y = cy - R * (cosT * Math.sin(lat) - sinT * Math.cos(lat) * Math.cos(dl));
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // contour + halo atmosphérique
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, R * 0.016); ctx.strokeStyle = "rgba(46,230,166,.30)"; ctx.stroke();
    const ag = ctx.createRadialGradient(cx, cy, R * 0.97, cx, cy, R * 1.12);
    ag.addColorStop(0, "rgba(46,230,166,.18)"); ag.addColorStop(1, "rgba(46,230,166,0)");
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, 0, Math.PI * 2); ctx.fillStyle = ag; ctx.fill();

    if (!dragging) { lon0 += vel; vel += (baseSpeed - vel) * 0.03; }   // hors glisser : élan + retour doux à la vitesse de base
  }
  globeRAF = requestAnimationFrame(frame);
}

function wire() {
  fillZoneOptions();
  try {
    const savedName = localStorage.getItem("geoq-name");
    if (savedName) { G.playerName = cleanName(savedName); $("player-name").value = G.playerName; }
    G.avatarChoice = parseInt(localStorage.getItem("geoq-av"), 10) || 0;
    if (G.avatarChoice < 0 || G.avatarChoice >= AVATARS.length) G.avatarChoice = 0;
  } catch (e) {}
  $("player-name").addEventListener("change", savePlayerName);
  $("player-name").addEventListener("blur", savePlayerName);
  buildAvatarGrid();
  setAvatar("avatar-current", G.avatarChoice);
  $("avatar-grid").addEventListener("click", (e) => {
    const b = e.target.closest(".avatar-opt"); if (!b) return;
    selectAvatar(parseInt(b.dataset.i, 10));
  });
  $("avatar-trigger").addEventListener("click", () => { buildAvatarGrid(); $("avatar-modal").hidden = false; });
  $("avatar-close").addEventListener("click", () => { $("avatar-modal").hidden = true; });
  $("avatar-done").addEventListener("click", () => { $("avatar-modal").hidden = true; });
  $("avatar-modal").addEventListener("click", (e) => { if (e.target.id === "avatar-modal") $("avatar-modal").hidden = true; });

  // sélecteur de zone visuel
  buildZoneModal();
  updateZoneTrigger();
  loadZones().then(() => updateZoneTrigger());
  ["zone-trigger", "online-zone-trigger", "room-zone-trigger"].forEach((id) => {
    const t = $(id);
    if (t) t.addEventListener("click", () => {
      if ($("zone-search")) { $("zone-search").value = ""; filterZones(""); }
      $("zone-modal").hidden = false; loadZones().then(initZoneMaps);
    });
  });
  if ($("zone-search")) $("zone-search").addEventListener("input", (e) => filterZones(e.target.value));
  $("zone-modal-close").addEventListener("click", () => { $("zone-modal").hidden = true; });
  $("zone-modal").addEventListener("click", (e) => { if (e.target.id === "zone-modal") $("zone-modal").hidden = true; });
  $("zone-groups").addEventListener("click", (e) => {
    const b = e.target.closest(".zone-card"); if (!b) return;
    selectZone(b.dataset.z, b.dataset.co || null);
  });

  // segmented manches
  $("rounds-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-r]"); if (!b) return;
    $("rounds-seg").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); G.rounds = parseInt(b.dataset.r, 10);
  });
  $("online-rounds-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-r]"); if (!b) return;
    $("online-rounds-seg").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
  });
  $("room-rounds-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-r]"); if (!b) return;
    $("room-rounds-seg").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    sendRoomSettings();
  });
  // segments « Temps / manche » (menu / online / salon)
  ["time-seg", "online-time-seg", "room-time-seg"].forEach((id) => {
    const seg = $(id); if (!seg) return;
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-t]"); if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      if (id === "time-seg") G.timeLimit = parseInt(b.dataset.t, 10) * 60;
      if (id === "room-time-seg") sendRoomSettings();
    });
  });
  $("zone-filter").addEventListener("change", () => {
    G.zoneFilter = $("zone-filter").value;
    $("country-field").classList.toggle("hidden", G.zoneFilter !== "country");
  });
  $("country-filter").addEventListener("change", () => {
    G.countryFilter = $("country-filter").value;
  });
  $("online-zone-filter").addEventListener("change", () => {
    $("online-country-field").classList.toggle("hidden", $("online-zone-filter").value !== "country");
  });
  $("room-zone-filter").addEventListener("change", () => {
    $("room-country-field").classList.toggle("hidden", $("room-zone-filter").value !== "country");
    sendRoomSettings();
  });
  $("room-country-filter").addEventListener("change", sendRoomSettings);

  $("btn-solo").addEventListener("click", startSolo);
  $("btn-online").addEventListener("click", () => {
    if (!requirePlayerName()) return;
    readMenuSettings();
    mirrorSettingsToOnline();
    backToOnlineChoice();
    $("online-error").textContent = "";
    showScreen("online");
  });
  $("btn-create").addEventListener("click", createRoom);
  $("btn-join").addEventListener("click", () => joinRoom());
  $("btn-start-room").addEventListener("click", hostStartGame);
  // croix d'exclusion : délégation sur la liste des joueurs du salon
  $("room-players").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kick]"); if (!b) return;
    kickPlayer(b.dataset.kick);
  });
  $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  $("btn-copy").addEventListener("click", copyLink);

  document.querySelectorAll("[data-back]").forEach((b) =>
    b.addEventListener("click", () => { onlineReset(); showScreen(b.dataset.back); }));

  $("btn-guess").addEventListener("click", submitGuess);
  $("btn-reset-view").addEventListener("click", resetView);
  $("btn-expand").addEventListener("click", () => {
    $("guess-panel").classList.toggle("expanded");
    if (G.gmap) setTimeout(() => G.gmap.invalidateSize(), 280);
  });
  // la carte de guess s'agrandit au survol (CSS) → prévenir Leaflet du resize
  ["mouseenter", "mouseleave"].forEach((ev) =>
    $("guess-panel").addEventListener(ev, () => { if (G.gmap) setTimeout(() => G.gmap.invalidateSize(), 280); }));
  $("btn-quit").addEventListener("click", () => { if (confirm("Quitter la partie en cours ?")) goHome(); });

  $("btn-next").addEventListener("click", nextRound);
  $("btn-replay").addEventListener("click", replay);
  $("btn-home").addEventListener("click", goHome);

  // auto-join via ?join=CODE
  const params = new URLSearchParams(location.search);
  const j = params.get("join");
  if (j) {
    $("join-code").value = j.toUpperCase().slice(0, 4);
    if (G.playerName) showScreen("online");
    else {
      setMapsState("Entre un pseudo, puis ouvre le multijoueur pour rejoindre la salle.");
      showScreen("menu");
    }
  }
}

function copyLink() {
  if (!G.online.code || $("btn-copy").disabled) return;
  const url = location.origin + location.pathname + "?join=" + (G.online.code || "");
  navigator.clipboard.writeText(url).then(
    () => { $("btn-copy").textContent = "Lien copié ✓"; setTimeout(() => ($("btn-copy").textContent = "Copier le lien"), 1800); },
    () => { $("btn-copy").textContent = url; }
  );
}

/* ---------- boot ---------- */
wire();
loadMaps();
initHomeGlobe();

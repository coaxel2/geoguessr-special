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
  return G.rounds + " manches · " + (zone || "Monde entier");
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
  updateNameLabels();
  // en lobby : prévenir l'adversaire du nouvel avatar choisi
  if (G.online.active) sendMsg({ type: "hello", name: G.playerName, av: G.avatarChoice });
}
function updateNameLabels() {
  const opp = G.online.oppName || "Adversaire";
  const me = G.playerName || "Toi";
  if ($("result-me-name")) $("result-me-name").textContent = me;
  if ($("result-opp-name")) $("result-opp-name").textContent = opp;
  if ($("final-me-name")) $("final-me-name").textContent = me;
  if ($("final-opp-name")) $("final-opp-name").textContent = opp;
  setAvatar("result-me-av", G.avatarChoice);
  setAvatar("result-opp-av", G.online.oppAvatarChoice);
  setAvatar("final-me-av", G.avatarChoice);
  setAvatar("final-opp-av", G.online.oppAvatarChoice);
  setAvatar("hud-opp-av", G.online.oppAvatarChoice);
}

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
  online: {
    active: false, peer: null, conn: null, isHost: false, code: null,
    started: false,
    oppName: "Adversaire", oppAvatarChoice: 0,
    oppGuess: null, oppDone: false, oppScores: [],
    iWantNext: false, oppWantNext: false,
    iWantReplay: false, oppWantReplay: false, ka: null,
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
  if (G.zoneFilter === "country") return { type: "region", items: COUNTRY_REGIONS[G.countryFilter] || COUNTRY_REGIONS.france };
  return { type: "region", items: ZONE_REGIONS[G.zoneFilter] || REGIONS };
}
function setRoundSeg(id, rounds) {
  $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("on", parseInt(b.dataset.r, 10) === rounds));
}
function selectedRounds(id) {
  const selected = $(id).querySelector("button.on");
  return selected ? parseInt(selected.dataset.r, 10) : G.rounds;
}
function readMenuSettings() {
  G.zoneFilter = $("zone-filter").value;
  G.countryFilter = $("country-filter").value;
}
function readOnlineSettings() {
  G.rounds = selectedRounds("online-rounds-seg");
  G.zoneFilter = $("online-zone-filter").value;
  G.countryFilter = $("online-country-filter").value;
  $("online-country-field").classList.toggle("hidden", G.zoneFilter !== "country");
}
function readRoomSettings() {
  G.rounds = selectedRounds("room-rounds-seg");
  G.zoneFilter = $("room-zone-filter").value;
  G.countryFilter = $("room-country-filter").value;
  $("room-country-field").classList.toggle("hidden", G.zoneFilter !== "country");
}
function mirrorSettingsToOnline() {
  setRoundSeg("online-rounds-seg", G.rounds);
  $("online-zone-filter").value = G.zoneFilter;
  $("online-country-filter").value = G.countryFilter;
  $("online-country-field").classList.toggle("hidden", G.zoneFilter !== "country");
}
function mirrorSettingsToRoom() {
  setRoundSeg("room-rounds-seg", G.rounds);
  $("room-zone-filter").value = G.zoneFilter;
  $("room-country-filter").value = G.countryFilter;
  $("room-country-field").classList.toggle("hidden", G.zoneFilter !== "country");
  $("room-settings").textContent = settingsText();
}
function sendRoomSettings() {
  if (!G.online.isHost || G.online.started) return;
  readRoomSettings();
  $("room-settings").textContent = settingsText();
  sendMsg({ type: "room", rounds: G.rounds, zone: G.zoneFilter, country: G.countryFilter });
}
function applyRemoteSettings(m) {
  G.rounds = m.rounds || G.rounds;
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
  G.online.oppScores = [];
  G.online.iWantReplay = false; G.online.oppWantReplay = false;
  $("hud-opp").classList.toggle("hidden", !G.online.active);
  updateNameLabels();
  showScreen("game");
  loadRound();
}

async function loadRound() {
  const round = G.current;
  G.guess = null; G.submitted = false;
  G.online.oppGuess = null; G.online.oppDone = false;
  G.online.iWantNext = false; G.online.oppWantNext = false;
  if (G.marker && G.gmap) { G.gmap.removeLayer(G.marker); G.marker = null; }
  $("btn-guess").disabled = true;
  $("guess-hint").textContent = "Place ton marqueur sur la carte";
  $("opp-flag").classList.add("hidden");

  $("hud-round").textContent = "Manche " + (round + 1) + "/" + G.rounds;
  $("hud-score").textContent = sum(G.scores) + " pts";
  updateOppHud();

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
  const reveal = () => { if (done) return; done = true; uncover(); };
  google.maps.event.addListenerOnce(G.pano, "position_changed", reveal);
  setTimeout(reveal, 4000); // filet de sécurité
}

function resetView() {
  if (G.pano && G.startPov) { G.pano.setPov(G.startPov); G.pano.setZoom(0); }
}

function submitGuess() {
  if (!G.guess || G.submitted) return;
  G.submitted = true;
  $("btn-guess").disabled = true;
  const loc = G.locations[G.current];
  const d = distM(G.guess, loc);
  G.lastDist = d;
  G.scores[G.current] = scoreFor(d);

  if (G.online.active) {
    sendMsg({ type: "guess", round: G.current, lat: G.guess.lat, lng: G.guess.lng, dist: d, pts: G.scores[G.current] });
    if (G.online.oppDone) revealRound();
    else $("guess-hint").textContent = "✔ Deviné — en attente de l'adversaire…";
  } else {
    revealRound();
  }
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
  if (G.guess) {
    const g = [G.guess.lat, G.guess.lng]; pts.push(g);
    resOverlays.push(pin(g, "#2ee6a6").addTo(resMap).bindTooltip("Toi"));
    resOverlays.push(L.polyline([g, actual], { color: "#2ee6a6", weight: 2, dashArray: "4 6" }).addTo(resMap));
  }
  if (G.online.active && G.online.oppGuess) {
    const o = [G.online.oppGuess.lat, G.online.oppGuess.lng]; pts.push(o);
    resOverlays.push(pin(o, "#19b7e6").addTo(resMap).bindTooltip("Adversaire"));
    resOverlays.push(L.polyline([o, actual], { color: "#19b7e6", weight: 2, dashArray: "4 6" }).addTo(resMap));
  }
  if (pts.length > 1) resMap.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 12 });
  else resMap.setView(actual, 5);
}

function revealRound() {
  showScreen("result");
  updateNameLabels();
  ensureResultMap();
  const loc = G.locations[G.current];
  resMap.invalidateSize();
  drawResult(loc);
  setTimeout(() => { resMap.invalidateSize(); drawResult(loc); }, 160);

  $("result-title").textContent = "Manche " + (G.current + 1) + " / " + G.rounds;
  $("result-dist").textContent = fmtDist(G.lastDist);
  $("result-pts").textContent = G.scores[G.current] + " pts";

  const oppRow = $("result-opp-row");
  if (G.online.active && G.online.oppGuess) {
    oppRow.classList.remove("hidden");
    $("result-opp-dist").textContent = fmtDist(G.online.oppGuess.dist);
    $("result-opp-pts").textContent = G.online.oppGuess.pts + " pts";
  } else oppRow.classList.add("hidden");

  const last = G.current >= G.rounds - 1;
  $("btn-next").textContent = last ? "Voir le résultat ›" : "Manche suivante ›";
  $("btn-next").classList.remove("hidden");
  $("next-wait").classList.add("hidden");
}

function nextRound() {
  if (G.online.active) {
    G.online.iWantNext = true;
    sendMsg({ type: "next", round: G.current });
    if (G.online.oppWantNext) advance();
    else { $("btn-next").classList.add("hidden"); $("next-wait").classList.remove("hidden"); }
  } else advance();
}
function advance() {
  G.online.iWantNext = false; G.online.oppWantNext = false;
  G.current++;
  if (G.current >= G.rounds) showFinal();
  else { showScreen("game"); loadRound(); }
}

function showFinal() {
  showScreen("final");
  updateNameLabels();
  const me = sum(G.scores);
  const max = G.rounds * 5000;
  $("final-me").textContent = me.toLocaleString("fr-FR");
  $("final-max").textContent = max.toLocaleString("fr-FR");

  if (G.online.active) {
    const opp = sum(G.online.oppScores);
    $("final-opp-block").classList.remove("hidden");
    $("final-opp").textContent = opp.toLocaleString("fr-FR");
    if (me > opp) { $("final-emoji").textContent = "🏆"; $("final-title").textContent = "Victoire !"; }
    else if (me < opp) { $("final-emoji").textContent = "😵"; $("final-title").textContent = "Défaite…"; }
    else { $("final-emoji").textContent = "🤝"; $("final-title").textContent = "Égalité !"; }
  } else {
    $("final-opp-block").classList.add("hidden");
    const pct = me / max;
    $("final-emoji").textContent = pct > .8 ? "🌟" : pct > .5 ? "🎯" : "🧭";
    $("final-title").textContent = "Partie terminée";
  }
  updateReplayUI();
}

function updateOppHud() {
  if (!G.online.active) return;
  $("hud-opp").classList.remove("hidden");
  $("hud-opp-txt").textContent = (G.online.oppName || "Adversaire") + " : " + sum(G.online.oppScores) + " pts";
  setAvatar("hud-opp-av", G.online.oppAvatarChoice);
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
  G.online = { active: false, peer: null, conn: null, isHost: false, code: null,
               started: false, oppName: "Adversaire", oppAvatarChoice: 0, oppGuess: null, oppDone: false, oppScores: [],
               iWantNext: false, oppWantNext: false, iWantReplay: false, oppWantReplay: false, ka: null };
}
function sendMsg(m) { try { if (G.online.conn && G.online.conn.open) G.online.conn.send(m); } catch (e) {} }
function roomPeerId(code) {
  return "geoq2-" + location.hostname.replace(/[^a-z0-9-]/gi, "-") + "-" + code;
}
function resetRoomAfterGuestLeft(text) {
  G.online.active = false;
  G.online.conn = null;
  G.online.started = false;
  G.online.oppName = "Adversaire";
  clearInterval(G.online.ka);
  $("btn-start-room").classList.add("hidden");
  $("btn-start-room").disabled = true;
  $("btn-kick-player").classList.add("hidden");
  $("online-status").textContent = text || "En attente d'un adversaire…";
}
function kickPlayer() {
  if (!G.online.isHost || !G.online.active || G.online.started) return;
  sendMsg({ type: "kick" });
  try { if (G.online.conn) G.online.conn.close(); } catch (e) {}
  resetRoomAfterGuestLeft("Joueur exclu — en attente d'un adversaire…");
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
  $("btn-kick-player").classList.add("hidden");
  $("room-options").classList.remove("hidden");
  mirrorSettingsToRoom();
  $("room-code").textContent = "----";
  $("btn-copy").textContent = "Copier le lien";
  $("btn-copy").disabled = true;
  $("room-settings").textContent = settingsText();
  $("online-status").textContent = "Création de la salle…";

  const peer = new Peer(roomPeerId(code), { debug: 0, secure: true, config: ICE });
  G.online.peer = peer;
  peer.on("open", () => {
    if (G.online.peer !== peer || !G.online.isHost) return;
    $("room-code").textContent = code;
    $("btn-copy").disabled = false;
    $("online-status").textContent = "En attente d'un adversaire…";
  });
  peer.on("connection", (conn) => {
    $("online-status").textContent = "Adversaire connecté…";
    conn.on("open", () => setupConn(conn));
    conn.on("error", () => flashStatus("Problème de connexion avec l'adversaire"));
  });
  peer.on("error", (e) => {
    $("online-error").textContent = e.type === "unavailable-id" ? "Code déjà pris, réessaie." : "Erreur réseau : " + e.type;
    backToOnlineChoice();
  });
  peer.on("disconnected", () => { try { peer.reconnect(); } catch (e) {} });
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
  $("btn-kick-player").classList.add("hidden");
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
        setupConn(conn);
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

function setupConn(conn) {
  G.online.conn = conn;
  G.online.active = true;
  G.online.started = false;
  clearInterval(G.online.ka);
  G.online.ka = setInterval(() => { try { if (conn.open) conn.send({ type: "ping" }); } catch (e) {} }, 12000);

  conn.on("data", onData);
  conn.on("close", () => {
    clearInterval(G.online.ka);
    if (G.online.isHost && !G.online.started && $("online").classList.contains("show")) resetRoomAfterGuestLeft("Joueur déconnecté — en attente d'un adversaire…");
    else if (!G.online.isHost && !G.online.started && $("online").classList.contains("show")) {
      $("online-error").textContent = "La salle a été fermée.";
      backToOnlineChoice();
    } else flashStatus("⚠️ Adversaire déconnecté");
  });
  conn.on("error", () => flashStatus("⚠️ Problème de connexion"));
  sendMsg({ type: "hello", name: G.playerName, av: G.avatarChoice });

  if (G.online.isHost) {
    $("online-status").textContent = "Joueur 2 connecté — prêt à lancer";
    $("btn-start-room").classList.remove("hidden");
    $("btn-start-room").disabled = false;
    $("btn-kick-player").classList.remove("hidden");
    sendMsg({ type: "room", rounds: G.rounds, zone: G.zoneFilter, country: G.countryFilter });
  } else {
    $("online-status").textContent = "Connecté — en attente de l'hôte";
  }
}

async function hostStartGame() {
  if (!G.online.active || !G.online.isHost || G.online.started) return;
  readRoomSettings();
  G.online.started = true;
  $("btn-start-room").disabled = true;
  $("btn-kick-player").classList.add("hidden");
  $("room-options").classList.add("hidden");
  sendMsg({ type: "start", rounds: G.rounds, zone: G.zoneFilter, country: G.countryFilter });
  $("online-status").textContent = "Connecté — recherche des lieux…";
  showScreen("game");
  resetLocations();
  cover("Recherche du premier lieu…");
  const first = await findOneLocation();
  if (!first) { cover("Impossible de trouver un lieu."); return; }
  setLocationAt(0, first);
  sendMsg({ type: "init", rounds: G.rounds, locations: G.locations });
  beginRoundsLocal();
  preloadRemainingLocations(1, true);
}

function onData(m) {
  if (!m || !m.type || m.type === "ping") return;

  if (m.type === "hello") {
    G.online.oppName = cleanName(m.name || "Adversaire");
    G.online.oppAvatarChoice = m.av || 0;
    updateNameLabels();
    updateOppHud();
    if ($("online").classList.contains("show")) {
      $("online-status").textContent = G.online.isHost
        ? G.online.oppName + " connecté — prêt à lancer"
        : "Connecté — en attente de l'hôte";
    }

  } else if (m.type === "room") {
    if (!G.online.isHost) {
      applyRemoteSettings(m);
      $("online-status").textContent = "Connecté — en attente de l'hôte";
    }

  } else if (m.type === "start") {
    if (!G.online.isHost) {
      applyRemoteSettings(m);
      $("online-status").textContent = "L'hôte lance la partie…";
    }

  } else if (m.type === "kick") {
    $("online-error").textContent = "Tu as été exclu de la salle.";
    onlineReset();
    backToOnlineChoice();
    showScreen("online");

  } else if (m.type === "init") {
    G.online.started = true;
    G.rounds = m.rounds; resetLocations();
    (m.locations || []).forEach((loc, i) => { if (loc) setLocationAt(i, loc); });
    beginRoundsLocal();

  } else if (m.type === "location") {
    if (m.loc && Number.isInteger(m.index)) setLocationAt(m.index, m.loc);

  } else if (m.type === "guess") {
    G.online.oppGuess = m; G.online.oppDone = true;
    G.online.oppScores[m.round] = m.pts;
    updateOppHud();
    $("opp-flag").classList.remove("hidden");
    $("opp-flag").textContent = (G.online.oppName || "Ton adversaire") + " a deviné";
    if (G.submitted) revealRound();

  } else if (m.type === "next") {
    G.online.oppWantNext = true;
    if (G.online.iWantNext) advance();
    else if ($("result").classList.contains("show")) $("next-wait").textContent = (G.online.oppName || "L'adversaire") + " est prêt…";

  } else if (m.type === "replay") {
    G.online.oppWantReplay = true;
    if ($("final").classList.contains("show")) updateReplayUI();
    maybeStartReplay();
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
  // multijoueur : il faut que LES DEUX joueurs cliquent « Rejouer » (2/2)
  G.online.iWantReplay = true;
  sendMsg({ type: "replay" });
  updateReplayUI();
  maybeStartReplay();
}
function maybeStartReplay() {
  if (!(G.online.iWantReplay && G.online.oppWantReplay)) return;
  G.online.iWantReplay = false; G.online.oppWantReplay = false;
  // l'hôte (re)génère les lieux et les envoie ; l'invité attend l'init
  if (G.online.isHost) hostReplay();
  else { showScreen("game"); cover("Nouvelle partie — l'hôte prépare les lieux…"); }
}
function updateReplayUI() {
  const btn = $("btn-replay");
  if (!btn) return;
  if (!G.online.active) { btn.disabled = false; btn.textContent = "Rejouer"; return; }
  const ready = (G.online.iWantReplay ? 1 : 0) + (G.online.oppWantReplay ? 1 : 0);
  if (ready === 0) { btn.disabled = false; btn.textContent = "Rejouer"; }
  else if (G.online.iWantReplay) { btn.disabled = true; btn.textContent = "En attente… " + ready + "/2"; }
  else { btn.disabled = false; btn.textContent = "Rejouer (" + ready + "/2)"; }
}
async function hostReplay() {
  showScreen("game"); cover("Nouvelle partie — recherche des lieux…");
  resetLocations();
  const first = await findOneLocation();
  if (!first) { cover("Impossible de trouver un lieu."); return; }
  setLocationAt(0, first);
  sendMsg({ type: "init", rounds: G.rounds, locations: G.locations });
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
  $("btn-kick-player").classList.add("hidden");
  $("room-settings").textContent = "";
}
function goHome() { onlineReset(); G.online.active = false; showScreen("menu"); }

/* ===========================================================
   Wiring UI
   =========================================================== */
function wire() {
  try {
    const savedName = localStorage.getItem("geoq-name");
    if (savedName) { G.playerName = cleanName(savedName); $("player-name").value = G.playerName; }
    G.avatarChoice = parseInt(localStorage.getItem("geoq-av"), 10) || 0;
    if (G.avatarChoice < 0 || G.avatarChoice >= AVATARS.length) G.avatarChoice = 0;
  } catch (e) {}
  $("player-name").addEventListener("change", savePlayerName);
  $("player-name").addEventListener("blur", savePlayerName);
  buildAvatarGrid();
  $("avatar-grid").addEventListener("click", (e) => {
    const b = e.target.closest(".avatar-opt"); if (!b) return;
    selectAvatar(parseInt(b.dataset.i, 10));
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
  $("btn-kick-player").addEventListener("click", kickPlayer);
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

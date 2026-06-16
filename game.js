/* ===========================================================
   GeoGuessr Spécial — logique de jeu
   - Street View + carte via Google Maps JS API
   - Multijoueur P2P via PeerJS (repris du projet d'échecs)
   =========================================================== */

"use strict";

/* ---------- CONFIG ---------- */
const CONFIG = {
  // Clé injectée en production par docker-entrypoint.sh depuis GMAPS_KEY.
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
  pano: null,
  gmap: null,
  marker: null,
  startPov: null,
  locationWaiters: {},
  locationBatch: 0,
  online: {
    active: false, peer: null, conn: null, isHost: false, code: null,
    oppGuess: null, oppDone: false, oppScores: [],
    iWantNext: false, oppWantNext: false, ka: null,
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
const REGION_TOTAL = REGIONS.reduce((t, r) => t + r[4], 0);
function pickRegion() {
  let x = Math.random() * REGION_TOTAL;
  for (const r of REGIONS) { x -= r[4]; if (x <= 0) return r; }
  return REGIONS[0];
}

/* ===========================================================
   Génération / validation des lieux (StreetViewService)
   =========================================================== */
async function findOneLocation() {
  const sv = new google.maps.StreetViewService();
  for (let attempt = 0; attempt < 40; attempt++) {
    const r = pickRegion();
    const req = {
      location: { lat: rand(r[0], r[1]), lng: rand(r[2], r[3]) },
      radius: 150000,
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
  $("hud-opp").classList.toggle("hidden", !G.online.active);
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
}

function updateOppHud() {
  if (!G.online.active) return;
  $("hud-opp").classList.remove("hidden");
  $("hud-opp").textContent = "Adversaire : " + sum(G.online.oppScores) + " pts";
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
               oppGuess: null, oppDone: false, oppScores: [], iWantNext: false, oppWantNext: false, ka: null };
}
function sendMsg(m) { try { if (G.online.conn && G.online.conn.open) G.online.conn.send(m); } catch (e) {} }

function createRoom() {
  if (!mapsReady) { $("online-error").textContent = "La carte charge encore, patiente une seconde."; return; }
  if (typeof Peer === "undefined") { $("online-error").textContent = "Module réseau indisponible."; return; }
  onlineReset();
  const code = genCode();
  G.online.code = code; G.online.isHost = true;
  $("online-error").textContent = "";
  $("online-choice").style.display = "none";
  $("online-wait").classList.add("show");
  $("room-code").textContent = "----";
  $("btn-copy").textContent = "Copier le lien";
  $("btn-copy").disabled = true;
  $("online-status").textContent = "Création de la salle…";

  const peer = new Peer("geoq-" + code, { debug: 0, config: ICE });
  G.online.peer = peer;
  peer.on("open", () => {
    if (G.online.peer !== peer || !G.online.isHost) return;
    $("room-code").textContent = code;
    $("btn-copy").disabled = false;
    $("online-status").textContent = "En attente d'un adversaire…";
  });
  peer.on("connection", (conn) => conn.on("open", () => setupConn(conn)));
  peer.on("error", (e) => {
    $("online-error").textContent = e.type === "unavailable-id" ? "Code déjà pris, réessaie." : "Erreur réseau : " + e.type;
    backToOnlineChoice();
  });
  peer.on("disconnected", () => { try { peer.reconnect(); } catch (e) {} });
}

function joinRoom(codeArg) {
  if (!mapsReady) { $("online-error").textContent = "La carte charge encore, patiente une seconde."; return; }
  if (typeof Peer === "undefined") { $("online-error").textContent = "Module réseau indisponible."; return; }
  const code = (codeArg || $("join-code").value || "").trim().toUpperCase();
  if (code.length < 4) { $("online-error").textContent = "Entre le code à 4 caractères."; return; }
  onlineReset();
  G.online.code = code; G.online.isHost = false;
  $("online-error").textContent = "";
  $("online-choice").style.display = "none";
  $("online-wait").classList.add("show");
  $("room-code").textContent = code;
  $("btn-copy").textContent = "Copier le lien";
  $("btn-copy").disabled = true;
  $("online-status").textContent = "Connexion à la salle…";

  const peer = new Peer({ debug: 0, config: ICE });
  G.online.peer = peer;
  let attempts = 0;
  const deadline = Date.now() + 18000;
  const retryConnect = () => {
    if (G.online.active || G.online.peer !== peer) return;
    attempts++;
    $("online-status").textContent = attempts > 1 ? "Nouvelle tentative de connexion…" : "Connexion à la salle…";
    const conn = peer.connect("geoq-" + code, { reliable: true });
    conn.on("open", () => setupConn(conn));
    conn.on("error", () => {
      if (!G.online.active && Date.now() < deadline) setTimeout(retryConnect, 1000);
    });
  };
  peer.on("open", () => {
    if (G.online.peer !== peer || G.online.isHost) return;
    retryConnect();
    setTimeout(() => {
      if (!G.online.active && G.online.peer === peer) {
        $("online-error").textContent = "Salle introuvable, vérifie le code.";
        backToOnlineChoice();
      }
    }, 19000);
  });
  peer.on("error", (e) => {
    if (G.online.peer !== peer) return;
    if (e.type === "peer-unavailable" && Date.now() < deadline) {
      setTimeout(retryConnect, 1000);
      return;
    }
    $("online-error").textContent = e.type === "peer-unavailable" ? "Salle introuvable, vérifie le code." : "Erreur réseau : " + e.type;
    backToOnlineChoice();
  });
  peer.on("disconnected", () => { try { peer.reconnect(); } catch (e) {} });
}

function setupConn(conn) {
  G.online.conn = conn;
  G.online.active = true;
  clearInterval(G.online.ka);
  G.online.ka = setInterval(() => { try { if (conn.open) conn.send({ type: "ping" }); } catch (e) {} }, 12000);

  conn.on("data", onData);
  conn.on("close", () => {
    clearInterval(G.online.ka);
    flashStatus("⚠️ Adversaire déconnecté");
  });
  conn.on("error", () => flashStatus("⚠️ Problème de connexion"));

  // L'hôte prépare la partie (génération des lieux) puis envoie l'init.
  if (G.online.isHost) hostStartGame();
  else $("online-status").textContent = "✅ Connecté — préparation de la partie…";
}

async function hostStartGame() {
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

  if (m.type === "init") {
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
    if (G.submitted) revealRound();

  } else if (m.type === "next") {
    G.online.oppWantNext = true;
    if (G.online.iWantNext) advance();
    else if ($("result").classList.contains("show")) $("next-wait").textContent = "L'adversaire est prêt…";

  } else if (m.type === "replay") {
    if (G.online.isHost) hostReplay();
  }
}

function flashStatus(txt) {
  // affiche un message non bloquant selon l'écran courant
  if ($("game").classList.contains("show")) $("guess-hint").textContent = txt;
  else if ($("result").classList.contains("show")) $("next-wait").classList.remove("hidden"), ($("next-wait").textContent = txt);
  else $("online-status").textContent = txt;
}

function replay() {
  if (G.online.active) {
    if (G.online.isHost) hostReplay();
    else { sendMsg({ type: "replay" }); showScreen("game"); cover("Nouvelle partie demandée…"); }
  } else startSolo();
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
}
function goHome() { onlineReset(); G.online.active = false; showScreen("menu"); }

/* ===========================================================
   Wiring UI
   =========================================================== */
function wire() {
  // segmented manches
  $("rounds-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-r]"); if (!b) return;
    $("rounds-seg").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); G.rounds = parseInt(b.dataset.r, 10);
  });

  $("btn-solo").addEventListener("click", startSolo);
  $("btn-online").addEventListener("click", () => { backToOnlineChoice(); $("online-error").textContent = ""; showScreen("online"); });
  $("btn-create").addEventListener("click", createRoom);
  $("btn-join").addEventListener("click", () => joinRoom());
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
  if (j) { showScreen("online"); $("join-code").value = j.toUpperCase().slice(0, 4); }
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

/* ===========================================================
   Geoloc — logique de jeu
   - Street View via Google Maps JS API ; cartes de guess via Leaflet
   - Multijoueur via relay WebSocket auto-hébergé
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
const HUB_IDS = ["menu", "online", "leaderboard", "shop", "community", "profile"];
function activeScreenId() {
  const s = document.querySelector(".screen.show");
  return s ? s.id : null;
}
// Visibilité de la cloche : seulement hors-jeu (hub) ET connecté. Recalculée à
// chaque changement d'écran ET après l'hydratation auth (le boot rend l'écran
// avant que /api/me ait répondu, donc isLogged() est encore false à ce moment-là).
function refreshNotifBell() {
  const notif = document.getElementById("notif-wrap");
  if (!notif) return;
  const show = HUB_IDS.includes(activeScreenId()) && isLogged();
  const wasHidden = notif.hidden;
  notif.hidden = !show;
  if (show && wasHidden && typeof pollFriendGames === "function") pollFriendGames();
}
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("show"));
  $(id).classList.add("show");
  syncTabs(id);
  // La monnaie n'a de sens que sur les écrans « vitrine » ; on la masque en partie
  // (game / result / final) pour ne pas encombrer le Street View ni ses contrôles.
  const isHub = HUB_IDS.includes(id);
  const wallet = document.getElementById("wallet-pill");
  if (wallet) wallet.style.display = isHub ? "" : "none";
  const accountBtn = document.getElementById("account-btn");
  if (accountBtn) accountBtn.style.display = isHub ? "" : "none";
  // le menu burger (mobile) n'a pas de sens en partie : on le masque + on referme le tiroir
  const burger = document.getElementById("nav-burger");
  if (burger) burger.style.display = isHub ? "" : "none";
  refreshNotifBell();
  if (!isHub) {
    document.body.classList.remove("drawer-open");
    const drw = document.getElementById("nav-drawer"), scr = document.getElementById("nav-scrim");
    if (drw) drw.hidden = true; if (scr) scr.hidden = true;
  }
  if (id === "leaderboard") loadLeaderboardPage();
  if (id === "community") renderCommunity();
  if (id === "shop") renderShop();   // labels Acheter/Équiper/Équipé à jour à chaque ouverture
  if (id === "profile") renderProfilePage();
  if (isHub) {
    try { $(id).scrollTop = 0; } catch (e) {}
  }
}
function syncTabs(id) {
  document.querySelectorAll(".tab-link").forEach((b) => {
    const tab = b.dataset.tab;
    b.classList.toggle("on", (id === "menu" && tab === "menu") || (id === "online" && tab === "online") || (id === "leaderboard" && tab === "leaderboard") || (id === "shop" && tab === "shop") || (id === "community" && tab === "community"));
  });
}
function routeForTab(tab) {
  if (tab === "online") return "/multi";
  if (tab === "leaderboard") return "/classement";
  if (tab === "shop") return "/boutique";
  if (tab === "community") return "/communaute";
  if (tab === "profile") return "/profil";
  return "/";
}
function tabForPath(path) {
  const clean = (path || "/").replace(/\/+$/, "") || "/";
  if (clean === "/multi") return "online";
  if (clean === "/classement") return "leaderboard";
  if (clean === "/boutique") return "shop";
  if (clean === "/communaute") return "community";
  if (clean === "/profil") return "profile";
  return "menu";
}
function setRoute(tab, replace) {
  if (!window.history) return;
  const path = routeForTab(tab);
  if (location.pathname === path && !location.search) return;
  const fn = replace ? "replaceState" : "pushState";
  history[fn]({ tab: tab }, "", path);
}
// Confirmation « quitter la partie » via une modale du jeu (remplace le confirm() natif).
function confirmQuit(onYes) {
  const m = $("quit-modal");
  if (!m) { if (onYes) onYes(); return; }
  G._quitYes = onYes || null;
  m.hidden = false;
}
function goTab(tab, opts) {
  opts = opts || {};
  const current = document.querySelector(".screen.show");
  const inRound = current && (current.id === "game" || current.id === "result");
  if (inRound && !opts.confirmed) { confirmQuit(() => goTab(tab, Object.assign({}, opts, { confirmed: true }))); return; }
  if (inRound) { clearTimer(); onlineReset(); G.online.active = false; document.body.classList.remove("time-critical"); }
  if (tab === "online") {
    readMenuSettings();
    // le mode de déplacement en multi est propre au sélecteur multi (online-mode-seg),
    // jamais hérité du réglage solo → un Hardcore/Bateau solo ne contamine pas la partie multi.
    G.moveMode = selectedMode("online-mode-seg") || "free";
    mirrorSettingsToOnline();
    backToOnlineChoice();
    $("online-error").textContent = "";
    showScreen("online");
    if (!opts.fromPop) setRoute("online", opts.replace);
    return;
  }
  if (tab === "leaderboard") {
    showScreen("leaderboard");
    if (!opts.fromPop) setRoute("leaderboard", opts.replace);
    return;
  }
  if (tab === "shop") {
    showScreen("shop");
    if (!opts.fromPop) setRoute("shop", opts.replace);
    return;
  }
  if (tab === "community") {
    showScreen("community");
    if (!opts.fromPop) setRoute("community", opts.replace);
    return;
  }
  if (tab === "profile") {
    showScreen("profile");
    if (!opts.fromPop) setRoute("profile", opts.replace);
    return;
  }
  clearTimer();
  onlineReset();
  backToOnlineChoice();
  G.online.active = false;
  showScreen("menu");
  if (!opts.fromPop) setRoute("menu", opts.replace);
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
// popup pseudo : demande un pseudo s'il manque, puis exécute cb
let pendingJoin = null;
function requestName(cb) {
  if (savePlayerName()) { if (cb) cb(); return; }
  try { const n = localStorage.getItem("geoq-name"); if (n) { $("player-name").value = n; if (savePlayerName()) { if (cb) cb(); return; } } } catch (e) {}
  const m = $("name-modal");
  if (!m) { requirePlayerName("online-error"); return; }
  m._cb = cb || null;
  $("name-modal-input").value = "";
  $("name-modal-err").textContent = "";
  m.hidden = false;
  setTimeout(() => { try { $("name-modal-input").focus(); } catch (e) {} }, 60);
}
function confirmName() {
  const m = $("name-modal"); if (!m) return;
  $("player-name").value = $("name-modal-input").value;
  if (!savePlayerName()) { $("name-modal-err").textContent = "Entre un pseudo valide."; return; }
  m.hidden = true;
  const cb = m._cb; m._cb = null;
  if (cb) cb();
}
function autoJoin() {
  if (!pendingJoin) return;
  if (!mapsReady) { setTimeout(autoJoin, 250); return; }   // attendre que la carte soit prête
  const code = pendingJoin; pendingJoin = null;
  showScreen("online");
  joinRoom(code);
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

/* ---------- monnaie + boutique ---------- */
const COINS_KEY = "geoq-coins";
const OWNED_KEY = "geoq-owned";
const EQUIPPED_KEY = "geoq-equipped";
const PASS_XP_KEY = "geoq-pass-xp";
const PASS_CLAIMS_KEY = "geoq-pass-claims";
const PASS_MAX_LEVEL = 100;
const PASS_XP_PER_LEVEL = 1000;
const SHOP_ITEMS = {
  boreal: { price: 1500, type: "theme", slot: "theme", label: "Nuit boréale" },
  aurora: { price: 1200, type: "theme", slot: "theme", label: "Thème Aurora" },
  sunset: { price: 900,  type: "theme", slot: "theme", label: "Thème Sunset" },
  emerald: { price: 1000, type: "theme", slot: "theme", label: "Émeraude profonde" },
  magma:   { price: 1300, type: "theme", slot: "theme", label: "Magma" },
  cyber:   { price: 1600, type: "theme", slot: "theme", label: "Cyber néon" },
  sakura:  { price: 1100, type: "theme", slot: "theme", label: "Sakura" },
  mono:    { price: 800,  type: "theme", slot: "theme", label: "Monochrome ardoise" },
  themeDefault: { price: 0, type: "theme", slot: "theme", label: "Vert original" },
  badge:        { price: 500,  type: "badge", slot: "badge", label: "Badge Globe" },
  badgeCompass: { price: 700,  type: "badge", slot: "badge", label: "Badge Boussole" },
  badgeFlame:   { price: 900,  type: "badge", slot: "badge", label: "Badge Flamme" },
  badgeStar:    { price: 650,  type: "badge", slot: "badge", label: "Badge Étoile" },
  badgeCrown:   { price: 1400, type: "badge", slot: "badge", label: "Badge Couronne" },
  avatars:     { price: 0,   type: "avatarPack", slot: "avatarPack", label: "Pack Explorateurs" },
  avatarsBot:  { price: 600, type: "avatarPack", slot: "avatarPack", label: "Pack Robots" },
  avatarsPixel:{ price: 750, type: "avatarPack", slot: "avatarPack", label: "Pack Pixel" },
  fxNone:   { price: 0,    type: "fx", slot: "fx", label: "Aucun effet" },
  fxAurora: { price: 1200, type: "fx", slot: "fx", label: "Halo aurore" },
  bannerDefault: { price: 0, type: "banner", slot: "banner", label: "Fond Horizon" },
  bannerSummit: { price: 850, type: "banner", slot: "banner", label: "Fond Sommets" },
  bannerAurora: { price: 1250, type: "banner", slot: "banner", label: "Fond Aurore" },
  bannerSunset: { price: 1050, type: "banner", slot: "banner", label: "Fond Coucher de soleil" },
  bannerAtlas: { price: 1600, type: "banner", slot: "banner", label: "Fond Atlas nocturne" },
  bannerOcean: { price: 950, type: "banner", slot: "banner", label: "Fond Océan abyssal" },
  bannerForest: { price: 900, type: "banner", slot: "banner", label: "Fond Forêt boréale" },
  bannerCosmos: { price: 1350, type: "banner", slot: "banner", label: "Fond Cosmos étoilé" },
  bannerRuby: { price: 1500, type: "banner", slot: "banner", label: "Fond Rubis royal" },
  passBannerSummit: { price: 0, type: "banner", slot: "banner", label: "Fond Sommets de saison", passOnly: true },
  passBannerAurora: { price: 0, type: "banner", slot: "banner", label: "Fond Aurore de saison", passOnly: true },
  passBannerSunset: { price: 0, type: "banner", slot: "banner", label: "Fond Couchant de saison", passOnly: true },
  passBannerAtlas: { price: 0, type: "banner", slot: "banner", label: "Fond Atlas de saison", passOnly: true },
  passBannerLegendary: { price: 0, type: "banner", slot: "banner", label: "Fond Légende céleste", passOnly: true },
  passBadgeCeleste: { price: 0, type: "badge", slot: "badge", label: "Badge Céleste", passOnly: true },
  passBadgeNord: { price: 0, type: "badge", slot: "badge", label: "Badge Nord", passOnly: true },
  passBadgeSolar: { price: 0, type: "badge", slot: "badge", label: "Badge Solaire", passOnly: true },
  passBadgeAtlas: { price: 0, type: "badge", slot: "badge", label: "Badge Atlas", passOnly: true },
  passBadgeSouverain: { price: 0, type: "badge", slot: "badge", label: "Badge Souverain", passOnly: true },
  passBadgeDiamond: { price: 0, type: "badge", slot: "badge", label: "Badge Diamant", passOnly: true },
  passBadgeBolt: { price: 0, type: "badge", slot: "badge", label: "Badge Foudre", passOnly: true },
  passBadgeWave: { price: 0, type: "badge", slot: "badge", label: "Badge Vague", passOnly: true },
  passBadgeDragon: { price: 0, type: "badge", slot: "badge", label: "Badge Dragon", passOnly: true },
  passBannerNebula: { price: 0, type: "banner", slot: "banner", label: "Fond Nébuleuse", passOnly: true },
  passBannerEmber: { price: 0, type: "banner", slot: "banner", label: "Fond Braises ardentes", passOnly: true },
  passBannerGold: { price: 0, type: "banner", slot: "banner", label: "Fond Sacre doré", passOnly: true },
  avatarsExpedition: { price: 0, type: "avatarPack", slot: "avatarPack", label: "Pack Aventurier", passOnly: true },
};

/* ---------- comptes (login / inscription) ----------
   Le login est OPTIONNEL : le jeu reste 100% jouable en invité. Si le serveur
   n'a pas de DB (local), /api/me renvoie {user:null} et rien ne casse.
   Tout l'état (pièces, possessions, équipement, pseudo) est lié au pseudo via
   la session cookie httpOnly « gtok » ; le client ne manipule jamais le token. */
let AUTH = { user: null };
let _hydrating = false; // évite la boucle hydrate -> setCoins -> pushState
function isLogged() { return !!AUTH.user; }
function hydrateFromServer(u) {
  if (!u) return;
  _hydrating = true;
  try {
    setCoins(u.coins || 0);
    saveOwnedItems(u.owned || {});
    saveEquippedItems(u.equipped || {});
    savePassState(u.progress || {});
    G.playerName = u.pseudo;
    try { localStorage.setItem("geoq-name", u.pseudo); localStorage.setItem("geoq-auth", u.pseudo); } catch (e) {}
    if (Array.isArray(u.favorites)) { try { localStorage.setItem("geoq-fav", JSON.stringify(u.favorites)); } catch (e) {} }
    if (typeof u.av === "number") { G.avatarChoice = u.av; try { localStorage.setItem("geoq-av", String(u.av)); } catch (e) {} }
    if (typeof updateWallet === "function") updateWallet();
    if (typeof applyCosmetics === "function") applyCosmetics();
    if (typeof renderShop === "function") renderShop();
    const inp = document.getElementById("player-name");
    if (inp) { inp.value = u.pseudo; inp.readOnly = true; }
    refreshNotifBell();   // l'auth vient d'être connue : révèle la cloche si on est sur un hub
  } catch (e) {
    console.error("[auth] hydrate", e);
  } finally {
    _hydrating = false;
  }
}
let _stateT = null;
function pushState() {
  if (_hydrating || !isLogged()) return;
  clearTimeout(_stateT);
  _stateT = setTimeout(() => {
    fetch("/api/me/state", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coins: getCoins(), owned: ownedItems(), equipped: equippedItems(), favorites: getFavorites(), av: G.avatarChoice, progress: passState() }),
    }).catch(() => {});
  }, 450);
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}
function getCoins() {
  try {
    const n = parseInt(localStorage.getItem(COINS_KEY), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}
function setCoins(n) {
  const value = Math.max(0, Math.floor(n || 0));
  try { localStorage.setItem(COINS_KEY, String(value)); } catch (e) {}
  updateWallet();
  pushState();
}
function addCoins(n) { setCoins(getCoins() + Math.max(0, Math.floor(n || 0))); }
function updateWallet() {
  const el = $("wallet-amount");
  if (el) el.textContent = getCoins().toLocaleString("fr-FR");
}
function ownedItems() {
  const owned = readJSON(OWNED_KEY, {});
  owned.avatars = true;
  owned.bannerDefault = true;
  owned.themeDefault = true;
  owned.fxNone = true;
  if (owned.bannerLegendary) owned.passBannerLegendary = true; // migration de la première version du passe
  return owned;
}
function equippedItems() {
  const equipped = Object.assign({ avatarPack: "avatars", banner: "bannerDefault", theme: "themeDefault", fx: "fxNone" }, readJSON(EQUIPPED_KEY, {}));
  if (equipped.banner === "bannerLegendary") equipped.banner = "passBannerLegendary";
  return equipped;
}
function saveOwnedItems(owned) { writeJSON(OWNED_KEY, owned); pushState(); }
function saveEquippedItems(equipped) { writeJSON(EQUIPPED_KEY, equipped); pushState(); }
function passState() { return { xp: getPassXP(), claims: passClaims() }; }
function getPassXP() { try { const n = parseInt(localStorage.getItem(PASS_XP_KEY), 10); return Number.isFinite(n) && n > 0 ? Math.min(n, PASS_MAX_LEVEL * PASS_XP_PER_LEVEL) : 0; } catch (e) { return 0; } }
function passClaims() { const claims = readJSON(PASS_CLAIMS_KEY, []); return Array.isArray(claims) ? claims.filter((n) => Number.isInteger(n) && n >= 1 && n <= PASS_MAX_LEVEL) : []; }
function savePassState(progress) {
  const xp = Number.isInteger(progress && progress.xp) ? Math.max(0, Math.min(progress.xp, PASS_MAX_LEVEL * PASS_XP_PER_LEVEL)) : 0;
  const claims = Array.isArray(progress && progress.claims) ? progress.claims.filter((n) => Number.isInteger(n) && n >= 1 && n <= PASS_MAX_LEVEL) : [];
  try { localStorage.setItem(PASS_XP_KEY, String(xp)); } catch (e) {}
  writeJSON(PASS_CLAIMS_KEY, [...new Set(claims)]); pushState();
}
function setPassXP(xp) { try { localStorage.setItem(PASS_XP_KEY, String(Math.max(0, Math.min(Math.floor(xp || 0), PASS_MAX_LEVEL * PASS_XP_PER_LEVEL)))); } catch (e) {} pushState(); }
function passLevel() { return Math.min(PASS_MAX_LEVEL, Math.floor(getPassXP() / PASS_XP_PER_LEVEL) + 1); }
function passProgress() { const xp = getPassXP(); return { level: passLevel(), current: xp >= PASS_MAX_LEVEL * PASS_XP_PER_LEVEL ? PASS_XP_PER_LEVEL : xp % PASS_XP_PER_LEVEL }; }
function passReward(level) {
  // Récompenses cosmétiques exclusives, réparties tous les 5 paliers (18 cosmétiques + 2 jackpots + 1 ultime).
  const R = {
    5:  ["passBadgeDiamond", "Badge Diamant 💎"],   10: ["passBannerSummit", "Fond Sommets"],
    15: ["passBadgeBolt", "Badge Foudre ⚡"],        20: ["passBadgeCeleste", "Badge Céleste ⭐"],
    25: ["avatarsExpedition", "Pack Aventurier"],    30: ["passBannerAurora", "Fond Aurore"],
    35: ["passBadgeWave", "Badge Vague 🌊"],         40: ["passBadgeNord", "Badge Nord 🧭"],
    45: ["passBannerNebula", "Fond Nébuleuse"],      55: ["passBannerEmber", "Fond Braises ardentes"],
    60: ["passBannerSunset", "Fond Couchant"],       65: ["passBadgeDragon", "Badge Dragon 🐉"],
    70: ["passBadgeAtlas", "Badge Atlas 🌍"],        75: ["passBannerGold", "Fond Sacre doré"],
    80: ["passBannerAtlas", "Fond Atlas nocturne"],  85: ["passBadgeSolar", "Badge Solaire 🔥"],
    90: ["passBadgeSouverain", "Badge Souverain 👑"],
  };
  if (level === 100) return { coins: 12000, item: "passBannerLegendary", label: "Fond Légende céleste", ultimate: true };
  if (level === 50) return { coins: 2500, label: "Jackpot · 2 500 pièces", jackpot: true };
  if (level === 95) return { coins: 4000, label: "Jackpot · 4 000 pièces", jackpot: true };
  if (R[level]) return { coins: 250 + level * 30, item: R[level][0], label: R[level][1], milestone: true };
  return { coins: 50 + level * 12, label: (50 + level * 12).toLocaleString("fr-FR") + " pièces" };
}
function awardGameXP(score) { if (G.progressRewarded) return 0; G.progressRewarded = true; const earned = Math.max(80, Math.round(Math.max(0, score || 0) / 11)); setPassXP(getPassXP() + earned); return earned; }
function claimPassReward(level) {
  const reward = passReward(level), claims = passClaims(); if (level > passLevel() || claims.includes(level)) return;
  claims.push(level); writeJSON(PASS_CLAIMS_KEY, claims); if (reward.coins) addCoins(reward.coins);
  if (reward.item) { const owned = ownedItems(); owned[reward.item] = true; saveOwnedItems(owned); }
  pushState(); renderBattlePass(); renderProfileCollections();
}
// Badges : id d'item équipé (badge/badgeCompass/…) → nom court (data-badge) → emoji.
// Sert à afficher le badge à côté du pseudo PARTOUT (profil, lobby, classement, en jeu…).
const BADGE_NAME = { badge: "globe", badgeCompass: "compass", badgeFlame: "flame", badgeStar: "star", badgeCrown: "crown", passBadgeCeleste: "star", passBadgeNord: "compass", passBadgeSolar: "flame", passBadgeAtlas: "globe", passBadgeSouverain: "crown", passBadgeDiamond: "diamond", passBadgeBolt: "bolt", passBadgeWave: "wave", passBadgeDragon: "dragon" };
const BADGE_EMOJI = { globe: "🌍", compass: "🧭", flame: "🔥", star: "⭐", crown: "👑", diamond: "💎", bolt: "⚡", wave: "🌊", dragon: "🐉" };
function badgeEmoji(badgeId) { return BADGE_EMOJI[BADGE_NAME[badgeId]] || ""; }
function myBadgeEmoji() { return badgeEmoji(equippedItems().badge); }
const BANNER_SKIN = { passBannerSummit: "bannerSummit", passBannerAurora: "bannerAurora", passBannerSunset: "bannerSunset", passBannerAtlas: "bannerAtlas", passBannerLegendary: "bannerLegendary", passBannerNebula: "bannerNebula", passBannerEmber: "bannerEmber", passBannerGold: "bannerGold" };
function bannerSkin(id) { return BANNER_SKIN[id] || id || "bannerDefault"; }
// Aperçus CSS (mini-vignettes boutique/passe) des fonds — clé = skin (data-banner).
const BANNER_ART = {
  bannerDefault: "radial-gradient(120% 90% at 50% -25%, #6382ff, transparent 62%), linear-gradient(160deg,#1b2748,#0b1020)",
  bannerSummit: "radial-gradient(95% 85% at 82% -12%, #7dcdff, transparent 56%), radial-gradient(85% 95% at 8% 24%, #8468d2, transparent 60%), linear-gradient(160deg,#243a64,#0d1730)",
  bannerAurora: "radial-gradient(92% 120% at 16% 0%, #53ffbe, transparent 56%), radial-gradient(80% 110% at 84% 16%, #9664ff, transparent 58%), linear-gradient(160deg,#06243c,#081026)",
  bannerSunset: "radial-gradient(100% 110% at 18% 0%, #ffc470, transparent 55%), radial-gradient(95% 120% at 90% 95%, #f55692, transparent 58%), linear-gradient(160deg,#3a2142,#150e22)",
  bannerAtlas: "repeating-linear-gradient(28deg,transparent 0 12px,rgba(120,205,235,.16) 12px 13px,transparent 13px 26px), radial-gradient(100% 95% at 22% 0%, #2ecdde, transparent 58%), linear-gradient(160deg,#0e2c45,#060f1d)",
  bannerLegendary: "radial-gradient(95% 120% at 12% 0%, #ffcd5a, transparent 56%), radial-gradient(95% 120% at 90% 100%, #7d5fff, transparent 60%), linear-gradient(160deg,#241a44,#0a0a1e)",
  bannerNebula: "radial-gradient(92% 120% at 24% 0%, #aa5afa, transparent 56%), radial-gradient(92% 120% at 84% 34%, #ec4899, transparent 58%), linear-gradient(160deg,#1d0f33,#0a0618)",
  bannerEmber: "radial-gradient(110% 120% at 16% 100%, #ff7034, transparent 56%), radial-gradient(90% 110% at 86% 90%, #ffbc40, transparent 54%), linear-gradient(160deg,#3a160c,#140706)",
  bannerGold: "radial-gradient(100% 110% at 14% 0%, #ffd470, transparent 58%), radial-gradient(90% 110% at 92% 100%, #b88634, transparent 60%), linear-gradient(160deg,#3e2e12,#14100a)",
  bannerOcean: "radial-gradient(100% 110% at 22% 0%, #38bdf8, transparent 56%), radial-gradient(92% 120% at 88% 95%, #0d9488, transparent 58%), linear-gradient(160deg,#07273e,#04141e)",
  bannerForest: "radial-gradient(100% 110% at 18% 0%, #4ade80, transparent 56%), radial-gradient(92% 120% at 90% 92%, #16803d, transparent 58%), linear-gradient(160deg,#102a1c,#07150e)",
  bannerCosmos: "radial-gradient(110% 120% at 50% -10%, #6366f1, transparent 58%), linear-gradient(160deg,#131a3e,#060a1c)",
  bannerRuby: "radial-gradient(100% 110% at 22% 0%, #f43f5e, transparent 56%), radial-gradient(92% 120% at 88% 95%, #a855f7, transparent 58%), linear-gradient(160deg,#3a0f24,#150811)",
};
function applyCosmetics() {
  const equipped = equippedItems();
  document.body.dataset.theme = equipped.theme && equipped.theme !== "themeDefault" ? equipped.theme : "";
  document.body.dataset.badge = BADGE_NAME[equipped.badge] || "";
  document.body.dataset.fx = equipped.fx === "fxAurora" ? "aurora" : "";
  const hero = document.querySelector(".prof-hero"); if (hero) hero.dataset.banner = bannerSkin(equipped.banner);   // .prof-hero est une CLASSE (pas un id) → le fond s'applique sur le profil perso
  // reflète le badge à côté du pseudo du profil IMMÉDIATEMENT (sinon il fallait recharger la page)
  const pp = $("prof-pseudo");
  if (pp) { const ps = (AUTH.user && AUTH.user.pseudo) || G.playerName || "Joueur", b = myBadgeEmoji(); pp.textContent = ps + (b ? " " + b : ""); }
  try {
    if (typeof setAvatar === "function") setAvatar("avatar-current", G.avatarChoice);
    if (typeof buildAvatarGrid === "function" && $("avatar-grid") && $("avatar-grid").childElementCount) buildAvatarGrid();
  } catch (e) {}
}
function setShopFeedback(text) {
  const el = $("shop-feedback");
  if (!el) return;
  el.textContent = text || "";
}
function buyOrEquip(itemId) {
  const item = SHOP_ITEMS[itemId];
  if (!item) return;
  const owned = ownedItems();
  const equipped = equippedItems();
  if (!owned[itemId]) {
    if (item.passOnly) { setShopFeedback(item.label + " est une récompense exclusive du passe de combat."); return; }
    const coins = getCoins();
    if (coins < item.price) {
      setShopFeedback("Pas assez de pièces pour " + item.label + ".");
      return;
    }
    setCoins(coins - item.price);
    owned[itemId] = true;
    saveOwnedItems(owned);
  }
  equipped[item.slot] = itemId;
  saveEquippedItems(equipped);
  applyCosmetics();
  renderShop();
  setShopFeedback(item.label + " équipé.");
}
function renderShop() {
  updateWallet();
  applyCosmetics();
  const owned = ownedItems();
  const equipped = equippedItems();
  Object.keys(SHOP_ITEMS).forEach((id) => {
    const item = SHOP_ITEMS[id];
    const isOwned = !!owned[id];
    const isEquipped = equipped[item.slot] === id;
    document.querySelectorAll('[data-shop-card="' + id + '"]').forEach((card) => {
      card.classList.toggle("owned", isOwned);
      card.classList.toggle("equipped", isEquipped);
    });
    document.querySelectorAll('[data-shop-item="' + id + '"]').forEach((btn) => {
      btn.disabled = false;
      if (isEquipped) btn.textContent = "Équipé";
      else if (isOwned) btn.textContent = "Équiper";
      else btn.textContent = item.price ? "Acheter" : "Équiper";
    });
  });
  if (!renderShop._filled) { fillShopVignettes(); renderShop._filled = true; }   // vignettes fidèles (1×)
}
// ===== Aperçu fidèle des items de la boutique (vignette + modale de prévisualisation) =====
// Couleurs réelles de chaque thème (accent / accent-2) — synchronisées avec le CSS body[data-theme].
const THEME_COLORS = {
  themeDefault: { a: "#2ee6a6", b: "#2bb3c9" }, emerald: { a: "#2ee6a6", b: "#2bb3c9" },
  magma: { a: "#ff7a4d", b: "#ffd35c" }, cyber: { a: "#4dffd2", b: "#b06bff" },
  sakura: { a: "#ff9ec4", b: "#c0aede" }, mono: { a: "#c7d2e4", b: "#8aa0c0" },
  aurora: { a: "#8af7d1", b: "#8aa8ff" }, sunset: { a: "#ffcf6b", b: "#ee5a9b" },
  boreal: { a: "#69f0c4", b: "#9fb7ff" },
};
function myPseudo() { return (AUTH.user && AUTH.user.pseudo) || G.playerName || "AX730"; }
// Construit le visuel d'aperçu CONCRET d'un item (DOM, réutilisé en grand dans la modale et
// en petit dans la vignette). `big` = version détaillée (modale).
function itemStage(itemId, big) {
  const item = SHOP_ITEMS[itemId];
  const wrap = document.createElement("div");
  wrap.className = "pv-stage-inner pv-" + (item ? item.type : "x") + (big ? " big" : "");
  if (!item) return wrap;
  if (item.type === "theme") {
    const c = THEME_COLORS[itemId] || THEME_COLORS.themeDefault;
    wrap.style.setProperty("--a", c.a); wrap.style.setProperty("--b", c.b);
    // mini-rendu de l'interface avec ce thème : fond teinté + petite « fenêtre » (avatar + texte + bouton accent)
    const win = document.createElement("div"); win.className = "pv-theme-win";
    win.innerHTML = '<span class="pv-theme-dot"></span><span class="pv-theme-row"></span><span class="pv-theme-row sm"></span><span class="pv-theme-go">Jouer</span>';
    wrap.appendChild(win);
  } else if (item.type === "badge") {
    const ps = document.createElement("span"); ps.className = "pv-badge-pseudo";
    ps.textContent = myPseudo() + " ";
    const em = document.createElement("span"); em.className = "pv-badge-emo"; em.textContent = badgeEmoji(itemId);
    ps.appendChild(em); wrap.appendChild(ps);
  } else if (item.type === "avatarPack") {
    const style = (typeof AV_STYLES !== "undefined" && AV_STYLES[itemId]) || "avataaars";
    const n = big ? 5 : 1;
    for (let i = 0; i < n; i++) {
      const im = document.createElement("img"); im.className = "pv-av"; im.alt = ""; im.draggable = false;
      im.src = avatarURLFor(big ? i : (G.avatarChoice || 0), style);
      wrap.appendChild(im);
    }
  } else if (item.type === "fx") {
    const fx = document.createElement("span");
    fx.className = "pv-fx-orb" + (itemId === "fxAurora" ? " on" : "");
    wrap.appendChild(fx);
  } else if (item.type === "banner") {
    wrap.style.background = BANNER_ART[bannerSkin(itemId)] || BANNER_ART.bannerDefault;
  }
  return wrap;
}
// Remplit les vignettes .shop-art des cartes par leur aperçu fidèle (avatar réel, emoji de badge…).
function fillShopVignettes() {
  document.querySelectorAll("[data-shop-card]").forEach((card) => {
    const id = card.dataset.shopCard, art = card.querySelector(".shop-art");
    if (!art || !SHOP_ITEMS[id]) return;
    art.innerHTML = "";
    art.appendChild(itemStage(id, false));
  });
}
let _pvItem = null;
function openShopPreview(itemId) {
  const item = SHOP_ITEMS[itemId], m = $("shop-preview");
  if (!item || !m) return;
  _pvItem = itemId;
  $("pv-name").textContent = item.label;
  const owned = !!ownedItems()[itemId], equipped = equippedItems()[item.slot] === itemId;
  const TYPE = { theme: "Thème d'ambiance", badge: "Badge de profil", avatarPack: "Pack d'avatars", fx: "Effet visuel", banner: "Bannière de profil" };
  $("pv-sub").textContent = (TYPE[item.type] || "") + (equipped ? " · équipé" : owned ? " · possédé" : item.price ? " · " + item.price + " pièces" : " · gratuit");
  const stage = $("pv-stage"); stage.innerHTML = ""; stage.appendChild(itemStage(itemId, true));
  const act = $("pv-action");
  act.textContent = equipped ? "✓ Équipé" : owned ? "Équiper" : item.price ? "Acheter — " + item.price : "Équiper";
  act.disabled = equipped;
  m.hidden = false;
}
function pvAction() {
  if (!_pvItem) return;
  buyOrEquip(_pvItem);          // achète si besoin puis équipe (+ applyCosmetics + renderShop)
  openShopPreview(_pvItem);     // rafraîchit l'état du bouton (Équipé)
}
function rewardForScore(score) {
  if (!score || score <= 0) return 0;
  return Math.max(5, Math.round(score / 75));
}
function awardGameCoins(score) {
  if (G.rewarded) return 0;
  G.rewarded = true;
  const earned = rewardForScore(score);
  if (earned > 0) addCoins(earned);
  return earned;
}
// ===== Défi du jour : tourne chaque jour, jouable UNE seule fois par jour =====
// r = manches (3/5/10), m = minutes/manche (5), z = zone (toutes valides côté jeu), g = objectif.
const DAILY_CHALLENGES = [
  { t: "Capitales cachées",     d: "5 manches dans les grandes villes du monde.", z: "world-cities",  r: 5,  m: 5, g: 18000 },
  { t: "Tour du monde",         d: "5 manches n'importe où sur Terre.",           z: "world",         r: 5,  m: 5, g: 12000 },
  { t: "Grand tour d'Europe",   d: "5 manches à travers l'Europe.",               z: "europe",        r: 5,  m: 5, g: 16000 },
  { t: "Échappée asiatique",    d: "5 manches en Asie.",                          z: "asia",          r: 5,  m: 5, g: 15000 },
  { t: "Safari africain",       d: "5 manches en Afrique.",                       z: "africa",        r: 5,  m: 5, g: 14000 },
  { t: "Nouveau Monde",         d: "5 manches en Amérique du Nord.",              z: "north-america", r: 5,  m: 5, g: 16000 },
  { t: "Esprit latino",         d: "5 manches en Amérique du Sud.",               z: "south-america", r: 5,  m: 5, g: 14000 },
  { t: "Au cœur du Pacifique",  d: "5 manches en Océanie.",                       z: "oceania",       r: 5,  m: 5, g: 15000 },
  { t: "Sprint mondial",        d: "3 manches éclair dans les grandes villes.",   z: "world-cities",  r: 3,  m: 5, g: 9000 },
  { t: "Marathon planétaire",   d: "10 manches autour du globe.",                 z: "world",         r: 10, m: 5, g: 24000 },
  { t: "Soleil levant",         d: "5 manches au Japon.",                         z: "japan",         r: 5,  m: 5, g: 18000 },
  { t: "Carnaval brésilien",    d: "5 manches au Brésil.",                        z: "brazil",        r: 5,  m: 5, g: 16000 },
  { t: "Far West",              d: "5 manches aux États-Unis.",                   z: "usa",           r: 5,  m: 5, g: 16000 },
  { t: "Dolce Vita",            d: "5 manches en Italie.",                        z: "italy",         r: 5,  m: 5, g: 17000 },
];
function dailyKey() {                       // identifiant du jour LOCAL (anti-rejeu quotidien)
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}
function dailyIndex() {                      // index tournant : change chaque jour, déterministe
  const d = new Date();
  const dayNum = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  const n = DAILY_CHALLENGES.length;
  return ((dayNum % n) + n) % n;
}
function dailyChallenge() { return DAILY_CHALLENGES[dailyIndex()]; }
function dailyDone() {
  try { return localStorage.getItem("geoq-daily-done") === dailyKey(); } catch (e) { return false; }
}
function renderDailyChallenge() {
  const c = dailyChallenge();
  const title = $("challenge-title"), desc = $("challenge-desc"), btn = $("btn-weekly-challenge");
  if (title) title.textContent = c.t;
  if (desc) desc.textContent = c.d + " Objectif : " + fmtPts(c.g) + " pts.";
  if (btn) {
    const done = dailyDone();
    btn.disabled = done;
    btn.textContent = done ? "✓ Défi du jour terminé — reviens demain" : "Lancer le défi du jour";
  }
}
function startWeeklyChallenge() {            // (nom conservé : câblé sur le bouton du défi)
  if (dailyDone()) { renderDailyChallenge(); return; }
  const c = dailyChallenge();
  G.rounds = c.r;
  G.timeLimit = c.m * 60;
  G.zoneFilter = c.z;
  G.countryFilter = "";
  setRoundSeg("rounds-seg", c.r);
  setTimeSeg("time-seg", G.timeLimit);
  $("zone-filter").value = c.z;
  updateZoneTrigger();
  setShopFeedback("");
  try { localStorage.setItem("geoq-daily-done", dailyKey()); } catch (e) {}   // 1 essai / jour
  startSolo();
}
function openPublicRoom() {
  goTab("online");
  $("join-code").value = "FR01";
  $("online-error").textContent = "Code FR01 prérempli : rejoins si le salon est ouvert.";
}
function toggleCommunityVote() {
  const current = readJSON("geoq-community-vote", { choice: "Japon" });
  current.choice = current.choice === "Japon" ? "France" : "Japon";
  writeJSON("geoq-community-vote", current);
  renderCommunity();
}
// petit util : nombre → chaîne formatée FR ; tolère undefined/NaN
function fmtPts(x) { return Number(x || 0).toLocaleString("fr-FR"); }
// crée un <span class="…"> avec du texte échappé (textContent ⇒ pas d'injection HTML)
function commSpan(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text == null ? "" : String(text);
  return s;
}
// span pseudo cliquable (communauté) : garde le vrai pseudo dans data-pseudo (pour openPublicProfile)
// et ajoute l'emoji du badge équipé au texte affiché.
function commNameSpan(cls, pseudo, badgeId) {
  const ps = pseudo || "Anonyme";
  const s = commSpan(cls, ps);
  s.dataset.pseudo = ps;
  const b = badgeEmoji(badgeId);
  if (b) s.textContent = ps + " " + b;
  return s;
}
function commEmpty() {
  const p = document.createElement("p");
  p.className = "comm-empty";
  p.textContent = "Aucune partie pour l'instant — sois le premier !";
  return p;
}
// Communauté : vraies données depuis /api/community (stats + podium + parties récentes).
/* ---------- Communauté : création + liste des zones joueurs ---------- */
function setCzMsg(text, isErr) {
  const m = $("czone-msg"); if (!m) return;
  m.textContent = text || "";
  m.classList.toggle("err", !!isErr);
  m.classList.toggle("ok", !!text && !isErr);
}
async function submitCommunityZone(ev) {
  if (ev) ev.preventDefault();
  if (typeof isLogged === "function" && !isLogged()) { setCzMsg("Connecte-toi pour créer une zone.", true); if (typeof openAuthModal === "function") openAuthModal(); return; }
  const inp = $("czone-input"), btn = $("czone-submit");
  const name = (inp && inp.value || "").trim();
  if (name.length < 2) { setCzMsg("Entre le nom d'un lieu (ville, région, pays…).", true); return; }
  if (btn) { btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = "Recherche…"; }
  setCzMsg("Recherche du contour de « " + name + " »…", false);
  try {
    const r = await fetch("/api/community/zones", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ name }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { setCzMsg(j.error || "Échec de la création de la zone.", true); }
    else if (zoneDupesNative(j.zone)) {
      // ce lieu est déjà une VILLE NATIVE du jeu → on annule la création (le serveur ne
      // connaît pas les villes natives, donc le contrôle se fait ici) pour éviter un doublon.
      fetch("/api/community/zones/" + j.zone.id, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
      setCzMsg("Cette ville est déjà dans le jeu — choisis-la directement dans son pays.", true);
    }
    else {
      injectCommunityZone(j.zone);
      COMMUNITY_ZONES = [j.zone].concat(COMMUNITY_ZONES.filter((z) => z.id !== j.zone.id));
      buildZoneModal(true);   // régénère le sélecteur avec la nouvelle zone
      if (inp) inp.value = "";
      setCzMsg("✓ Zone « " + j.zone.name + " » ajoutée — choisis-la dans le sélecteur de zone.", false);
      renderCommunityZones();
    }
  } catch (e) { setCzMsg("Erreur réseau, réessaie.", true); }
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || "Ajouter"; }
}
function renderCommunityZones() {
  const box = $("czone-list"); if (!box) return;
  loadCommunityZones(true).then(() => {
    if (!COMMUNITY_ZONES.length) { box.innerHTML = '<p class="comm-empty">Aucune zone pour l\'instant — sois le premier à en créer une !</p>'; return; }
    box.innerHTML = "";
    COMMUNITY_ZONES.slice(0, 10).forEach((z) => {
      const row = document.createElement("button");
      row.type = "button"; row.className = "czone-item";
      const nm = document.createElement("span"); nm.className = "czone-item-name"; nm.textContent = z.name;
      const by = document.createElement("span"); by.className = "czone-item-by"; by.textContent = "par " + z.pseudo;
      const go = document.createElement("span"); go.className = "czone-item-go"; go.textContent = "Jouer ›";
      row.appendChild(nm); row.appendChild(by); row.appendChild(go);
      row.addEventListener("click", () => { selectZone(czKey(z.id)); startSolo(); });
      box.appendChild(row);
    });
  });
}

function renderCommunity() {
  renderDailyChallenge();
  renderCommunityZones();
  // ancien faux « vote » : peut avoir disparu de l'HTML → guards systématiques.
  const voteTxt = $("community-vote-text");
  if (voteTxt) voteTxt.textContent = "";

  const statsEl = $("community-stats");
  const topEl = $("community-top");
  const recentEl = $("community-recent");
  if (!statsEl && !topEl && !recentEl) return;

  fetch("/api/community", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      d = d || {};
      // --- Stats ---
      if (statsEl) {
        statsEl.innerHTML = "";
        const stats = d.stats || {};
        const wrap = document.createElement("div");
        wrap.className = "comm-stats";
        [
          { num: fmtPts(stats.games), label: "parties jouées" },
          { num: fmtPts(stats.players), label: "joueurs" },
          { num: fmtPts(stats.best), label: "meilleur score" },
        ].forEach((s) => {
          const cell = document.createElement("div");
          cell.className = "comm-stat";
          cell.appendChild(commSpan("comm-stat-num", s.num));
          cell.appendChild(commSpan("comm-stat-label", s.label));
          wrap.appendChild(cell);
        });
        statsEl.appendChild(wrap);
      }
      // --- Podium ---
      if (topEl) {
        topEl.innerHTML = "";
        const top = (Array.isArray(d.top) ? d.top : []).slice(0, 10);
        if (!top.length) {
          topEl.appendChild(commEmpty());
        } else {
          const medals = ["🥇", "🥈", "🥉"];
          top.forEach((e, i) => {
            e = e || {};
            const row = document.createElement("div");
            row.className = "comm-rank";
            row.appendChild(commSpan("comm-rank-pos", medals[i] || String(i + 1)));
            row.appendChild(commNameSpan("comm-rank-name", e.pseudo, e.badge));
            row.appendChild(commSpan("comm-rank-score", fmtPts(e.score) + " pts"));
            topEl.appendChild(row);
          });
        }
      }
      // --- Parties récentes ---
      if (recentEl) {
        recentEl.innerHTML = "";
        const recent = (Array.isArray(d.recent) ? d.recent : []).slice(0, 10);
        if (!recent.length) {
          recentEl.appendChild(commEmpty());
        } else {
          recent.forEach((e) => {
            e = e || {};
            const meta = [e.zoneLabel, e.ago].filter(Boolean).join(" · ");
            const row = document.createElement("div");
            row.className = "comm-recent";
            row.appendChild(commNameSpan("comm-recent-name", e.pseudo, e.badge));
            row.appendChild(commSpan("comm-recent-meta", meta));
            row.appendChild(commSpan("comm-recent-score", fmtPts(e.score) + " pts"));
            recentEl.appendChild(row);
          });
        }
      }
    })
    .catch(() => {
      if (topEl) { topEl.innerHTML = ""; topEl.appendChild(commEmpty()); }
      if (recentEl) { recentEl.innerHTML = ""; recentEl.appendChild(commEmpty()); }
    });
}
/* ---------- avatars « bonhomme » via DiceBear (style avataaars) ----------
   Déterministes : générés depuis le pseudo (+ une graine cyclable au clic).
   En P2P on ne transmet que le pseudo + la graine ; chaque client recompose
   l'avatar de l'autre à l'identique (même seed ⇒ même bonhomme). */
const AV_STYLE = "avataaars";
const AV_STYLES = { avatars: "avataaars", avatarsBot: "bottts", avatarsPixel: "pixel-art", avatarsExpedition: "adventurer" };
function currentAvStyle() { const eq = equippedItems(); return AV_STYLES[eq.avatarPack] || "avataaars"; }
const AV_BG = "b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf,d1f4d9,ffeeb3";
// Galerie d'avatars à CHOISIR (chaque graine = un bonhomme distinct et fixe).
const AVATARS = ["Felix", "Luna", "Milo", "Zoe", "Oscar", "Nina", "Hugo", "Lea", "Tom", "Emma", "Sam", "Jade"];
function avatarURL(choice) {
  const seed = AVATARS[choice] || AVATARS[0];
  return "https://api.dicebear.com/9.x/" + currentAvStyle() + "/svg?seed=" +
         encodeURIComponent(seed) + "&backgroundColor=" + AV_BG;
}
// avatar d'un AUTRE joueur (profil public) avec SON style (pack équipé), pas le nôtre
function avatarURLFor(choice, style) {
  const seed = AVATARS[choice] || AVATARS[0];
  return "https://api.dicebear.com/9.x/" + (style || "avataaars") + "/svg?seed=" +
         encodeURIComponent(seed) + "&backgroundColor=" + AV_BG;
}
// Version PNG RONDE (radius=50) pour servir d'icône de marqueur « tête du joueur »
// sur les cartes Google (le SVG se redimensionne mal en icône Marker).
function avatarPngURL(choice) {
  return avatarPngURLFor(choice, currentAvStyle());
}
// version PNG ronde d'un joueur DONNÉ (index + style) — pour afficher la tête de CHAQUE
// joueur en multi (sinon tous les marqueurs prennent le style du joueur local).
function avatarPngURLFor(choice, style) {
  const seed = AVATARS[choice] || AVATARS[0];
  return "https://api.dicebear.com/9.x/" + (style || "avataaars") + "/png?seed=" +
         encodeURIComponent(seed) + "&backgroundColor=" + AV_BG + "&radius=50&size=96";
}
function avatarPinIcon(choice) { return avatarPinIconFor(choice, currentAvStyle()); }
function avatarPinIconFor(choice, style) {
  return { url: avatarPngURLFor(choice, style), scaledSize: new google.maps.Size(36, 36), anchor: new google.maps.Point(18, 18) };
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
  if (typeof pushState === "function") pushState();   // persiste l'avatar au compte (profil public)
  const grid = $("avatar-grid");
  if (grid) grid.querySelectorAll(".avatar-opt").forEach((b) =>
    b.classList.toggle("on", parseInt(b.dataset.i, 10) === i));
  setAvatar("avatar-current", i);
  // en lobby : mettre à jour mon avatar et prévenir les autres joueurs
  if (G.online.active) {
    const meP = myPlayer(); if (meP) { meP.av = i; meP.avStyle = currentAvStyle(); meP.badge = equippedItems().badge; }
    if (G.online.isHost) broadcastRoster();
    else sendToHost({ type: "hello", name: G.playerName, av: i, avStyle: currentAvStyle(), badge: equippedItems().badge });
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
  rewarded: false,
  progressRewarded: false,
  lastDist: null,
  playerName: "",
  avatarChoice: 0,
  pano: null,
  gmap: null,
  marker: null,
  startPov: null,
  startPanoId: null,
  locationWaiters: {},
  locationBatch: 0,
  zoneFilter: "world",
  countryFilter: "france",
  timeLimit: 0,
  timer: null,
  online: {
    active: false, peer: null, ws: null, isHost: false, code: null, started: false,
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
  france: [[42.3, 51.1, -5.1, 8.3, 5], [41.3, 43.1, 8.5, 9.6, 1]],
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
function pointInBoxes(lat, lng, boxes) {
  return (boxes || []).some((b) => lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3]);
}
function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const hit = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}
function pointInPolygon(lat, lng, poly) {
  if (!poly || !poly.length || !pointInRing(lat, lng, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(lat, lng, poly[i])) return false;
  return true;
}
function pointInGeometry(lat, lng, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInPolygon(lat, lng, geom.coordinates);
  if (geom.type === "MultiPolygon") return geom.coordinates.some((poly) => pointInPolygon(lat, lng, poly));
  return false;
}
function zoneGeometryKey() {
  if (G.zoneFilter === "country") return "country:" + G.countryFilter;
  if (FR_REGION_ZONES[G.zoneFilter] || ZONE_REGIONS[G.zoneFilter] || CITY_ZONES[G.zoneFilter] || G.zoneFilter === "france-cities") return G.zoneFilter;
  return null;
}
function locationAllowed(loc, pool, picked) {
  if (!loc) return false;
  if (pool.type === "city") {
    // si la ville a un contour réel (frontière), le lieu doit tomber DEDANS (resserré, fidèle) ;
    // sinon on se rabat sur le rayon du cercle.
    const key = zoneGeometryKey();
    if (key && ZGEO && ZGEO[key]) return pointInGeometry(loc.lat, loc.lng, ZGEO[key]);
    const max = picked[2] || 12000;
    return distM({ lat: picked[0], lng: picked[1] }, loc) <= max;
  }
  if (G.zoneFilter === "world") return true;
  const shape = zoneShape(G.zoneFilter, G.countryFilter);
  if (shape && shape.boxes && !pointInBoxes(loc.lat, loc.lng, shape.boxes)) return false;
  const key = zoneGeometryKey();
  if (key && ZGEO && ZGEO[key]) return pointInGeometry(loc.lat, loc.lng, ZGEO[key]);
  if (shape && shape.boxes) return pointInBoxes(loc.lat, loc.lng, shape.boxes);
  return true;
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
// Tuile CartoDB claire contenant le point, à un zoom donné.
function tileURL(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = ((Math.floor((lng + 180) / 360 * n)) % n + n) % n;
  const lr = lat * Math.PI / 180;
  let y = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
  y = Math.max(0, Math.min(n - 1, y));
  return "https://a.basemaps.cartocdn.com/rastertiles/voyager/" + z + "/" + x + "/" + y + ".png";
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
  const groups = [
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
  // Villes par pays (centre + rayon court, chargées via loadCityPacks) : gros pays d'abord,
  // puis tous les autres pays du monde par ordre alphabétique de nom.
  const otherPacks = Object.keys(CITY_PACKS).filter((k) => BIG_PACK_ORDER.indexOf(k) < 0)
    .sort((a, b) => ((CITY_PACKS[a] || {}).name || "").localeCompare((CITY_PACKS[b] || {}).name || "", "fr"));
  BIG_PACK_ORDER.concat(otherPacks).forEach((country) => {
    const pack = CITY_PACKS[country];
    if (!pack || !pack.cities || !pack.cities.length) return;
    groups.push([(pack.flag || "🏙️") + " " + pack.name + " — top " + pack.cities.length + " villes",
      pack.cities.map((c) => ({ l: c[1], z: cpKey(country, c[0]), la: c[2], lo: c[3], tz: 9 }))]);
  });
  // Zones créées par les joueurs (chargées via loadCommunityZones, injectées dans ZGEO/ZONE_REGIONS).
  if (COMMUNITY_ZONES && COMMUNITY_ZONES.length) {
    groups.push(["👥 Communauté", COMMUNITY_ZONES.map((z) => ({
      l: z.name, by: z.pseudo, z: czKey(z.id), la: z.center[0], lo: z.center[1],
      tz: z.radius_km <= 30 ? 9 : (z.radius_km <= 200 ? 6 : 4),
    }))]);
  }
  return groups;
}
function zoneLabel() {
  let label = "Monde entier";
  zoneGroups().forEach((g) => g[1].forEach((e) => {
    if (e.z === G.zoneFilter && (!e.co || e.co === G.countryFilter)) label = e.l;
  }));
  return label;
}
function buildZoneModal(force) {
  const wrap = $("zone-groups");
  if (!wrap) return;
  if (wrap.dataset.built && !force) return;
  if (force) { wrap.innerHTML = ""; wrap.dataset.built = ""; }
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
      const map = document.createElement("div");
      map.className = "zone-card-map";
      map.dataset.la = e.la; map.dataset.lo = e.lo; map.dataset.lz = e.tz; map.dataset.z = e.z; map.dataset.co = e.co || "";
      b.appendChild(map);
      const lbl = document.createElement("span");
      lbl.className = "zone-card-label"; lbl.textContent = e.l;   // textContent : nom de zone communautaire = saisie utilisateur
      b.appendChild(lbl);
      if (e.by) { const by = document.createElement("span"); by.className = "zone-card-by"; by.textContent = "par " + e.by; b.appendChild(by); }
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
    .then((j) => {
      ZGEO = j;
      // si des zones communautaires / villes-packs ont déjà été chargées (course possible),
      // ré-applique leurs contours — sinon ce gros fetch écraserait ZGEO et les perdrait.
      if (COMMUNITY_ZONES && COMMUNITY_ZONES.length) COMMUNITY_ZONES.forEach((z) => { if (z.geojson) ZGEO[czKey(z.id)] = z.geojson; });
      Object.keys(CITY_PACKS).forEach((country) => {
        const p = CITY_PACKS[country]; if (!p || !p.cities) return;
        p.cities.forEach((c) => { if (c[5]) ZGEO[cpKey(country, c[0])] = c[5]; });
      });
      return ZGEO;
    }).catch(() => { ZGEO = {}; return ZGEO; });
  return loadZones._p;
}

/* ---------- Zones communautaires (créées par les joueurs, géocodées au serveur) ---------- */
let COMMUNITY_ZONES = [];
function czKey(id) { return "community:" + id; }
// Injecte une zone communautaire dans les structures du moteur de jeu pour qu'elle soit
// jouable (spawn), scorée, cadrée et affichée — exactement comme une zone native.
function injectCommunityZone(z) {
  if (!z || z.id == null) return;
  const key = czKey(z.id);
  if (z.geojson) { ZGEO = ZGEO || {}; ZGEO[key] = z.geojson; }
  const bb = z.bbox;   // [minLng, minLat, maxLng, maxLat]
  if (z.radius_km && z.radius_km <= 30) {
    // petite zone → traitée comme une ville (spawn dans un cercle autour du centre)
    CITY_ZONES[key] = [z.center[0], z.center[1], Math.max(2500, z.radius_km * 1000)];
  } else if (bb && bb.length === 4) {
    // grande zone → région : spawn dans la bbox, validé par le contour GeoJSON
    ZONE_REGIONS[key] = [[bb[1], bb[3], bb[0], bb[2], 1]];
  } else {
    CITY_ZONES[key] = [z.center[0], z.center[1], Math.max(4000, (z.radius_km || 25) * 1000)];
  }
}
// Renvoie la clé d'une VILLE NATIVE du jeu (CITY_ZONES hors community:*) située à < ~4 km
// du point — sert à détecter qu'une zone communautaire duplique une ville déjà jouable.
function czNorm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, ""); }
function nativeNear(lat, lng, km) {
  km = km || 4;
  if (typeof CITY_ZONES === "undefined" || lat == null) return null;
  for (const k in CITY_ZONES) {
    if (k.indexOf("community:") === 0) continue;     // ne compare qu'aux villes natives
    const v = CITY_ZONES[k];
    if (v && distM({ lat: lat, lng: lng }, { lat: v[0], lng: v[1] }) < km * 1000) return k;
  }
  return null;
}
// même VILLE NATIVE par NOM (slug de la clé) : rattrape les grandes villes dont le centre
// du contour communautaire est loin du centre natif (ex. Las Vegas ≈ 13 km).
function nativeNameMatch(name) {
  const n = czNorm(name); if (!n || typeof CITY_ZONES === "undefined") return null;
  for (const k in CITY_ZONES) {
    if (k.indexOf("community:") === 0) continue;
    const slug = k.indexOf(":") >= 0 ? k.substring(k.lastIndexOf(":") + 1) : k.replace(/^city-/, "");
    if (czNorm(slug) === n) return k;
  }
  return null;
}
// une zone communautaire DOUBLE une ville native si : même endroit (<4 km) OU même nom
function zoneDupesNative(z) {
  if (!z) return null;
  if (z.center && nativeNear(z.center[0], z.center[1])) return true;
  if (z.name && nativeNameMatch(z.name)) return true;
  return false;
}
function loadCommunityZones(force) {
  if (force) loadCommunityZones._p = null;
  if (loadCommunityZones._p) return loadCommunityZones._p;
  // on attend les villes natives (city packs) pour pouvoir filtrer les doublons par position
  loadCommunityZones._p = Promise.all([
    fetch("/api/community/zones").then((r) => r.json()).catch(() => ({})),
    (typeof loadCityPacks === "function" ? loadCityPacks().catch(() => null) : Promise.resolve()),
  ]).then(([j]) => {
    const all = (j && j.zones) || [];
    // masque les zones qui dupliquent une ville déjà présente nativement (même lieu OU nom) → plus de doublons
    COMMUNITY_ZONES = all.filter((z) => !zoneDupesNative(z));
    COMMUNITY_ZONES.forEach(injectCommunityZone);
    return COMMUNITY_ZONES;
  }).catch(() => { COMMUNITY_ZONES = []; return COMMUNITY_ZONES; });
  return loadCommunityZones._p;
}

/* ---------- Packs de villes par pays (gros pays top 50, autres top 10 ; centre + rayon court) ---------- */
// Format : { "<pays>": { flag, name, cities: [[slug, nom, lat, lng, rayon_m], …] } }
let CITY_PACKS = {};
// ordre d'affichage : les 15 « gros » pays d'abord, puis tous les autres par nom
const BIG_PACK_ORDER = ["france", "usa", "canada", "uk-ireland", "spain-portugal", "italy", "germany", "japan", "south-korea", "australia", "new-zealand", "brazil", "argentina-chile", "south-africa", "mexico"];
function cpKey(country, slug) { return "cp:" + country + ":" + slug; }
function loadCityPacks() {
  if (loadCityPacks._p) return loadCityPacks._p;
  loadCityPacks._p = fetch("cities-by-country.json?v=5").then((r) => r.json())
    .then((packs) => {
      CITY_PACKS = packs || {};
      // dédup : retire des packs toute ville proche d'une ville NATIVE (qui a déjà un vrai
      // contour) — évite les doublons (Paris/Londres/Tokyo… présents en natif ET en pack).
      const natives = Object.keys(CITY_ZONES).filter((k) => k.indexOf("city-") === 0).map((k) => CITY_ZONES[k]);
      const nearNative = (lat, lng) => natives.some((n) => Math.abs(n[0] - lat) < 0.08 && Math.abs(n[1] - lng) < 0.08);
      Object.keys(CITY_PACKS).forEach((country) => {
        const pack = CITY_PACKS[country];
        if (!pack || !pack.cities) return;
        pack.cities = pack.cities.filter((c) => !nearNative(c[2], c[3]));
        pack.cities.forEach((c) => {
          const key = cpKey(country, c[0]);
          CITY_ZONES[key] = [c[2], c[3], c[4]];
          if (c[5]) { ZGEO = ZGEO || {}; ZGEO[key] = c[5]; }   // contour réel (frontière) si géocodé
        });
      });
      return CITY_PACKS;
    }).catch(() => { CITY_PACKS = {}; return CITY_PACKS; });
  return loadCityPacks._p;
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
    // villes (centre + rayon) : cercle de délimitation bien visible = la zone jouable
    L.circle([s.circle[0], s.circle[1]], { radius: s.r, color: "#2ee6a6", weight: 2.5, fillColor: "#2ee6a6", fillOpacity: 0.2 }).addTo(m);
    if (!bounds) bounds = L.latLng(s.circle[0], s.circle[1]).toBounds(s.r * 2.6);
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
  if (G.favPick) { G.favPick = false; $("zone-modal").hidden = true; addFavorite(z, co); return; }   // choix d'une favorite
  G.zoneFilter = z;
  if (co) G.countryFilter = co;
  // synchronise les 3 sélecteurs cachés (compat read/mirror). Les zones communautaires
  // (community:<id>) n'existent pas dans les <select> statiques → on ajoute l'option à la
  // volée, sinon readMenuSettings() relirait une valeur vide et retomberait sur « monde ».
  ["zone-filter", "online-zone-filter", "room-zone-filter"].forEach((id) => {
    const s = $(id); if (!s) return;
    if (z && !Array.from(s.options).some((o) => o.value === z)) { const o = document.createElement("option"); o.value = z; s.appendChild(o); }
    s.value = z;
  });
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
// Modes de déplacement dans le Street View — partagés entre le menu solo ET le multi.
const MOVE_HINTS = {
  free: "Déplacement, rotation et zoom autorisés.",
  pro: "Déplacement désactivé — tu restes sur place (rotation + zoom OK).",
  hardcore: "Ni déplacement ni zoom — juste regarder autour. Pour les pros.",
};
function selectedMode(id) {
  const sel = $(id) && $(id).querySelector("button.on");
  return sel ? sel.dataset.m : null;
}
function setModeSeg(id, mode) {
  const seg = $(id); if (!seg) return;
  seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === (mode || "free")));
}
function readMenuSettings() {
  G.zoneFilter = $("zone-filter").value;
  G.countryFilter = $("country-filter").value;
  const ms = $("mode-seg") && $("mode-seg").querySelector("button.on");
  G.moveMode = ms ? ms.dataset.m : (G.moveMode || "free");
}
function readOnlineSettings() {
  G.rounds = selectedRounds("online-rounds-seg");
  G.timeLimit = selectedTime("online-time-seg");
  G.zoneFilter = $("online-zone-filter").value;
  G.countryFilter = $("online-country-filter").value;
  G.moveMode = selectedMode("online-mode-seg") || G.moveMode || "free";
}
function readRoomSettings() {
  G.rounds = selectedRounds("room-rounds-seg");
  G.timeLimit = selectedTime("room-time-seg");
  G.zoneFilter = $("room-zone-filter").value;
  G.countryFilter = $("room-country-filter").value;
  G.moveMode = selectedMode("room-mode-seg") || G.moveMode || "free";
}
function mirrorSettingsToOnline() {
  setRoundSeg("online-rounds-seg", G.rounds);
  setTimeSeg("online-time-seg", G.timeLimit);
  setModeSeg("online-mode-seg", G.moveMode);
  $("online-zone-filter").value = G.zoneFilter;
  $("online-country-filter").value = G.countryFilter;
  updateZoneTrigger();
}
function mirrorSettingsToRoom() {
  setRoundSeg("room-rounds-seg", G.rounds);
  setTimeSeg("room-time-seg", G.timeLimit);
  setModeSeg("room-mode-seg", G.moveMode);
  $("room-zone-filter").value = G.zoneFilter;
  $("room-country-filter").value = G.countryFilter;
  $("room-settings").textContent = settingsText();
  updateZoneTrigger();
}
function sendRoomSettings() {
  if (!G.online.isHost || G.online.started) return;
  readRoomSettings();
  $("room-settings").textContent = settingsText();
  broadcast({ type: "settings", rounds: G.rounds, zone: G.zoneFilter, country: G.countryFilter, time: G.timeLimit, mode: G.moveMode });
}
function applyRemoteSettings(m) {
  G.rounds = m.rounds || G.rounds;
  if (m.time != null) G.timeLimit = m.time;
  G.zoneFilter = m.zone || G.zoneFilter;
  G.countryFilter = m.country || G.countryFilter;
  if (m.mode) G.moveMode = m.mode;
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
  if (!ZGEO) await loadZones();
  for (let attempt = 0; attempt < 70; attempt++) {
    const pool = activePool();
    const r = pickRegion();
    // villes : spawn très resserré autour du centre-ville (cible proche du centre + recherche
    // de panorama courte) → on reste dans la ville, jamais dans la ville d'à côté.
    const cr = r[2] || 6000;
    // villes : cible QUASI au centre-ville (≤18 % du rayon) + recherche de panorama
    // courte → on tombe en plein centre, jamais en périphérie ni dans la ville voisine.
    const searchRadius = pool.type === "city" ? Math.max(700, Math.min(2200, cr * 0.32)) : 70000;
    const target = pool.type === "city"
      ? randomPointNear(r[0], r[1], cr * 0.18)
      : { lat: rand(r[0], r[1]), lng: rand(r[2], r[3]) };
    const req = {
      location: target,
      radius: searchRadius,
      // GOOGLE = imagerie officielle des voitures Street View uniquement
      // (exclut les photosphères utilisateur, qui rendent mal / en noir).
      source: google.maps.StreetViewSource.GOOGLE,
    };
    try {
      const res = await sv.getPanorama(req);
      const loc = res.data.location;
      const out = { lat: loc.latLng.lat(), lng: loc.latLng.lng(), panoId: loc.pano };
      if (locationAllowed(out, pool, r)) return out;
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
function waitForLocation(index, timeoutMs) {
  if (G.locations[index]) return Promise.resolve(G.locations[index]);
  return new Promise((resolve) => {
    if (!G.locationWaiters[index]) G.locationWaiters[index] = [];
    G.locationWaiters[index].push(resolve);
    if (timeoutMs) {
      setTimeout(() => {
        if (G.locations[index]) return;
        G.locationWaiters[index] = (G.locationWaiters[index] || []).filter((fn) => fn !== resolve);
        resolve(null);
      }, timeoutMs);
    }
  });
}
async function ensureLocationAt(index, sendOnline, batch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (batch != null && batch !== G.locationBatch) return null;
    if (G.locations[index]) return G.locations[index];
    const loc = await findOneLocation();
    if (batch != null && batch !== G.locationBatch) return null;
    if (!loc) continue;
    setLocationAt(index, loc);
    if (sendOnline) sendMsg({ type: "location", index: index, loc: loc });
    return loc;
  }
  return null;
}
async function preloadRemainingLocations(startIndex, sendOnline) {
  const batch = G.locationBatch;
  for (let i = startIndex; i < G.rounds; i++) {
    if (batch !== G.locationBatch) return;
    await ensureLocationAt(i, sendOnline, batch);
  }
}

/* ===========================================================
   Panorama + carte de guess
   =========================================================== */
// (Re)crée le panorama à chaque manche : setPano() sur un panorama existant
// ne rafraîchit pas toujours le rendu WebGL, recréer garantit l'image correcte.
function makePano(loc, pov) {
  // Mode de jeu : pro = déplacement désactivé ; hardcore = + zoom désactivé.
  const mm = G.moveMode || "free";
  const noMove = (mm === "pro" || mm === "hardcore");
  const noZoom = (mm === "hardcore");
  G.pano = new google.maps.StreetViewPanorama($("pano"), {
    pano: loc.panoId,
    pov: pov,
    addressControl: false,    // cache le nom du lieu (sinon trop facile)
    showRoadLabels: false,    // cache les noms de rues
    fullscreenControl: false,
    motionTracking: false,
    motionTrackingControl: false,
    enableCloseButton: false,
    linksControl: !noMove,    // flèches de déplacement
    clickToGo: !noMove,       // clic pour avancer
    panControl: true,
    zoomControl: !noZoom,
    scrollwheel: !noZoom,
    disableDoubleClickZoom: noZoom,
  });
  document.body.classList.toggle("mode-pro", noMove);   // masque le ⟲/réglages liés au déplacement si besoin
  buildCompass();
  G.pano.addListener("pov_changed", () => { try { updateCompass(G.pano.getPov().heading); } catch (e) {} });
  try { updateCompass((pov && pov.heading) || 0); } catch (e) {}
  const hav = $("hud-me-av"); if (hav) hav.src = avatarURL(G.avatarChoice);   // ta tête dans le HUD
  const hbd = $("hud-me-badge"); if (hbd) hbd.textContent = myBadgeEmoji();   // ton badge équipé dans le HUD
}
// Tuiles claires CartoDB Voyager — utilisées UNIQUEMENT pour les mini-cartes du sélecteur de
// zone (Leaflet). Les cartes en jeu (guess + résultat) sont passées à Google Maps (POI/commerces).
const TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const TILE_OPT = { maxZoom: 19, subdomains: "abcd" };
// Carte de guess : Google Maps (roadmap détaillé — commerces, POI, rues visibles).
// clickableIcons:false → cliquer un POI place le marqueur au lieu d'ouvrir l'info Google.
function ensureGuessMap() {
  if (G.gmap || typeof google === "undefined" || !google.maps) return;
  G.gmap = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 20, lng: 0 }, zoom: 2, minZoom: 2,
    disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy",
    clickableIcons: false, mapTypeControl: false, streetViewControl: false,
    fullscreenControl: false, keyboardShortcuts: false,
  });
  G.gmap.addListener("click", (e) => { if (e && e.latLng) placeGuess(e.latLng.lat(), e.latLng.lng()); });
}
// Convertit un LatLngBounds Leaflet (calculé par la logique de zone) en bounds Google.
function llToGoogleBounds(b){ return new google.maps.LatLngBounds({ lat: b.getSouth(), lng: b.getWest() }, { lat: b.getNorth(), lng: b.getEast() }); }
function zoneBoundsForGuess(){const z=G.zoneFilter,co=G.countryFilter;if(z==="world"||z==="world-cities")return null;try{const feats=zoneFeatures(z,co);if(feats&&feats.length){const b=L.geoJSON({type:"FeatureCollection",features:feats}).getBounds();if(b&&b.isValid())return b;}}catch(e){}try{const s=zoneShape(z,co);if(s&&s.circle)return L.latLng(s.circle[0],s.circle[1]).toBounds(s.r*2.2);if(s&&s.boxes)return bboxOf(s.boxes);}catch(e){}return null;}
function frameGuessMapToZone(){
  if (!G.gmap) return;
  const b = zoneBoundsForGuess();
  if (b) {
    try { G.gmap.fitBounds(llToGoogleBounds(b), 18);
      google.maps.event.addListenerOnce(G.gmap, "idle", () => { if (G.gmap.getZoom() > 13) G.gmap.setZoom(13); });
    } catch (e) { G.gmap.setCenter({ lat: 20, lng: 0 }); G.gmap.setZoom(2); }
  } else { G.gmap.setCenter({ lat: 20, lng: 0 }); G.gmap.setZoom(2); }
}
// Couleur d'accent courante (suit le thème équipé ; ne jamais hardcoder le vert).
function accentColor(){ try { return (getComputedStyle(document.body).getPropertyValue('--accent') || '').trim() || '#2ee6a6'; } catch(e){ return '#2ee6a6'; } }
// Compteur animé (easeOutCubic) pour faire « monter » les scores au reveal / récap.
function animateCount(el, to, dur){
  if (!el) return; to = Math.round(to || 0); dur = dur || 650;
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(to * e).toLocaleString("fr-FR");
    if (k < 1) requestAnimationFrame(step); else el.textContent = to.toLocaleString("fr-FR");
  };
  requestAnimationFrame(step);
}
// Libellé qualitatif d'un score de manche (barème /5000).
function scoreQuality(pts){
  if (pts >= 4500) return "Dans le mille";
  if (pts >= 3500) return "Excellent";
  if (pts >= 2200) return "Bien vu";
  if (pts >= 1000) return "Tu peux mieux faire";
  if (pts > 0)     return "Loin du compte";
  return "Manqué";
}
function placeGuess(lat, lng) {
  if (G.submitted || !G.gmap) return;
  const pos = { lat: lat, lng: lng };
  if (!G.marker) {
    G.marker = new google.maps.Marker({
      position: pos, map: G.gmap, zIndex: 999, icon: avatarPinIcon(G.avatarChoice), title: "Ton point",
    });
  } else G.marker.setPosition(pos);
  G.guess = { lat: lat, lng: lng };
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
  G.rewarded = false; G.progressRewarded = false; G.streak = 0;
  G.gameStart = Date.now();              // chrono de la partie (pour le classement)
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
  G.round30 = false;                  // un joueur a-t-il déjà deviné cette manche (=> plafond 30 s)
  if (G.online.active) resetRoundFlags();
  if (G.marker) { G.marker.setMap(null); G.marker = null; }
  $("btn-guess").disabled = true;
  $("guess-hint").textContent = "Place ton marqueur sur la carte";
  $("opp-flag").classList.add("hidden");

  $("hud-round").textContent = "Manche " + (round + 1) + "/" + G.rounds;
  const prog = $("hud-progress");
  if (prog) {
    prog.innerHTML = "";
    for (let i = 0; i < G.rounds; i++) {
      const s = document.createElement("span");
      s.className = "seg" + (i < round ? " done" : i === round ? " current" : "");
      prog.appendChild(s);
    }
  }
  $("hud-score").textContent = sum(G.scores) + " pts";
  updateMultiHud();

  // repli la carte agrandie : à chaque nouvelle manche, on revient à la mini-carte
  const gpanel = $("guess-panel"); if (gpanel) gpanel.classList.remove("expanded");
  ensureGuessMap();
  frameGuessMapToZone();
  // la div #map vient d'être affichée → forcer Google à relire sa taille puis recadrer
  setTimeout(() => { if (G.gmap) { google.maps.event.trigger(G.gmap, "resize"); frameGuessMapToZone(); } }, 120);

  if (!G.locations[round]) {
    cover("Préparation de la manche…");
    if (!G.online.active || G.online.isHost) {
      const made = await ensureLocationAt(round, G.online.active && G.online.isHost, G.locationBatch);
      if (!made) { cover("Impossible de préparer cette manche. Retourne au menu puis relance."); return; }
    }
  }
  const loc = G.locations[round] || await waitForLocation(round, G.online.active ? 30000 : 0);
  if (G.current !== round || !$("game").classList.contains("show")) return;
  if (!loc) { cover("Lieu non reçu. L'hôte peut relancer depuis le lobby."); return; }

  cover("Chargement du panorama…");
  G.startPov = { heading: Math.random() * 360, pitch: 0, zoom: 0 };
  G.startPanoId = loc.panoId;
  makePano(loc, G.startPov);
  let done = false;
  // Si un joueur a déjà deviné pendant que ce pano chargeait, démarrer directement plafonné à 30 s
  // (sinon le timer complet écraserait — ou supprimerait en mode illimité — le compte à rebours des 30 s).
  const reveal = () => { if (done) return; done = true; uncover(); startTimer(G.round30 ? Math.min(30, G.timeLimit || 30) : G.timeLimit); };
  google.maps.event.addListenerOnce(G.pano, "position_changed", reveal);
  setTimeout(reveal, 4000); // filet de sécurité
}

function resetView() {
  if (!G.pano) return;
  if (G.startPanoId) { try { G.pano.setPano(G.startPanoId); } catch (e) {} }
  if (G.startPov) {
    G.pano.setPov({ heading: G.startPov.heading, pitch: G.startPov.pitch });
    G.pano.setZoom(G.startPov.zoom || 0);
  }
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
function geomBBox(geom){let laMin=90,laMax=-90,loMin=180,loMax=-180;const scan=(ring)=>ring.forEach(([lng,lat])=>{if(lat<laMin)laMin=lat;if(lat>laMax)laMax=lat;if(lng<loMin)loMin=lng;if(lng>loMax)loMax=lng;});if(geom.type==="Polygon")geom.coordinates.forEach(scan);else if(geom.type==="MultiPolygon")geom.coordinates.forEach((poly)=>poly.forEach(scan));return[laMin,laMax,loMin,loMax];}
function bboxRadiusKm(b){return distM({lat:b[0],lng:b[2]},{lat:b[1],lng:b[3]})/1000/2;}
// Rayon caractéristique d'une géométrie = rayon du disque de même aire (√(aire/π)).
// Robuste aux territoires lointains (DOM-TOM, Alaska…) qui gonflaient la bbox : la bbox de la France
// avec la Polynésie donnait un "rayon" de ~4000 km. L'aire, elle, reflète la vraie taille jouable.
function ringAreaKm2(ring){let lat0=0;for(const p of ring)lat0+=p[1];lat0=lat0/ring.length*Math.PI/180;const kx=111.320*Math.cos(lat0),ky=110.574;let a=0;for(let i=0,n=ring.length;i<n;i++){const p=ring[i],q=ring[(i+1)%n];a+=(p[0]*kx)*(q[1]*ky)-(q[0]*kx)*(p[1]*ky);}return Math.abs(a)/2;}
function geomAreaKm2(geom){let A=0;const add=(poly)=>{A+=ringAreaKm2(poly[0]);for(let h=1;h<poly.length;h++)A-=ringAreaKm2(poly[h]);};if(geom.type==="Polygon")add(geom.coordinates);else if(geom.type==="MultiPolygon")geom.coordinates.forEach(add);return A;}
function geomRadiusKm(geom){return Math.sqrt(Math.max(1,geomAreaKm2(geom))/Math.PI);}
const MEDIAN=(arr)=>{const s=[...arr].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
function zoneRadiusKm(){const z=G.zoneFilter,co=G.countryFilter;if(z==="world")return 9000;if(typeof CITY_ZONES!=="undefined"&&CITY_ZONES[z])return(CITY_ZONES[z][2]||12000)/1000;if(z==="world-cities"&&typeof WORLD_CITIES!=="undefined")return MEDIAN(WORLD_CITIES.map((c)=>c[2]))/1000;if(z==="france-cities"&&typeof FRANCE_CITIES!=="undefined")return MEDIAN(FRANCE_CITIES.map((c)=>c[2]))/1000;try{const key=zoneGeometryKey();if(key&&ZGEO&&ZGEO[key])return geomRadiusKm(ZGEO[key]);}catch(e){}try{const s=zoneShape(z,co);if(s&&s.boxes){const b=bboxOf(s.boxes);return distM({lat:b.getSouth(),lng:b.getWest()},{lat:b.getNorth(),lng:b.getEast()})/1000/2;}}catch(e){}return 1500;}
// Score adaptatif à la taille de la zone. tau = distance de décroissance (à tau, ~37% des points).
// tau = 0.23·R·(1 + R/15000) : quasi-linéaire pour les petites zones (villes restent serrées/exigeantes),
// mais sur-linéaire pour les grandes (monde/continents plus cléments → plus de points selon la distance).
function scoreFor(d){const km=d/1000;const R=zoneRadiusKm();const tau=Math.max(1.0,Math.min(4800,0.23*R*(1+R/15000)));const perfect=Math.max(0.06,Math.min(70,R*0.013));if(km<=perfect)return 5000;const s=Math.round(5000*Math.exp(-(km-perfect)/tau));return Math.max(0,Math.min(5000,s));}

/* ---------- chrono + son ---------- */
let audioCtx = null;
function sfxVol() { return (typeof G.sfxVol === "number") ? G.sfxVol : 0.7; }   // 0→1
function kbLayout() { return G.kbLayout === "qwerty" ? "qwerty" : "azerty"; }
function beep(freq, dur) {
  try {
    const vol = sfxVol();
    if (vol <= 0) return;                       // sons coupés
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.value = freq || 880;
    g.gain.setValueAtTime(0.14 * vol, audioCtx.currentTime);
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + (dur || 0.16));
    o.stop(audioCtx.currentTime + (dur || 0.16));
  } catch (e) {}
}

/* ===== Boussole N/E/S/O : bande défilante selon le heading du Street View ===== */
const COMPASS_PPD = 2.4;   // pixels par degré
function buildCompass() {
  const strip = $("compass-strip");
  if (!strip || strip.childElementCount) return;
  const card = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SO", 270: "O", 315: "NO" };
  for (let deg = -360; deg <= 720; deg += 15) {
    const norm = ((deg % 360) + 360) % 360, lab = card[norm];
    const t = document.createElement("div");
    t.className = "compass-tick" + (lab ? " major" : "") + (norm % 90 === 0 ? " cardinal" : "");
    t.style.left = ((deg + 360) * COMPASS_PPD) + "px";
    if (lab) t.textContent = lab;
    strip.appendChild(t);
  }
}
function updateCompass(heading) {
  const wrap = $("compass"), strip = $("compass-strip");
  if (!wrap || !strip) return;
  strip.style.transform = "translateX(" + (wrap.clientWidth / 2 - ((heading || 0) + 360) * COMPASS_PPD) + "px)";
}

/* ===== Déplacement clavier dans le Street View (ZQSD / WASD / flèches) ===== */
function svTurn(delta) {
  if (!G.pano) return;
  const p = G.pano.getPov();
  G.pano.setPov({ heading: ((p.heading + delta) % 360 + 360) % 360, pitch: p.pitch, zoom: p.zoom });
}
function svMove(forward) {
  if (!G.pano) return;
  if (G.moveMode === "pro" || G.moveMode === "hardcore") return;   // mode pro : déplacement désactivé
  const links = G.pano.getLinks() || [];
  if (!links.length) return;
  const h = G.pano.getPov().heading, target = forward ? h : (h + 180) % 360;
  let best = null, bd = 999;
  links.forEach((l) => {
    if (!l) return;
    const d = Math.abs(((l.heading - target + 540) % 360) - 180);
    if (d < bd) { bd = d; best = l; }
  });
  if (best && bd <= 72) G.pano.setPano(best.pano);   // tolérance regard↔route (évite les sauts latéraux)
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
  document.body.classList.remove("time-critical");
}
function startTimer(seconds) {
  clearTimer();
  if (!seconds || seconds <= 0) return;
  G.timer = { id: null, remaining: seconds, red: false };
  const el = $("hud-timer");
  if (el) { el.classList.remove("hidden", "danger"); el.textContent = "⏱ " + fmtTime(seconds); }
  document.body.classList.remove("time-critical");
  G.timer.id = setInterval(tickTimer, 1000);
}
function tickTimer() {
  if (!G.timer) return;
  G.timer.remaining--;
  const el = $("hud-timer");
  if (G.timer.remaining <= 30 && !G.timer.red) {            // 30 s restantes : rouge + son + aura
    G.timer.red = true;
    if (el) el.classList.add("danger");
    document.body.classList.add("time-critical");
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
  G.round30 = true;                   // mémorise le plafond : tient même si le pano se révèle après
  if (!G.timer) startTimer(30);
  else if (G.timer.remaining > 30) { G.timer.remaining = 30; G.timer.red = false; }
}

/* ---------- résultat de manche ---------- */
let resMap = null, resOverlays = [];
function ensureResultMap() {
  if (resMap || typeof google === "undefined" || !google.maps) return;
  resMap = new google.maps.Map(document.getElementById("result-map"), {
    center: { lat: 20, lng: 0 }, zoom: 2, minZoom: 2,
    disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy",
    clickableIcons: false, mapTypeControl: false, streetViewControl: false,
    fullscreenControl: false, keyboardShortcuts: false,
  });
}
function clearResultOverlays() { resOverlays.forEach((o) => o.setMap(null)); resOverlays = []; }
function pin(lat, lng, color, scale, title) {
  const m = new google.maps.Marker({
    position: { lat: lat, lng: lng },
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: scale || 7, fillColor: color, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 },
  });
  if (title) m.setTitle(title);
  return m;
}
function drawResult(loc) {
  if (!resMap) return;
  clearResultOverlays();
  const actual = { lat: loc.lat, lng: loc.lng };
  const gb = new google.maps.LatLngBounds(); gb.extend(actual);
  const real = pin(loc.lat, loc.lng, "#ffd35c", 9, "Lieu réel"); real.setMap(resMap); resOverlays.push(real);
  let n = 0;
  const drawFor = (la, ln, color, label, avChoice, avStyle) => {
    gb.extend({ lat: la, lng: ln }); n++;
    // marqueur = la « tête » du joueur (avatar) au lieu d'un point coloré — chaque joueur
    // avec SON index ET SON style (en multi), pas le style du joueur local.
    const m = new google.maps.Marker({ position: { lat: la, lng: ln }, icon: avatarPinIconFor(avChoice, avStyle), title: label, zIndex: 5 });
    m.setMap(resMap); resOverlays.push(m);
    // ligne pointillée guess → lieu réel (Google : trait masqué + symboles répétés)
    const line = new google.maps.Polyline({
      path: [{ lat: la, lng: ln }, actual], map: resMap, strokeOpacity: 0,
      icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: color, scale: 3 }, offset: "0", repeat: "11px" }],
    });
    resOverlays.push(line);
  };
  if (G.online.active) {
    playerList().forEach((p) => {
      const g = p.guess;
      if (g && g.lat != null) drawFor(g.lat, g.lng, playerColor(p.id), p.id === meId() ? "Toi" : p.name, p.av, p.id === meId() ? currentAvStyle() : p.avStyle);
    });
  } else if (G.guess) {
    drawFor(G.guess.lat, G.guess.lng, accentColor(), "Toi", G.avatarChoice, currentAvStyle());
  }
  if (n > 0) {
    resMap.fitBounds(gb, 56);
    google.maps.event.addListenerOnce(resMap, "idle", () => { if (resMap.getZoom() > 13) resMap.setZoom(13); });
  } else { resMap.setCenter(actual); resMap.setZoom(5); }
}

function revealRound() {
  clearTimer();
  showScreen("result");
  ensureResultMap();
  const loc = G.locations[G.current];
  drawResult(loc);
  setTimeout(() => { if (resMap) { google.maps.event.trigger(resMap, "resize"); drawResult(loc); } }, 160);

  $("result-title").textContent = "Manche " + (G.current + 1) + " / " + G.rounds;
  const sub = $("result-sub");
  if (sub) {
    if (!G.online.active) {
      const pts = G.scores[G.current] || 0;
      if (pts >= 3500) G.streak = (G.streak || 0) + 1; else G.streak = 0;
      let s = "À " + fmtDist(G.lastDist) + " · " + scoreQuality(pts);
      if (G.streak >= 2) s += " · Série ×" + G.streak;
      sub.textContent = s;
      sub.classList.remove("hidden");
    } else {
      sub.classList.add("hidden");
    }
  }
  renderResultHero();
  $("result-rows").classList.toggle("hidden", !G.online.active);   // solo : le héros suffit
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
// Héros du reveal : grande tête du joueur + ses points (comptés) + barre qui se remplit.
function renderResultHero() {
  const avEl = $("result-hero-av"), ptsEl = $("result-hero-pts"), fill = $("score-bar-fill"), qual = $("result-hero-quality");
  const me = G.online.active ? G.online.players[meId()] : null;
  const myPts = me ? (me.scores[G.current] || 0) : (G.scores[G.current] || 0);
  const myAv = (me && typeof me.av === "number") ? me.av : G.avatarChoice;
  const myStyle = (me && me.avStyle) ? me.avStyle : currentAvStyle();
  if (avEl) avEl.src = avatarURLFor(myAv, myStyle);
  if (qual) qual.textContent = scoreQuality(myPts);
  // barre : remet à 0, force un reflow, puis largeur cible → déclenche la transition CSS (width)
  if (fill) { fill.style.width = "0%"; void fill.offsetWidth; fill.style.width = Math.max(0, Math.min(100, myPts / 5000 * 100)) + "%"; }
  if (ptsEl) animateCount(ptsEl, myPts, 900);
}
function renderResultRows() {
  const box = $("result-rows"); if (!box) return;
  const round = G.current;
  let rows;
  if (G.online.active) {
    rows = playerList().map((p) => ({
      name: p.id === meId() ? (G.playerName || "Toi") : p.name, av: p.av, me: p.id === meId(),
      avStyle: p.id === meId() ? currentAvStyle() : (p.avStyle || "avataaars"),
      color: playerColor(p.id), dist: p.guess ? p.guess.dist : null, pts: (p.scores[round] || 0),
      badge: p.id === meId() ? equippedItems().badge : p.badge,
    }));
  } else {
    rows = [{ name: G.playerName || "Toi", av: G.avatarChoice, avStyle: currentAvStyle(), me: true, color: accentColor(), dist: G.lastDist, pts: (G.scores[round] || 0), badge: equippedItems().badge }];
  }
  rows.sort((a, b) => b.pts - a.pts);
  box.innerHTML = "";
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "result-row" + (r.me ? " me" : "");
    row.innerHTML =
      '<span class="rank">' + (i + 1) + "</span>" +
      '<span class="dot" style="background:' + r.color + '"></span>' +
      '<img class="rav" src="' + avatarURLFor(r.av, r.avStyle) + '" alt="" draggable="false" />' +
      '<span class="who"></span>' +
      '<span class="dist">' + fmtDist(r.dist) + "</span>" +
      '<span class="pts"><b class="pts-n">0</b> pts</span>';
    const whoEl = row.querySelector(".who");
    whoEl.dataset.pseudo = r.name;
    whoEl.textContent = r.name;
    const wb = badgeEmoji(r.badge);
    if (wb) whoEl.textContent += " " + wb;   // badge à côté du pseudo (résultat multi)
    box.appendChild(row);
    animateCount(row.querySelector(".pts-n"), r.pts, 700);
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
  if (G._advancing) return;                 // anti double-clic / double-message réseau
  G._advancing = true;
  setTimeout(() => { G._advancing = false; }, 500);
  G.current++;
  if (G.current >= G.rounds) showFinal();
  else { showScreen("game"); loadRound(); }
}

function showFinal() {
  showScreen("final");
  const max = G.rounds * 5000;
  let rows;
  if (G.online.active) {
    rows = playerList().map((p) => ({ name: p.id === meId() ? (G.playerName || "Toi") : p.name, av: p.av, avStyle: p.id === meId() ? currentAvStyle() : (p.avStyle || "avataaars"), me: p.id === meId(), total: sum(p.scores) }));
  } else {
    rows = [{ name: G.playerName || "Toi", av: G.avatarChoice, avStyle: currentAvStyle(), me: true, total: sum(G.scores) }];
  }
  rows.sort((a, b) => b.total - a.total);
  const myRank = Math.max(0, rows.findIndex((r) => r.me));
  const myTotal = rows[myRank] ? rows[myRank].total : sum(G.scores);
  G.lastFinalTotal = myTotal;

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
        '<img class="fav" src="' + avatarURLFor(r.av, r.avStyle) + '" alt="" draggable="false" />' +
        '<span class="who"></span>' +
        '<span class="big">0</span>';
      row.querySelector(".who").textContent = r.name;
      box.appendChild(row);
      animateCount(row.querySelector(".big"), r.total, 850);
    });
  }
  if (!G.online.active) recordSoloScore();
  const earned = awardGameCoins(myTotal);
  const xpEarned = awardGameXP(myTotal);
  const coinEl = $("final-coins");
  if (coinEl) {
    coinEl.textContent = earned > 0
      ? "+" + earned.toLocaleString("fr-FR") + " pièces · +" + xpEarned.toLocaleString("fr-FR") + " XP de passe"
      : "+" + xpEarned.toLocaleString("fr-FR") + " XP de passe";
    coinEl.classList.remove("hidden");
  }
  updateReplayUI();
}

/* ===========================================================
   Classement persistant (PostgreSQL via /api/scores)
   La DB est optionnelle : si le serveur répond 503 ou est
   injoignable, le bloc classement se masque sans casser le jeu.
   =========================================================== */
function leaderboardZoneKey() {
  return G.zoneFilter === "country" ? "country:" + G.countryFilter : G.zoneFilter;
}

async function recordSoloScore() {
  const block = $("lb-block"), list = $("lb-list"), rankEl = $("lb-myrank");
  if (!block || !list) return;
  block.classList.remove("hidden");
  list.innerHTML = '<p class="lb-empty">Chargement du classement…</p>';
  if (rankEl) rankEl.textContent = "";
  const zone = leaderboardZoneKey(), label = zoneLabel();
  const duration = G.gameStart ? Math.round((Date.now() - G.gameStart) / 1000) : 0;
  G.lastDuration = duration;
  try {
    const r = await fetch("/api/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pseudo: G.playerName || "Anonyme", zone, zoneLabel: label, rounds: G.rounds, score: sum(G.scores), duration: duration }),
    });
    if (r.status === 503) { block.classList.add("hidden"); return; }   // classement désactivé côté serveur
    if (r.ok && rankEl) {
      const d = await r.json();
      if (d && d.rank) rankEl.textContent = d.rank === 1 ? "🏆 Meilleur score de la zone !" : "Ton rang : " + d.rank + "ᵉ sur « " + label + " »";
    }
  } catch (e) { block.classList.add("hidden"); return; }                // hors-ligne : pas de classement
  loadLeaderboard(zone, list);
}

async function loadLeaderboard(zone, list) {
  try {
    const r = await fetch("/api/scores?limit=10&zone=" + encodeURIComponent(zone || ""));
    const d = await r.json();
    renderLeaderboard(list, (d && d.scores) || []);
  } catch (e) { list.innerHTML = '<p class="lb-empty">Classement indisponible.</p>'; }
}

function renderLeaderboard(list, scores) {
  if (!scores.length) { list.innerHTML = '<p class="lb-empty">Aucun score enregistré pour l\'instant.</p>'; return; }
  const medals = ["🥇", "🥈", "🥉"];
  list.innerHTML = scores.map((s, i) =>
    '<div class="lb-row">' +
      '<span class="lb-rank">' + (medals[i] || (i + 1) + "ᵉ") + "</span>" +
      '<span class="lb-name"></span>' +
      '<span class="lb-time">' + (s.duration_s > 0 ? "⏱ " + fmtTime(s.duration_s) : "") + "</span>" +
      '<span class="lb-pts">' + Number(s.score).toLocaleString("fr-FR") + " pts</span>" +
    "</div>"
  ).join("");
  // les pseudos viennent des joueurs : injectés en textContent (jamais innerHTML) → aucun XSS stocké
  list.querySelectorAll(".lb-name").forEach((el, i) => {
    el.dataset.pseudo = scores[i].pseudo;
    const b = badgeEmoji(scores[i].badge);
    el.textContent = scores[i].pseudo + (b ? " " + b : "");
  });
}

// modale « Classement » ouverte depuis l'accueil : top global toutes zones
async function openLeaderboard() {
  const modal = $("lb-modal"), list = $("lb-modal-list");
  if (!modal || !list) return;
  list.innerHTML = '<p class="lb-empty">Chargement…</p>';
  modal.hidden = false;
  try {
    const r = await fetch("/api/scores?limit=15");
    if (r.status === 503) { list.innerHTML = '<p class="lb-empty">Le classement n\'est pas activé.</p>'; return; }
    const d = await r.json();
    renderLeaderboard(list, (d && d.scores) || []);
  } catch (e) { list.innerHTML = '<p class="lb-empty">Classement indisponible.</p>'; }
}

async function loadLeaderboardPage() {
  const list = $("leaderboard-list");
  if (!list) return;
  list.innerHTML = '<p class="lb-empty">Chargement…</p>';
  try {
    const r = await fetch("/api/scores?limit=25");
    if (r.status === 503) { list.innerHTML = '<p class="lb-empty">Le classement n\'est pas activé.</p>'; return; }
    const d = await r.json();
    renderLeaderboard(list, (d && d.scores) || []);
  } catch (e) { list.innerHTML = '<p class="lb-empty">Classement indisponible.</p>'; }
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
  box.dataset.label = "Salon";
  if (!G.online.active) return;
  const players = playerList();
  box.dataset.label = players.length + (players.length > 1 ? " joueurs" : " joueur") + " dans le salon";
  players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "lobby-player" + (p.id === meId() ? " me" : "");
    let html = '<img class="lobby-av" src="' + avatarURL(p.av) + '" alt="" draggable="false" />' +
               '<span class="lobby-name"></span>';
    if (p.isHost) html += '<span class="lobby-tag">hôte</span>';
    if (G.online.isHost && !G.online.started && p.id !== meId())
      html += '<button class="lobby-kick" data-kick="' + p.id + '" title="Exclure ce joueur">✕</button>';
    row.innerHTML = html;
    const nameEl = row.querySelector(".lobby-name");
    nameEl.dataset.pseudo = p.id === meId() ? ((AUTH.user && AUTH.user.pseudo) || G.playerName || "") : p.name;
    nameEl.textContent = p.id === meId() ? ((G.playerName || "Toi") + " (toi)") : p.name;
    const bdg = p.id === meId() ? myBadgeEmoji() : badgeEmoji(p.badge);
    if (bdg) nameEl.textContent += " " + bdg;   // badge équipé à côté du pseudo
    nameEl.style.color = playerColor(p.id);
    box.appendChild(row);
  });
}

/* ===========================================================
   MULTIJOUEUR — relay WebSocket auto-hébergé
   =========================================================== */
// log multijoueur visible dans la console (préfixe [MP]) — pour diagnostiquer salon/connexion
function mlog() { try { console.log.apply(console, ["%c[MP]", "color:#2ee6a6;font-weight:700"].concat([].slice.call(arguments))); } catch (e) {} }
function genCode() {
  const c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function onlineReset() {
  if (G.online && G.online.isHost && G.online.code) closeOpenGame();   // retire la partie des notifs amis
  try { if (G.online.peer) G.online.peer.destroy(); } catch (e) {}
  try { if (G.online.ws) G.online.ws.close(); } catch (e) {}
  clearInterval(G.online.ka);
  G.online = { active: false, peer: null, ws: null, isHost: false, code: null, started: false,
               myId: null, hostConn: null, conns: {}, players: {}, order: [], open: true,
               revealed: false, iWantReplay: false, ka: null };
}
/* ---- réseau N joueurs : topologie en étoile, l'hôte relaie tout ---- */
function meId() { return G.online.myId; }
function myPlayer() { return G.online.players[meId()] || null; }
function playerList() { return G.online.order.map((id) => G.online.players[id]).filter(Boolean); }
function activePlayerCount() { return playerList().length; }
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
  return G.online.order.map((id) => {
    const p = G.online.players[id];
    return p ? { id, name: p.name, av: p.av, avStyle: p.avStyle || "avataaars", badge: p.badge || "", isHost: !!p.isHost } : null;
  }).filter(Boolean);
}
function broadcastRoster() { if (G.online.isHost) broadcast({ type: "roster", players: buildRoster() }); renderLobby(); updateMultiHud(); }
function applyRoster(list) {
  const old = G.online.players;
  G.online.players = {}; G.online.order = [];
  (list || []).forEach((p) => {
    const prev = old[p.id] || {};
    G.online.players[p.id] = { id: p.id, name: p.name, av: p.av, avStyle: p.avStyle || "avataaars", badge: p.badge || "", isHost: !!p.isHost,
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
function relayClientId() {
  const rnd = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
  return "geoq2-client-" + rnd;
}
function roomsUrl() {
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/rooms";
}
function wsSend(ws, msg) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); } catch (e) {}
}
function relayGuestConn(ws, id) {
  return {
    peer: id,
    open: true,
    send: (m) => wsSend(ws, { type: "to", to: id, message: m }),
    close: function () { this.open = false; wsSend(ws, { type: "close-peer", id }); },
  };
}
function relayHostConn(ws) {
  return {
    peer: "host",
    open: true,
    send: (m) => wsSend(ws, { type: "to-host", message: m }),
    close: function () { this.open = false; try { ws.close(); } catch (e) {} },
  };
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
  if (!requirePlayerName("online-error")) return;
  readOnlineSettings();
  onlineReset();
  const code = genCode();
  G.online.code = code; G.online.isHost = true;
  $("online-error").textContent = "";
  $("online-choice").classList.add("hidden");
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
  mlog("createRoom code", code, "→ relay", roomsUrl());
  G.online.active = true;
  G.online.myId = id;
  G.online.players[id] = { id, name: G.playerName, av: G.avatarChoice, avStyle: currentAvStyle(), badge: equippedItems().badge, scores: [], guess: null, done: false, isHost: true };
  G.online.order = [id];
  renderLobby();

  const ws = new WebSocket(roomsUrl());
  G.online.ws = ws;
  ws.onopen = () => {
    if (G.online.ws !== ws || !G.online.isHost) return;
    wsSend(ws, { type: "create", code, id, name: G.playerName, av: G.avatarChoice });
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (G.online.ws !== ws || !G.online.isHost) return;

    if (m.type === "created") {
    mlog("salle prête, code", code);
    $("room-code").textContent = code;
    $("btn-copy").disabled = false;
    announceOpenGame();   // partie ouverte (défaut) → notifie tes amis
    $("online-status").textContent = "En attente de joueurs…";

    } else if (m.type === "peer-joined" && m.player && m.player.id) {
      G.online.conns[m.player.id] = relayGuestConn(ws, m.player.id);
      mlog("invité connecté:", m.player.id);
      $("online-status").textContent = "Un joueur se connecte…";

    } else if (m.type === "from" && m.from) {
      if (!G.online.conns[m.from]) G.online.conns[m.from] = relayGuestConn(ws, m.from);
      onData(m.message, m.from);

    } else if (m.type === "peer-left" && m.id) {
      if (G.online.conns[m.id]) hostDropConn(m.id);

    } else if (m.type === "error") {
      $("online-error").textContent = m.reason === "code-taken" ? "Code déjà pris, réessaie." : "Erreur réseau : " + (m.reason || "relay");
      backToOnlineChoice();
    }
  };
  ws.onerror = () => {
    $("online-error").textContent = "Erreur réseau : relay WebSocket indisponible.";
    backToOnlineChoice();
  };
  ws.onclose = () => {
    if (G.online.isHost && !G.online.started && $("online").classList.contains("show")) {
      $("online-error").textContent = "La salle a été fermée.";
      backToOnlineChoice();
    }
  };
  clearInterval(G.online.ka);
  G.online.ka = setInterval(() => {
    if (G.online.ws && G.online.ws.readyState === WebSocket.OPEN) wsSend(G.online.ws, { type: "ping" });
  }, 12000);
}

function joinRoom(codeArg) {
  if (!mapsReady) { $("online-error").textContent = "La carte charge encore, patiente une seconde."; return; }
  if (!requirePlayerName("online-error")) return;
  const code = (codeArg || $("join-code").value || "").trim().toUpperCase();
  if (code.length < 4) { $("online-error").textContent = "Entre le code à 4 caractères."; return; }
  onlineReset();
  G.online.code = code; G.online.isHost = false;
  $("online-error").textContent = "";
  $("online-choice").classList.add("hidden");
  $("online-wait").classList.add("show");
  $("btn-start-room").classList.add("hidden");
  $("btn-start-room").disabled = true;
  $("room-options").classList.add("hidden");
  $("room-code").textContent = code;
  $("btn-copy").textContent = "Copier le lien";
  $("btn-copy").disabled = true;
  $("room-settings").textContent = "";
  $("online-status").textContent = "Connexion à la salle…";

  const id = relayClientId();
  mlog("joinRoom", code, "→ relay", roomsUrl());
  const ws = new WebSocket(roomsUrl());
  G.online.ws = ws;
  G.online.myId = id;

  ws.onopen = () => {
    if (G.online.ws !== ws || G.online.isHost || G.online.code !== code) return;
    wsSend(ws, { type: "join", code, id, name: G.playerName, av: G.avatarChoice });
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (G.online.ws !== ws || G.online.isHost) return;

    if (m.type === "joined") {
      setupGuestRelay(ws, id);
      if (m.roster) applyRoster(m.roster);

    } else if (m.type === "from") {
      onData(m.message, "host");

    } else if (m.type === "server-roster" && !G.online.started && m.roster) {
      applyRoster(m.roster);

    } else if (m.type === "host-closed") {
      clearInterval(G.online.ka);
      $("online-error").textContent = "Cette partie n'est plus disponible : l'hôte a quitté le salon.";
      if (typeof markNotifRead === "function") markNotifRead("game:" + code);   // retire la notif fantôme
      backToOnlineChoice();

    } else if (m.type === "error") {
      if (m.reason === "not-found" && typeof markNotifRead === "function") markNotifRead("game:" + code);
      $("online-error").textContent = m.reason === "not-found" ? "Cette partie n'existe plus (l'hôte a fermé le salon) ou le code est erroné." : "Erreur réseau : " + (m.reason || "relay");
      backToOnlineChoice();
    }
  };
  ws.onerror = () => {
    if (!G.online.active) {
      $("online-error").textContent = "Connexion impossible au serveur multijoueur.";
      backToOnlineChoice();
    } else flashStatus("⚠️ Problème de connexion");
  };
  ws.onclose = () => {
    clearInterval(G.online.ka);
    if (!G.online.started && $("online").classList.contains("show")) {
      $("online-error").textContent = "La salle a été fermée."; backToOnlineChoice();
    } else if (G.online.active) flashStatus("⚠️ Hôte déconnecté — partie terminée");
  };
}

function setupGuestRelay(ws, id) {
  G.online.hostConn = relayHostConn(ws);
  G.online.active = true;
  G.online.started = false;
  G.online.myId = id;
  clearInterval(G.online.ka);
  G.online.ka = setInterval(() => wsSend(ws, { type: "ping" }), 12000);

  // s'inscrire localement, puis se présenter à l'hôte (qui diffuse le roster complet)
  G.online.players = {}; G.online.order = [];
  G.online.players[meId()] = { id: meId(), name: G.playerName, av: G.avatarChoice, avStyle: currentAvStyle(), badge: equippedItems().badge, scores: [], guess: null, done: false, isHost: false };
  G.online.order = [meId()];

  sendToHost({ type: "hello", name: G.playerName, av: G.avatarChoice, avStyle: currentAvStyle(), badge: equippedItems().badge });
  $("online-status").textContent = "Connecté — en attente de l'hôte";
  renderLobby();
}

async function hostStartGame() {
  mlog("hostStartGame:", activePlayerCount(), "joueurs · isHost", G.online.isHost, "· started", G.online.started);
  if (!G.online.active || !G.online.isHost || G.online.started) return;
  if (activePlayerCount() < 2) { $("online-status").textContent = "Il faut au moins un autre joueur pour lancer."; return; }
  readRoomSettings();
  closeOpenGame();           // la partie démarre → plus joignable, retire des notifs
  G.online.started = true;
  $("btn-start-room").disabled = true;
  $("btn-start-room").classList.add("hidden");
  $("room-options").classList.add("hidden");
  broadcast({ type: "start", rounds: G.rounds, zone: G.zoneFilter, country: G.countryFilter, time: G.timeLimit, mode: G.moveMode });
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
  mlog("recv", m.type, "from", fromId);

  if (m.type === "hello") {
    // [hôte] un invité se présente → l'ajouter au roster et le diffuser à tous
    if (G.online.isHost && fromId && fromId !== "host") {
      const exists = !!G.online.players[fromId];
      const prev = G.online.players[fromId] || {};
      G.online.players[fromId] = { id: fromId, name: cleanName(m.name || "Joueur"), av: m.av || 0, avStyle: m.avStyle || "avataaars", badge: m.badge || "",
        scores: prev.scores || [], guess: prev.guess || null, done: prev.done || false, isHost: false };
      if (!exists) G.online.order.push(fromId);
      broadcastRoster();
      const c = G.online.conns[fromId];
      try { if (c && c.open) c.send({ type: "settings", rounds: G.rounds, time: G.timeLimit, zone: G.zoneFilter, country: G.countryFilter, mode: G.moveMode }); } catch (e) {}
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

  } else if (m.type === "lobby") {
    if (!G.online.isHost) { applyRemoteSettings(m); enterOnlineLobby("Connecté — en attente de l'hôte"); }

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
  hostReturnToLobby();
}
function updateReplayUI() {
  const btn = $("btn-replay");
  if (!btn) return;
  if (!G.online.active) { btn.classList.remove("hidden"); btn.disabled = false; btn.textContent = "Rejouer"; }
  else if (G.online.isHost) { btn.classList.remove("hidden"); btn.disabled = false; btn.textContent = "Retour au lobby"; }
  else btn.classList.add("hidden");   // l'invité attend que l'hôte relance
  const w = $("final-wait");
  if (w) w.classList.toggle("hidden", !(G.online.active && !G.online.isHost));
  if (w && G.online.active && !G.online.isHost) w.textContent = "En attente de l'hôte pour retourner au lobby…";
}
function resetOnlineGameState() {
  clearTimer();
  G.current = 0;
  G.scores = [];
  G.guess = null;
  G.submitted = false;
  G.rewarded = false;
  G.progressRewarded = false;
  G.lastDist = null;
  resetLocations();
  playerList().forEach((p) => { p.scores = []; p.guess = null; p.done = false; });
  G.online.started = false;
  G.online.revealed = false;
}
function enterOnlineLobby(statusText) {
  resetOnlineGameState();
  showScreen("online");
  $("online-choice").classList.add("hidden");
  $("online-wait").classList.add("show");
  $("room-code").textContent = G.online.code || "----";
  $("btn-copy").textContent = "Copier le lien";
  $("btn-copy").disabled = !G.online.isHost;
  $("online-error").textContent = "";
  if (G.online.isHost) {
    $("room-options").classList.remove("hidden");
    mirrorSettingsToRoom();
    $("btn-start-room").classList.remove("hidden");
    updateLobbyControls();
    broadcastRoster();
    sendRoomSettings();
  } else {
    $("room-options").classList.add("hidden");
    $("btn-start-room").classList.add("hidden");
    $("btn-start-room").disabled = true;
    $("room-settings").textContent = settingsText();
    $("online-status").textContent = statusText || "Connecté — en attente de l'hôte";
  }
  renderLobby();
  updateMultiHud();
}
function hostReturnToLobby() {
  if (!G.online.active || !G.online.isHost) return;
  broadcast({ type: "lobby", rounds: G.rounds, zone: G.zoneFilter, country: G.countryFilter, time: G.timeLimit, mode: G.moveMode });
  enterOnlineLobby();
}

/* ---------- navigation online ---------- */
function backToOnlineChoice() {
  $("online-wait").classList.remove("show");
  $("online-choice").classList.remove("hidden");
  $("room-options").classList.add("hidden");
  $("btn-start-room").classList.add("hidden");
  $("btn-start-room").disabled = true;
  $("room-settings").textContent = "";
}
function goHome() { goTab("menu", { confirmed: true }); }   // déjà confirmé → ne rouvre pas la modale

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
  const D = Math.PI / 180;
  const polys = geo.type === "MultiPolygon" ? geo.coordinates : [geo.coordinates];

  // 1) masque terre/mer en projection équirectangulaire (remplissage robuste : un pixel = terre OU mer)
  const TW = 1024, TH = 512;
  const tc = document.createElement("canvas"); tc.width = TW; tc.height = TH;
  const tctx = tc.getContext("2d");
  tctx.fillStyle = "#000"; tctx.fillRect(0, 0, TW, TH);
  tctx.fillStyle = "#fff";
  polys.forEach((poly) => {
    const ring = poly[0]; if (!ring || ring.length < 3) return;   // anneau extérieur seul (pas les mers intérieures)
    tctx.beginPath();
    for (let i = 0; i < ring.length; i++) {
      const x = (ring[i][0] / 360 + 0.5) * TW, y = (0.5 - ring[i][1] / 180) * TH;
      if (i) tctx.lineTo(x, y); else tctx.moveTo(x, y);
    }
    tctx.closePath(); tctx.fill();
  });
  const td = tctx.getImageData(0, 0, TW, TH).data;
  const land = new Uint8Array(TW * TH);
  for (let i = 0; i < TW * TH; i++) land[i] = td[i * 4] > 100 ? 1 : 0;

  // 2) anneaux pour le contour vectoriel (côtes nettes), densifiés
  const rings = [];
  polys.forEach((poly) => {
    const ring = poly[0]; if (!ring || ring.length < 3) return;
    const pts = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      pts.push([a[0] * D, a[1] * D]);
      const dl = b[0] - a[0], db = b[1] - a[1];
      if (Math.abs(dl) > 180) continue;
      const dist = Math.hypot(dl, db);
      if (dist > 3) { const n = Math.ceil(dist / 3); for (let s = 1; s < n; s++) pts.push([(a[0] + dl * s / n) * D, (a[1] + db * s / n) * D]); }
    }
    if (pts.length > 2) rings.push(pts);
  });

  const ctx = cv.getContext("2d");
  const tilt = 16 * D, sinT = Math.sin(tilt), cosT = Math.cos(tilt);
  let lon0 = -0.2, R = 0, cx = 0, cy = 0;

  // 3) tampon raster hors-écran (diamètre plafonné) + grille pré-calculée (indépendante de la rotation)
  const oc = document.createElement("canvas"), octx = oc.getContext("2d");
  let oimg = null, latG = null, lngG = null, inDisk = null, shade = null;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const box = cv.getBoundingClientRect();
    cv.width = Math.max(2, Math.round((box.width || 400) * dpr));
    cv.height = Math.max(2, Math.round((box.height || 400) * dpr));
    // Garde une large marge pour le halo atmosphérique dessiné à R * 1.14.
    R = Math.min(cv.width, cv.height) / 2 * 0.68; cx = cv.width / 2; cy = cv.height / 2;
    const od = Math.min(Math.round(2 * R), 560), oR = od / 2;   // résolution du remplissage (haute = globe net, plafonnée pour la perf)
    oc.width = Math.max(2, od); oc.height = oc.width;
    oimg = octx.createImageData(oc.width, oc.height);
    const N = oc.width * oc.height;
    latG = new Float32Array(N); lngG = new Float32Array(N); inDisk = new Uint8Array(N); shade = new Float32Array(N);
    for (let py = 0; py < oc.height; py++) for (let px = 0; px < oc.width; px++) {
      const i = py * oc.width + px;
      const xm = (px - oR) / oR, ym = -(py - oR) / oR;   // repère math (nord = +y)
      const rho2 = xm * xm + ym * ym;
      if (rho2 > 1) { inDisk[i] = 0; continue; }
      inDisk[i] = 1;
      const rho = Math.sqrt(rho2), c = Math.asin(rho < 1 ? rho : 1);
      const sinc = Math.sin(c), cosc = Math.cos(c);
      latG[i] = (rho < 1e-9) ? tilt : Math.asin(cosc * sinT + ym * sinc * cosT / rho);
      lngG[i] = Math.atan2(xm * sinc, rho * cosc * cosT - ym * sinc * sinT);
      const dot = -0.36 * xm + 0.46 * ym + 0.81 * cosc;   // éclairage haut-gauche-avant
      shade[i] = 0.42 + 0.64 * (dot > 0 ? dot : 0);
    }
  }
  resize();
  window.addEventListener("resize", resize);

  // rotation au cliquer-glisser ; au relâcher, élan puis retour à la vitesse de base
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

  const TWO = Math.PI * 2;
  let lastT = 0;
  function frame(t) {
    globeRAF = requestAnimationFrame(frame);
    if (t - lastT < 26) return;   // ~38 fps
    lastT = t;
    if (!document.getElementById("menu").classList.contains("show")) return;
    ctx.clearRect(0, 0, cv.width, cv.height);

    // remplissage raster : terre verte / océan bleu, par échantillonnage du masque (jamais de vert dans l'eau)
    const d = oimg.data, N = inDisk.length;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (!inDisk[i]) { d[o + 3] = 0; continue; }
      let lng = lngG[i] + lon0;
      lng -= TWO * Math.floor((lng + Math.PI) / TWO);   // ramener dans -π..π
      let tx = ((lng / TWO) + 0.5) * TW | 0; if (tx < 0) tx = 0; else if (tx >= TW) tx = TW - 1;
      let ty = (0.5 - latG[i] / Math.PI) * TH | 0; if (ty < 0) ty = 0; else if (ty >= TH) ty = TH - 1;
      if (land[ty * TW + tx]) { const sh = shade[i]; d[o] = 26 + 70 * sh; d[o + 1] = 150 + 95 * sh; d[o + 2] = 112 + 70 * sh; d[o + 3] = 240; }
      else d[o + 3] = 0;   // mer transparente → l'océan dégradé en dessous reste visible
    }
    octx.putImageData(oimg, 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TWO); ctx.clip();
    // océan : un seul disque dégradé couvrant tout le globe jusqu'au bord (évite tout « second cercle »)
    const og = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.12, cx, cy, R * 1.12);
    og.addColorStop(0, "#1b4d80"); og.addColorStop(.6, "#103258"); og.addColorStop(1, "#0a2240");
    ctx.fillStyle = og; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(oc, cx - R, cy - R, 2 * R, 2 * R);

    // contour vectoriel des côtes (net) — uniquement les segments sur la face visible
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(168,252,218,.55)";
    ctx.lineWidth = Math.max(1, R * 0.0035);
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r]; ctx.beginPath(); let pen = false;
      for (let i = 0; i < ring.length; i++) {
        const lat = ring[i][1], dl = ring[i][0] - lon0;
        const cc = sinT * Math.sin(lat) + cosT * Math.cos(lat) * Math.cos(dl);
        if (cc < 0) { pen = false; continue; }
        const x = cx + R * Math.cos(lat) * Math.sin(dl);
        const y = cy - R * (cosT * Math.sin(lat) - sinT * Math.cos(lat) * Math.cos(dl));
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // halo atmosphérique doux uniquement (un seul globe, pas de cercle de contour distinct)
    const ag = ctx.createRadialGradient(cx, cy, R * 0.99, cx, cy, R * 1.14);
    ag.addColorStop(0, "rgba(46,230,166,.16)"); ag.addColorStop(1, "rgba(46,230,166,0)");
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.14, 0, TWO); ctx.fillStyle = ag; ctx.fill();

    if (!dragging) { lon0 += vel; vel += (baseSpeed - vel) * 0.03; }
  }
  globeRAF = requestAnimationFrame(frame);
}

/* ---------- UI comptes (modale login / inscription) ---------- */
function renderAuthUI() {
  const btn = $("account-btn");
  if (!btn) return;
  // L'icône SVG (.account-ico) est fixe dans index.html ; on ne change QUE le
  // libellé (#account-name) et l'état .logged — jamais d'emoji injecté ici.
  const name = $("account-name");
  if (isLogged()) {
    if (name) name.textContent = AUTH.user.pseudo || "Compte";
    btn.classList.add("logged");
    btn.title = "Voir mon profil";
  } else {
    if (name) name.textContent = "Se connecter";
    btn.classList.remove("logged");
    btn.title = "Se connecter ou créer un compte";
  }
}
function setAuthMode(mode) {
  const m = $("auth-modal");
  if (!m) return;
  m.dataset.mode = mode; // "login" | "register"
  const tabLogin = $("auth-tab-login");
  const tabReg = $("auth-tab-register");
  if (tabLogin) tabLogin.classList.toggle("on", mode === "login");
  if (tabReg) tabReg.classList.toggle("on", mode === "register");
  const ok = $("auth-submit");
  if (ok) ok.textContent = mode === "register" ? "Créer mon compte" : "Se connecter";
  const err = $("auth-err");
  if (err) err.textContent = "";
}
function openAuthModal() {
  // Déjà connecté : on ouvre le profil (la déconnexion s'y trouve désormais).
  if (isLogged()) { openProfile(); return; }
  const m = $("auth-modal");
  if (!m) return;
  setAuthMode("login");
  const p = $("auth-pseudo"); if (p) p.value = (G.playerName || "");
  const pw = $("auth-password"); if (pw) pw.value = "";
  const err = $("auth-err"); if (err) err.textContent = "";
  m.hidden = false;
  setTimeout(() => { try { (G.playerName ? $("auth-password") : $("auth-pseudo")).focus(); } catch (e) {} }, 60);
}
function closeAuthModal() {
  const m = $("auth-modal");
  if (m) m.hidden = true;
}

/* ---------- Profil (modale) : collection cosmétique + équipement ----------
   Réutilise SHOP_ITEMS / ownedItems / equippedItems / buyOrEquip / applyCosmetics.
   N'affiche QUE les items débloqués, regroupés par catégorie, avec aperçu live. */
// id d'item → classe d'aperçu CSS (.shop-art.<classe>). Items sans aperçu dédié
// (badge, avatars, themeDefault, fxNone) → fond neutre/vert par défaut (.shop-art seule).
const PROFILE_ART = {
  boreal: "", aurora: "aurora", sunset: "sunset", emerald: "emerald", magma: "magma",
  cyber: "cyber", sakura: "sakura", mono: "mono", themeDefault: "emerald",
  badge: "badge", badgeCompass: "badge-compass", badgeFlame: "badge-flame",
  badgeStar: "badge-star", badgeCrown: "badge-crown",
  avatars: "compass-art", avatarsBot: "pack-bot", avatarsPixel: "pack-pixel",
  fxNone: "", fxAurora: "fx-aurora",
  bannerDefault: "banner-default", bannerSummit: "banner-summit", bannerAurora: "banner-aurora",
  bannerSunset: "banner-sunset", bannerAtlas: "banner-atlas", bannerLegendary: "banner-legendary",
};
const PROFILE_CATS = [
  ["theme", "Thèmes"],
  ["badge", "Badges"],
  ["avatarPack", "Avatars"],
  ["fx", "Effets"],
  ["banner", "Bannières de profil"],
];
function renderProfilePass() {
  const progress = passProgress(), rank = $("prof-rank"), small = $("profile-pass-progress"), passFill = $("profile-pass-fill");
  if (rank) rank.textContent = "🎟 Passe de combat · Palier " + progress.level + " / " + PASS_MAX_LEVEL;
  const percent = progress.level >= PASS_MAX_LEVEL ? 100 : progress.current / PASS_XP_PER_LEVEL * 100;
  if (passFill) passFill.style.width = percent + "%";
  const text = progress.level >= PASS_MAX_LEVEL ? "Passe terminée · récompense ultime récupérable" : progress.current.toLocaleString("fr-FR") + " / " + PASS_XP_PER_LEVEL.toLocaleString("fr-FR") + " XP";
  if (small) small.textContent = text;
}
// Mini-vignette d'aperçu d'une récompense de palier (fond dégradé / emoji badge / avatar / pièces).
function passRewardThumb(reward) {
  const t = document.createElement("span");
  t.className = "pass-art";
  const it = reward.item && SHOP_ITEMS[reward.item];
  if (it && it.type === "banner") { t.classList.add("k-banner"); t.style.background = BANNER_ART[bannerSkin(reward.item)] || BANNER_ART.bannerDefault; }
  else if (it && it.type === "badge") { t.classList.add("k-badge"); t.textContent = badgeEmoji(reward.item) || "🎖"; }
  else if (it && it.type === "avatarPack") { t.classList.add("k-av"); const im = document.createElement("img"); im.alt = ""; im.draggable = false; im.src = avatarURLFor(0, AV_STYLES[reward.item] || "avataaars"); t.appendChild(im); }
  else { t.classList.add("k-coins"); t.textContent = reward.jackpot ? "💰" : "🪙"; }
  return t;
}
function renderBattlePass() {
  const list = $("battle-pass-list"); if (!list) return;
  const progress = passProgress(), claims = passClaims(), head = $("battle-pass-summary"), fill = $("battle-pass-fill");
  if (head) head.textContent = "Palier " + progress.level + " / " + PASS_MAX_LEVEL + " · " + (progress.level >= PASS_MAX_LEVEL ? "Passe complétée" : progress.current.toLocaleString("fr-FR") + " / " + PASS_XP_PER_LEVEL.toLocaleString("fr-FR") + " XP");
  if (fill) fill.style.width = (progress.level >= PASS_MAX_LEVEL ? 100 : progress.current / PASS_XP_PER_LEVEL * 100) + "%";
  list.innerHTML = "";
  for (let level = 1; level <= PASS_MAX_LEVEL; level++) {
    const reward = passReward(level), claimed = claims.includes(level), unlocked = level <= progress.level;
    const row = document.createElement("article");
    row.className = "pass-tier" + (unlocked ? " unlocked" : "") + (claimed ? " claimed" : "") + (reward.milestone ? " milestone" : "") + (reward.jackpot ? " jackpot" : "") + (reward.ultimate ? " ultimate" : "");
    const title = reward.ultimate ? "✦ ULTIME" : reward.jackpot ? "💰 JACKPOT" : reward.milestone ? "★ MAJEUR" : "Récompense";
    const text = reward.item ? reward.label + " + " + reward.coins.toLocaleString("fr-FR") + " pièces" : reward.label;
    const lvl = document.createElement("span"); lvl.className = "pass-level"; lvl.textContent = level;
    row.appendChild(lvl);
    row.appendChild(passRewardThumb(reward));
    const rw = document.createElement("span"); rw.className = "pass-reward";
    const st = document.createElement("strong"); st.textContent = title;
    const sm = document.createElement("small"); sm.textContent = text;
    rw.appendChild(st); rw.appendChild(sm); row.appendChild(rw);
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn btn-mini pass-claim"; btn.dataset.passLevel = level;
    btn.disabled = !unlocked || claimed; btn.textContent = claimed ? "Récupérée" : unlocked ? "Récupérer" : "Verrouillée";
    row.appendChild(btn);
    list.appendChild(row);
  }
}
function openBattlePass() { if (!isLogged()) { openAuthModal(); return; } renderBattlePass(); $("battle-pass-modal").hidden = false; }
function closeBattlePass() { const m = $("battle-pass-modal"); if (m) m.hidden = true; }
function openProfile() {
  if (!isLogged()) { openAuthModal(); return; }
  goTab("profile");                    // page dédiée (plus de pop-up)
}
function closeProfile() { /* la page se ferme par navigation ; conservé pour compat */ }

// ===== Page Profil : identité + rang + top 3 + zones favorites =====
const RANKS = [
  [0, "Explorateur novice", "🧭"], [8000, "Aventurier", "🗺️"], [13000, "Globe-trotteur", "🌍"],
  [17000, "Cartographe", "📍"], [20000, "Maître géographe", "🎯"], [23000, "Légende du globe", "👑"],
];
function rankFor(best) {
  let r = RANKS[0];
  for (const x of RANKS) if (best >= x[0]) r = x;
  const idx = RANKS.indexOf(r), next = RANKS[idx + 1] || null;
  return { name: r[1], icon: r[2], cur: r[0], next: next ? next[0] : null };
}
function renderProfilePage() {
  if (!isLogged()) { showScreen("menu"); return; }   // pas de modale auto (évite l'ouverture parasite au boot)
  const pseudo = (AUTH.user && AUTH.user.pseudo) || G.playerName || "Joueur";
  if ($("prof-pseudo")) $("prof-pseudo").textContent = pseudo + (myBadgeEmoji() ? " " + myBadgeEmoji() : "");
  if ($("prof-av")) $("prof-av").innerHTML = '<img src="' + avatarURL(G.avatarChoice) + '" alt="" draggable="false" />';
  if ($("profile-coins")) $("profile-coins").innerHTML = '<span aria-hidden="true">🪙</span> ' + getCoins().toLocaleString("fr-FR");
  renderProfilePass();
  renderProfileCollections();
  renderFavorites();
  if (typeof renderFriends === "function") renderFriends();
  const box = $("prof-top3"); if (box) box.innerHTML = '<p class="comm-empty">Chargement…</p>';
  fetch("/api/me/top", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      d = d || {};
      const best = d.best || 0, games = d.games || 0;
      if ($("prof-best")) $("prof-best").textContent = best > 0 ? "Record " + best.toLocaleString("fr-FR") : "Record —";
      if ($("prof-games")) $("prof-games").textContent = games + (games > 1 ? " parties" : " partie");
      if (!box) return;
      box.innerHTML = "";
      const top = Array.isArray(d.top) ? d.top : [];
      if (!top.length) { box.innerHTML = '<p class="comm-empty">Aucune partie enregistrée — lance-toi !</p>'; return; }
      const medals = ["🥇", "🥈", "🥉"];
      top.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "prof-score-row";
        row.appendChild(commSpan("prof-score-rank", medals[i] || (i + 1) + "ᵉ"));
        row.appendChild(commSpan("prof-score-zone", s.zone_label || "—"));
        if (s.duration_s > 0) row.appendChild(commSpan("prof-score-time", "⏱ " + fmtTime(s.duration_s)));
        row.appendChild(commSpan("prof-score-pts", fmtPts(s.score) + " pts"));
        box.appendChild(row);
      });
    })
    .catch(() => { if (box) box.innerHTML = '<p class="comm-empty">Scores indisponibles.</p>'; });
}

// ----- Zones favorites -----
const FAV_KEY = "geoq-fav";
function getFavorites() { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch (e) { return []; } }
function saveFavorites(f) { try { localStorage.setItem(FAV_KEY, JSON.stringify(f)); } catch (e) {} pushState(); }
function favLabelFor(z, co) {
  let label = z;
  zoneGroups().forEach((g) => g[1].forEach((e) => { if (e.z === z && (!e.co || e.co === co)) label = e.l; }));
  return label;
}
function addFavorite(z, co) {
  let f = getFavorites();
  const key = z + "|" + (co || "");
  f = f.filter((x) => x.key !== key);
  f.unshift({ key: key, z: z, co: co || "", label: favLabelFor(z, co) });
  saveFavorites(f.slice(0, 3)); renderFavorites();
}
function removeFavorite(key) { saveFavorites(getFavorites().filter((x) => x.key !== key)); renderFavorites(); }
function renderFavorites() {
  const box = $("prof-fav"); if (!box) return;
  box.innerHTML = "";
  const favs = getFavorites();
  favs.forEach((f) => {
    const row = document.createElement("div"); row.className = "prof-fav-item";
    const play = document.createElement("button"); play.type = "button"; play.className = "prof-fav-play";
    play.appendChild(commSpan("prof-fav-name", f.label));
    play.appendChild(commSpan("prof-fav-go", "Jouer ›"));
    play.addEventListener("click", () => { selectZone(f.z, f.co || undefined); startSolo(); });
    const del = document.createElement("button"); del.type = "button"; del.className = "prof-fav-del"; del.textContent = "✕"; del.title = "Retirer";
    del.addEventListener("click", () => removeFavorite(f.key));
    row.appendChild(play); row.appendChild(del); box.appendChild(row);
  });
  if (favs.length < 3) {
    const add = document.createElement("button"); add.type = "button"; add.className = "prof-fav-add";
    add.textContent = "+ Ajouter une zone favorite";
    add.addEventListener("click", () => { G.favPick = true; buildZoneModal(true); $("zone-modal").hidden = false; });
    box.appendChild(add);
  }
}

// ----- Profil PUBLIC (modale ouverte en cliquant un pseudo) + amis -----
function profScoreRow(s, i) {
  const medals = ["🥇", "🥈", "🥉"];
  const row = document.createElement("div"); row.className = "prof-score-row";
  row.appendChild(commSpan("prof-score-rank", medals[i] || (i + 1) + "ᵉ"));
  row.appendChild(commSpan("prof-score-zone", s.zone_label || "—"));
  if (s.duration_s > 0) row.appendChild(commSpan("prof-score-time", "⏱ " + fmtTime(s.duration_s)));
  row.appendChild(commSpan("prof-score-pts", fmtPts(s.score) + " pts"));
  return row;
}
let _pubPseudo = null;
function openPublicProfile(pseudo) {
  const m = $("pubprofile-modal"); if (!m || !pseudo) return;
  const card = m.querySelector(".pubprofile-card") || m;   // le fond s'applique sur la CARTE, pas l'overlay
  card.dataset.banner = "bannerDefault";
  _pubPseudo = pseudo;
  $("pub-pseudo").textContent = pseudo;
  $("pub-av").innerHTML = ""; $("pub-rank").textContent = "🎟 Passe de combat";
  if ($("pub-pass-label")) $("pub-pass-label").textContent = "Passe de combat · chargement…";
  if ($("pub-pass-fill")) $("pub-pass-fill").style.width = "0%";
  $("pub-best").textContent = "Record —"; $("pub-games").textContent = "";
  $("pub-top3").innerHTML = '<p class="comm-empty">Chargement…</p>';
  $("pub-friend").hidden = true;
  { const fd = $("pub-friend-decline"); if (fd) fd.hidden = true; }
  m.hidden = false;
  fetch("/api/profile/" + encodeURIComponent(pseudo), { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d || !d.ok) { $("pub-top3").innerHTML = '<p class="comm-empty">Profil introuvable.</p>'; return; }
      const p = d.profile;
      card.dataset.banner = bannerSkin((p.equipped || {}).banner);
      const pubBadge = badgeEmoji((p.equipped || {}).badge);
      $("pub-pseudo").textContent = p.pseudo + (pubBadge ? " " + pubBadge : "");
      const style = (AV_STYLES[(p.equipped || {}).avatarPack]) || "avataaars";
      $("pub-av").innerHTML = '<img src="' + avatarURLFor(p.av || 0, style) + '" alt="" draggable="false" />';
      const xp = Number.isInteger(p.passXp) ? Math.max(0, Math.min(p.passXp, PASS_MAX_LEVEL * PASS_XP_PER_LEVEL)) : 0;
      const level = Math.min(PASS_MAX_LEVEL, Math.floor(xp / PASS_XP_PER_LEVEL) + 1);
      const current = xp >= PASS_MAX_LEVEL * PASS_XP_PER_LEVEL ? PASS_XP_PER_LEVEL : xp % PASS_XP_PER_LEVEL;
      const percent = level >= PASS_MAX_LEVEL ? 100 : current / PASS_XP_PER_LEVEL * 100;
      $("pub-rank").textContent = "🎟 Passe de combat · Palier " + level + " / " + PASS_MAX_LEVEL;
      if ($("pub-pass-label")) $("pub-pass-label").textContent = level >= PASS_MAX_LEVEL ? "Passe de combat terminée" : current.toLocaleString("fr-FR") + " / " + PASS_XP_PER_LEVEL.toLocaleString("fr-FR") + " XP vers le palier " + (level + 1);
      if ($("pub-pass-fill")) $("pub-pass-fill").style.width = percent + "%";
      $("pub-best").textContent = p.best > 0 ? "Record " + p.best.toLocaleString("fr-FR") : "Record —";
      $("pub-games").textContent = (p.games || 0) + ((p.games || 0) > 1 ? " parties" : " partie");
      const box = $("pub-top3"); box.innerHTML = "";
      const top = Array.isArray(p.top) ? p.top : [];
      if (!top.length) box.innerHTML = '<p class="comm-empty">Aucune partie enregistrée.</p>';
      else top.forEach((s, i) => box.appendChild(profScoreRow(s, i)));
      const fb = $("pub-friend"), fd = $("pub-friend-decline");
      if (fd) fd.hidden = true;
      if (isLogged() && !p.isMe) {
        fb.hidden = false;
        // 4 états : ami / demande reçue (accepter + refuser) / demande envoyée / rien
        if (p.isFriend) { fb.textContent = "✓ Amis — retirer"; fb.dataset.action = "remove"; fb.disabled = false; }
        else if (p.requestReceived) { fb.textContent = "✓ Accepter la demande"; fb.dataset.action = "accept"; fb.disabled = false; if (fd) fd.hidden = false; }
        else if (p.requestSent) { fb.textContent = "⏳ Demande envoyée — annuler"; fb.dataset.action = "cancel"; fb.disabled = false; }
        else { fb.textContent = "+ Ajouter en ami"; fb.dataset.action = "add"; fb.disabled = false; }
      } else { fb.hidden = true; if (fd) fd.hidden = true; }
    })
    .catch(() => { $("pub-top3").innerHTML = '<p class="comm-empty">Erreur réseau.</p>'; });
}
function renderFriends() {
  const block = $("prof-friends-block"), box = $("prof-friends");
  if (!block || !box) return;
  if (!isLogged()) { block.hidden = true; return; }
  block.hidden = false;
  box.innerHTML = '<p class="comm-empty">Chargement…</p>';
  fetch("/api/friends", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const friends = (d && d.friends) || [];
      box.innerHTML = "";
      if (!friends.length) { box.innerHTML = '<p class="comm-empty">Aucun ami pour l\'instant — cherche un pseudo ci-dessous ou clique sur un joueur (classement, communauté…) pour lui envoyer une demande.</p>'; return; }
      friends.forEach((f) => {
        const row = document.createElement("div"); row.className = "prof-friend-row";
        const img = document.createElement("img"); img.className = "prof-friend-av"; img.src = avatarURLFor(f.av || 0, "avataaars"); img.alt = "";
        img.addEventListener("click", () => openPublicProfile(f.pseudo));
        const nm = commNameSpan("prof-friend-name", f.pseudo, f.badge);
        nm.addEventListener("click", () => openPublicProfile(f.pseudo));
        const best = commSpan("prof-friend-best", f.best > 0 ? fmtPts(f.best) + " pts" : "—");
        const del = document.createElement("button"); del.className = "prof-friend-del"; del.textContent = "✕"; del.title = "Retirer";
        del.addEventListener("click", () => { fetch("/api/friends/" + encodeURIComponent(f.pseudo), { method: "DELETE", credentials: "same-origin" }).then(() => renderFriends()); });
        row.appendChild(img); row.appendChild(nm); row.appendChild(best); row.appendChild(del);
        box.appendChild(row);
      });
    })
    .catch(() => { box.innerHTML = '<p class="comm-empty">Amis indisponibles.</p>'; });
}
// Recherche de joueurs à ajouter en ami (barre dans la page profil)
let _friendSearchT = null;
function searchFriends(q) {
  const box = $("friend-results"); if (!box) return;
  clearTimeout(_friendSearchT);
  q = (q || "").trim();
  if (q.length < 2) { box.innerHTML = ""; return; }
  _friendSearchT = setTimeout(() => {
    fetch("/api/players/search?q=" + encodeURIComponent(q), { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const players = (d && d.players) || [];
        box.innerHTML = "";
        if (!players.length) { box.innerHTML = '<p class="comm-empty">Aucun joueur à ce pseudo.</p>'; return; }
        players.forEach((p) => {
          const row = document.createElement("div"); row.className = "friend-result-row";
          const img = document.createElement("img"); img.className = "prof-friend-av"; img.src = avatarURLFor(p.av || 0, "avataaars"); img.alt = "";
          img.addEventListener("click", () => openPublicProfile(p.pseudo));
          const nm = commNameSpan("prof-friend-name", p.pseudo, p.badge);
          nm.addEventListener("click", () => openPublicProfile(p.pseudo));
          const btn = document.createElement("button"); btn.type = "button"; btn.className = "friend-add-btn";
          // états : déjà ami / demande envoyée (en attente) / l'autre m'a demandé / rien
          if (p.isFriend) { btn.textContent = "✓ Ami"; btn.disabled = true; }
          else if (p.requested) { btn.textContent = "⏳ Envoyée"; btn.disabled = true; }
          else {
            btn.textContent = p.incoming ? "✓ Accepter" : "+ Ajouter";
            btn.addEventListener("click", () => {
              btn.disabled = true;
              fetch("/api/friends/" + encodeURIComponent(p.pseudo), { method: "POST", credentials: "same-origin" })
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => { btn.textContent = (d && d.status === "friends") ? "✓ Ami" : "⏳ Envoyée"; renderFriends(); pollFriendGames(); });
            });
          }
          row.appendChild(img); row.appendChild(nm); row.appendChild(btn); box.appendChild(row);
        });
      })
      .catch(() => { box.innerHTML = '<p class="comm-empty">Recherche indisponible.</p>'; });
  }, 280);
}

// ===== Cloche : parties multi OUVERTES des amis =====
function announceOpenGame() {
  if (!isLogged() || !G.online || !G.online.code || !G.online.isHost || !G.online.open) return;
  fetch("/api/games/open", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: G.online.code, label: zoneLabel(), rounds: G.rounds }) }).catch(() => {});
}
function closeOpenGame() {
  if (!isLogged() || !G.online || !G.online.code) return;
  fetch("/api/games/close", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: G.online.code }) }).catch(() => {});
}
let _notifReqs = [], _notifGames = [];
// Notifs « lues » (masquées) — persistées localement, car le poll régénère sinon la liste.
// id d'une demande = "req:"+pseudo ; id d'une partie = "game:"+code.
function notifReadSet() { try { return new Set(readJSON("geoq-notif-read", [])); } catch (e) { return new Set(); } }
function saveNotifRead(set) { try { localStorage.setItem("geoq-notif-read", JSON.stringify([...set].slice(-200))); } catch (e) {} }
function markNotifRead(id) { const s = notifReadSet(); s.add(id); saveNotifRead(s); renderNotifBell(_notifReqs, _notifGames); }
// Marque toutes les notifs actuellement affichées comme lues (bouton à droite du titre).
function markAllNotifRead() {
  const s = notifReadSet();
  _notifReqs.forEach((r) => s.add("req:" + r.pseudo));
  _notifGames.forEach((g) => s.add("game:" + g.code));
  saveNotifRead(s); renderNotifBell(_notifReqs, _notifGames);
}
// Petit lien avatar+pseudo cliquable vers le profil public (referme le panneau).
function notifProfileLink(el, pseudo) {
  el.style.cursor = "pointer";
  el.addEventListener("click", () => { const p = $("notif-panel"); if (p) p.hidden = true; openPublicProfile(pseudo); });
}
function renderNotifBell(reqs, games) {
  _notifReqs = reqs || []; _notifGames = games || [];
  const read = notifReadSet();
  const vReqs = _notifReqs.filter((r) => !read.has("req:" + r.pseudo));   // non lues seulement
  const vGames = _notifGames.filter((g) => !read.has("game:" + g.code));
  const badge = $("notif-badge"), list = $("notif-list"), readAll = $("notif-readall");
  const total = vReqs.length + vGames.length;
  if (badge) { if (total) { badge.textContent = total > 9 ? "9+" : total; badge.hidden = false; } else badge.hidden = true; }
  if (readAll) readAll.hidden = total === 0;   // « tout lu » seulement s'il reste des notifs
  if (!list) return;
  list.innerHTML = "";
  if (!total) { list.innerHTML = '<p class="comm-empty">Rien de neuf. Les demandes d\'ami et les parties ouvertes de tes amis apparaîtront ici.</p>'; return; }
  // --- Demandes d'ami reçues (accepter / refuser) ---
  if (vReqs.length) {
    const h = document.createElement("div"); h.className = "notif-sec"; h.textContent = "Demandes d'ami"; list.appendChild(h);
    vReqs.forEach((r) => {
      const row = document.createElement("div"); row.className = "notif-item";
      const img = document.createElement("img"); img.className = "notif-item-av"; img.src = avatarURLFor(r.av || 0, "avataaars"); img.alt = ""; notifProfileLink(img, r.pseudo);
      const txt = document.createElement("div"); txt.className = "notif-item-txt";
      const nm = commSpan("notif-item-host", r.pseudo); notifProfileLink(nm, r.pseudo); txt.appendChild(nm);
      txt.appendChild(commSpan("notif-item-sub", "veut t'ajouter en ami"));
      const acts = document.createElement("div"); acts.className = "notif-acts";
      const yes = document.createElement("button"); yes.type = "button"; yes.className = "notif-yes"; yes.textContent = "✓"; yes.title = "Accepter";
      const no = document.createElement("button"); no.type = "button"; no.className = "notif-no"; no.textContent = "✕"; no.title = "Refuser";
      yes.addEventListener("click", () => respondFriendReq(r.pseudo, "accept"));
      no.addEventListener("click", () => respondFriendReq(r.pseudo, "decline"));
      acts.appendChild(yes); acts.appendChild(no);
      row.appendChild(img); row.appendChild(txt); row.appendChild(acts); list.appendChild(row);
    });
  }
  // --- Parties multi ouvertes des amis (rejoindre + masquer) ---
  if (vGames.length) {
    const h = document.createElement("div"); h.className = "notif-sec"; h.textContent = "Parties de tes amis"; list.appendChild(h);
    vGames.forEach((g) => {
      const row = document.createElement("div"); row.className = "notif-item";
      const img = document.createElement("img"); img.className = "notif-item-av"; img.src = avatarURLFor(g.av || 0, "avataaars"); img.alt = ""; notifProfileLink(img, g.host);
      const txt = document.createElement("div"); txt.className = "notif-item-txt";
      const nm = commSpan("notif-item-host", g.host); notifProfileLink(nm, g.host); txt.appendChild(nm);
      txt.appendChild(commSpan("notif-item-sub", (g.label || "Partie") + " · " + (g.rounds || 5) + " manches"));
      const acts = document.createElement("div"); acts.className = "notif-acts";
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "notif-join"; btn.textContent = "Rejoindre";
      // on peut être sur n'importe quel écran hub → basculer sur « online » AVANT de rejoindre
      // (sinon joinRoom manipule #online-wait/#online-choice qui sont masqués → « ça ne marche pas »).
      btn.addEventListener("click", () => { $("notif-panel").hidden = true; requestName(() => { showScreen("online"); joinRoom(g.code); }); });
      const x = document.createElement("button"); x.type = "button"; x.className = "notif-dismiss"; x.textContent = "✕"; x.title = "Masquer cette notification";
      x.addEventListener("click", () => markNotifRead("game:" + g.code));
      acts.appendChild(btn); acts.appendChild(x);
      row.appendChild(img); row.appendChild(txt); row.appendChild(acts); list.appendChild(row);
    });
  }
}
// Répond à une demande d'ami (accept|decline) puis rafraîchit cloche + liste d'amis.
function respondFriendReq(pseudo, action) {
  fetch("/api/friends/" + encodeURIComponent(pseudo) + "/" + action, { method: "POST", credentials: "same-origin" })
    .then(() => { pollFriendGames(); if (activeScreenId() === "profile") renderFriends(); })
    .catch(() => {});
}
// Rafraîchit la cloche : demandes d'ami reçues + parties ouvertes des amis (en parallèle).
function pollFriendGames() {
  if (!isLogged()) { renderNotifBell([], []); return; }
  Promise.all([
    fetch("/api/friends/requests", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/api/friends/games", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]).then(([rq, gm]) => renderNotifBell((rq && rq.requests) || [], (gm && gm.games) || []));
}
function renderProfileCollections() {
  const wrap = $("profile-collections");
  if (!wrap) return;
  const owned = ownedItems();
  const equipped = equippedItems();
  const ids = Object.keys(SHOP_ITEMS);
  const total = ids.length;
  const unlocked = ids.filter((id) => owned[id]).length;
  const stat = $("profile-unlocked");
  if (stat) stat.textContent = unlocked + " / " + total + " débloqués";
  const coins = $("profile-coins");
  if (coins) coins.innerHTML = '<span aria-hidden="true">🪙</span> ' + getCoins().toLocaleString("fr-FR");

  wrap.innerHTML = "";
  PROFILE_CATS.forEach(([slot, title]) => {
    const items = ids.filter((id) => SHOP_ITEMS[id].slot === slot && owned[id]);
    const sec = document.createElement("section");
    sec.className = "profile-cat";
    const h = document.createElement("h3");
    h.className = "profile-cat-title";
    h.textContent = title;
    sec.appendChild(h);

    const grid = document.createElement("div");
    grid.className = "profile-grid";
    items.forEach((id) => {
      const item = SHOP_ITEMS[id];
      const isEq = equipped[slot] === id;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "profile-item" + (isEq ? " equipped" : "");
      cell.dataset.item = id;
      cell.disabled = isEq;
      cell.title = isEq ? item.label + " — équipé" : "Équiper " + item.label;
      cell.innerHTML =
        '<span class="profile-art shop-art"></span>' +
        '<span class="profile-item-label">' + item.label + "</span>" +
        '<span class="profile-item-state">' + (isEq ? "Équipé ✓" : "Équiper") + "</span>";
      cell.querySelector(".profile-art").appendChild(itemStage(id, false));   // même vignette fidèle que la boutique
      grid.appendChild(cell);
    });
    sec.appendChild(grid);

    // Catégorie réduite au seul item par défaut → invite vers la Boutique.
    if (items.length <= 1) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "profile-more";
      more.textContent = "Débloque-en plus dans la Boutique →";
      more.addEventListener("click", () => {
        closeProfile();
        if (typeof goTab === "function") goTab("shop");
      });
      sec.appendChild(more);
    }
    wrap.appendChild(sec);
  });
}
function setAuthBusy(busy) {
  const ok = $("auth-submit");
  if (ok) ok.disabled = !!busy;
}
function submitAuth(mode) {
  const m = $("auth-modal");
  if (!m) return;
  mode = mode || m.dataset.mode || "login";
  const pseudo = ($("auth-pseudo") ? $("auth-pseudo").value : "").trim();
  const password = $("auth-password") ? $("auth-password").value : "";
  const err = $("auth-err");
  const setErr = (t) => { if (err) err.textContent = t || ""; };
  if (!pseudo || !password) { setErr("Pseudo et mot de passe requis."); return; }
  setErr("");
  setAuthBusy(true);
  const url = mode === "register" ? "/api/register" : "/api/login";
  const body = {
    pseudo: pseudo,
    password: password,
    remember: $("auth-remember") ? $("auth-remember").checked : true,
    guest: { coins: getCoins(), owned: ownedItems(), equipped: equippedItems(), progress: passState() },
  };
  fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => r.json().catch(() => ({})).then((d) => ({ status: r.status, data: d })))
    .then(({ status, data }) => {
      if (status === 200 && data && data.user) {
        AUTH.user = data.user;
        hydrateFromServer(data.user);
        renderAuthUI();
        closeAuthModal();
        return;
      }
      if (status === 409) setErr("Pseudo déjà pris.");
      else if (status === 401) setErr("Identifiants invalides.");
      else if (status === 429) setErr("Trop de tentatives, réessaie plus tard.");
      else if (status === 503) setErr("Comptes indisponibles pour le moment.");
      else if (status === 400) setErr("Pseudo ou mot de passe invalide.");
      else setErr("Une erreur est survenue. Réessaie.");
    })
    .catch(() => setErr("Connexion impossible. Vérifie ta connexion."))
    .finally(() => setAuthBusy(false));
}
function logout() {
  fetch("/api/logout", { method: "POST", credentials: "same-origin" })
    .catch(() => {})
    .finally(() => {
      AUTH.user = null;
      try { localStorage.removeItem("geoq-auth"); } catch (e) {}
      const inp = $("player-name");
      if (inp) inp.readOnly = false;
      renderAuthUI();
      const np = $("notif-panel"); if (np) np.hidden = true;
      refreshNotifBell();   // plus connecté → la cloche disparaît
    });
}
function wireAuth() {
  const btn = $("account-btn");
  if (btn) btn.addEventListener("click", openAuthModal);
  const m = $("auth-modal");
  if (!m) return;
  const close = $("auth-close");
  if (close) close.addEventListener("click", closeAuthModal);
  m.addEventListener("click", (e) => { if (e.target === m) closeAuthModal(); });
  const tabLogin = $("auth-tab-login");
  if (tabLogin) tabLogin.addEventListener("click", () => setAuthMode("login"));
  const tabReg = $("auth-tab-register");
  if (tabReg) tabReg.addEventListener("click", () => setAuthMode("register"));
  const ok = $("auth-submit");
  if (ok) ok.addEventListener("click", () => submitAuth());
  const pw = $("auth-password");
  if (pw) pw.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
  const ps = $("auth-pseudo");
  if (ps) ps.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
  wireProfile();
}
function wireProfile() {
  const out = $("prof-logout");
  if (out) out.addEventListener("click", () => { logout(); goTab("menu"); });
  const fs = $("friend-search");
  if (fs) fs.addEventListener("input", () => searchFriends(fs.value));
  const coll = $("profile-collections");
  if (coll) coll.addEventListener("click", (e) => {
    const cell = e.target.closest(".profile-item"); if (!cell) return;
    buyOrEquip(cell.dataset.item); // item possédé → équipe + applyCosmetics live
    renderProfileCollections();    // rafraîchit l'état « équipé »
  });
  const pass = $("profile-pass-open"); if (pass) pass.addEventListener("click", openBattlePass);
  const passModal = $("battle-pass-modal");
  if (passModal) {
    const close = $("battle-pass-close"); if (close) close.addEventListener("click", closeBattlePass);
    passModal.addEventListener("click", (e) => { if (e.target === passModal) closeBattlePass(); });
    const list = $("battle-pass-list"); if (list) list.addEventListener("click", (e) => { const b = e.target.closest("[data-pass-level]"); if (b && !b.disabled) claimPassReward(parseInt(b.dataset.passLevel, 10)); });
  }
}

function wire() {
  fillZoneOptions();
  try {
    const savedName = localStorage.getItem("geoq-name");
    if (savedName) { G.playerName = cleanName(savedName); $("player-name").value = G.playerName; }
    G.avatarChoice = parseInt(localStorage.getItem("geoq-av"), 10) || 0;
    if (G.avatarChoice < 0 || G.avatarChoice >= AVATARS.length) G.avatarChoice = 0;
    const sv = parseFloat(localStorage.getItem("geoq-vol"));
    G.sfxVol = isNaN(sv) ? 0.7 : Math.max(0, Math.min(1, sv));
    G.kbLayout = localStorage.getItem("geoq-kb") === "qwerty" ? "qwerty" : "azerty";
    G.moveMode = localStorage.getItem("geoq-mode") || "free";
  } catch (e) {}
  $("player-name").addEventListener("change", savePlayerName);
  $("player-name").addEventListener("blur", savePlayerName);

  // Comptes (optionnel) : on branche l'UI puis on demande la session courante.
  // Si pas de DB / pas connecté, /api/me renvoie {user:null} -> reste en invité.
  wireAuth();
  // affichage optimiste : si on était connecté (flag local), montre le pseudo tout de suite
  // → plus de flash « Se connecter » au reload pendant la requête /api/me.
  try { const la = localStorage.getItem("geoq-auth"); if (la && $("account-name")) { $("account-name").textContent = la; $("account-btn").classList.add("logged"); } } catch (e) {}
  fetch("/api/me", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((d) => {
      if (d && d.user) { AUTH.user = d.user; hydrateFromServer(d.user); }
      else { try { localStorage.removeItem("geoq-auth"); } catch (e) {} }
      renderAuthUI();
      // chargement direct sur /profil : l'auth n'était pas prête au routage initial → on y va maintenant
      if (location.pathname === "/profil") { if (isLogged()) goTab("profile", { replace: true }); else goTab("menu", { replace: true }); }
    })
    .catch(() => { renderAuthUI(); });

  buildAvatarGrid();
  setAvatar("avatar-current", G.avatarChoice);
  renderShop();
  renderCommunity();
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
  loadCommunityZones();   // précharge les zones communautaires (sélecteur prêt dès la 1re ouverture)
  loadCityPacks();        // précharge les top 50 villes par pays
  ["zone-trigger", "online-zone-trigger", "room-zone-trigger"].forEach((id) => {
    const t = $(id);
    if (t) t.addEventListener("click", () => {
      if ($("zone-search")) { $("zone-search").value = ""; filterZones(""); }
      $("zone-modal").hidden = false;
      // ne reconstruit le (gros) sélecteur que si les données ont changé (packs/communauté)
      Promise.all([loadZones(), loadCommunityZones(), loadCityPacks()]).then(() => {
        const stamp = Object.keys(CITY_PACKS).length + ":" + (COMMUNITY_ZONES || []).length;
        if (stamp !== buildZoneModal._stamp) { buildZoneModal(true); buildZoneModal._stamp = stamp; }
        initZoneMaps();
      });
    });
  });
  // formulaire « Crée ta zone » de la page Communauté
  if ($("czone-form")) $("czone-form").addEventListener("submit", submitCommunityZone);
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

  const shop = $("shop");
  if (shop) shop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-shop-item]");
    if (b) { buyOrEquip(b.dataset.shopItem); return; }   // bouton Acheter/Équiper : action directe
    const card = e.target.closest("[data-shop-card]");
    if (card) openShopPreview(card.dataset.shopCard);     // clic ailleurs sur la carte → prévisualisation
  });
  const pvM = $("shop-preview");
  if (pvM) {
    $("pv-close").addEventListener("click", () => { pvM.hidden = true; });
    pvM.addEventListener("click", (e) => { if (e.target === pvM) pvM.hidden = true; });
    $("pv-action").addEventListener("click", pvAction);
  }
  const weekly = $("btn-weekly-challenge");
  if (weekly) weekly.addEventListener("click", () => requestName(startWeeklyChallenge));
  const publicRoom = $("btn-public-room");
  if (publicRoom) publicRoom.addEventListener("click", openPublicRoom);
  const profile = $("btn-community-profile");
  if (profile) profile.addEventListener("click", () => goTab("leaderboard"));
  const vote = $("btn-community-vote");
  if (vote) vote.addEventListener("click", toggleCommunityVote);

  document.querySelectorAll(".tab-link").forEach((b) =>
    b.addEventListener("click", () => goTab(b.dataset.tab)));

  // Menu burger mobile : ouverture/fermeture du tiroir latéral. Les onglets du tiroir
  // relaient vers goTab() ; le bouton compte relaie un clic sur le profil réel (masqué
  // en mobile) pour réutiliser sa logique de connexion.
  (function () {
    const burger = $("nav-burger"), drawer = $("nav-drawer"), scrim = $("nav-scrim");
    if (!burger || !drawer || !scrim) return;
    const closeBtn = $("nav-drawer-close"), drawerAcc = $("drawer-account"), accBtn = $("account-btn");
    const openDrawer = () => {
      const an = $("account-name");
      if (drawerAcc && an) drawerAcc.textContent = an.textContent || "Se connecter";
      const cur = document.querySelector(".site-tabs .tab-link.on");
      const curTab = cur ? cur.dataset.tab : "menu";
      drawer.querySelectorAll(".drawer-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === curTab));
      drawer.hidden = false; scrim.hidden = false;
      void drawer.offsetWidth;   // reflow : peint l'état initial puis déclenche l'animation d'ouverture
      document.body.classList.add("drawer-open");
      burger.setAttribute("aria-expanded", "true");
    };
    const closeDrawer = () => {
      document.body.classList.remove("drawer-open");
      burger.setAttribute("aria-expanded", "false");
      setTimeout(() => { drawer.hidden = true; scrim.hidden = true; }, 260);
    };
    // le burger est fixe au-dessus du tiroir (z-index supérieur) : il sert donc de
    // bascule (ouvre / ferme) et se transforme en croix — évite que le burger intercepte
    // le clic destiné à une croix interne placée au même endroit.
    burger.addEventListener("click", () => {
      if (document.body.classList.contains("drawer-open")) closeDrawer(); else openDrawer();
    });
    if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
    scrim.addEventListener("click", closeDrawer);
    drawer.querySelectorAll(".drawer-tab").forEach((b) =>
      b.addEventListener("click", () => { closeDrawer(); goTab(b.dataset.tab); }));
    if (drawerAcc && accBtn) drawerAcc.addEventListener("click", () => { closeDrawer(); accBtn.click(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("drawer-open")) closeDrawer();
    });
  })();

  // sélecteur de mode SOLO (Libre / Pro / Hardcore / Bateau) — déplacement & zoom dans le Street View
  const modeSeg = $("mode-seg");
  if (modeSeg) {
    const syncMode = () => {
      const m = G.moveMode || "free";
      setModeSeg("mode-seg", m);
      if ($("mode-hint")) $("mode-hint").textContent = MOVE_HINTS[m] || MOVE_HINTS.free;
    };
    modeSeg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      G.moveMode = b.dataset.m; try { localStorage.setItem("geoq-mode", G.moveMode); } catch (e) {} syncMode();
    }));
    syncMode();
  }
  // sélecteurs de mode MULTI (matchmaking + salon) — réglage propre au multi, n'écrase pas le solo
  ["online-mode-seg", "room-mode-seg"].forEach((id) => {
    const seg = $(id); if (!seg) return;
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-m]"); if (!b) return;
      setModeSeg(id, b.dataset.m);
      G.moveMode = b.dataset.m;
      if ($("mode-hint-" + id)) $("mode-hint-" + id).textContent = MOVE_HINTS[b.dataset.m] || MOVE_HINTS.free;
      if (id === "room-mode-seg") sendRoomSettings();   // hôte : propage le mode aux invités
    });
  });

  $("btn-solo").addEventListener("click", startSolo);
  if ($("btn-leaderboard")) $("btn-leaderboard").addEventListener("click", () => goTab("leaderboard"));
  if ($("btn-refresh-leaderboard")) $("btn-refresh-leaderboard").addEventListener("click", loadLeaderboardPage);
  $("lb-modal-close").addEventListener("click", () => { $("lb-modal").hidden = true; });
  $("lb-modal").addEventListener("click", (e) => { if (e.target === $("lb-modal")) $("lb-modal").hidden = true; });
  $("btn-online").addEventListener("click", () => goTab("online"));
  $("btn-create").addEventListener("click", () => requestName(createRoom));
  $("btn-join").addEventListener("click", () => requestName(() => joinRoom()));
  $("name-modal-ok").addEventListener("click", confirmName);
  $("name-modal-input").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmName(); });
  $("btn-start-room").addEventListener("click", hostStartGame);
  // « Quitter la salle » (invité ET hôte) : ferme la connexion (onlineReset retire l'annonce
  // si on est l'hôte + libère le WS → le serveur retire le joueur) et revient au choix créer/rejoindre.
  $("btn-leave-room").addEventListener("click", () => { onlineReset(); backToOnlineChoice(); });
  // croix d'exclusion : délégation sur la liste des joueurs du salon
  $("room-players").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kick]"); if (!b) return;
    kickPlayer(b.dataset.kick);
  });
  $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  $("btn-copy").addEventListener("click", copyLink);

  document.querySelectorAll("[data-back]").forEach((b) =>
    b.addEventListener("click", () => goTab(b.dataset.back)));

  $("btn-guess").addEventListener("click", submitGuess);
  $("btn-reset-view").addEventListener("click", resetView);
  const reflowGuessMap = () => {
    if (!G.gmap) return;
    setTimeout(() => { const c = G.gmap.getCenter(); google.maps.event.trigger(G.gmap, "resize"); if (c) G.gmap.setCenter(c); }, 280);
  };
  $("btn-expand").addEventListener("click", () => {
    $("guess-panel").classList.toggle("expanded");
    reflowGuessMap();
  });
  // la carte de guess s'agrandit au survol (CSS) → prévenir Google du resize
  ["mouseenter", "mouseleave"].forEach((ev) =>
    $("guess-panel").addEventListener(ev, reflowGuessMap));
  $("btn-quit").addEventListener("click", () => confirmQuit(goHome));
  const qm = $("quit-modal");
  if (qm) {
    $("quit-cancel").addEventListener("click", () => { qm.hidden = true; G._quitYes = null; });
    $("quit-confirm").addEventListener("click", () => { qm.hidden = true; const cb = G._quitYes; G._quitYes = null; if (cb) cb(); });
    qm.addEventListener("click", (e) => { if (e.target === qm) { qm.hidden = true; G._quitYes = null; } });
  }

  // Profils publics : cliquer un pseudo (classement, communauté, lobby, amis) ouvre sa fiche
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".lb-name, .who, .comm-rank-name, .comm-recent-name, .lobby-name, .prof-friend-name");
    if (!el) return;
    // data-pseudo (vrai pseudo, sans badge) prioritaire — le textContent peut contenir un emoji de badge
    const pseudo = (el.dataset.pseudo || el.textContent || "").replace(/\s*\(toi\)\s*$/i, "").trim();
    if (!pseudo || pseudo === "Toi" || pseudo === "Anonyme") return;
    openPublicProfile(pseudo);
  });
  const pubM = $("pubprofile-modal");
  if (pubM) {
    $("pub-close").addEventListener("click", () => { pubM.hidden = true; });
    pubM.addEventListener("click", (e) => { if (e.target === pubM) pubM.hidden = true; });
    $("pub-friend").addEventListener("click", () => {
      if (!_pubPseudo) return;
      const action = $("pub-friend").dataset.action || "add";
      // add → envoie une demande ; accept → accepte ; remove/cancel → supprime (les deux sens)
      let url = "/api/friends/" + encodeURIComponent(_pubPseudo), method = "POST";
      if (action === "accept") url += "/accept";
      else if (action === "remove" || action === "cancel") method = "DELETE";
      $("pub-friend").disabled = true;
      fetch(url, { method, credentials: "same-origin" })
        .then(() => { openPublicProfile(_pubPseudo); pollFriendGames(); if (activeScreenId() === "profile") renderFriends(); });
    });
    const pfd = $("pub-friend-decline");
    if (pfd) pfd.addEventListener("click", () => {
      if (!_pubPseudo) return;
      pfd.disabled = true;
      fetch("/api/friends/" + encodeURIComponent(_pubPseudo) + "/decline", { method: "POST", credentials: "same-origin" })
        .then(() => { pfd.disabled = false; openPublicProfile(_pubPseudo); pollFriendGames(); });
    });
  }

  // cloche de notifications (parties ouvertes des amis)
  const bell = $("notif-bell"), npanel = $("notif-panel");
  if (bell && npanel) {
    bell.addEventListener("click", (e) => { e.stopPropagation(); npanel.hidden = !npanel.hidden; if (!npanel.hidden) pollFriendGames(); });
    document.addEventListener("click", (e) => { if (!npanel.hidden && $("notif-wrap") && !$("notif-wrap").contains(e.target)) npanel.hidden = true; });
    const readAllBtn = $("notif-readall");
    if (readAllBtn) readAllBtn.addEventListener("click", (e) => { e.stopPropagation(); markAllNotifRead(); });
  }
  // toggle « partie ouverte / fermée » du salon (hôte) → annonce ou retire des notifs amis
  const openSeg = $("room-open-seg");
  if (openSeg) openSeg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    openSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    G.online.open = b.dataset.open === "1";
    if (G.online.active && G.online.isHost && G.online.code) { if (G.online.open) announceOpenGame(); else closeOpenGame(); }
  }));
  setInterval(pollFriendGames, 15000);   // rafraîchit demandes d'ami + parties d'amis
  // poll immédiat quand l'utilisateur revient sur l'onglet/l'app (notif quasi-instantanée,
  // utile en test multi-appareils : on regarde son téléphone → la partie apparaît tout de suite)
  document.addEventListener("visibilitychange", () => { if (!document.hidden && isLogged()) pollFriendGames(); });
  window.addEventListener("focus", () => { if (isLogged()) pollFriendGames(); });
  // heartbeat : ré-annonce le salon ouvert toutes les 45 s tant qu'on l'héberge. La liste
  // serveur est en mémoire (Map openGames) → cela la repeuple après un redémarrage du conteneur.
  setInterval(() => {
    if (isLogged() && G.online && G.online.active && G.online.isHost && G.online.open && G.online.code) announceOpenGame();
  }, 45000);

  $("btn-next").addEventListener("click", nextRound);
  $("btn-replay").addEventListener("click", replay);
  if ($("btn-share")) $("btn-share").addEventListener("click", shareResult);
  $("btn-home").addEventListener("click", goHome);

  // Raccourcis clavier : Échap ferme une modale ; Entrée = deviner / manche suivante.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modals = ["quit-modal", "name-modal", "auth-modal", "pubprofile-modal", "battle-pass-modal", "avatar-modal", "zone-modal", "lb-modal"];
      for (const id of modals) { const m = $(id); if (m && !m.hidden) { m.hidden = true; e.preventDefault(); return; } }
      return;
    }
    if (e.key !== "Enter") return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;   // laisser les champs gérer Entrée
    if ($("game") && $("game").classList.contains("show") && !$("btn-guess").disabled) { e.preventDefault(); submitGuess(); return; }
    const res = $("result");
    if (res && res.classList.contains("show")) {
      const bn = $("btn-next");
      if (bn && !bn.classList.contains("hidden")) { e.preventDefault(); nextRound(); }
    }
  });

  // Réglages en jeu : engrenage → popover (disposition clavier + volume des effets)
  (function () {
    const btn = $("game-settings-btn"), panel = $("game-settings-panel"), box = $("game-settings");
    if (!btn || !panel || !box) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      btn.setAttribute("aria-expanded", String(!panel.hidden));
    });
    document.addEventListener("click", (e) => {
      if (!panel.hidden && !box.contains(e.target)) { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); }
    });
    const seg = $("gs-kb");
    const syncKb = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.kb === kbLayout()));
    seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      G.kbLayout = b.dataset.kb; try { localStorage.setItem("geoq-kb", G.kbLayout); } catch (e) {} syncKb();
    }));
    syncKb();
    const vol = $("gs-vol"), val = $("gs-vol-val");
    vol.value = Math.round(sfxVol() * 100); val.textContent = vol.value + " %";
    vol.addEventListener("input", () => {
      G.sfxVol = (parseInt(vol.value, 10) || 0) / 100; val.textContent = vol.value + " %";
      try { localStorage.setItem("geoq-vol", String(G.sfxVol)); } catch (e) {}
    });
    vol.addEventListener("change", () => beep(720, 0.12));   // petit aperçu sonore au relâchement
  })();

  // Déplacement clavier dans le Street View (ZQSD azerty / WASD qwerty + flèches), en jeu seulement
  // ⚠️ CAPTURE (3e arg true) : Street View a son PROPRE clavier natif (flèches = déplacement)
  // attaché sur le conteneur du pano. En bubble, notre handler passait APRÈS lui → le pano
  // bougeait quand même en mode pro. En capture + stopImmediatePropagation, on intercepte la
  // touche AVANT Google → tout le déplacement passe par svMove/svTurn (qui respectent le mode).
  document.addEventListener("keydown", (e) => {
    if (!$("game") || !$("game").classList.contains("show")) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const k = (e.key || "").toLowerCase(), az = kbLayout() === "azerty";
    const fwd = (k === "arrowup" || k === (az ? "z" : "w"));
    const back = (k === "arrowdown" || k === "s");
    const left = (k === "arrowleft" || k === (az ? "q" : "a"));
    const right = (k === "arrowright" || k === "d");
    const zoomKey = (k === "+" || k === "-" || k === "=" || k === "_");
    if (fwd || back || left || right) {
      e.preventDefault(); e.stopImmediatePropagation();   // neutralise le clavier natif du pano
      if (fwd) svMove(true);
      else if (back) svMove(false);
      else if (left) svTurn(-22);
      else if (right) svTurn(22);
    } else if (zoomKey && G.moveMode === "hardcore") {
      e.preventDefault(); e.stopImmediatePropagation();   // hardcore : pas de zoom clavier (+/-)
    }
  }, true);
  // Hardcore : bloque le zoom de la VUE à la molette / au pinch trackpad (le pano génère un
  // wheel ; en capture+non-passif on l'annule avant Street View). NB : le zoom NAVIGATEUR
  // (Cmd/Ctrl +/-) reste hors de notre portée — c'est un raccourci du navigateur.
  document.addEventListener("wheel", (e) => {
    if (G.moveMode === "hardcore" && $("game") && $("game").classList.contains("show")) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, { capture: true, passive: false });

  // Débloque l'audio dès le 1er geste : sinon la politique « autoplay » des navigateurs
  // crée l'AudioContext suspendu et avale le 1er bip du chrono.
  const unlockAudio = () => {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {}
  };
  document.addEventListener("pointerdown", unlockAudio, { once: true });
  window.addEventListener("popstate", () => goTab(tabForPath(location.pathname), { fromPop: true }));

  // lien ?join=CODE → rejoint directement la salle (popup pseudo si besoin)
  const params = new URLSearchParams(location.search);
  const j = params.get("join");
  if (j) {
    pendingJoin = j.toUpperCase().slice(0, 4);
    $("join-code").value = pendingJoin;
    readMenuSettings();
    mirrorSettingsToOnline();
    backToOnlineChoice();
    showScreen("online");
    setRoute("online", true);
    $("online-status").textContent = "Connexion à la salle…";
    requestName(autoJoin);
  } else {
    goTab(tabForPath(location.pathname), { replace: true });
  }
}

function copyLink() {
  if (!G.online.code || $("btn-copy").disabled) return;
  const url = location.origin + "/multi?join=" + (G.online.code || "");
  navigator.clipboard.writeText(url).then(
    () => { $("btn-copy").textContent = "Lien copié ✓"; setTimeout(() => ($("btn-copy").textContent = "Copier le lien"), 1800); },
    () => { $("btn-copy").textContent = url; }
  );
}

function shareResult() {
  const btn = $("btn-share"); if (!btn) return;
  const total = (G.lastFinalTotal != null ? G.lastFinalTotal : sum(G.scores)) || 0;
  const txt = "🌍 J'ai marqué " + total.toLocaleString("fr-FR") + " pts sur Geoloc en " + G.rounds + " manches. Tu fais mieux ? " + location.origin;
  navigator.clipboard.writeText(txt).then(
    () => { btn.textContent = "Score copié ✓"; setTimeout(() => (btn.textContent = "Partager mon score"), 1800); },
    () => { btn.textContent = "Copie impossible"; }
  );
}

/* ---------- boot ---------- */
wire();
loadMaps();
initHomeGlobe();

// Geoloc — serveur Node : sert les fichiers statiques, relaie le multijoueur
// ET expose un classement persistant (PostgreSQL).
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 80;
const DIR = __dirname;

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.DATABASE_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admingeo";

// Page de la console admin — HTML inline. Le secret n'apparaît jamais ici :
// l'utilisateur le saisit à la connexion et il est envoyé en header X-Admin-Secret.
const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Geoloc — Admin</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2230;--bd:#2a3140;--tx:#e6edf3;--mut:#8b97a7;--acc:#4c8dff;--acc2:#2563eb;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--rad:12px}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--tx)}
  a{color:var(--acc)}
  button{font:inherit;cursor:pointer;border:1px solid var(--bd);background:var(--panel2);color:var(--tx);padding:8px 12px;border-radius:8px;transition:.12s}
  button:hover{border-color:var(--acc);background:#222b3d}
  button:disabled{opacity:.5;cursor:not-allowed}
  button.pri{background:var(--acc2);border-color:var(--acc2)}
  button.pri:hover{background:var(--acc)}
  button.danger{border-color:#5a2326;color:#ffb4ae;background:#2a1719}
  button.danger:hover{background:#3a1d20;border-color:var(--bad)}
  button.sm{padding:5px 9px;font-size:12px;border-radius:7px}
  input,select{font:inherit;background:#0b0f15;border:1px solid var(--bd);color:var(--tx);padding:8px 10px;border-radius:8px;outline:none;width:100%}
  input:focus,select:focus{border-color:var(--acc)}
  label{display:block;font-size:12px;color:var(--mut);margin:0 0 4px}
  .wrap{max-width:1080px;margin:0 auto;padding:22px 18px 60px}
  .topbar{display:flex;align-items:center;gap:12px;margin-bottom:22px}
  .logo{font-weight:700;font-size:18px;letter-spacing:.3px}
  .logo span{color:var(--acc)}
  .spacer{flex:1}
  .pill{font-size:12px;color:var(--mut);border:1px solid var(--bd);padding:4px 10px;border-radius:999px}
  .card{background:var(--panel);border:1px solid var(--bd);border-radius:var(--rad);padding:18px;margin-bottom:18px}
  .card h2{margin:0 0 14px;font-size:14px;font-weight:600;color:var(--tx);display:flex;align-items:center;gap:8px}
  .card h2 .ic{color:var(--mut)}
  .grid{display:grid;gap:12px}
  .g2{grid-template-columns:1fr 1fr}
  .g3{grid-template-columns:repeat(3,1fr)}
  .row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
  .row .col{flex:1;min-width:130px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .stat{background:linear-gradient(180deg,#1a2030,#161b22);border:1px solid var(--bd);border-radius:var(--rad);padding:16px}
  .stat .n{font-size:26px;font-weight:700;letter-spacing:.5px}
  .stat .l{font-size:12px;color:var(--mut);margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--bd);vertical-align:middle}
  th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  tr:hover td{background:#12161d}
  .muted{color:var(--mut)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .coins{color:var(--warn);font-weight:600}
  .acts{display:flex;gap:5px;flex-wrap:wrap}
  .tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
  .tabs button{border-radius:999px}
  .tabs button.on{background:var(--acc2);border-color:var(--acc2);color:#fff}
  .hide{display:none}
  .login-box{max-width:380px;margin:8vh auto 0}
  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#0b0f15;border:1px solid var(--bd);padding:11px 16px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);opacity:0;transition:.25s;pointer-events:none;max-width:90vw}
  .toast.show{opacity:1}
  .toast.ok{border-color:var(--ok)}
  .toast.err{border-color:var(--bad)}
  .empty{color:var(--mut);text-align:center;padding:24px}
  .badge{display:inline-block;font-size:11px;color:var(--mut);background:#0b0f15;border:1px solid var(--bd);border-radius:6px;padding:1px 6px;margin:1px}
  .hint{font-size:12px;color:var(--mut);margin-top:6px}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div class="logo">Geo<span>loc</span> · Admin</div>
    <div class="spacer"></div>
    <div id="who" class="pill hide"></div>
    <button id="logoutBtn" class="sm hide">Déconnexion</button>
  </div>

  <!-- Écran de connexion -->
  <div id="loginView">
    <div class="card login-box">
      <h2><span class="ic">🔒</span> Accès administrateur</h2>
      <form id="loginForm">
        <label for="secret">Mot de passe admin</label>
        <input id="secret" type="password" autocomplete="current-password" placeholder="••••••••" autofocus>
        <div class="hint">Le secret reste en mémoire de l'onglet uniquement. Il n'est jamais stocké.</div>
        <div style="margin-top:14px"><button class="pri" type="submit" style="width:100%">Se connecter</button></div>
      </form>
    </div>
  </div>

  <!-- Console -->
  <div id="appView" class="hide">
    <div class="stats" id="statsRow">
      <div class="stat"><div class="n" id="stUsers">–</div><div class="l">Comptes</div></div>
      <div class="stat"><div class="n coins" id="stCoins">–</div><div class="l">Pièces en circulation</div></div>
      <div class="stat"><div class="n" id="stScores">–</div><div class="l">Scores enregistrés</div></div>
    </div>

    <div class="tabs">
      <button data-tab="accounts" class="on">Comptes</button>
      <button data-tab="credit">Créditer / Gérer</button>
      <button data-tab="scores">Scores</button>
    </div>

    <!-- Onglet comptes -->
    <section id="tab-accounts" class="card">
      <h2><span class="ic">👥</span> Comptes joueurs</h2>
      <div class="row" style="margin-bottom:12px">
        <div class="col"><label>Recherche (pseudo)</label><input id="accSearch" placeholder="Rechercher…"></div>
        <button id="accRefresh">Rafraîchir</button>
      </div>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>Pseudo</th><th>Pièces</th><th>Items</th><th>Vu</th><th>Créé</th><th></th></tr></thead>
          <tbody id="accBody"><tr><td colspan="6" class="empty">…</td></tr></tbody>
        </table>
      </div>
      <div id="accMore" class="muted" style="margin-top:10px"></div>
    </section>

    <!-- Onglet credit/gestion -->
    <section id="tab-credit" class="card hide">
      <h2><span class="ic">🪙</span> Créditer / débiter</h2>
      <div class="row">
        <div class="col"><label>Pseudo</label><input id="crPseudo" placeholder="pseudo du joueur"></div>
        <div class="col"><label>Montant (négatif = débit)</label><input id="crAmount" type="number" placeholder="ex: 500 ou -200"></div>
        <button class="pri" id="crBtn">Appliquer</button>
      </div>
      <div class="hint">Le solde est borné entre 0 et 100 000 000.</div>

      <h2 style="margin-top:24px"><span class="ic">🔑</span> Réinitialiser le mot de passe</h2>
      <div class="row">
        <div class="col"><label>Pseudo</label><input id="pwPseudo" placeholder="pseudo du joueur"></div>
        <div class="col"><label>Nouveau mot de passe (6+)</label><input id="pwNew" type="text" placeholder="nouveau mot de passe"></div>
        <button id="pwBtn">Changer</button>
      </div>
      <div class="hint">Déconnecte toutes les sessions du joueur.</div>

      <h2 style="margin-top:24px"><span class="ic">⚠️</span> Actions destructrices</h2>
      <div class="grid g2">
        <div class="card" style="margin:0;background:var(--panel2)">
          <label>Réinitialiser un compte (pièces / items à zéro)</label>
          <div class="row" style="margin-top:6px"><div class="col"><input id="rsPseudo" placeholder="pseudo"></div><button class="danger" id="rsBtn">Réinitialiser</button></div>
        </div>
        <div class="card" style="margin:0;background:var(--panel2)">
          <label>Supprimer un compte définitivement</label>
          <div class="row" style="margin-top:6px"><div class="col"><input id="delPseudo" placeholder="pseudo"></div><button class="danger" id="delBtn">Supprimer</button></div>
        </div>
      </div>
    </section>

    <!-- Onglet scores -->
    <section id="tab-scores" class="card hide">
      <h2><span class="ic">🏆</span> Scores / classement</h2>
      <div class="row" style="margin-bottom:12px">
        <div class="col"><label>Filtrer par pseudo</label><input id="scSearch" placeholder="pseudo…"></div>
        <button id="scRefresh">Rafraîchir</button>
        <button class="danger" id="scPurge">Purger tout le classement</button>
      </div>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>#</th><th>Pseudo</th><th>Zone</th><th>Manches</th><th>Score</th><th>Date</th><th></th></tr></thead>
          <tbody id="scBody"><tr><td colspan="7" class="empty">…</td></tr></tbody>
        </table>
      </div>
    </section>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
(function(){
  "use strict";
  var SECRET = null;
  var $ = function(id){ return document.getElementById(id); };
  var esc = function(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); };
  var fmt = function(n){ return Number(n||0).toLocaleString("fr-FR"); };
  var dt = function(s){ if(!s) return ""; try{ return new Date(s).toLocaleString("fr-FR",{dateStyle:"short",timeStyle:"short"}); }catch(e){ return s; } };

  var toastT;
  function toast(msg, kind){
    var t = $("toast"); t.textContent = msg; t.className = "toast show " + (kind||"");
    clearTimeout(toastT); toastT = setTimeout(function(){ t.className = "toast " + (kind||""); }, 2600);
  }

  async function api(method, path, body){
    var opt = { method: method, headers: { "X-Admin-Secret": SECRET || "" } };
    if(body !== undefined){ opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    var r = await fetch("/admin-geo/api" + path, opt);
    var data = {};
    try{ data = await r.json(); }catch(e){}
    if(r.status === 403){ throw { status: 403, error: "admin-refuse" }; }
    if(!r.ok){ throw { status: r.status, error: (data && data.error) || ("erreur-" + r.status) }; }
    return data;
  }

  function showApp(){
    $("loginView").classList.add("hide");
    $("appView").classList.remove("hide");
    $("who").classList.remove("hide"); $("who").textContent = "session active";
    $("logoutBtn").classList.remove("hide");
    refreshStats(); loadAccounts();
  }
  function showLogin(){
    SECRET = null;
    $("appView").classList.add("hide");
    $("loginView").classList.remove("hide");
    $("who").classList.add("hide"); $("logoutBtn").classList.add("hide");
    $("secret").value = ""; $("secret").focus();
  }

  // ---- login ----
  $("loginForm").addEventListener("submit", async function(e){
    e.preventDefault();
    SECRET = $("secret").value;
    if(!SECRET){ toast("Mot de passe requis", "err"); return; }
    try{ await api("GET", "/stats"); showApp(); }
    catch(err){ SECRET = null; toast(err.status === 403 ? "Mot de passe incorrect" : ("Erreur: " + err.error), "err"); }
  });
  $("logoutBtn").addEventListener("click", showLogin);

  // ---- tabs ----
  Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function(b){
    b.addEventListener("click", function(){
      Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function(x){ x.classList.remove("on"); });
      b.classList.add("on");
      var t = b.getAttribute("data-tab");
      $("tab-accounts").classList.toggle("hide", t !== "accounts");
      $("tab-credit").classList.toggle("hide", t !== "credit");
      $("tab-scores").classList.toggle("hide", t !== "scores");
      if(t === "scores") loadScores();
    });
  });

  // ---- stats ----
  async function refreshStats(){
    try{ var d = await api("GET", "/stats");
      $("stUsers").textContent = fmt(d.users);
      $("stCoins").textContent = fmt(d.totalCoins);
      $("stScores").textContent = fmt(d.scores);
    }catch(err){ if(err.status===403) showLogin(); }
  }

  // ---- accounts ----
  function itemCount(owned){ if(!owned||typeof owned!=="object") return 0; var n=0; for(var k in owned){ if(owned[k]) n++; } return n; }
  function equippedBadges(eq){ if(!eq||typeof eq!=="object") return ""; var out=""; for(var k in eq){ if(eq[k]) out += '<span class="badge">'+esc(k)+": "+esc(eq[k])+'</span>'; } return out; }

  async function loadAccounts(){
    var q = $("accSearch").value.trim();
    $("accBody").innerHTML = '<tr><td colspan="6" class="empty">Chargement…</td></tr>';
    try{
      var d = await api("GET", "/accounts?limit=100&q=" + encodeURIComponent(q));
      if(!d.accounts.length){ $("accBody").innerHTML = '<tr><td colspan="6" class="empty">Aucun compte</td></tr>'; $("accMore").textContent=""; return; }
      var html = d.accounts.map(function(a){
        var p = esc(a.pseudo);
        var pj = JSON.stringify(a.pseudo);
        return '<tr>'
          + '<td class="mono">'+p+'</td>'
          + '<td class="coins">'+fmt(a.coins)+'</td>'
          + '<td>'+itemCount(a.owned)+' '+equippedBadges(a.equipped)+'</td>'
          + '<td class="muted">'+dt(a.last_seen)+'</td>'
          + '<td class="muted">'+dt(a.created_at)+'</td>'
          + '<td><div class="acts">'
            + '<button class="sm" onclick=\\'quickCredit('+pj+')\\'>+ Pièces</button>'
            + '<button class="sm danger" onclick=\\'doReset('+pj+')\\'>Reset</button>'
            + '<button class="sm danger" onclick=\\'doDelete('+pj+')\\'>Suppr.</button>'
          + '</div></td>'
        + '</tr>';
      }).join("");
      $("accBody").innerHTML = html;
      $("accMore").textContent = d.accounts.length + " / " + d.total + " compte(s)";
    }catch(err){ if(err.status===403){ showLogin(); return; } $("accBody").innerHTML = '<tr><td colspan="6" class="empty">Erreur: '+esc(err.error)+'</td></tr>'; }
  }
  var accT; $("accSearch").addEventListener("input", function(){ clearTimeout(accT); accT=setTimeout(loadAccounts, 250); });
  $("accRefresh").addEventListener("click", function(){ loadAccounts(); refreshStats(); });

  // quick actions (exposées en global pour les onclick)
  window.quickCredit = function(pseudo){
    var v = prompt("Montant à créditer pour " + pseudo + " (négatif pour débiter) :", "100");
    if(v === null) return; var n = parseInt(v, 10);
    if(!Number.isInteger(n)){ toast("Montant invalide", "err"); return; }
    credit(pseudo, n);
  };
  window.doReset = function(pseudo){ if(!confirm("Réinitialiser le compte « "+pseudo+" » (pièces et items à zéro) ?")) return; reset(pseudo); };
  window.doDelete = function(pseudo){ if(!confirm("SUPPRIMER définitivement le compte « "+pseudo+" » ? Cette action est irréversible.")) return; del(pseudo); };

  async function credit(pseudo, amount){
    try{ var d = await api("POST", "/credit", { pseudo: pseudo, amount: amount });
      toast(d.pseudo + " → " + fmt(d.coins) + " pièces", "ok"); loadAccounts(); refreshStats();
    }catch(err){ toast("Échec: " + err.error, "err"); }
  }
  async function reset(pseudo){
    try{ await api("POST", "/reset", { pseudo: pseudo }); toast("Compte réinitialisé", "ok"); loadAccounts(); refreshStats(); }
    catch(err){ toast("Échec: " + err.error, "err"); }
  }
  async function del(pseudo){
    try{ await api("DELETE", "/accounts/" + encodeURIComponent(pseudo)); toast("Compte supprimé", "ok"); loadAccounts(); refreshStats(); }
    catch(err){ toast("Échec: " + err.error, "err"); }
  }

  // ---- credit tab buttons ----
  $("crBtn").addEventListener("click", function(){
    var p = $("crPseudo").value.trim(); var n = parseInt($("crAmount").value, 10);
    if(!p){ toast("Pseudo requis", "err"); return; }
    if(!Number.isInteger(n)){ toast("Montant invalide", "err"); return; }
    credit(p, n);
  });
  $("pwBtn").addEventListener("click", async function(){
    var p = $("pwPseudo").value.trim(); var pw = $("pwNew").value;
    if(!p){ toast("Pseudo requis", "err"); return; }
    if(pw.length < 6){ toast("Mot de passe trop court (6 min.)", "err"); return; }
    try{ await api("POST", "/set-password", { pseudo: p, password: pw }); $("pwNew").value=""; toast("Mot de passe changé", "ok"); }
    catch(err){ toast("Échec: " + err.error, "err"); }
  });
  $("rsBtn").addEventListener("click", function(){ var p=$("rsPseudo").value.trim(); if(!p){toast("Pseudo requis","err");return;} window.doReset(p); });
  $("delBtn").addEventListener("click", function(){ var p=$("delPseudo").value.trim(); if(!p){toast("Pseudo requis","err");return;} window.doDelete(p); });

  // ---- scores ----
  async function loadScores(){
    var q = $("scSearch").value.trim();
    $("scBody").innerHTML = '<tr><td colspan="7" class="empty">Chargement…</td></tr>';
    try{
      var d = await api("GET", "/scores?limit=150&pseudo=" + encodeURIComponent(q));
      if(!d.scores.length){ $("scBody").innerHTML = '<tr><td colspan="7" class="empty">Aucun score</td></tr>'; return; }
      $("scBody").innerHTML = d.scores.map(function(s){
        var label = s.zone_label || s.zone || "";
        return '<tr>'
          + '<td class="muted mono">'+s.id+'</td>'
          + '<td class="mono">'+esc(s.pseudo)+'</td>'
          + '<td>'+esc(label)+'</td>'
          + '<td>'+esc(s.rounds)+'</td>'
          + '<td class="coins">'+fmt(s.score)+'</td>'
          + '<td class="muted">'+dt(s.created_at)+'</td>'
          + '<td><button class="sm danger" onclick="delScore('+s.id+')">Suppr.</button></td>'
        + '</tr>';
      }).join("");
    }catch(err){ if(err.status===403){ showLogin(); return; } $("scBody").innerHTML = '<tr><td colspan="7" class="empty">Erreur: '+esc(err.error)+'</td></tr>'; }
  }
  var scT; $("scSearch").addEventListener("input", function(){ clearTimeout(scT); scT=setTimeout(loadScores, 250); });
  $("scRefresh").addEventListener("click", function(){ loadScores(); refreshStats(); });
  window.delScore = async function(id){
    if(!confirm("Supprimer le score #" + id + " ?")) return;
    try{ await api("DELETE", "/scores/" + id); toast("Score supprimé", "ok"); loadScores(); refreshStats(); }
    catch(err){ toast("Échec: " + err.error, "err"); }
  };
  $("scPurge").addEventListener("click", async function(){
    if(!confirm("PURGER TOUT le classement ? Tous les scores seront supprimés. Action irréversible.")) return;
    var c = prompt('Pour confirmer, tape PURGE en majuscules :', "");
    if(c !== "PURGE"){ toast("Purge annulée", "err"); return; }
    try{ var d = await api("POST", "/scores/purge", { confirm: "PURGE" }); toast(fmt(d.deleted) + " score(s) supprimé(s)", "ok"); loadScores(); refreshStats(); }
    catch(err){ toast("Échec: " + err.error, "err"); }
  });

  showLogin();
})();
</script>
</body>
</html>`;

app.use(express.json({ limit: "8kb" }));
app.use(cookieParser());

app.use((req, res, next) => {
  // pas de cache sur le HTML (les visiteurs ont toujours la dernière version)
  if (req.path === "/" || req.path === "/multi" || req.path === "/classement" || req.path === "/boutique" || req.path === "/communaute" || req.path.endsWith(".html")) res.set("Cache-Control", "no-cache");
  res.set("Content-Security-Policy", "upgrade-insecure-requests");
  next();
});

// ---- base de données : classement persistant (données métier) ----
// La DB est optionnelle : sans DATABASE_URL (dev local), le jeu tourne et le
// classement est simplement désactivé — aucune fonctionnalité de jeu n'en dépend.
const db = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
      max: 5,
    })
  : null;

async function initDb() {
  if (!db) return console.log("[db] DATABASE_URL absente — classement désactivé");
  await db.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id          SERIAL      PRIMARY KEY,
      pseudo      TEXT        NOT NULL,
      zone        TEXT        NOT NULL,
      zone_label  TEXT        NOT NULL DEFAULT '',
      rounds      INTEGER     NOT NULL,
      score       INTEGER     NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_scores_zone_score ON scores (zone, score DESC);`);
  // ---- comptes joueurs + sessions (auth persistante) ----
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL       PRIMARY KEY,
      pseudo_key    TEXT         NOT NULL UNIQUE,
      pseudo        TEXT         NOT NULL,
      password_hash TEXT         NOT NULL,
      coins         INTEGER      NOT NULL DEFAULT 0,
      owned         JSONB        NOT NULL DEFAULT '{}'::jsonb,
      equipped      JSONB        NOT NULL DEFAULT '{}'::jsonb,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      last_seen     TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_users_pseudo_key ON users (pseudo_key);`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT        PRIMARY KEY,
      user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS community_zones (
      id          SERIAL      PRIMARY KEY,
      user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pseudo      TEXT        NOT NULL,
      name        TEXT        NOT NULL,
      geojson     JSONB       NOT NULL,
      center_lat  DOUBLE PRECISION NOT NULL,
      center_lng  DOUBLE PRECISION NOT NULL,
      bbox        JSONB       NOT NULL,
      radius_km   DOUBLE PRECISION NOT NULL DEFAULT 50,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_czones_created ON community_zones (created_at DESC);`);
  console.log("[db] tables 'scores', 'users', 'sessions', 'community_zones' prêtes");
}

function requireDb(res) {
  if (db) return true;
  res.status(503).json({ ok: false, error: "leaderboard-desactive" });
  return false;
}

// ====================================================================
// Comptes joueurs + sessions
// ====================================================================

// Clé de déduplication d'un pseudo (insensible à la casse / aux espaces).
function pseudoKey(s) { return String(s || "").trim().toLowerCase().normalize("NFKC").replace(/\s+/g, " "); }
// Pseudo affiché nettoyé (max 18 car.) ; "Joueur" est réservé → rejeté.
function cleanPseudo(s) { const v = String(s || "").trim().replace(/\s+/g, " ").slice(0, 18); return /^joueur$/i.test(v) ? "" : v; }
// Vue publique d'un compte (jamais le hash ni l'id interne).
function publicUser(u) { return { pseudo: u.pseudo, coins: u.coins, owned: u.owned, equipped: u.equipped }; }

function readToken(req) {
  if (req.cookies && req.cookies.gtok) return req.cookies.gtok;
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}
function setSessionCookie(res, token) {
  res.cookie("gtok", token, { httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/", maxAge: SESSION_TTL_MS });
}
function clearSessionCookie(res) {
  res.clearCookie("gtok", { httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/" });
}
async function newSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`, [token, userId, new Date(Date.now() + SESSION_TTL_MS)]);
  return token;
}

// Middleware : charge req.user depuis le cookie/Bearer si la session est valide.
async function loadUser(req, res, next) {
  req.user = null;
  if (!db) return next();
  const token = readToken(req);
  if (!token) return next();
  try {
    const { rows } = await db.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()`,
      [token]
    );
    if (rows[0]) {
      req.user = rows[0];
      req.token = token;
      db.query(`UPDATE users SET last_seen = now() WHERE id = $1`, [rows[0].id]).catch(() => {});
    }
  } catch (e) { console.error("[auth]", e.message); }
  next();
}
function requireAuth(req, res, next) {
  if (!requireDb(res)) return;
  if (!req.user) return res.status(401).json({ ok: false, error: "non-authentifie" });
  next();
}

// Rate-limiting en mémoire (best-effort, suffisant pour un petit service).
const rl = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const e = rl.get(key);
  if (!e || now > e.reset) { rl.set(key, { n: 1, reset: now + windowMs }); return true; }
  if (e.n >= max) return false;
  e.n++;
  return true;
}
function clientIp(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "?"; }

// Fusionne l'état d'un invité (avant connexion) dans son compte : on ne fait que
// croître (pièces max, items possédés en union) ; l'équipement invité prime s'il existe.
function mergeGuest(u, g) {
  let changed = false;
  let coins = u.coins;
  if (Number.isInteger(g && g.coins) && g.coins > u.coins) { coins = Math.min(g.coins, 100000000); changed = true; }
  const owned = Object.assign({}, u.owned);
  if (g && g.owned && typeof g.owned === "object") {
    for (const k of Object.keys(g.owned)) if (g.owned[k] && !owned[k]) { owned[k] = true; changed = true; }
  }
  let equipped = u.equipped;
  if (g && g.equipped && typeof g.equipped === "object" && Object.keys(g.equipped).length) { equipped = g.equipped; changed = true; }
  return { coins, owned, equipped, changed };
}

// Vérifie le secret admin (timing-safe) + rate-limit par IP.
function checkAdmin(req, res, next) {
  if (!requireDb(res)) return;
  if (!rateLimit("adminip:" + clientIp(req), 40, 10 * 60 * 1000)) return res.status(429).json({ ok: false, error: "trop-de-tentatives" });
  const provided = req.headers["x-admin-secret"] || (req.body && req.body.secret) || "";
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_SECRET);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(403).json({ ok: false, error: "admin-refuse" });
  next();
}

app.use(loadUser);

// POST /api/register — crée un compte (+ fusionne l'état invité s'il est fourni).
app.post("/api/register", async (req, res) => {
  if (!requireDb(res)) return;
  if (!rateLimit("reg:" + clientIp(req), 10, 3600 * 1000)) return res.status(429).json({ ok: false, error: "trop-de-comptes" });
  const b = req.body || {};
  const pseudo = cleanPseudo(b.pseudo);
  const key = pseudoKey(pseudo);
  const password = String(b.password || "");
  if (!pseudo || !key) return res.status(400).json({ ok: false, error: "pseudo-invalide" });
  if (password.length < 6 || password.length > 100) return res.status(400).json({ ok: false, error: "mot-de-passe-invalide" });
  const g = b.guest || {};
  let coins = Number.isInteger(g.coins) ? Math.max(0, Math.min(g.coins, 100000000)) : 0;
  const owned = g.owned && typeof g.owned === "object" ? g.owned : {};
  const equipped = g.equipped && typeof g.equipped === "object" ? g.equipped : {};
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await db.query(
      `INSERT INTO users (pseudo_key, pseudo, password_hash, coins, owned, equipped)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING *`,
      [key, pseudo, hash, coins, JSON.stringify(owned), JSON.stringify(equipped)]
    );
    const user = rows[0];
    const token = await newSession(user.id);
    setSessionCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ ok: false, error: "pseudo-pris" });
    console.error("[register]", e.message);
    res.status(500).json({ ok: false, error: "db-error" });
  }
});

// POST /api/login — authentifie + fusionne l'état invité éventuel.
app.post("/api/login", async (req, res) => {
  if (!requireDb(res)) return;
  if (!rateLimit("login:" + clientIp(req), 20, 15 * 60 * 1000)) return res.status(429).json({ ok: false, error: "trop-de-tentatives" });
  const b = req.body || {};
  const key = pseudoKey(b.pseudo);
  const password = String(b.password || "");
  try {
    const { rows } = await db.query(`SELECT * FROM users WHERE pseudo_key = $1`, [key]);
    const user = rows[0];
    // Comparaison factice si le compte n'existe pas → temps de réponse constant.
    const hash = user ? user.password_hash : "$2a$10$0000000000000000000000000000000000000000000000000000a";
    const valid = await bcrypt.compare(password, hash);
    if (!user || !valid) return res.status(401).json({ ok: false, error: "identifiants-invalides" });
    const m = mergeGuest(user, b.guest || {});
    if (m.changed) {
      const { rows: upd } = await db.query(
        `UPDATE users SET coins = $1, owned = $2::jsonb, equipped = $3::jsonb WHERE id = $4 RETURNING *`,
        [m.coins, JSON.stringify(m.owned), JSON.stringify(m.equipped), user.id]
      );
      Object.assign(user, upd[0]);
    }
    const token = await newSession(user.id);
    setSessionCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (e) {
    console.error("[login]", e.message);
    res.status(500).json({ ok: false, error: "db-error" });
  }
});

// POST /api/logout — supprime la session courante + le cookie.
app.post("/api/logout", async (req, res) => {
  if (db && req.token) { try { await db.query(`DELETE FROM sessions WHERE token = $1`, [req.token]); } catch (e) { console.error("[logout]", e.message); } }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/me — état du compte courant (ou null).
app.get("/api/me", (req, res) => {
  if (!db) return res.json({ ok: true, user: null });
  res.json({ ok: true, user: req.user ? publicUser(req.user) : null });
});

// PUT /api/me/state — persiste l'état du joueur connecté (pièces / items / équipement).
app.put("/api/me/state", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!Number.isInteger(b.coins) || b.coins < 0) return res.status(400).json({ ok: false, error: "coins-invalide" });
  if (!b.owned || typeof b.owned !== "object" || Array.isArray(b.owned)) return res.status(400).json({ ok: false, error: "owned-invalide" });
  if (!b.equipped || typeof b.equipped !== "object" || Array.isArray(b.equipped)) return res.status(400).json({ ok: false, error: "equipped-invalide" });
  const coins = Math.min(b.coins, 100000000);
  try {
    const { rows } = await db.query(
      `UPDATE users SET coins = $1, owned = $2::jsonb, equipped = $3::jsonb WHERE id = $4 RETURNING *`,
      [coins, JSON.stringify(b.owned), JSON.stringify(b.equipped), req.user.id]
    );
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (e) {
    console.error("[me/state]", e.message);
    res.status(500).json({ ok: false, error: "db-error" });
  }
});

// ====================================================================
// Zones communautaires : un joueur tape un nom de ville/région, on géocode
// via Nominatim (OSM), on récupère le contour, et la zone devient jouable
// par tous depuis l'onglet « Communauté » du sélecteur de zone.
// ====================================================================

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (resp) => {
      if (resp.statusCode >= 400) { resp.resume(); return reject(new Error("http-" + resp.statusCode)); }
      let data = "";
      resp.on("data", (c) => { data += c; if (data.length > 8000000) { req.destroy(); reject(new Error("too-large")); } });
      resp.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("bad-json")); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// Géocode un nom libre → contour GeoJSON (Polygon/MultiPolygon). Nominatim impose
// un User-Agent identifiable et ~1 req/s (on borne via rateLimit en amont).
async function geocodeZone(query) {
  const u = "https://nominatim.openstreetmap.org/search?format=geojson&polygon_geojson=1&limit=1&q=" + encodeURIComponent(query);
  const j = await httpsGetJson(u, { "User-Agent": "GeolocGame/1.0 (axelcourty1@gmail.com)", "Accept-Language": "fr" });
  const f = j && j.features && j.features[0];
  if (!f || !f.geometry) throw new Error("not-found");
  const g = f.geometry;
  if (g.type !== "Polygon" && g.type !== "MultiPolygon") throw new Error("no-area");  // lieu ponctuel sans contour
  return g;
}

// Décime + arrondit un contour pour alléger le stockage et le transfert.
function decimateGeom(geom, maxPerRing) {
  const thin = (ring) => {
    const round = (p) => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4];
    if (ring.length <= maxPerRing) return ring.map(round);
    const step = Math.ceil(ring.length / maxPerRing), out = [];
    for (let i = 0; i < ring.length; i += step) out.push(round(ring[i]));
    out.push(round(ring[0]));   // referme l'anneau
    return out;
  };
  if (geom.type === "Polygon") return { type: "Polygon", coordinates: geom.coordinates.map(thin) };
  return { type: "MultiPolygon", coordinates: geom.coordinates.map((poly) => poly.map(thin)) };
}

// bbox [minLng,minLat,maxLng,maxLat], centre, rayon (demi-diagonale haversine, km).
function geoMeta(geom) {
  let mnLng = 180, mnLat = 90, mxLng = -180, mxLat = -90;
  const scan = (ring) => ring.forEach(([lng, lat]) => { if (lng < mnLng) mnLng = lng; if (lng > mxLng) mxLng = lng; if (lat < mnLat) mnLat = lat; if (lat > mxLat) mxLat = lat; });
  if (geom.type === "Polygon") geom.coordinates.forEach(scan);
  else geom.coordinates.forEach((poly) => poly.forEach(scan));
  const cLat = (mnLat + mxLat) / 2, cLng = (mnLng + mxLng) / 2;
  const R = 6371, toR = (x) => x * Math.PI / 180;
  const a = Math.sin(toR(mxLat - mnLat) / 2) ** 2 + Math.cos(toR(mnLat)) * Math.cos(toR(mxLat)) * Math.sin(toR(mxLng - mnLng) / 2) ** 2;
  const diag = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  return { bbox: [mnLng, mnLat, mxLng, mxLat], centerLat: cLat, centerLng: cLng, radiusKm: Math.round(diag / 2 * 10) / 10 };
}

// POST : crée une zone (auth requise). Géocode → simplifie → stocke.
app.post("/api/community/zones", requireAuth, async (req, res) => {
  const name = String((req.body && req.body.name) || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (name.length < 2) return res.status(400).json({ ok: false, error: "Donne un nom de lieu (ville, région…)." });
  if (!rateLimit("czone:" + req.user.id, 6, 10 * 60 * 1000)) return res.status(429).json({ ok: false, error: "Trop de zones créées, réessaie dans quelques minutes." });
  // anti-doublon : refuse une zone dont le nom existe déjà (insensible à la casse)
  try {
    const dup = await db.query(`SELECT id, pseudo FROM community_zones WHERE lower(name) = lower($1) LIMIT 1`, [name]);
    if (dup.rows.length) return res.status(409).json({ ok: false, error: "Cette zone existe déjà (créée par " + dup.rows[0].pseudo + ")." });
  } catch (e) { /* en cas d'erreur DB on laisse passer, l'INSERT tranchera */ }
  let geom;
  try { geom = await geocodeZone(name); }
  catch (e) {
    if (e.message === "no-area") return res.status(404).json({ ok: false, error: "Ce lieu n'a pas de contour (essaie une ville ou une région)." });
    if (e.message === "not-found") return res.status(404).json({ ok: false, error: "Lieu introuvable — vérifie l'orthographe." });
    return res.status(502).json({ ok: false, error: "Géocodage indisponible, réessaie dans un instant." });
  }
  const small = decimateGeom(geom, 360);
  if (JSON.stringify(small).length > 500000) return res.status(400).json({ ok: false, error: "Zone trop vaste — choisis une ville ou une région plus précise." });
  const meta = geoMeta(small);
  try {
    const { rows } = await db.query(
      `INSERT INTO community_zones (user_id, pseudo, name, geojson, center_lat, center_lng, bbox, radius_km)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8)
       RETURNING id, name, pseudo, center_lat, center_lng, bbox, radius_km, created_at`,
      [req.user.id, req.user.pseudo, name, JSON.stringify(small), meta.centerLat, meta.centerLng, JSON.stringify(meta.bbox), meta.radiusKm]
    );
    const z = rows[0];
    res.json({ ok: true, zone: { id: z.id, name: z.name, pseudo: z.pseudo, center: [z.center_lat, z.center_lng], bbox: z.bbox, radius_km: z.radius_km, geojson: small } });
  } catch (e) {
    console.error("[czone-create]", e.message);
    res.status(500).json({ ok: false, error: "Erreur d'enregistrement." });
  }
});

// GET : liste publique des zones communautaires (dégradation gracieuse sans DB).
app.get("/api/community/zones", async (req, res) => {
  if (!db) return res.json({ ok: true, zones: [] });
  try {
    const { rows } = await db.query(
      `SELECT id, name, pseudo, center_lat, center_lng, bbox, radius_km, geojson, created_at
       FROM community_zones ORDER BY created_at DESC LIMIT 80`);
    res.json({ ok: true, zones: rows.map((z) => ({ id: z.id, name: z.name, pseudo: z.pseudo, center: [z.center_lat, z.center_lng], bbox: z.bbox, radius_km: z.radius_km, geojson: z.geojson })) });
  } catch (e) {
    console.error("[czones]", e.message);
    res.json({ ok: true, zones: [] });
  }
});

// DELETE : un joueur retire sa propre zone.
app.delete("/api/community/zones/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "id-invalide" });
  try {
    const { rowCount } = await db.query(`DELETE FROM community_zones WHERE id = $1 AND user_id = $2`, [id, req.user.id]);
    res.json({ ok: rowCount > 0 });
  } catch (e) { res.status(500).json({ ok: false, error: "db-error" }); }
});

// ====================================================================
// Console d'administration  (GET /admin-geo + /admin-geo/api/*)
// ====================================================================

app.get("/admin-geo", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex");
  res.type("html").send(ADMIN_PAGE_HTML);
});

// GET /admin-geo/api/stats — chiffres globaux pour le dashboard.
app.get("/admin-geo/api/stats", checkAdmin, async (req, res) => {
  try {
    const u = await db.query(`SELECT count(*)::int AS users, COALESCE(SUM(coins), 0)::bigint AS coins FROM users`);
    const s = await db.query(`SELECT count(*)::int AS scores FROM scores`);
    res.json({ ok: true, users: u.rows[0].users, totalCoins: Number(u.rows[0].coins), scores: s.rows[0].scores });
  } catch (e) { console.error("[admin/stats]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// GET /admin-geo/api/accounts?q=&limit=&offset= — liste paginée des comptes.
app.get("/admin-geo/api/accounts", checkAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 40);
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) limit = 50;
  let offset = parseInt(req.query.offset, 10);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  const like = "%" + q.toLowerCase() + "%";
  try {
    const { rows } = await db.query(
      `SELECT pseudo, coins, owned, equipped, created_at, last_seen
         FROM users
        WHERE ($1 = '' OR pseudo_key LIKE $2)
        ORDER BY last_seen DESC
        LIMIT $3 OFFSET $4`,
      [q, like, limit, offset]
    );
    const cnt = await db.query(`SELECT count(*)::int AS total FROM users WHERE ($1 = '' OR pseudo_key LIKE $2)`, [q, like]);
    res.json({ ok: true, accounts: rows, total: cnt.rows[0].total });
  } catch (e) { console.error("[admin/accounts]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// POST /admin-geo/api/credit {pseudo, amount} — crédite/débite (borné 0..1e8).
app.post("/admin-geo/api/credit", checkAdmin, async (req, res) => {
  const b = req.body || {};
  const key = pseudoKey(b.pseudo);
  const amount = Number(b.amount);
  if (!key) return res.status(400).json({ ok: false, error: "pseudo-requis" });
  if (!Number.isInteger(amount)) return res.status(400).json({ ok: false, error: "montant-invalide" });
  try {
    const { rows } = await db.query(
      `UPDATE users SET coins = GREATEST(0, LEAST(100000000, coins + $1)) WHERE pseudo_key = $2 RETURNING pseudo, coins`,
      [amount, key]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "compte-introuvable" });
    res.json({ ok: true, pseudo: rows[0].pseudo, coins: rows[0].coins });
  } catch (e) { console.error("[admin/credit]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// POST /admin-geo/api/reset {pseudo} — remet le compte à zéro + déconnecte ses sessions.
app.post("/admin-geo/api/reset", checkAdmin, async (req, res) => {
  const key = pseudoKey((req.body || {}).pseudo);
  if (!key) return res.status(400).json({ ok: false, error: "pseudo-requis" });
  try {
    const { rows } = await db.query(
      `UPDATE users SET coins = 0, owned = '{}'::jsonb, equipped = '{}'::jsonb WHERE pseudo_key = $1 RETURNING id, pseudo`,
      [key]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "compte-introuvable" });
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [rows[0].id]);
    res.json({ ok: true, pseudo: rows[0].pseudo });
  } catch (e) { console.error("[admin/reset]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// DELETE /admin-geo/api/accounts/:pseudo — supprime un compte (sessions en cascade).
app.delete("/admin-geo/api/accounts/:pseudo", checkAdmin, async (req, res) => {
  const key = pseudoKey(req.params.pseudo);
  if (!key) return res.status(400).json({ ok: false, error: "pseudo-requis" });
  try {
    const { rows } = await db.query(`DELETE FROM users WHERE pseudo_key = $1 RETURNING pseudo`, [key]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "compte-introuvable" });
    res.json({ ok: true, pseudo: rows[0].pseudo });
  } catch (e) { console.error("[admin/delete-account]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// POST /admin-geo/api/set-password {pseudo, password} — réinitialise le mot de passe.
app.post("/admin-geo/api/set-password", checkAdmin, async (req, res) => {
  const b = req.body || {};
  const key = pseudoKey(b.pseudo);
  const password = String(b.password || "");
  if (!key) return res.status(400).json({ ok: false, error: "pseudo-requis" });
  if (password.length < 6 || password.length > 100) return res.status(400).json({ ok: false, error: "mot-de-passe-invalide" });
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await db.query(`UPDATE users SET password_hash = $1 WHERE pseudo_key = $2 RETURNING id, pseudo`, [hash, key]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "compte-introuvable" });
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [rows[0].id]);
    res.json({ ok: true, pseudo: rows[0].pseudo });
  } catch (e) { console.error("[admin/set-password]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// GET /admin-geo/api/scores?pseudo=&limit= — liste de scores (filtrable par pseudo).
app.get("/admin-geo/api/scores", checkAdmin, async (req, res) => {
  const pseudo = String(req.query.pseudo || "").trim().slice(0, 18);
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) limit = 50;
  const like = "%" + pseudo.toLowerCase() + "%";
  try {
    const { rows } = await db.query(
      `SELECT id, pseudo, zone, zone_label, rounds, score, created_at
         FROM scores
        WHERE ($1 = '' OR lower(pseudo) LIKE $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [pseudo, like, limit]
    );
    res.json({ ok: true, scores: rows });
  } catch (e) { console.error("[admin/scores]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// DELETE /admin-geo/api/scores/:id — supprime un score précis.
app.delete("/admin-geo/api/scores/:id", checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "id-invalide" });
  try {
    const { rows } = await db.query(`DELETE FROM scores WHERE id = $1 RETURNING id`, [id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "score-introuvable" });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { console.error("[admin/delete-score]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// POST /admin-geo/api/scores/purge {confirm:"PURGE"} — vide tout le classement.
app.post("/admin-geo/api/scores/purge", checkAdmin, async (req, res) => {
  if (((req.body || {}).confirm) !== "PURGE") return res.status(400).json({ ok: false, error: "confirmation-requise" });
  try {
    const { rowCount } = await db.query(`DELETE FROM scores`);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) { console.error("[admin/purge]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// POST /api/scores — enregistre le score d'une partie solo terminée
app.post("/api/scores", async (req, res) => {
  if (!requireDb(res)) return;
  const b = req.body || {};
  const pseudo = String(b.pseudo || "").trim().slice(0, 18);
  const zone = String(b.zone || "").trim().slice(0, 40);
  const zoneLabel = String(b.zoneLabel || "").trim().slice(0, 80);
  const rounds = Number(b.rounds);
  const score = Number(b.score);
  if (!pseudo || !zone) return res.status(400).json({ ok: false, error: "pseudo-et-zone-requis" });
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) return res.status(400).json({ ok: false, error: "rounds-invalide" });
  if (!Number.isInteger(score) || score < 0 || score > 300000) return res.status(400).json({ ok: false, error: "score-invalide" });
  try {
    await db.query(
      `INSERT INTO scores (pseudo, zone, zone_label, rounds, score) VALUES ($1, $2, $3, $4, $5)`,
      [pseudo, zone, zoneLabel, rounds, score]
    );
    const { rows } = await db.query(
      `SELECT count(*)::int + 1 AS rank FROM scores WHERE zone = $1 AND score > $2`,
      [zone, score]
    );
    console.log("[db] score " + score + " (" + pseudo + " / " + zone + ") rang " + rows[0].rank);
    res.json({ ok: true, rank: rows[0].rank });
  } catch (e) {
    console.error("[db] insert error:", e.message);
    res.status(500).json({ ok: false, error: "db-error" });
  }
});

// GET /api/scores?zone=...&limit=10 — meilleurs scores (par zone, ou global si zone absente)
app.get("/api/scores", async (req, res) => {
  if (!requireDb(res)) return;
  const zone = String(req.query.zone || "").trim().slice(0, 40);
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) limit = 10;
  try {
    const { rows } = await db.query(
      `SELECT pseudo, zone_label, rounds, score, created_at FROM (
         SELECT DISTINCT ON (pseudo) pseudo, zone_label, rounds, score, created_at
           FROM scores
          WHERE ($1 = '' OR zone = $1)
          ORDER BY pseudo, score DESC, created_at ASC
       ) t
       ORDER BY score DESC, created_at ASC
       LIMIT $2`,
      [zone, limit]
    );
    res.json({ ok: true, scores: rows });
  } catch (e) {
    console.error("[db] select error:", e.message);
    res.status(500).json({ ok: false, error: "db-error" });
  }
});

// Chaîne relative en français depuis une date (calcul côté serveur).
function frAgo(date) {
  const then = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "à l'instant";
  const min = Math.floor(s / 60);
  if (min < 60) return "il y a " + min + " min";
  const h = Math.floor(min / 60);
  if (h < 24) return "il y a " + h + " h";
  const j = Math.floor(h / 24);
  if (j < 2) return "hier";
  return "il y a " + j + " j";
}

// GET /api/community — vraies données pour la page Communauté (publique).
// Toujours 200 : sans DB ou en cas d'erreur, on renvoie des valeurs vides.
app.get("/api/community", async (req, res) => {
  const empty = { ok: true, stats: { games: 0, players: 0, best: 0 }, top: [], recent: [] };
  if (!db) return res.json(empty);
  try {
    const stats = await db.query(
      `SELECT count(*)::int AS games,
              count(DISTINCT pseudo)::int AS players,
              COALESCE(max(score), 0)::int AS best
         FROM scores`
    );
    const top = await db.query(
      `SELECT pseudo, score, zone_label, rounds FROM (
         SELECT DISTINCT ON (pseudo) pseudo, score, COALESCE(NULLIF(zone_label, ''), zone) AS zone_label, rounds
           FROM scores
          ORDER BY pseudo, score DESC
       ) t
       ORDER BY score DESC
       LIMIT 5`
    );
    const recent = await db.query(
      `SELECT pseudo, score, COALESCE(NULLIF(zone_label, ''), zone) AS zone_label, rounds, created_at
         FROM scores
        ORDER BY created_at DESC
        LIMIT 6`
    );
    res.json({
      ok: true,
      stats: stats.rows[0],
      top: top.rows.map((r) => ({ pseudo: r.pseudo, score: r.score, zoneLabel: r.zone_label, rounds: r.rounds })),
      recent: recent.rows.map((r) => ({ pseudo: r.pseudo, score: r.score, zoneLabel: r.zone_label, rounds: r.rounds, ago: frAgo(r.created_at) })),
    });
  } catch (e) {
    console.error("[db] community error:", e.message);
    res.json(empty);
  }
});

// healthcheck : utilisé par Coolify ET Uptime Kuma. Indique aussi l'état de la DB.
app.get("/healthz", (req, res) => res.json({ ok: true, db: !!db }));

app.use(express.static(DIR, { extensions: ["html"] }));
app.get("/", (req, res) => res.sendFile(path.join(DIR, "index.html")));
app.get(["/multi", "/classement", "/boutique", "/communaute"], (req, res) => res.sendFile(path.join(DIR, "index.html")));

const server = app.listen(PORT, () => console.log("[geoloc] HTTP + multi sur :" + PORT));
initDb().catch((e) => console.error("[db] init error:", e.message));

// ---- relay multijoueur WebSocket (/rooms) ----
// Le jeu échange très peu de données. Un relay WebSocket évite que rejoindre une salle dépende
// d'un TURN public ou d'une connexion WebRTC P2P réussie entre deux réseaux différents.
const rooms = new Map();
const wss = new WebSocketServer({ server, path: "/rooms" });

// Heartbeat : un ping protocolaire toutes les 25 s maintient le flux bidirectionnel (les reverse
// proxies coupent souvent les WebSocket inactives ⇒ « hôte déconnecté ») et détecte/ferme les
// sockets morts (le navigateur répond « pong » automatiquement, aucun code client nécessaire).
function heartbeat() { this.isAlive = true; }
const wssHeartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 25000);
wss.on("close", () => clearInterval(wssHeartbeat));

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function roomRoster(room) {
  return Array.from(room.clients.values()).map((ws) => ({
    id: ws.playerId,
    name: ws.playerName,
    av: ws.playerAv,
    isHost: ws.playerId === room.hostId,
  }));
}

function broadcastServerRoster(room) {
  const roster = roomRoster(room);
  room.clients.forEach((client) => send(client, { type: "server-roster", roster }));
}

function cleanupClient(ws) {
  if (ws.cleaned) return;
  ws.cleaned = true;
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room || !ws.playerId) return;

  room.clients.delete(ws.playerId);
  if (ws.playerId === room.hostId) {
    room.clients.forEach((client) => send(client, { type: "host-closed" }));
    rooms.delete(room.code);
    console.log("[rooms] closed " + room.code);
    return;
  }

  const host = room.clients.get(room.hostId);
  send(host, { type: "peer-left", id: ws.playerId });
  broadcastServerRoster(room);
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || !msg.type) return;

    if (msg.type === "create") {
      const code = String(msg.code || "").trim().toUpperCase();
      const id = String(msg.id || "");
      if (!/^[A-Z0-9]{4}$/.test(code) || !id) return send(ws, { type: "error", reason: "bad-create" });
      if (rooms.has(code)) return send(ws, { type: "error", reason: "code-taken" });

      const room = { code, hostId: id, clients: new Map() };
      rooms.set(code, room);
      ws.roomCode = code;
      ws.playerId = id;
      ws.playerName = String(msg.name || "Joueur").slice(0, 18);
      ws.playerAv = Number.isFinite(msg.av) ? msg.av : 0;
      room.clients.set(id, ws);
      console.log("[rooms] create " + code + " host=" + id);
      send(ws, { type: "created", code, roster: roomRoster(room) });

    } else if (msg.type === "join") {
      const code = String(msg.code || "").trim().toUpperCase();
      const id = String(msg.id || "");
      const room = rooms.get(code);
      const host = room && room.clients.get(room.hostId);
      if (!room || !host || !id) return send(ws, { type: "error", reason: "not-found" });

      ws.roomCode = code;
      ws.playerId = id;
      ws.playerName = String(msg.name || "Joueur").slice(0, 18);
      ws.playerAv = Number.isFinite(msg.av) ? msg.av : 0;
      room.clients.set(id, ws);
      console.log("[rooms] join " + code + " guest=" + id);
      send(host, { type: "peer-joined", player: { id, name: ws.playerName, av: ws.playerAv } });
      send(ws, { type: "joined", code, hostId: room.hostId, roster: roomRoster(room) });
      broadcastServerRoster(room);

    } else if (msg.type === "to-host") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      const host = room && room.clients.get(room.hostId);
      send(host, { type: "from", from: ws.playerId, message: msg.message });

    } else if (msg.type === "to") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      const dst = room && room.clients.get(String(msg.to || ""));
      send(dst, { type: "from", from: ws.playerId, message: msg.message });

    } else if (msg.type === "close-peer") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      const dst = room && room.clients.get(String(msg.id || ""));
      if (dst && dst.playerId !== room.hostId) dst.close();
    }
  });

  ws.on("close", () => cleanupClient(ws));
  ws.on("error", () => cleanupClient(ws));
});

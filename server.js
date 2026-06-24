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
  .stats{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  .card h2 .spacer{flex:1}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{font-size:12px;background:#0b0f15;border:1px solid var(--bd);border-radius:7px;padding:4px 8px;cursor:pointer;transition:.12s}
  .chip:hover{border-color:var(--bad);color:#ffb4ae;background:#2a1719}
  .chip.eq{border-color:var(--ok);color:#9be7a8}
  .pc-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
  .pc-meta span{font-size:12px;color:var(--mut);background:var(--panel);border:1px solid var(--bd);border-radius:7px;padding:4px 9px}
  .pc-meta b{color:var(--tx)}
  tr.clickable{cursor:pointer}
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
      <div class="stat"><div class="n" id="stActive">–</div><div class="l">Actifs (24 h)</div></div>
      <div class="stat"><div class="n coins" id="stCoins">–</div><div class="l">Pièces en circulation</div></div>
      <div class="stat"><div class="n" id="stScores">–</div><div class="l">Scores enregistrés</div></div>
      <div class="stat"><div class="n" id="stScores24">–</div><div class="l">Scores (24 h)</div></div>
      <div class="stat"><div class="n" id="stZones">–</div><div class="l">Zones communauté</div></div>
    </div>

    <div class="tabs">
      <button data-tab="dashboard" class="on">Tableau de bord</button>
      <button data-tab="players">Joueurs</button>
      <button data-tab="scores">Scores</button>
      <button data-tab="zones">Zones</button>
      <button data-tab="tools">Outils</button>
    </div>

    <!-- Tableau de bord -->
    <section id="tab-dashboard" class="card">
      <h2><span class="ic">📊</span> Top joueurs <span class="spacer"></span><button class="sm" id="dashRefresh">Rafraîchir</button></h2>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>#</th><th>Pseudo</th><th>Meilleur score</th><th>Parties</th><th>Pièces</th><th></th></tr></thead>
          <tbody id="topBody"><tr><td colspan="6" class="empty">…</td></tr></tbody>
        </table>
      </div>
    </section>

    <!-- Joueurs -->
    <section id="tab-players" class="card hide">
      <h2><span class="ic">👥</span> Joueurs</h2>
      <div class="row" style="margin-bottom:12px">
        <div class="col"><label>Recherche (pseudo)</label><input id="accSearch" placeholder="Rechercher un joueur…"></div>
        <button id="accRefresh">Rafraîchir</button>
      </div>

      <!-- Fiche joueur détaillée (cachée tant qu'aucun joueur n'est sélectionné) -->
      <div id="playerCard" class="card hide" style="background:var(--panel2);border-color:var(--acc)">
        <h2><span class="ic">🎯</span> <span id="pcName">—</span><span class="spacer"></span><button class="sm" id="pcClose">Fermer ✕</button></h2>
        <div class="pc-meta" id="pcMeta"></div>

        <div class="grid g2" style="margin-top:14px">
          <div class="card" style="margin:0;background:var(--panel)">
            <label>🪙 Pièces — <span id="pcCoins" class="coins">–</span></label>
            <div class="row" style="margin-top:6px"><div class="col"><input id="pcCoinVal" type="number" placeholder="ex: 500"></div>
              <button class="sm pri" data-pc="coinAdd">Créditer</button><button class="sm" data-pc="coinSet">Définir</button></div>
          </div>
          <div class="card" style="margin:0;background:var(--panel)">
            <label>🎟 Passe — palier <span id="pcLevel">–</span> / 100 · <span id="pcXp">–</span> XP</label>
            <div class="row" style="margin-top:6px"><div class="col"><input id="pcPassVal" type="number" placeholder="palier ou XP"></div>
              <button class="sm pri" data-pc="passLevel">Définir palier</button><button class="sm" data-pc="passXp">Définir XP</button></div>
            <div class="acts" style="margin-top:8px">
              <button class="sm" data-pc="passAdd1">+1 palier</button>
              <button class="sm" data-pc="passAdd5">+5 paliers</button>
              <button class="sm" data-pc="passAdd1k">+1 000 XP</button>
              <button class="sm danger" data-pc="passReset">Reset passe</button>
            </div>
          </div>
        </div>

        <div class="card" style="margin:14px 0 0;background:var(--panel)">
          <label>🎨 Cosmétiques possédés <span id="pcOwnCount" class="muted"></span> — clique pour retirer</label>
          <div id="pcOwned" class="chips" style="margin:6px 0 10px"></div>
          <div class="row"><div class="col"><input id="pcItem" list="itemList" placeholder="id d'item (ex: bannerOcean, passBadgeDragon)"></div>
            <button class="sm pri" data-pc="itemGrant">Donner</button></div>
        </div>

        <div class="grid g2" style="margin-top:14px">
          <div class="card" style="margin:0;background:var(--panel)">
            <label>🔑 Réinitialiser le mot de passe (6+)</label>
            <div class="row" style="margin-top:6px"><div class="col"><input id="pcPw" type="text" placeholder="nouveau mot de passe"></div><button class="sm" data-pc="pw">Changer</button></div>
          </div>
          <div class="card" style="margin:0;background:var(--panel)">
            <label>⚠️ Zone de danger</label>
            <div class="acts" style="margin-top:6px"><button class="sm danger" data-pc="reset">Reset compte</button><button class="sm danger" data-pc="delete">Supprimer le compte</button></div>
          </div>
        </div>
      </div>

      <div style="overflow:auto">
        <table>
          <thead><tr><th>Pseudo</th><th>Pièces</th><th>Items</th><th>Vu</th><th>Créé</th><th></th></tr></thead>
          <tbody id="accBody"><tr><td colspan="6" class="empty">…</td></tr></tbody>
        </table>
      </div>
      <div id="accMore" class="muted" style="margin-top:10px"></div>
    </section>

    <!-- Scores -->
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

    <!-- Zones communautaires -->
    <section id="tab-zones" class="card hide">
      <h2><span class="ic">🗺️</span> Zones communautaires <span class="spacer"></span><button class="sm" id="znRefresh">Rafraîchir</button></h2>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>#</th><th>Nom</th><th>Créateur</th><th>Rayon</th><th>Coordonnées</th><th>Date</th><th></th></tr></thead>
          <tbody id="znBody"><tr><td colspan="7" class="empty">…</td></tr></tbody>
        </table>
      </div>
    </section>

    <!-- Outils -->
    <section id="tab-tools" class="card hide">
      <h2><span class="ic">🛠️</span> Outils globaux</h2>
      <div class="card" style="margin:0;background:var(--panel2)">
        <label>🪙 Créditer / débiter TOUS les comptes</label>
        <div class="row" style="margin-top:6px"><div class="col"><input id="caAmount" type="number" placeholder="ex: 1000 (négatif = débit)"></div><button class="pri" id="caBtn">Appliquer à tous</button></div>
        <div class="hint">Ajoute le montant au solde de chaque joueur (borné 0 – 100 000 000).</div>
      </div>
    </section>
  </div>
</div>
<datalist id="itemList">
  <option value="themeDefault"><option value="aurora"><option value="sunset"><option value="emerald"><option value="magma"><option value="cyber"><option value="sakura"><option value="mono"><option value="boreal">
  <option value="badge"><option value="badgeCompass"><option value="badgeFlame"><option value="badgeStar"><option value="badgeCrown">
  <option value="avatars"><option value="avatarsBot"><option value="avatarsPixel"><option value="avatarsExpedition">
  <option value="fxNone"><option value="fxAurora">
  <option value="bannerDefault"><option value="bannerSummit"><option value="bannerAurora"><option value="bannerSunset"><option value="bannerAtlas"><option value="bannerOcean"><option value="bannerForest"><option value="bannerCosmos"><option value="bannerRuby">
  <option value="passBadgeCeleste"><option value="passBadgeNord"><option value="passBadgeSolar"><option value="passBadgeAtlas"><option value="passBadgeSouverain"><option value="passBadgeDiamond"><option value="passBadgeBolt"><option value="passBadgeWave"><option value="passBadgeDragon">
  <option value="passBannerSummit"><option value="passBannerAurora"><option value="passBannerSunset"><option value="passBannerAtlas"><option value="passBannerLegendary"><option value="passBannerNebula"><option value="passBannerEmber"><option value="passBannerGold">
</datalist>

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
  function toast(msg, kind){ var t=$("toast"); t.textContent=msg; t.className="toast show "+(kind||""); clearTimeout(toastT); toastT=setTimeout(function(){ t.className="toast "+(kind||""); }, 2600); }

  async function api(method, path, body){
    var opt={ method:method, headers:{ "X-Admin-Secret": SECRET||"" } };
    if(body!==undefined){ opt.headers["Content-Type"]="application/json"; opt.body=JSON.stringify(body); }
    var r=await fetch("/admin-geo/api"+path, opt);
    var data={}; try{ data=await r.json(); }catch(e){}
    if(r.status===403){ throw { status:403, error:"admin-refuse" }; }
    if(!r.ok){ throw { status:r.status, error:(data&&data.error)||("erreur-"+r.status) }; }
    return data;
  }

  function showApp(){ $("loginView").classList.add("hide"); $("appView").classList.remove("hide"); $("who").classList.remove("hide"); $("who").textContent="session active"; $("logoutBtn").classList.remove("hide"); refreshStats(); loadAccounts(); }
  function showLogin(){ SECRET=null; $("appView").classList.add("hide"); $("loginView").classList.remove("hide"); $("who").classList.add("hide"); $("logoutBtn").classList.add("hide"); $("secret").value=""; $("secret").focus(); }
  function guard(err){ if(err && err.status===403){ showLogin(); toast("Session expirée","err"); return true; } return false; }

  $("loginForm").addEventListener("submit", async function(e){ e.preventDefault(); SECRET=$("secret").value; if(!SECRET){ toast("Mot de passe requis","err"); return; } try{ await api("GET","/stats"); showApp(); }catch(err){ SECRET=null; toast(err.status===403?"Mot de passe incorrect":("Erreur: "+err.error),"err"); } });
  $("logoutBtn").addEventListener("click", showLogin);

  var TABS=["dashboard","players","scores","zones","tools"];
  Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function(b){
    b.addEventListener("click", function(){
      Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function(x){ x.classList.remove("on"); });
      b.classList.add("on");
      var t=b.getAttribute("data-tab");
      TABS.forEach(function(name){ $("tab-"+name).classList.toggle("hide", name!==t); });
      if(t==="scores") loadScores(); else if(t==="zones") loadZones(); else if(t==="dashboard") refreshStats();
    });
  });

  async function refreshStats(){
    try{ var d=await api("GET","/stats");
      $("stUsers").textContent=fmt(d.users); $("stActive").textContent=fmt(d.active24);
      $("stCoins").textContent=fmt(d.totalCoins); $("stScores").textContent=fmt(d.scores);
      $("stScores24").textContent=fmt(d.scores24); $("stZones").textContent=fmt(d.zones);
      var top=d.top||[];
      $("topBody").innerHTML = top.length ? top.map(function(u,i){
        return '<tr class="clickable" data-open="'+esc(u.pseudo)+'"><td class="muted">'+(i+1)+'</td><td class="mono">'+esc(u.pseudo)+'</td><td class="coins">'+fmt(u.best)+'</td><td>'+fmt(u.games)+'</td><td class="coins">'+fmt(u.coins)+'</td><td><button class="sm" data-open="'+esc(u.pseudo)+'">Gerer</button></td></tr>';
      }).join("") : '<tr><td colspan="6" class="empty">Aucun joueur</td></tr>';
    }catch(err){ guard(err); }
  }
  $("dashRefresh").addEventListener("click", refreshStats);

  function itemCount(o){ if(!o||typeof o!=="object") return 0; var n=0; for(var k in o){ if(o[k]) n++; } return n; }
  async function loadAccounts(){
    var q=$("accSearch").value.trim();
    $("accBody").innerHTML='<tr><td colspan="6" class="empty">Chargement...</td></tr>';
    try{
      var d=await api("GET","/accounts?limit=100&q="+encodeURIComponent(q));
      if(!d.accounts.length){ $("accBody").innerHTML='<tr><td colspan="6" class="empty">Aucun compte</td></tr>'; $("accMore").textContent=""; return; }
      $("accBody").innerHTML=d.accounts.map(function(a){
        return '<tr class="clickable" data-open="'+esc(a.pseudo)+'"><td class="mono">'+esc(a.pseudo)+'</td><td class="coins">'+fmt(a.coins)+'</td><td>'+itemCount(a.owned)+'</td><td class="muted">'+dt(a.last_seen)+'</td><td class="muted">'+dt(a.created_at)+'</td><td><button class="sm pri" data-open="'+esc(a.pseudo)+'">Gerer</button></td></tr>';
      }).join("");
      $("accMore").textContent=d.accounts.length+" / "+d.total+" compte(s)";
    }catch(err){ if(guard(err)) return; $("accBody").innerHTML='<tr><td colspan="6" class="empty">Erreur: '+esc(err.error)+'</td></tr>'; }
  }
  var accT; $("accSearch").addEventListener("input", function(){ clearTimeout(accT); accT=setTimeout(loadAccounts, 250); });
  $("accRefresh").addEventListener("click", function(){ loadAccounts(); refreshStats(); });

  document.addEventListener("click", function(e){ var el=e.target.closest("[data-open]"); if(el){ openPlayer(el.getAttribute("data-open")); } });

  var CUR=null;
  async function openPlayer(pseudo){
    try{
      var d=await api("GET","/account/"+encodeURIComponent(pseudo));
      CUR=d.account; renderPlayer();
      $("playerCard").classList.remove("hide");
      var pt=document.querySelector('.tabs button[data-tab="players"]'); if($("tab-players").classList.contains("hide")) pt.click();
      $("playerCard").scrollIntoView({behavior:"smooth", block:"start"});
    }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); }
  }
  function renderPlayer(){
    var a=CUR; if(!a) return;
    $("pcName").textContent=a.pseudo;
    $("pcCoins").textContent=fmt(a.coins); $("pcLevel").textContent=a.level; $("pcXp").textContent=fmt(a.xp);
    $("pcMeta").innerHTML=[["Parties",fmt(a.games)],["Record",fmt(a.best)],["Amis",fmt(a.friends)],["Zones",fmt(a.zones)],["Avatar","#"+a.avatar_idx],["Paliers recup.",(a.claims||[]).length],["Cree",dt(a.created_at)],["Vu",dt(a.last_seen)]].map(function(p){ return '<span>'+p[0]+' <b>'+esc(p[1])+'</b></span>'; }).join("");
    var eq=a.equipped||{}; var eqSet={}; for(var s in eq){ if(eq[s]) eqSet[eq[s]]=1; }
    var owned=a.owned||{}; var keys=Object.keys(owned).filter(function(k){ return owned[k]; });
    $("pcOwnCount").textContent="("+keys.length+")";
    $("pcOwned").innerHTML = keys.length ? keys.map(function(k){ return '<span class="chip'+(eqSet[k]?" eq":"")+'" data-revoke="'+esc(k)+'" title="Retirer">'+esc(k)+(eqSet[k]?" ✓":"")+'</span>'; }).join("") : '<span class="muted">aucun</span>';
  }
  $("pcClose").addEventListener("click", function(){ $("playerCard").classList.add("hide"); CUR=null; });
  $("pcOwned").addEventListener("click", function(e){ var c=e.target.closest("[data-revoke]"); if(!c||!CUR) return; itemAction("revoke", c.getAttribute("data-revoke")); });

  async function refreshCur(){ if(!CUR) return; try{ var d=await api("GET","/account/"+encodeURIComponent(CUR.pseudo)); CUR=d.account; renderPlayer(); }catch(e){} }
  async function passOp(op, value){ try{ var d=await api("POST","/pass",{ pseudo:CUR.pseudo, op:op, value:value }); toast("Passe -> palier "+d.level+" ("+fmt(d.xp)+" XP)","ok"); await refreshCur(); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } }
  async function coinOp(op, value){ try{ var d=await api("POST","/coins",{ pseudo:CUR.pseudo, op:op, value:value }); toast(d.pseudo+" -> "+fmt(d.coins)+" pieces","ok"); await refreshCur(); refreshStats(); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } }
  async function itemAction(op, item){ try{ await api("POST","/item",{ pseudo:CUR.pseudo, op:op, item:item }); toast(op==="grant"?"Item donne":"Item retire","ok"); await refreshCur(); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } }

  $("playerCard").addEventListener("click", function(e){
    var b=e.target.closest("[data-pc]"); if(!b||!CUR) return;
    var act=b.getAttribute("data-pc");
    if(act==="coinAdd"||act==="coinSet"){ var v=parseInt($("pcCoinVal").value,10); if(!Number.isInteger(v)){ toast("Montant invalide","err"); return; } coinOp(act==="coinSet"?"set":"add", v); }
    else if(act==="passLevel"){ var l=parseInt($("pcPassVal").value,10); if(!Number.isInteger(l)){ toast("Palier invalide","err"); return; } passOp("setlevel",l); }
    else if(act==="passXp"){ var x=parseInt($("pcPassVal").value,10); if(!Number.isInteger(x)){ toast("XP invalide","err"); return; } passOp("setxp",x); }
    else if(act==="passAdd1"){ passOp("addxp",1000); }
    else if(act==="passAdd5"){ passOp("addxp",5000); }
    else if(act==="passAdd1k"){ passOp("addxp",1000); }
    else if(act==="passReset"){ if(confirm("Remettre le passe de "+CUR.pseudo+" a zero ?")) passOp("reset",0); }
    else if(act==="itemGrant"){ var it=$("pcItem").value.trim(); if(!it){ toast("Id d'item requis","err"); return; } itemAction("grant",it); $("pcItem").value=""; }
    else if(act==="pw"){ var pw=$("pcPw").value; if(pw.length<6){ toast("Mot de passe trop court (6 min.)","err"); return; } setPw(CUR.pseudo, pw); $("pcPw").value=""; }
    else if(act==="reset"){ if(confirm("Reinitialiser le compte "+CUR.pseudo+" (pieces + items a zero) ?")) doReset(CUR.pseudo); }
    else if(act==="delete"){ if(confirm("SUPPRIMER definitivement "+CUR.pseudo+" ? Irreversible.")) doDelete(CUR.pseudo); }
  });
  async function setPw(pseudo, pw){ try{ await api("POST","/set-password",{ pseudo:pseudo, password:pw }); toast("Mot de passe change","ok"); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } }
  async function doReset(pseudo){ try{ await api("POST","/reset",{ pseudo:pseudo }); toast("Compte reinitialise","ok"); await refreshCur(); loadAccounts(); refreshStats(); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } }
  async function doDelete(pseudo){ try{ await api("DELETE","/accounts/"+encodeURIComponent(pseudo)); toast("Compte supprime","ok"); $("playerCard").classList.add("hide"); CUR=null; loadAccounts(); refreshStats(); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } }

  async function loadScores(){
    var q=$("scSearch").value.trim();
    $("scBody").innerHTML='<tr><td colspan="7" class="empty">Chargement...</td></tr>';
    try{
      var d=await api("GET","/scores?limit=150&pseudo="+encodeURIComponent(q));
      if(!d.scores.length){ $("scBody").innerHTML='<tr><td colspan="7" class="empty">Aucun score</td></tr>'; return; }
      $("scBody").innerHTML=d.scores.map(function(s){
        return '<tr><td class="muted mono">'+s.id+'</td><td class="mono">'+esc(s.pseudo)+'</td><td>'+esc(s.zone_label||s.zone||"")+'</td><td>'+esc(s.rounds)+'</td><td class="coins">'+fmt(s.score)+'</td><td class="muted">'+dt(s.created_at)+'</td><td><button class="sm danger" data-delscore="'+s.id+'">Suppr.</button></td></tr>';
      }).join("");
    }catch(err){ if(guard(err)) return; $("scBody").innerHTML='<tr><td colspan="7" class="empty">Erreur: '+esc(err.error)+'</td></tr>'; }
  }
  var scT; $("scSearch").addEventListener("input", function(){ clearTimeout(scT); scT=setTimeout(loadScores, 250); });
  $("scRefresh").addEventListener("click", function(){ loadScores(); refreshStats(); });
  $("scBody").addEventListener("click", async function(e){ var b=e.target.closest("[data-delscore]"); if(!b) return; var id=b.getAttribute("data-delscore"); if(!confirm("Supprimer le score #"+id+" ?")) return; try{ await api("DELETE","/scores/"+id); toast("Score supprime","ok"); loadScores(); refreshStats(); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } });
  $("scPurge").addEventListener("click", async function(){ if(!confirm("PURGER TOUT le classement ? Irreversible.")) return; var c=prompt("Tape PURGE pour confirmer :",""); if(c!=="PURGE"){ toast("Purge annulee","err"); return; } try{ var d=await api("POST","/scores/purge",{ confirm:"PURGE" }); toast(fmt(d.deleted)+" score(s) supprime(s)","ok"); loadScores(); refreshStats(); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } });

  async function loadZones(){
    $("znBody").innerHTML='<tr><td colspan="7" class="empty">Chargement...</td></tr>';
    try{
      var d=await api("GET","/zones?limit=200");
      if(!d.zones.length){ $("znBody").innerHTML='<tr><td colspan="7" class="empty">Aucune zone</td></tr>'; return; }
      $("znBody").innerHTML=d.zones.map(function(z){
        return '<tr><td class="muted mono">'+z.id+'</td><td>'+esc(z.name)+'</td><td class="mono">'+esc(z.pseudo)+'</td><td>'+esc(Math.round(z.radius_km))+' km</td><td class="muted mono">'+Number(z.center_lat).toFixed(2)+', '+Number(z.center_lng).toFixed(2)+'</td><td class="muted">'+dt(z.created_at)+'</td><td><button class="sm danger" data-delzone="'+z.id+'">Suppr.</button></td></tr>';
      }).join("");
    }catch(err){ if(guard(err)) return; $("znBody").innerHTML='<tr><td colspan="7" class="empty">Erreur: '+esc(err.error)+'</td></tr>'; }
  }
  $("znRefresh").addEventListener("click", loadZones);
  $("znBody").addEventListener("click", async function(e){ var b=e.target.closest("[data-delzone]"); if(!b) return; var id=b.getAttribute("data-delzone"); if(!confirm("Supprimer la zone #"+id+" ?")) return; try{ await api("DELETE","/zones/"+id); toast("Zone supprimee","ok"); loadZones(); refreshStats(); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } });

  $("caBtn").addEventListener("click", async function(){ var v=parseInt($("caAmount").value,10); if(!Number.isInteger(v)||v===0){ toast("Montant invalide","err"); return; } if(!confirm("Appliquer "+(v>0?"+":"")+fmt(v)+" pieces a TOUS les comptes ?")) return; try{ var d=await api("POST","/credit-all",{ amount:v }); toast(fmt(d.updated)+" compte(s) credite(s)","ok"); refreshStats(); }catch(err){ if(!guard(err)) toast("Echec: "+err.error,"err"); } });

  showLogin();
})();
</script>
</body>
</html>`;

app.use(express.json({ limit: "8kb" }));
app.use(cookieParser());

app.use((req, res, next) => {
  // pas de cache sur le HTML (les visiteurs ont toujours la dernière version)
  if (req.path === "/" || req.path === "/multi" || req.path === "/classement" || req.path === "/boutique" || req.path === "/communaute" || req.path === "/profil" || req.path.endsWith(".html")) res.set("Cache-Control", "no-cache");
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
  await db.query(`ALTER TABLE scores ADD COLUMN IF NOT EXISTS duration_s INTEGER NOT NULL DEFAULT 0;`);   // chrono de la partie
  await db.query(`CREATE TABLE IF NOT EXISTS friends (
    user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id  INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, friend_id)
  );`);
  // statut de la relation : 'pending' (demande en attente, user_id a demandé friend_id) ou 'accepted'
  // (amitié = 2 lignes symétriques 'accepted'). Les lignes existantes deviennent 'accepted'.
  await db.query(`ALTER TABLE friends ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'accepted';`);
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
      progress      JSONB        NOT NULL DEFAULT '{"xp":0,"claims":[]}'::jsonb,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      last_seen     TIMESTAMPTZ  NOT NULL DEFAULT now()
    );
  `);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS favorites JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_idx INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{"xp":0,"claims":[]}'::jsonb;`);
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
  // Déduplication : supprime les doublons existants (garde la plus ANCIENNE zone de chaque
  // nom normalisé) puis pose un index UNIQUE → impossible d'avoir deux fois la même zone,
  // au niveau base, en renfort du contrôle applicatif du POST.
  try {
    const dd = await db.query(`DELETE FROM community_zones a USING community_zones b
                               WHERE a.id > b.id AND lower(btrim(a.name)) = lower(btrim(b.name));`);
    if (dd.rowCount) console.log("[db] zones doublons (nom) supprimées :", dd.rowCount);
    // + doublons de LIEU : même centre géocodé (≈ même ville) même si le nom diffère
    // (ex. « bordeaux$ » vs « Bordeaux »). Garde la plus ancienne.
    const dd2 = await db.query(`DELETE FROM community_zones a USING community_zones b
                                WHERE a.id > b.id
                                  AND abs(a.center_lat - b.center_lat) < 0.025
                                  AND abs(a.center_lng - b.center_lng) < 0.025;`);
    if (dd2.rowCount) console.log("[db] zones doublons (lieu) supprimées :", dd2.rowCount);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_czone_name ON community_zones (lower(btrim(name)));`);
  } catch (e) { console.error("[db] dédup community_zones:", e.message); }
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
function publicUser(u) { return { pseudo: u.pseudo, coins: u.coins, owned: u.owned, equipped: u.equipped, favorites: u.favorites || [], av: u.avatar_idx || 0, progress: u.progress || { xp: 0, claims: [] } }; }

function readToken(req) {
  if (req.cookies && req.cookies.gtok) return req.cookies.gtok;
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}
function setSessionCookie(res, token, remember) {
  const opts = { httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/" };
  if (remember !== false) opts.maxAge = SESSION_TTL_MS;   // « rester connecté » → cookie persistant ; sinon cookie de session
  res.cookie("gtok", token, opts);
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
  const gp = g && g.progress && typeof g.progress === "object" ? g.progress : {};
  const accountProgress = u.progress && typeof u.progress === "object" ? u.progress : { xp: 0, claims: [] };
  const progress = {
    xp: Math.max(Number.isInteger(accountProgress.xp) ? accountProgress.xp : 0, Number.isInteger(gp.xp) ? Math.max(0, Math.min(gp.xp, 100000)) : 0),
    claims: Array.from(new Set([].concat(Array.isArray(accountProgress.claims) ? accountProgress.claims : [], Array.isArray(gp.claims) ? gp.claims : [])).filter((n) => Number.isInteger(n) && n >= 1 && n <= 100)),
  };
  if (progress.xp !== accountProgress.xp || progress.claims.length !== (Array.isArray(accountProgress.claims) ? accountProgress.claims.length : 0)) changed = true;
  return { coins, owned, equipped, progress, changed };
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
      `INSERT INTO users (pseudo_key, pseudo, password_hash, coins, owned, equipped, progress)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb) RETURNING *`,
      [key, pseudo, hash, coins, JSON.stringify(owned), JSON.stringify(equipped), JSON.stringify(g.progress && typeof g.progress === "object" ? g.progress : { xp: 0, claims: [] })]
    );
    const user = rows[0];
    const token = await newSession(user.id);
    setSessionCookie(res, token, (req.body && req.body.remember));
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
        `UPDATE users SET coins = $1, owned = $2::jsonb, equipped = $3::jsonb, progress = $4::jsonb WHERE id = $5 RETURNING *`,
        [m.coins, JSON.stringify(m.owned), JSON.stringify(m.equipped), JSON.stringify(m.progress), user.id]
      );
      Object.assign(user, upd[0]);
    }
    const token = await newSession(user.id);
    setSessionCookie(res, token, (req.body && req.body.remember));
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
  if (!b.progress || typeof b.progress !== "object" || Array.isArray(b.progress) || !Number.isInteger(b.progress.xp) || b.progress.xp < 0 || b.progress.xp > 100000 || !Array.isArray(b.progress.claims) || b.progress.claims.some((n) => !Number.isInteger(n) || n < 1 || n > 100)) return res.status(400).json({ ok: false, error: "progress-invalide" });
  const coins = Math.min(b.coins, 100000000);
  const fav = Array.isArray(b.favorites) ? b.favorites.filter((x) => x && typeof x === "object").slice(0, 3) : null;
  const av = (Number.isInteger(b.av) && b.av >= 0 && b.av < 100) ? b.av : null;
  try {
    const { rows } = await db.query(
      `UPDATE users SET coins = $1, owned = $2::jsonb, equipped = $3::jsonb, progress = $4::jsonb,
              favorites = COALESCE($6::jsonb, favorites), avatar_idx = COALESCE($7, avatar_idx) WHERE id = $5 RETURNING *`,
      [coins, JSON.stringify(b.owned), JSON.stringify(b.equipped), JSON.stringify({ xp: b.progress.xp, claims: Array.from(new Set(b.progress.claims)) }), req.user.id, fav ? JSON.stringify(fav) : null, av]
    );
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (e) {
    console.error("[me/state]", e.message);
    res.status(500).json({ ok: false, error: "db-error" });
  }
});

// GET /api/me/top — top 3 scores + stats du joueur connecté (page profil).
app.get("/api/me/top", requireAuth, async (req, res) => {
  try {
    const top = await db.query(
      `SELECT zone_label, score, duration_s, created_at FROM scores WHERE pseudo = $1 ORDER BY score DESC, created_at ASC LIMIT 3`,
      [req.user.pseudo]
    );
    const st = await db.query(
      `SELECT count(*)::int AS games, COALESCE(max(score), 0)::int AS best FROM scores WHERE pseudo = $1`,
      [req.user.pseudo]
    );
    res.json({ ok: true, top: top.rows, games: st.rows[0].games, best: st.rows[0].best });
  } catch (e) {
    console.error("[me/top]", e.message);
    res.status(500).json({ ok: false, error: "db-error" });
  }
});

// GET /api/profile/:pseudo — profil PUBLIC d'un joueur (pas les pièces). isFriend/isMe si connecté.
app.get("/api/profile/:pseudo", async (req, res) => {
  if (!requireDb(res)) return;
  const key = pseudoKey(req.params.pseudo);
  try {
    const u = await db.query(`SELECT id, pseudo, equipped, avatar_idx, progress FROM users WHERE pseudo_key = $1`, [key]);
    if (!u.rows.length) return res.status(404).json({ ok: false, error: "joueur introuvable" });
    const usr = u.rows[0];
    const st = await db.query(`SELECT count(*)::int AS games, COALESCE(max(score), 0)::int AS best FROM scores WHERE pseudo = $1`, [usr.pseudo]);
    const top = await db.query(`SELECT zone_label, score, duration_s FROM scores WHERE pseudo = $1 ORDER BY score DESC, created_at ASC LIMIT 3`, [usr.pseudo]);
    let isFriend = false, isMe = false, requestSent = false, requestReceived = false;
    if (req.user) {
      isMe = req.user.id === usr.id;
      if (!isMe) { const fs = await friendState(req.user.id, usr.id); isFriend = fs.isFriend; requestSent = fs.requestSent; requestReceived = fs.requestReceived; }
    }
    const passXp = usr.progress && Number.isInteger(usr.progress.xp) ? Math.max(0, Math.min(usr.progress.xp, 100000)) : 0;
    res.json({ ok: true, profile: { pseudo: usr.pseudo, av: usr.avatar_idx || 0, equipped: usr.equipped || {}, passXp, games: st.rows[0].games, best: st.rows[0].best, top: top.rows, isFriend, isMe, requestSent, requestReceived } });
  } catch (e) {
    console.error("[profile]", e.message);
    res.status(500).json({ ok: false, error: "db-error" });
  }
});

// ===== Amis avec DEMANDES (pending) puis acceptation/refus =====
// État de la relation entre `meId` et `otherId` (dans les deux sens).
async function friendState(meId, otherId) {
  const r = await db.query(
    `SELECT user_id, status FROM friends
      WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [meId, otherId]
  );
  let isFriend = false, requestSent = false, requestReceived = false;
  for (const row of r.rows) {
    if (row.status === "accepted") isFriend = true;
    else if (row.user_id === meId) requestSent = true;     // j'ai demandé l'autre
    else requestReceived = true;                            // l'autre m'a demandé
  }
  return { isFriend, requestSent, requestReceived };
}
// Établit l'amitié réciproque (2 lignes 'accepted').
async function acceptFriendship(meId, otherId) {
  await db.query(`UPDATE friends SET status='accepted' WHERE user_id=$1 AND friend_id=$2`, [otherId, meId]);
  await db.query(
    `INSERT INTO friends (user_id, friend_id, status) VALUES ($1,$2,'accepted')
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status='accepted'`,
    [meId, otherId]
  );
}

// POST /api/friends/:pseudo — ENVOYER une demande d'ami (ou accepter direct si l'autre m'avait déjà demandé).
app.post("/api/friends/:pseudo", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const key = pseudoKey(req.params.pseudo);
  try {
    const u = await db.query(`SELECT id FROM users WHERE pseudo_key = $1`, [key]);
    if (!u.rows.length) return res.status(404).json({ ok: false, error: "joueur introuvable" });
    const otherId = u.rows[0].id;
    if (otherId === req.user.id) return res.status(400).json({ ok: false, error: "impossible-soi-meme" });
    const st = await friendState(req.user.id, otherId);
    if (st.isFriend) return res.json({ ok: true, status: "friends" });
    if (st.requestReceived) { await acceptFriendship(req.user.id, otherId); return res.json({ ok: true, status: "friends" }); }
    await db.query(
      `INSERT INTO friends (user_id, friend_id, status) VALUES ($1,$2,'pending') ON CONFLICT (user_id, friend_id) DO NOTHING`,
      [req.user.id, otherId]
    );
    res.json({ ok: true, status: "requested" });
  } catch (e) { console.error("[friends+]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});
// POST /api/friends/:pseudo/accept — ACCEPTER une demande reçue
app.post("/api/friends/:pseudo/accept", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const key = pseudoKey(req.params.pseudo);
  try {
    const u = await db.query(`SELECT id FROM users WHERE pseudo_key = $1`, [key]);
    if (!u.rows.length) return res.status(404).json({ ok: false, error: "joueur introuvable" });
    const otherId = u.rows[0].id;
    const pend = await db.query(`SELECT 1 FROM friends WHERE user_id=$1 AND friend_id=$2 AND status='pending'`, [otherId, req.user.id]);
    if (!pend.rows.length) return res.status(404).json({ ok: false, error: "aucune-demande" });
    await acceptFriendship(req.user.id, otherId);
    res.json({ ok: true });
  } catch (e) { console.error("[friend-accept]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});
// POST /api/friends/:pseudo/decline — REFUSER une demande reçue
app.post("/api/friends/:pseudo/decline", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const key = pseudoKey(req.params.pseudo);
  try {
    const u = await db.query(`SELECT id FROM users WHERE pseudo_key = $1`, [key]);
    if (!u.rows.length) return res.status(404).json({ ok: false, error: "joueur introuvable" });
    await db.query(`DELETE FROM friends WHERE user_id=$1 AND friend_id=$2 AND status='pending'`, [u.rows[0].id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error("[friend-decline]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});
// DELETE /api/friends/:pseudo — retirer un ami OU annuler une demande envoyée (supprime les deux sens)
app.delete("/api/friends/:pseudo", requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const key = pseudoKey(req.params.pseudo);
  try {
    const u = await db.query(`SELECT id FROM users WHERE pseudo_key = $1`, [key]);
    if (!u.rows.length) return res.status(404).json({ ok: false, error: "joueur introuvable" });
    await db.query(`DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)`, [req.user.id, u.rows[0].id]);
    res.json({ ok: true });
  } catch (e) { console.error("[friends-]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});
// GET /api/friends — amis ACCEPTÉS
app.get("/api/friends", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.pseudo, u.avatar_idx, u.equipped->>'badge' AS badge,
              (SELECT COALESCE(max(score), 0)::int FROM scores s WHERE s.pseudo = u.pseudo) AS best
         FROM friends f JOIN users u ON u.id = f.friend_id
        WHERE f.user_id = $1 AND f.status='accepted' ORDER BY f.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ ok: true, friends: rows.map((r) => ({ pseudo: r.pseudo, av: r.avatar_idx || 0, best: r.best, badge: r.badge })) });
  } catch (e) { console.error("[friends]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});
// GET /api/friends/requests — demandes d'ami REÇUES en attente (pour la cloche)
app.get("/api/friends/requests", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.pseudo, u.avatar_idx
         FROM friends f JOIN users u ON u.id = f.user_id
        WHERE f.friend_id = $1 AND f.status='pending' ORDER BY f.created_at DESC LIMIT 30`,
      [req.user.id]
    );
    res.json({ ok: true, requests: rows.map((r) => ({ pseudo: r.pseudo, av: r.avatar_idx || 0 })) });
  } catch (e) { console.error("[freq]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// GET /api/players/search?q= — recherche de joueurs par pseudo (pour ajouter en ami)
app.get("/api/players/search", requireAuth, async (req, res) => {
  const q = pseudoKey(req.query.q || "");
  if (q.length < 2) return res.json({ ok: true, players: [] });
  try {
    const { rows } = await db.query(
      `SELECT u.pseudo, u.avatar_idx, u.equipped->>'badge' AS badge,
              EXISTS(SELECT 1 FROM friends f WHERE f.user_id = $2 AND f.friend_id = u.id AND f.status='accepted') AS is_friend,
              EXISTS(SELECT 1 FROM friends f WHERE f.user_id = $2 AND f.friend_id = u.id AND f.status='pending')  AS requested,
              EXISTS(SELECT 1 FROM friends f WHERE f.user_id = u.id AND f.friend_id = $2 AND f.status='pending')  AS incoming
         FROM users u
        WHERE u.pseudo_key LIKE $1 AND u.id <> $2
        ORDER BY (u.pseudo_key = $3) DESC, u.pseudo ASC LIMIT 12`,
      ["%" + q + "%", req.user.id, q]
    );
    res.json({ ok: true, players: rows.map((r) => ({ pseudo: r.pseudo, av: r.avatar_idx || 0, isFriend: r.is_friend, requested: r.requested, incoming: r.incoming, badge: r.badge })) });
  } catch (e) { console.error("[search]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// ===== Parties multi « ouvertes » (en mémoire) : code -> {hostId, hostPseudo, label, rounds, av, ts}
// Sert à notifier les amis qu'une partie ouverte est dispo (cloche).
const openGames = new Map();
function pruneOpenGames() { const now = Date.now(); for (const [c, g] of openGames) if (now - g.ts > 30 * 60 * 1000) openGames.delete(c); }
app.post("/api/games/open", requireAuth, (req, res) => {
  const code = String((req.body && req.body.code) || "").trim().toUpperCase().slice(0, 8);
  if (!/^[A-Z0-9]{3,8}$/.test(code)) return res.status(400).json({ ok: false, error: "code-invalide" });
  openGames.set(code, {
    code, hostId: req.user.id, hostPseudo: req.user.pseudo,
    label: String((req.body && req.body.label) || "").slice(0, 60),
    rounds: Number((req.body && req.body.rounds)) || 5,
    av: (req.user.avatar_idx || 0), ts: Date.now(),
  });
  res.json({ ok: true });
});
app.post("/api/games/close", requireAuth, (req, res) => {
  const code = String((req.body && req.body.code) || "").trim().toUpperCase();
  const g = openGames.get(code);
  if (g && g.hostId === req.user.id) openGames.delete(code);
  res.json({ ok: true });
});
app.get("/api/friends/games", requireAuth, async (req, res) => {
  pruneOpenGames();
  try {
    const fr = await db.query(`SELECT friend_id FROM friends WHERE user_id = $1 AND status='accepted'`, [req.user.id]);
    const ids = new Set(fr.rows.map((r) => r.friend_id));
    const games = [];
    for (const g of openGames.values()) if (ids.has(g.hostId)) games.push({ code: g.code, host: g.hostPseudo, label: g.label, rounds: g.rounds, av: g.av });
    res.json({ ok: true, games });
  } catch (e) { console.error("[fgames]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
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
    const dup = await db.query(`SELECT id, pseudo FROM community_zones WHERE lower(btrim(name)) = lower(btrim($1)) LIMIT 1`, [name]);
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
  // anti-doublon par LIEU : si une zone existe déjà au même endroit (centre géocodé proche),
  // on refuse — même si le nom tapé diffère (fautes, casse, « $ »…). C'est le vrai garde-fou.
  try {
    const near = await db.query(
      `SELECT name, pseudo FROM community_zones
        WHERE abs(center_lat - $1) < 0.025 AND abs(center_lng - $2) < 0.025 LIMIT 1`,
      [meta.centerLat, meta.centerLng]
    );
    if (near.rows.length) return res.status(409).json({ ok: false, error: "Cette zone existe déjà : « " + near.rows[0].name + " » (par " + near.rows[0].pseudo + ")." });
  } catch (e) { /* erreur DB : on laisse l'INSERT trancher */ }
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
    if (e.code === "23505") return res.status(409).json({ ok: false, error: "Cette zone existe déjà." });
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
    const u = await db.query(`SELECT count(*)::int AS users, COALESCE(SUM(coins), 0)::bigint AS coins,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new7,
        count(*) FILTER (WHERE last_seen > now() - interval '24 hours')::int AS active24 FROM users`);
    const s = await db.query(`SELECT count(*)::int AS scores,
        count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS scores24 FROM scores`);
    const z = await db.query(`SELECT count(*)::int AS zones FROM community_zones`);
    const top = await db.query(
      `SELECT u.pseudo, u.coins, COALESCE(MAX(sc.score), 0)::int AS best, COUNT(sc.id)::int AS games
         FROM users u LEFT JOIN scores sc ON lower(sc.pseudo) = lower(u.pseudo)
        GROUP BY u.pseudo, u.coins ORDER BY best DESC, u.coins DESC LIMIT 8`
    );
    res.json({ ok: true, users: u.rows[0].users, totalCoins: Number(u.rows[0].coins),
      scores: s.rows[0].scores, new7: u.rows[0].new7, active24: u.rows[0].active24,
      scores24: s.rows[0].scores24, zones: z.rows[0].zones, top: top.rows });
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

// GET /admin-geo/api/account/:pseudo — fiche détaillée d'un joueur.
app.get("/admin-geo/api/account/:pseudo", checkAdmin, async (req, res) => {
  const key = pseudoKey(req.params.pseudo);
  if (!key) return res.status(400).json({ ok: false, error: "pseudo-requis" });
  try {
    const u = await db.query(`SELECT id, pseudo, coins, owned, equipped, progress, favorites, avatar_idx, created_at, last_seen FROM users WHERE pseudo_key = $1`, [key]);
    if (!u.rows[0]) return res.status(404).json({ ok: false, error: "compte-introuvable" });
    const usr = u.rows[0];
    const st = await db.query(`SELECT count(*)::int AS games, COALESCE(MAX(score), 0)::int AS best FROM scores WHERE lower(pseudo) = lower($1)`, [usr.pseudo]);
    const fr = await db.query(`SELECT count(*)::int AS friends FROM friends WHERE user_id = $1 AND status = 'accepted'`, [usr.id]);
    const zn = await db.query(`SELECT count(*)::int AS zones FROM community_zones WHERE user_id = $1`, [usr.id]);
    const xp = (usr.progress && Number.isInteger(usr.progress.xp)) ? Math.max(0, Math.min(usr.progress.xp, 100000)) : 0;
    res.json({ ok: true, account: {
      pseudo: usr.pseudo, coins: usr.coins, owned: usr.owned || {}, equipped: usr.equipped || {},
      xp, level: Math.min(100, Math.floor(xp / 1000) + 1), claims: (usr.progress && usr.progress.claims) || [],
      favorites: usr.favorites || [], avatar_idx: usr.avatar_idx || 0,
      created_at: usr.created_at, last_seen: usr.last_seen,
      games: st.rows[0].games, best: st.rows[0].best, friends: fr.rows[0].friends, zones: zn.rows[0].zones,
    } });
  } catch (e) { console.error("[admin/account]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// POST /admin-geo/api/pass {pseudo, op, value} — gère l'XP / le palier du passe de combat.
// op : "addxp" (+value XP), "setxp" (XP exact), "setlevel" (palier 1..100), "reset".
app.post("/admin-geo/api/pass", checkAdmin, async (req, res) => {
  const b = req.body || {};
  const key = pseudoKey(b.pseudo);
  const op = String(b.op || "");
  const value = Number(b.value);
  if (!key) return res.status(400).json({ ok: false, error: "pseudo-requis" });
  try {
    const u = await db.query(`SELECT progress FROM users WHERE pseudo_key = $1`, [key]);
    if (!u.rows[0]) return res.status(404).json({ ok: false, error: "compte-introuvable" });
    const prog = (u.rows[0].progress && typeof u.rows[0].progress === "object") ? u.rows[0].progress : { xp: 0, claims: [] };
    let xp = Number.isInteger(prog.xp) ? prog.xp : 0;
    if (op === "addxp") { if (!Number.isFinite(value)) return res.status(400).json({ ok: false, error: "valeur-invalide" }); xp += Math.round(value); }
    else if (op === "setxp") { if (!Number.isFinite(value)) return res.status(400).json({ ok: false, error: "valeur-invalide" }); xp = Math.round(value); }
    else if (op === "setlevel") { if (!Number.isFinite(value)) return res.status(400).json({ ok: false, error: "valeur-invalide" }); xp = (Math.max(1, Math.min(100, Math.round(value))) - 1) * 1000; }
    else if (op === "reset") { xp = 0; }
    else return res.status(400).json({ ok: false, error: "op-invalide" });
    xp = Math.max(0, Math.min(100000, xp));
    const claims = Array.isArray(prog.claims) ? prog.claims : [];
    const newProg = { xp, claims: op === "reset" ? [] : claims };
    await db.query(`UPDATE users SET progress = $1::jsonb WHERE pseudo_key = $2`, [JSON.stringify(newProg), key]);
    res.json({ ok: true, xp, level: Math.min(100, Math.floor(xp / 1000) + 1) });
  } catch (e) { console.error("[admin/pass]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// POST /admin-geo/api/coins {pseudo, op, value} — op "add" (delta) ou "set" (valeur exacte).
app.post("/admin-geo/api/coins", checkAdmin, async (req, res) => {
  const b = req.body || {};
  const key = pseudoKey(b.pseudo);
  const op = String(b.op || "add");
  const value = Number(b.value);
  if (!key) return res.status(400).json({ ok: false, error: "pseudo-requis" });
  if (!Number.isInteger(value)) return res.status(400).json({ ok: false, error: "valeur-invalide" });
  const sql = op === "set"
    ? `UPDATE users SET coins = GREATEST(0, LEAST(100000000, $1)) WHERE pseudo_key = $2 RETURNING pseudo, coins`
    : `UPDATE users SET coins = GREATEST(0, LEAST(100000000, coins + $1)) WHERE pseudo_key = $2 RETURNING pseudo, coins`;
  try {
    const { rows } = await db.query(sql, [value, key]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "compte-introuvable" });
    res.json({ ok: true, pseudo: rows[0].pseudo, coins: rows[0].coins });
  } catch (e) { console.error("[admin/coins]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// POST /admin-geo/api/item {pseudo, op, item} — op "grant" (débloque) ou "revoke" (retire) un cosmétique.
app.post("/admin-geo/api/item", checkAdmin, async (req, res) => {
  const b = req.body || {};
  const key = pseudoKey(b.pseudo);
  const op = String(b.op || "grant");
  const item = String(b.item || "").trim().slice(0, 60);
  if (!key) return res.status(400).json({ ok: false, error: "pseudo-requis" });
  if (!/^[a-zA-Z0-9_-]+$/.test(item)) return res.status(400).json({ ok: false, error: "item-invalide" });
  try {
    const u = await db.query(`SELECT owned FROM users WHERE pseudo_key = $1`, [key]);
    if (!u.rows[0]) return res.status(404).json({ ok: false, error: "compte-introuvable" });
    const owned = (u.rows[0].owned && typeof u.rows[0].owned === "object") ? u.rows[0].owned : {};
    if (op === "revoke") delete owned[item]; else owned[item] = true;
    await db.query(`UPDATE users SET owned = $1::jsonb WHERE pseudo_key = $2`, [JSON.stringify(owned), key]);
    res.json({ ok: true, item, op, count: Object.keys(owned).filter((k) => owned[k]).length });
  } catch (e) { console.error("[admin/item]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// POST /admin-geo/api/credit-all {amount} — crédite (ou débite) TOUS les comptes d'un coup.
app.post("/admin-geo/api/credit-all", checkAdmin, async (req, res) => {
  const amount = Number((req.body || {}).amount);
  if (!Number.isInteger(amount) || amount === 0) return res.status(400).json({ ok: false, error: "montant-invalide" });
  try {
    const { rowCount } = await db.query(`UPDATE users SET coins = GREATEST(0, LEAST(100000000, coins + $1))`, [amount]);
    res.json({ ok: true, updated: rowCount });
  } catch (e) { console.error("[admin/credit-all]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// GET /admin-geo/api/zones?limit= — zones communautaires (modération).
app.get("/admin-geo/api/zones", checkAdmin, async (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 300) limit = 100;
  try {
    const { rows } = await db.query(`SELECT id, pseudo, name, center_lat, center_lng, radius_km, created_at FROM community_zones ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json({ ok: true, zones: rows });
  } catch (e) { console.error("[admin/zones]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
});

// DELETE /admin-geo/api/zones/:id — supprime une zone communautaire.
app.delete("/admin-geo/api/zones/:id", checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "id-invalide" });
  try {
    const { rows } = await db.query(`DELETE FROM community_zones WHERE id = $1 RETURNING id`, [id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "zone-introuvable" });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { console.error("[admin/del-zone]", e.message); res.status(500).json({ ok: false, error: "db-error" }); }
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
  let duration = Number(b.duration);
  if (!Number.isFinite(duration) || duration < 0 || duration > 86400) duration = 0;   // chrono en s (borné 24 h)
  if (!pseudo || !zone) return res.status(400).json({ ok: false, error: "pseudo-et-zone-requis" });
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) return res.status(400).json({ ok: false, error: "rounds-invalide" });
  if (!Number.isInteger(score) || score < 0 || score > 300000) return res.status(400).json({ ok: false, error: "score-invalide" });
  try {
    await db.query(
      `INSERT INTO scores (pseudo, zone, zone_label, rounds, score, duration_s) VALUES ($1, $2, $3, $4, $5, $6)`,
      [pseudo, zone, zoneLabel, rounds, score, Math.round(duration)]
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
      `SELECT t.pseudo, t.zone_label, t.rounds, t.score, t.duration_s, t.created_at,
              u.equipped->>'badge' AS badge
         FROM (
           SELECT DISTINCT ON (pseudo) pseudo, zone_label, rounds, score, duration_s, created_at
             FROM scores
            WHERE ($1 = '' OR zone = $1)
            ORDER BY pseudo, score DESC, created_at ASC
         ) t
         LEFT JOIN users u ON u.pseudo = t.pseudo
        ORDER BY t.score DESC, t.created_at ASC
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
      `SELECT t.pseudo, t.score, t.zone_label, t.rounds, u.equipped->>'badge' AS badge FROM (
         SELECT DISTINCT ON (pseudo) pseudo, score, COALESCE(NULLIF(zone_label, ''), zone) AS zone_label, rounds
           FROM scores
          ORDER BY pseudo, score DESC
       ) t
       LEFT JOIN users u ON u.pseudo = t.pseudo
       ORDER BY t.score DESC
       LIMIT 5`
    );
    const recent = await db.query(
      `SELECT s.pseudo, s.score, COALESCE(NULLIF(s.zone_label, ''), s.zone) AS zone_label, s.rounds, s.created_at,
              u.equipped->>'badge' AS badge
         FROM scores s
         LEFT JOIN users u ON u.pseudo = s.pseudo
        ORDER BY s.created_at DESC
        LIMIT 6`
    );
    res.json({
      ok: true,
      stats: stats.rows[0],
      top: top.rows.map((r) => ({ pseudo: r.pseudo, score: r.score, zoneLabel: r.zone_label, rounds: r.rounds, badge: r.badge })),
      recent: recent.rows.map((r) => ({ pseudo: r.pseudo, score: r.score, zoneLabel: r.zone_label, rounds: r.rounds, ago: frAgo(r.created_at), badge: r.badge })),
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
app.get(["/multi", "/classement", "/boutique", "/communaute", "/profil"], (req, res) => res.sendFile(path.join(DIR, "index.html")));

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
    openGames.delete(room.code);   // l'hôte a quitté → retire l'annonce (sinon notif « fantôme » vers une salle morte)
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

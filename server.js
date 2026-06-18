// Geoloc — serveur Node : sert les fichiers statiques, relaie le multijoueur
// ET expose un classement persistant (PostgreSQL).
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 80;
const DIR = __dirname;

app.use(express.json({ limit: "8kb" }));

app.use((req, res, next) => {
  // pas de cache sur le HTML (les visiteurs ont toujours la dernière version)
  if (req.path === "/" || req.path === "/multi" || req.path === "/classement" || req.path.endsWith(".html")) res.set("Cache-Control", "no-cache");
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
  console.log("[db] table 'scores' prête");
}

function requireDb(res) {
  if (db) return true;
  res.status(503).json({ ok: false, error: "leaderboard-desactive" });
  return false;
}

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
      `SELECT pseudo, zone_label, rounds, score, created_at
         FROM scores
        WHERE ($1 = '' OR zone = $1)
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

// healthcheck : utilisé par Coolify ET Uptime Kuma. Indique aussi l'état de la DB.
app.get("/healthz", (req, res) => res.json({ ok: true, db: !!db }));

app.use(express.static(DIR, { extensions: ["html"] }));
app.get("/", (req, res) => res.sendFile(path.join(DIR, "index.html")));
app.get(["/multi", "/classement"], (req, res) => res.sendFile(path.join(DIR, "index.html")));

const server = app.listen(PORT, () => console.log("[geoloc] HTTP + multi sur :" + PORT));
initDb().catch((e) => console.error("[db] init error:", e.message));

// ---- relay multijoueur WebSocket (/rooms) ----
// Le jeu échange très peu de données. Un relay WebSocket évite que rejoindre une salle dépende
// d'un TURN public ou d'une connexion WebRTC P2P réussie entre deux réseaux différents.
const rooms = new Map();
const wss = new WebSocketServer({ server, path: "/rooms" });

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

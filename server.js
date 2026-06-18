// Geoloc — serveur Node : sert les fichiers statiques ET relaie le multijoueur.
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
const PORT = process.env.PORT || 80;
const DIR = __dirname;

app.use((req, res, next) => {
  // pas de cache sur le HTML (les visiteurs ont toujours la dernière version)
  if (req.path === "/" || req.path.endsWith(".html")) res.set("Cache-Control", "no-cache");
  res.set("Content-Security-Policy", "upgrade-insecure-requests");
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.use(express.static(DIR, { extensions: ["html"] }));
app.get("/", (req, res) => res.sendFile(path.join(DIR, "index.html")));

const server = app.listen(PORT, () => console.log("[geoloc] HTTP + multi sur :" + PORT));

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
      send(ws, { type: "joined", code, hostId: room.hostId, roster: roomRoster(room) });
      send(host, { type: "peer-joined", player: { id, name: ws.playerName, av: ws.playerAv } });

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

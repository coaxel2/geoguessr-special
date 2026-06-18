// Geoloc — serveur Node : sert les fichiers statiques ET héberge le signaling PeerJS.
// On n'utilise plus le serveur public 0.peerjs.com (instable) : le signaling est sur /peerjs.
const path = require("path");
const express = require("express");
const { ExpressPeerServer } = require("peer");

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

const server = app.listen(PORT, () => console.log("[geoloc] HTTP + signaling sur :" + PORT));
server.on("upgrade", () => {});  // laisse passer l'upgrade WebSocket

// ---- serveur de signaling PeerJS auto-hébergé ----
const peerServer = ExpressPeerServer(server, { path: "/", allow_discovery: false, proxied: true });
peerServer.on("connection", (c) => console.log("[peer] + " + c.getId()));
peerServer.on("disconnect", (c) => console.log("[peer] - " + c.getId()));
app.use("/peerjs", peerServer);

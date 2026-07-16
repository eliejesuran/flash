/**
 * Flash — Serveur relais temps réel (light show synchronisé)
 * Stack : Node 20+ · bibliothèque ws
 * Lancer : node server.js
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT                = process.env.PORT || 3001;
const SESSION_TTL_MS       = 6 * 60 * 60 * 1000;  // 6h d'inactivité → expiration
const MAX_SESSIONS         = 100;
const MAX_PEERS            = 50;
const CUE_MIN_INTERVAL_MS  = 25;   // throttle serveur anti-abus (~40Hz max)
const MAX_MSG_SIZE         = 4096; // les messages sont de petits JSON, 4 Ko est déjà large
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

const ALLOWED_ORIGINS = [
  'https://eliejesuran.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'file://',
];
const ALLOW_NULL_ORIGIN = true;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// Beaucoup de téléphones sur le même wifi de salle partagent une seule IP
// publique (NAT) : un simple blip réseau peut faire reconnecter plusieurs
// d'entre eux à quelques secondes d'écart. Un seuil trop bas les bloquerait
// mutuellement pile au moment où ils essaient de se rétablir.
const RATE_LIMIT_MAX       = 60;

// IP réseau local (test depuis un vrai téléphone sur le même wifi que le
// serveur) : accès restreint au LAN de toute façon, pas un élargissement
// notable de la surface d'attaque publique.
const LOCAL_NETWORK_ORIGIN = /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;

// ─── État en mémoire ──────────────────────────────────────────────────────────

const sessions  = new Map();   // sessionId → Session
const connRates = new Map();   // ip → { count, resetAt }

// ─── Rate limiter ─────────────────────────────────────────────────────────────

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = connRates.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    connRates.set(ip, entry);
  }

  entry.count++;

  if (connRates.size > 5000) {
    for (const [k, v] of connRates) {
      if (now > v.resetAt) connRates.delete(k);
    }
  }

  return entry.count <= RATE_LIMIT_MAX;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(session, obj, exclude = null) {
  for (const client of session.clients) {
    if (client !== exclude) send(client, obj);
  }
}

function peersUpdate(session) {
  broadcast(session, { type: 'peers_update', peers: session.clients.size });
}

const BANDS = ['bass', 'mid', 'treble'];

// Répartit les bandes de fréquence entre les torches des clients connectés,
// pour casser l'effet "tout le monde flashe pareil en même temps" (trop
// stroboscope à plusieurs torches synchronisées) : 1 client -> intensité
// générale ; 2 -> aigus / moyenne(médium+graves) ; 3 -> une bande chacun ;
// au-delà, bande aléatoire par client supplémentaire. `session.clients` est
// un Set donc conserve l'ordre d'arrivée ; filtrer le maître donne l'ordre
// des clients. Recalculé à chaque connexion/déconnexion d'un client.
function recomputeRoles(session) {
  const clientList = [...session.clients].filter((ws) => ws !== session.master);
  const n = clientList.length;

  clientList.forEach((ws, i) => {
    let role;
    if (n === 1) role = 'overall';
    else if (n === 2) role = i === 0 ? 'treble' : 'mid_bass';
    else if (i < 3) role = BANDS[i];
    else role = BANDS[Math.floor(Math.random() * 3)];
    send(ws, { type: 'role', role });
  });
}

function touch(session) {
  clearTimeout(session.timer);
  session.expireAt = Date.now() + SESSION_TTL_MS;
  session.timer = setTimeout(() => expireSession(session.id), SESSION_TTL_MS);
}

function expireSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  clearTimeout(session.timer);
  for (const client of session.clients) {
    send(client, { type: 'session_expired', sessionId: id });
    client.close(1001, 'Session expirée');
  }
  sessions.delete(id);
  console.log(`[session] ${id} expirée — ${sessions.size} session(s) active(s)`);
}

function getOrCreateSession(id) {
  if (sessions.has(id)) return sessions.get(id);

  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.expireAt - b.expireAt)[0];
    expireSession(oldest.id);
  }

  const session = { id, master: null, clients: new Set(), expireAt: 0, timer: null, lastCueAt: 0 };
  sessions.set(id, session);
  console.log(`[session] ${id} créée — ${sessions.size} session(s) active(s)`);
  return session;
}

// ─── Serveur WebSocket ────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end();
  }
});
httpServer.listen(PORT);

const wss = new WebSocketServer({
  server: httpServer,
  // Vérification de l'Origin à la négociation WebSocket
  verifyClient: ({ origin, req }, cb) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
             || req.socket.remoteAddress;

    const originOk = !origin
      || (ALLOW_NULL_ORIGIN && origin === 'null')
      || ALLOWED_ORIGINS.some(o => origin.startsWith(o))
      || LOCAL_NETWORK_ORIGIN.test(origin);
    if (!originOk) {
      console.warn(`[blocked] origin="${origin}" ip=${ip}`);
      return cb(false, 403, 'Forbidden');
    }

    if (!checkRateLimit(ip)) {
      console.warn(`[rate-limit] ip=${ip}`);
      return cb(false, 429, 'Too Many Requests');
    }

    cb(true);
  },
});

wss.on('connection', (ws, req) => {
  const match = req.url?.match(/^\/session\/([a-zA-Z0-9-]{4,20})$/);
  if (!match) {
    ws.close(1008, 'URL invalide — utilise /session/{id}');
    return;
  }

  const sessionId = match[1];
  const session   = getOrCreateSession(sessionId);

  if (session.clients.size >= MAX_PEERS) {
    send(ws, { type: 'error', code: 'SESSION_FULL', message: `Session pleine (max ${MAX_PEERS})` });
    ws.close(1008, 'Session pleine');
    return;
  }

  session.clients.add(ws);
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
  touch(session);

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
           || req.socket.remoteAddress;
  console.log(`[connect] session=${sessionId} peers=${session.clients.size} ip=${ip}`);

  // ── Messages entrants ──────────────────────────────────────────────────────

  ws.on('message', (raw) => {
    if (raw.length > MAX_MSG_SIZE) {
      send(ws, { type: 'error', code: 'MSG_TOO_LARGE', message: `Message trop grand (max ${MAX_MSG_SIZE} octets)` });
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch {
      send(ws, { type: 'error', code: 'BAD_JSON' });
      return;
    }

    touch(session);

    switch (msg.type) {
      case 'identify': {
        const role = msg.role === 'master' ? 'master' : 'client';

        if (role === 'master') {
          const masterAlive = session.master && session.master.readyState === WebSocket.OPEN;
          if (masterAlive && session.master !== ws) {
            send(ws, { type: 'error', code: 'MASTER_TAKEN', message: 'Session déjà pilotée par un maître' });
            return;
          }
          session.master = ws;
        }

        send(ws, { type: 'joined', sessionId, role, peers: session.clients.size, hasMaster: !!session.master });
        broadcast(session, { type: 'master_status', hasMaster: !!session.master }, ws);
        peersUpdate(session);
        recomputeRoles(session);
        break;
      }

      case 'cue': {
        if (ws !== session.master) return;
        const now = Date.now();
        if (now - session.lastCueAt < CUE_MIN_INTERVAL_MS) return;
        session.lastCueAt = now;

        const clamp01 = (v) => typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 0;
        const bass = clamp01(msg.bass), mid = clamp01(msg.mid), treble = clamp01(msg.treble);
        broadcast(session, { type: 'cue', bass, mid, treble, ts: now }, ws);
        break;
      }

      case 'track_control': {
        if (ws !== session.master) return;
        const action = ['play', 'pause', 'seek'].includes(msg.action) ? msg.action : null;
        if (!action) return;
        broadcast(session, { type: 'track_control', action, position: msg.position ?? null, ts: Date.now() }, ws);
        break;
      }

      case 'color': {
        if (ws !== session.master) return;
        const color = typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : null;
        if (!color) return;
        broadcast(session, { type: 'color', color }, ws);
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong', ts: Date.now() });
        break;
      }

      default:
        send(ws, { type: 'error', code: 'UNKNOWN_TYPE' });
    }
  });

  // ── Déconnexion ────────────────────────────────────────────────────────────

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[disconnect] session=${sessionId} peers=${session.clients.size}`);

    if (session.master === ws) {
      session.master = null;
      broadcast(session, { type: 'master_status', hasMaster: false });
    }

    if (session.clients.size > 0) {
      peersUpdate(session);
      recomputeRoles(session);
    } else {
      expireSession(sessionId); // session vide → pas besoin d'attendre le TTL
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws error] session=${sessionId}`, err.message);
  });
});

// Détection des connexions zombies (coupure réseau sans close propre) :
// sans ça, un maître qui perd le réseau reste "master" côté serveur indéfiniment,
// et sa reconnexion se fait rejeter en MASTER_TAKEN — plus aucun cue n'est jamais
// émis, tous les clients restent figés sur la dernière couleur reçue.
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._alive === false) {
      ws.terminate(); // pas de pong depuis le tick précédent → on force le close
      continue;
    }
    ws._alive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

wss.on('listening', () => {
  console.log(`Flash server — ws://localhost:${PORT}`);
  console.log(`Origins autorisées : ${ALLOWED_ORIGINS.join(', ')}${ALLOW_NULL_ORIGIN ? ', null (file://)' : ''}`);
  console.log(`Rate limit : ${RATE_LIMIT_MAX} connexions/min/IP`);
  console.log(`Sessions max : ${MAX_SESSIONS} · TTL : ${SESSION_TTL_MS / 3600000}h · Peers/session : ${MAX_PEERS}`);
});

wss.on('error', (err) => {
  console.error('[server error]', err);
  process.exit(1);
});

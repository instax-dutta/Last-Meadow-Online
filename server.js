const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/home/container/game.db';
const BOSS_RESPAWN_DELAY = parseInt(process.env.BOSS_RESPAWN_DELAY, 10) || 3600000;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS boss_fights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    total_damage INTEGER DEFAULT 0,
    participant_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    current_hp INTEGER NOT NULL DEFAULT 1000000
  );

  CREATE TABLE IF NOT EXISTS contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fight_id INTEGER NOT NULL REFERENCES boss_fights(id),
    player_name TEXT NOT NULL,
    damage INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    UNIQUE(fight_id, player_name)
  );

  CREATE TABLE IF NOT EXISTS all_time_leaders (
    player_name TEXT PRIMARY KEY,
    total_damage INTEGER NOT NULL DEFAULT 0,
    total_hits INTEGER NOT NULL DEFAULT 0,
    bosses_killed INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL
  );
`);

const bossMaxHP = 1000000;
let bossHP = bossMaxHP;
let bossPhase = 'shielded';
let bossDefeated = false;
let currentFightId = null;
let participants = new Set();
let finalLeaderboard = null;
let respawnTimer = null;
let countdownInterval = null;

const players = new Map();

const RANGER_MAX_DMG = 100;
const PALADIN_MAX_DMG = 80;
const PRIEST_MAX_DMG = 60;

try {
  const existing = db.prepare('SELECT id, current_hp FROM boss_fights WHERE status = ? LIMIT 1').get('active');
  if (existing) {
    currentFightId = existing.id;
    bossHP = existing.current_hp;
    if (bossHP <= 0) {
      bossDefeated = true;
      bossHP = 0;
    }
    console.log(`[DB] Resumed active fight #${currentFightId} (boss HP: ${bossHP})`);
  }
} catch (err) {
  console.error('[DB] Error checking for active fight:', err.message);
}

if (!currentFightId) {
  try {
    const info = db.prepare('INSERT INTO boss_fights (started_at, current_hp) VALUES (?, ?)').run(Date.now(), bossMaxHP);
    currentFightId = Number(info.lastInsertRowid);
    console.log(`[DB] Created new fight #${currentFightId}`);
  } catch (err) {
    console.error('[DB] Error creating initial fight:', err.message);
  }
}

function sanitizeDisplayName(name) {
  if (typeof name !== 'string') return 'Anonymous';
  return name.replace(/<[^>]*>/g, '').trim().slice(0, 20) || 'Anonymous';
}

function broadcast(msgObj) {
  const payload = JSON.stringify(msgObj);
  for (const client of players.keys()) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch (err) { /* skip */ }
    }
  }
}

function sendTo(ws, msgObj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msgObj));
  } catch (err) { /* skip */ }
}

function startRespawnTimer() {
  if (respawnTimer) clearTimeout(respawnTimer);
  if (countdownInterval) clearInterval(countdownInterval);

  let remaining = Math.ceil(BOSS_RESPAWN_DELAY / 1000);

  broadcast({ type: 'bossRespawning', secondsUntil: remaining });

  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      broadcast({ type: 'bossRespawning', secondsUntil: remaining });
    } else {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }, 60000);

  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    bossHP = bossMaxHP;
    bossDefeated = false;
    bossPhase = 'shielded';
    participants = new Set();
    finalLeaderboard = null;

    try {
      const info = db.prepare('INSERT INTO boss_fights (started_at, current_hp) VALUES (?, ?)').run(Date.now(), bossMaxHP);
      currentFightId = Number(info.lastInsertRowid);
      console.log(`[DB] Created new fight #${currentFightId}`);
    } catch (err) {
      console.error('[DB] Error creating respawn fight:', err.message);
    }

    broadcast({ type: 'bossRespawned', bossHP: bossMaxHP });
    console.log('[Game] Boss has respawned');
  }, BOSS_RESPAWN_DELAY);
}

setInterval(() => {
  if (bossDefeated) return;
  bossPhase = (bossPhase === 'shielded') ? 'vulnerable' : 'shielded';
  broadcast({ type: 'phaseChange', bossPhase });
}, 30000);

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    let urlPath = req.url;
    if (urlPath === '/' || urlPath === '/index.html') {
      urlPath = '/index.html';
    }

    // Whitelist of allowed files to serve statically (prevents path traversal)
    const allowedStaticFiles = [
      '/index.html',
      '/favicon.ico',
      '/favicon-96x96.png',
      '/apple-touch-icon.png',
      '/web-app-manifest-192x192.png',
      '/web-app-manifest-512x512.png',
      '/site.webmanifest'
    ];

    if (allowedStaticFiles.includes(urlPath)) {
      const filePath = path.join(__dirname, urlPath);
      const ext = path.extname(filePath);
      
      let contentType = 'text/plain';
      if (ext === '.html') contentType = 'text/html';
      else if (ext === '.ico') contentType = 'image/x-icon';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.webmanifest') contentType = 'application/manifest+json';
      
      fs.readFile(filePath, (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        }
      });
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let messageCount = 0;
  let windowStart = Date.now();

  const hexChars = '0123456789abcdef';
  let playerId = '';
  for (let i = 0; i < 4; i++) playerId += hexChars[Math.floor(Math.random() * 16)];

  const playerData = {
    id: playerId,
    displayName: null,
    class: null,
    profession: null,
    damageContributed: 0,
    lastBattleAt: null,
    lastCraftAt: null,
    playerInfoLocked: false
  };

  players.set(ws, playerData);

  sendTo(ws, {
    type: 'init',
    playerId,
    bossHP,
    bossPhase,
    playerCount: players.size
  });

  if (bossDefeated) {
    sendTo(ws, {
      type: 'bossDefeated',
      participants: Array.from(participants)
    });
    if (finalLeaderboard) {
      sendTo(ws, { type: 'leaderboard', scope: 'final', data: finalLeaderboard });
    }
  }

  broadcast({ type: 'playerCount', count: players.size });

  ws.on('message', (message) => {
    try {
      const rawMessage = message.toString();
      if (rawMessage.length > 512) return;

      const now = Date.now();
      if (now - windowStart >= 10000) { windowStart = now; messageCount = 0; }
      messageCount++;
      if (messageCount > 30) return;

      let data;
      try { data = JSON.parse(rawMessage); } catch (e) { return; }
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

      const player = players.get(ws);
      if (!player) return;

      switch (data.type) {
        case 'playerInfo': {
          if (player.playerInfoLocked) return;

          const validClasses = ['Ranger', 'Paladin', 'Priest'];
          const validProfessions = ['Fletcher', 'Smithy', 'Scholar'];

          if (!validClasses.includes(data.class) || !validProfessions.includes(data.profession)) return;

          player.displayName = sanitizeDisplayName(data.displayName);
          player.class = data.class;
          player.profession = data.profession;
          player.playerInfoLocked = true;

          broadcast({ type: 'playerCount', count: players.size });
          break;
        }

        case 'craftComplete': {
          player.lastCraftAt = Date.now();
          break;
        }

        case 'damage': {
          if (bossDefeated) return;
          if (typeof data.amount !== 'number') return;

          const amt = data.amount;
          if (amt <= 0 || !Number.isFinite(amt) || Number.isNaN(amt)) return;
          if (!player.class) return;

          let classMax = 0;
          if (player.class === 'Ranger') classMax = RANGER_MAX_DMG;
          else if (player.class === 'Paladin') classMax = PALADIN_MAX_DMG;
          else if (player.class === 'Priest') classMax = PRIEST_MAX_DMG;

          if (amt > classMax) return;
          if (player.lastBattleAt !== null && (now - player.lastBattleAt < 150000)) return;
          if (player.lastCraftAt === null || player.lastCraftAt === undefined) return;
          if (now - player.lastCraftAt > 110000) return;

          const baseDmg = Math.floor(amt);
          if (baseDmg <= 0) return;

          const mult = (bossPhase === 'shielded') ? 0.25 : 1.0;
          const finalDmg = Math.floor(baseDmg * mult);

          player.lastBattleAt = now;
          bossHP -= finalDmg;
          if (bossHP < 0) bossHP = 0;

          player.damageContributed += finalDmg;
          participants.add(player.id);

          try {
            const playerName = player.displayName || player.id;
            db.prepare(
              'INSERT OR IGNORE INTO contributions (fight_id, player_name, damage, hits) VALUES (?, ?, 0, 0)'
            ).run(currentFightId, playerName);
            db.prepare(
              'UPDATE contributions SET damage = damage + ?, hits = hits + 1 WHERE fight_id = ? AND player_name = ?'
            ).run(finalDmg, currentFightId, playerName);
            db.prepare(
              'UPDATE boss_fights SET current_hp = ?, total_damage = total_damage + ? WHERE id = ?'
            ).run(bossHP, finalDmg, currentFightId);
          } catch (err) {
            console.error('[DB] Error persisting damage:', err.message);
          }

          broadcast({
            type: 'bossUpdate',
            bossHP,
            bossMaxHP,
            bossPhase,
            lastHitBy: player.id,
            lastHitAmount: finalDmg
          });

          if (bossHP <= 0 && !bossDefeated) {
            bossDefeated = true;

            try {
              db.prepare(
                `UPDATE boss_fights SET ended_at = ?, status = 'defeated', current_hp = 0,
                 participant_count = (SELECT COUNT(*) FROM contributions WHERE fight_id = ?)
                 WHERE id = ?`
              ).run(Date.now(), currentFightId, currentFightId);

              const contributors = db.prepare(
                'SELECT player_name, damage, hits FROM contributions WHERE fight_id = ?'
              ).all(currentFightId);

              const upsert = db.prepare(
                `INSERT INTO all_time_leaders (player_name, total_damage, total_hits, bosses_killed, last_seen)
                 VALUES (?, ?, ?, 1, ?)
                 ON CONFLICT(player_name) DO UPDATE SET
                   total_damage = total_damage + excluded.total_damage,
                   total_hits = total_hits + excluded.total_hits,
                   bosses_killed = bosses_killed + 1,
                   last_seen = excluded.last_seen`
              );

              const ts = Date.now();
              for (const c of contributors) {
                upsert.run(c.player_name, c.damage, c.hits, ts);
              }
            } catch (err) {
              console.error('[DB] Error persisting boss defeat:', err.message);
            }

            broadcast({
              type: 'bossDefeated',
              participants: Array.from(participants)
            });

            startRespawnTimer();
          }
          break;
        }

        case 'getLeaderboard': {
          try {
            const rows = db.prepare(
              'SELECT player_name, damage, hits FROM contributions WHERE fight_id = ? ORDER BY damage DESC LIMIT 20'
            ).all(currentFightId);
            sendTo(ws, { type: 'leaderboard', scope: 'current', data: rows });
          } catch (err) {
            console.error('[DB] Error reading leaderboard:', err.message);
          }
          break;
        }

        case 'getAllTimeLeaders': {
          try {
            const rows = db.prepare(
              'SELECT player_name, total_damage, total_hits, bosses_killed FROM all_time_leaders ORDER BY total_damage DESC LIMIT 20'
            ).all();
            sendTo(ws, { type: 'leaderboard', scope: 'alltime', data: rows });
          } catch (err) {
            console.error('[DB] Error reading all-time leaders:', err.message);
          }
          break;
        }

        default:
          break;
      }
    } catch (e) {
      // Silently drop
    }
  });

  const cleanup = () => {
    try {
      if (players.has(ws)) {
        players.delete(ws);
        broadcast({ type: 'playerCount', count: players.size });
      }
    } catch (err) { /* skip */ }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`[Last Meadow Online] WebSocket Server running on port ${PORT}`);
  console.log(`[DB] Database path: ${DB_PATH}`);
  console.log(`[DB] Active fight: #${currentFightId}`);
});

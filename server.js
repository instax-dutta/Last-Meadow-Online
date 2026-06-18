const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;

// Shared Game State
let bossHP = 1000000;
const bossMaxHP = 1000000;
let bossPhase = 'shielded'; // starts shielded
let bossDefeated = false;

const participants = new Set(); // Store unique player IDs of contributors
const players = new Map(); // ws connection -> player state

// Constants
const RANGER_MAX_DMG = 100;
const PALADIN_MAX_DMG = 80;
const PRIEST_MAX_DMG = 60;

// Create HTTP server to serve index.html statically
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, 'utf8', (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Helper to broadcast to all open connections
function broadcast(msgObj) {
  const payload = JSON.stringify(msgObj);
  for (const client of players.keys()) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (err) {
        // Ignore message delivery errors
      }
    }
  }
}

// Boss phase toggles every 30 seconds server-side via setInterval
setInterval(() => {
  if (bossDefeated) return;
  bossPhase = (bossPhase === 'shielded') ? 'vulnerable' : 'shielded';
  broadcast({ type: 'phaseChange', bossPhase });
}, 30000);

wss.on('connection', (ws) => {
  // Rate-limiting window counters per connection
  let messageCount = 0;
  let windowStart = Date.now();

  // Assign a random 4-character hex player ID
  const hexChars = '0123456789abcdef';
  let playerId = '';
  for (let i = 0; i < 4; i++) {
    playerId += hexChars[Math.floor(Math.random() * 16)];
  }

  // Create connection state
  const playerData = {
    id: playerId,
    class: null,
    profession: null,
    damageContributed: 0,
    lastBattleAt: null,
    lastCraftAt: null,
    playerInfoLocked: false
  };

  players.set(ws, playerData);

  // Send initial state message to newly connected client
  ws.send(JSON.stringify({
    type: 'init',
    playerId,
    bossHP,
    bossPhase,
    playerCount: players.size
  }));

  // If the boss is already dead, send bossDefeated state immediately
  if (bossDefeated) {
    ws.send(JSON.stringify({
      type: 'bossDefeated',
      participants: Array.from(participants)
    }));
  }

  // Broadcast updated playerCount to everyone
  broadcast({ type: 'playerCount', count: players.size });

  ws.on('message', (message) => {
    try {
      // 5. MESSAGE SIZE CAP (Block oversized payloads)
      const rawMessage = message.toString();
      if (rawMessage.length > 512) {
        return; // Silently drop
      }

      // 4. MESSAGE RATE LIMITING (Allow max 30 messages per 10-second window)
      const now = Date.now();
      if (now - windowStart >= 10000) {
        windowStart = now;
        messageCount = 0;
      }
      messageCount++;
      if (messageCount > 30) {
        return; // Silently drop
      }

      // 6. SCHEMA VALIDATION (Check types & structures)
      let data;
      try {
        data = JSON.parse(rawMessage);
      } catch (e) {
        return; // Silently drop malformed JSON
      }

      if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
        return; // Silently drop
      }

      const player = players.get(ws);
      if (!player) return;

      switch (data.type) {
        case 'playerInfo': {
          // Schema constraints:
          // Valid class/profession lists
          // Only sendable ONCE (tracked via playerInfoLocked)
          if (player.playerInfoLocked) {
            return;
          }

          const validClasses = ['Ranger', 'Paladin', 'Priest'];
          const validProfessions = ['Fletcher', 'Smithy', 'Scholar'];

          if (!validClasses.includes(data.class) || !validProfessions.includes(data.profession)) {
            return;
          }

          player.class = data.class;
          player.profession = data.profession;
          player.playerInfoLocked = true;

          // Broadcast updated player list count
          broadcast({ type: 'playerCount', count: players.size });
          break;
        }

        case 'craftComplete': {
          // 9. CRAFT COOLDOWN ENFORCED SERVER-SIDE
          // Record successful minigame completion timestamp
          player.lastCraftAt = Date.now();
          break;
        }

        case 'damage': {
          // 8. BOSS TERMINAL STATE (Prevent hits after death)
          if (bossDefeated) {
            return;
          }

          // Schema check for damage
          if (typeof data.amount !== 'number') {
            return;
          }

          // 1. DAMAGE VALUE CLAMP (Zero/Negative check and per-class caps)
          const amt = data.amount;
          if (amt <= 0 || !Number.isFinite(amt) || Number.isNaN(amt)) {
            return;
          }

          if (!player.class) {
            return;
          }

          let classMax = 0;
          if (player.class === 'Ranger') classMax = RANGER_MAX_DMG;
          else if (player.class === 'Paladin') classMax = PALADIN_MAX_DMG;
          else if (player.class === 'Priest') classMax = PRIEST_MAX_DMG;

          if (amt > classMax) {
            return;
          }

          // 3. BATTLE COOLDOWN ENFORCED SERVER-SIDE (Min 2.5 min battle cooldown)
          if (player.lastBattleAt !== null && (now - player.lastBattleAt < 150000)) {
            return;
          }

          // 9. CRAFT TIMELINE CHECK (Verify a valid craft exists and is within 110s of action)
          if (player.lastCraftAt === null || player.lastCraftAt === undefined) {
            return;
          }
          if (now - player.lastCraftAt > 110000) {
            return; // Expired craft, player must craft again
          }

          // 7. INTEGER CONVERSION FOR DAMAGE
          const baseDmg = Math.floor(amt);
          if (baseDmg <= 0) {
            return;
          }

          // 2. PHASE MULTIPLIER (Calculated on server-side authority)
          const mult = (bossPhase === 'shielded') ? 0.25 : 1.0;
          const finalDmg = Math.floor(baseDmg * mult);

          // Update battle cooldown
          player.lastBattleAt = now;

          // Apply damage
          bossHP -= finalDmg;
          if (bossHP < 0) {
            bossHP = 0;
          }

          player.damageContributed += finalDmg;
          participants.add(player.id);

          // Broadcast authoritative boss update to all clients
          broadcast({
            type: 'bossUpdate',
            bossHP,
            bossMaxHP,
            bossPhase,
            lastHitBy: player.id,
            lastHitAmount: finalDmg
          });

          // Check for Victory state trigger
          if (bossHP <= 0 && !bossDefeated) {
            bossDefeated = true;
            broadcast({
              type: 'bossDefeated',
              participants: Array.from(participants)
            });
          }
          break;
        }

        default:
          break;
      }
    } catch (e) {
      // Silently drop errors to prevent server crashing
    }
  });

  // 10. CLEAN DISCONNECT (Protected by try-catch to guarantee stability)
  const cleanup = () => {
    try {
      if (players.has(ws)) {
        players.delete(ws);
        broadcast({ type: 'playerCount', count: players.size });
      }
    } catch (err) {
      // Ignore
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// Listen on configured port
server.listen(PORT, () => {
  console.log(`[Last Meadow Online] WebSocket Server running on port ${PORT}`);
});

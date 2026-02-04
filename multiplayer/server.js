const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2]) || 8080;

// ── Serve static files ──
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  filePath = decodeURIComponent(filePath);
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── WebSocket server ──
const wss = new WebSocketServer({ server: httpServer });

// ── Player data persistence ──
const PLAYERS_FILE = path.join(__dirname, 'players.json');

function loadPlayers() {
  try {
    const data = fs.readFileSync(PLAYERS_FILE, 'utf8');
    const arr = JSON.parse(data);
    const map = new Map();
    for (const p of arr) map.set(p.name, p);
    return map;
  } catch { return new Map(); }
}

function savePlayers() {
  const arr = [];
  for (const [, p] of room.players) {
    arr.push({ name: p.name, points: p.points, stats: p.stats, inventory: p.inventory || [] });
  }
  fs.writeFile(PLAYERS_FILE, JSON.stringify(arr, null, 2), () => {});
}

// ── Room state ──
const room = {
  hostId: null,
  config: null,
  clients: new Map(),
  players: loadPlayers(),
  spinState: { spinning: false, wheelId: null, targetAngle: 0, duration: 0, initiator: null, minSpins: 6, visitedChain: [] },
  bets: new Map(), // clientId -> Map<entry, amount>
  bettingOpen: false,
};

// Player colors — assigned on join
const PLAYER_COLORS = ['#E74856','#557FC3','#47B04B','#F5A623','#D64DB0','#43B0A8','#EF6C35','#F9D423','#9B59B6','#1ABC9C'];
let nextColorIndex = 0;
const playerColors = new Map(); // name -> color

let nextClientId = 1;

// ── Helpers ──
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg, excludeId) {
  const data = JSON.stringify(msg);
  for (const [id, c] of room.clients) {
    if (id !== excludeId && c.ws.readyState === 1) c.ws.send(data);
  }
}

function getPlayerList() {
  const list = [];
  for (const [, p] of room.players) {
    list.push({ name: p.name, points: p.points, stats: p.stats, inventory: p.inventory || [], connected: p.connected, isHost: p.clientId === room.hostId, color: playerColors.get(p.name) || '#888' });
  }
  return list;
}

function broadcastPlayerList() {
  broadcast({ type: 'players_sync', payload: { players: getPlayerList() } });
}

function resolveNameCollision(name) {
  // If a player with this name is already connected, append a number
  const existing = room.players.get(name);
  if (existing && existing.connected) {
    let n = 2;
    while (room.players.has(name + n) && room.players.get(name + n).connected) n++;
    return name + n;
  }
  return name;
}

// ── Message handlers ──

function handleJoin(ws, clientId, payload) {
  let name = (payload.name || 'Player').trim().slice(0, 30);
  name = resolveNameCollision(name);

  const isHost = room.clients.size === 0;
  room.clients.set(clientId, { id: clientId, name, ws, isHost });

  if (isHost) room.hostId = clientId;

  // Assign player color if they don't have one
  if (!playerColors.has(name)) {
    playerColors.set(name, PLAYER_COLORS[nextColorIndex % PLAYER_COLORS.length]);
    nextColorIndex++;
  }

  // Restore or create player record
  let player = room.players.get(name);
  if (player) {
    player.connected = true;
    player.clientId = clientId;
    if (!player.inventory) player.inventory = [];
  } else {
    player = { name, points: 1000, stats: { totalSpins: 0, totalWins: 0 }, inventory: [], connected: true, clientId };
    room.players.set(name, player);
  }

  send(ws, {
    type: 'joined',
    payload: {
      clientId,
      name,
      isHost,
      config: room.config,
      players: getPlayerList(),
    },
  });

  broadcastPlayerList();

  // Send current bets to the new player
  if (room.bets.size > 0) {
    // Reuse broadcastAllBets format but send only to this client
    const currentBets = [];
    for (const [cid, betMap] of room.bets) {
      const c = room.clients.get(cid);
      if (!c) continue;
      const color = playerColors.get(c.name) || '#888';
      for (const [betKey, amount] of betMap) {
        let entryIndex = null, entry = betKey;
        if (betKey.startsWith('__idx_')) {
          entryIndex = parseInt(betKey.slice(6));
          if (room.config) {
            const wc2 = room.config.wheels[room.config.activeWheelId || Object.keys(room.config.wheels)[0]];
            if (wc2) {
              const entries2 = (wc2.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
              entry = entries2[entryIndex] || betKey;
            }
          }
        }
        currentBets.push({ playerName: c.name, color, entry, entryIndex, amount });
      }
    }
    send(ws, { type: 'bets_sync', payload: { bets: currentBets } });
  }

  console.log(`[+] ${name} joined${isHost ? ' (host)' : ''} — ${room.clients.size} connected`);
}

function handleConfigUpdate(ws, clientId, payload) {
  if (clientId !== room.hostId) {
    send(ws, { type: 'error', payload: { message: 'Only the host can update config' } });
    return;
  }
  room.config = payload.config;
  broadcast({ type: 'config_synced', payload: { config: room.config } }, clientId);
}

// ── Ready-up / Betting phase ──
let readyState = {
  active: false,
  wheelId: null,
  visitedChain: [],
  readyPlayers: new Set(),
  countdownTimer: null,
  countdownEnd: 0,
  initiator: null,
};

function handleSpinRequest(ws, clientId, payload) {
  if (room.spinState.spinning) {
    if (ws) send(ws, { type: 'spin_rejected', payload: { reason: 'already_spinning' } });
    return;
  }

  const wheelId = payload.wheelId;
  const visitedChain = payload.visitedChain || [];

  // For sub-wheel chains and spin-again, skip ready-up phase
  if (payload.skipReadyUp) {
    executeSpinNow(wheelId, visitedChain, clientId);
    return;
  }

  // If ready-up already active, ignore
  if (readyState.active) {
    if (ws) send(ws, { type: 'spin_rejected', payload: { reason: 'already_in_ready_phase' } });
    return;
  }

  // Start ready-up / betting phase
  readyState = {
    active: true,
    wheelId,
    visitedChain,
    readyPlayers: new Set(),
    countdownTimer: null,
    countdownEnd: 0,
    initiator: clientId,
  };
  room.bettingOpen = true;

  const client = room.clients.get(clientId);
  const initiatorName = client ? client.name : 'Server';

  broadcast({
    type: 'ready_phase',
    payload: { wheelId, initiator: initiatorName },
  });

  console.log(`[ready] ${initiatorName} started ready-up for ${wheelId}`);
}

function handleReady(ws, clientId) {
  if (!readyState.active) return;

  readyState.readyPlayers.add(clientId);
  const client = room.clients.get(clientId);
  const name = client ? client.name : clientId;

  broadcast({
    type: 'player_ready',
    payload: { name, readyCount: readyState.readyPlayers.size, totalPlayers: room.clients.size },
  });

  console.log(`[ready] ${name} is ready (${readyState.readyPlayers.size}/${room.clients.size})`);

  // First player ready: start 30s countdown
  if (readyState.readyPlayers.size === 1 && !readyState.countdownTimer) {
    startCountdown(30);
  }

  // All players ready: drop to 5s (or less if already under 5s)
  if (readyState.readyPlayers.size >= room.clients.size) {
    const remaining = (readyState.countdownEnd - Date.now()) / 1000;
    if (remaining > 5) {
      clearTimeout(readyState.countdownTimer);
      startCountdown(5);
    }
  }
}

function startCountdown(seconds) {
  readyState.countdownEnd = Date.now() + seconds * 1000;
  broadcast({
    type: 'countdown_update',
    payload: { seconds, endsAt: readyState.countdownEnd },
  });

  readyState.countdownTimer = setTimeout(() => {
    // Betting closes, spin starts
    room.bettingOpen = false;
    readyState.active = false;
    executeSpinNow(readyState.wheelId, readyState.visitedChain, readyState.initiator);
  }, seconds * 1000);
}

function handleBet(ws, clientId, payload) {
  // Reject bets while spinning
  if (room.spinState.spinning) {
    send(ws, { type: 'error', payload: { message: 'Cannot bet during spin' } });
    return;
  }

  const client = room.clients.get(clientId);
  if (!client) return;
  const player = room.players.get(client.name);
  if (!player) return;

  const entry = payload.entry;
  const entryIndex = payload.entryIndex != null ? payload.entryIndex : null;
  const betKey = entryIndex != null ? '__idx_' + entryIndex : entry;
  const delta = Math.floor(payload.amount); // can be negative (right-click to remove)
  if (delta === 0) return;

  // Get or create this player's bet map
  if (!room.bets.has(clientId)) room.bets.set(clientId, new Map());
  const playerBets = room.bets.get(clientId);
  const currentBet = playerBets.get(betKey) || 0;
  const newBet = Math.max(0, currentBet + delta);
  const actualDelta = newBet - currentBet; // how much actually changed

  if (actualDelta > 0 && actualDelta > player.points) {
    // Can't afford full increase, bet what they can
    const affordable = Math.max(0, player.points);
    if (affordable <= 0) {
      send(ws, { type: 'error', payload: { message: 'Not enough funds' } });
      return;
    }
    playerBets.set(betKey, currentBet + affordable);
    player.points -= affordable;
  } else if (actualDelta > 0) {
    playerBets.set(betKey, newBet);
    player.points -= actualDelta;
  } else if (actualDelta < 0) {
    // Refunding
    if (newBet === 0) playerBets.delete(betKey);
    else playerBets.set(betKey, newBet);
    player.points -= actualDelta; // actualDelta is negative, so this adds
  }

  // Clean up empty bet maps
  if (playerBets.size === 0) room.bets.delete(clientId);

  // Broadcast all bets so everyone can see
  broadcastAllBets();
  broadcastPlayerList();
  savePlayers();

  const finalBet = playerBets ? (playerBets.get(betKey) || 0) : 0;
  console.log(`[bet] ${client.name} bet on "${entry}" (idx ${entryIndex}): $${finalBet} (delta ${delta > 0 ? '+' : ''}${actualDelta})`);
}

function broadcastAllBets() {
  const allBets = []; // { playerName, color, entry, entryIndex, amount }
  for (const [cid, betMap] of room.bets) {
    const client = room.clients.get(cid);
    if (!client) continue;
    const color = playerColors.get(client.name) || '#888';
    for (const [betKey, amount] of betMap) {
      // Parse index from betKey (__idx_N or entry name)
      let entryIndex = null, entry = betKey;
      if (betKey.startsWith('__idx_')) {
        entryIndex = parseInt(betKey.slice(6));
        // Resolve entry name from config
        if (room.config) {
          const wc = room.config.wheels[room.config.activeWheelId || Object.keys(room.config.wheels)[0]];
          if (wc) {
            const entries = (wc.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
            entry = entries[entryIndex] || betKey;
          }
        }
      }
      allBets.push({ playerName: client.name, color, entry, entryIndex, amount });
    }
  }
  broadcast({ type: 'bets_sync', payload: { bets: allBets } });
}

// Track active boosts so we can revert them after spin
let activeBoosts = []; // { wheelId, weightKey, addedWeight, playerName }

function handleBoost(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;
  const player = room.players.get(client.name);
  if (!player) return;

  const { entry, entryIndex, amount, wheelId } = payload;
  const cost = Math.max(0, Math.min(Math.floor(amount), player.points));
  if (cost <= 0) return;

  player.points -= cost;
  savePlayers();

  // Apply boost: each $1 = 0.1 weight added, using index-based key
  const addedWeight = cost * 0.1;
  const weightKey = entryIndex != null ? '__idx_' + entryIndex : entry;
  if (room.config && room.config.wheels[wheelId]) {
    const wc = room.config.wheels[wheelId];
    if (!wc.entryWeights) wc.entryWeights = {};
    const current = wc.entryWeights[weightKey] || 0;
    wc.entryWeights[weightKey] = current + addedWeight;
    activeBoosts.push({ wheelId, weightKey, addedWeight, playerName: client.name });
  }

  broadcast({
    type: 'boost_applied',
    payload: { name: client.name, entry, entryIndex, cost, addedWeight, weightKey },
  });
  broadcastPlayerList();
  // Sync config so clients see updated weights
  broadcast({ type: 'config_synced', payload: { config: room.config } });

  console.log(`[boost] ${client.name} boosted "${entry}" (idx ${entryIndex}) by +${addedWeight.toFixed(1)} weight for $${cost}`);
}

function revertBoosts() {
  for (const b of activeBoosts) {
    if (room.config && room.config.wheels[b.wheelId]) {
      const wc = room.config.wheels[b.wheelId];
      if (wc.entryWeights && wc.entryWeights[b.weightKey] != null) {
        wc.entryWeights[b.weightKey] -= b.addedWeight;
        if (Math.abs(wc.entryWeights[b.weightKey]) < 0.001) delete wc.entryWeights[b.weightKey];
      }
    }
  }
  if (activeBoosts.length > 0) {
    broadcast({ type: 'config_synced', payload: { config: room.config } });
  }
  activeBoosts = [];
}

function executeSpinNow(wheelId, visitedChain, initiatorId) {
  // Generate deterministic spin parameters
  const buf = crypto.randomBytes(4);
  const seed = buf.readUInt32BE(0) / 0xFFFFFFFF;
  const targetAngle = seed * Math.PI * 2;
  const duration = 9000 + (crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF) * 3000;
  const minSpins = 6 + Math.floor((crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF) * 5);

  room.spinState = {
    spinning: true,
    wheelId,
    targetAngle,
    duration,
    minSpins,
    initiator: initiatorId,
    visitedChain,
  };

  // Track spin stat
  const client = room.clients.get(initiatorId);
  if (client) {
    const player = room.players.get(client.name);
    if (player) {
      player.stats.totalSpins++;
      savePlayers();
    }
  }

  const initiatorName = client ? client.name : 'Server';

  broadcast({
    type: 'spin_start',
    payload: {
      initiator: initiatorName,
      wheelId,
      targetAngle,
      duration,
      minSpins,
      timestamp: Date.now(),
      visitedChain,
    },
  });

  console.log(`[spin] ${initiatorName} spun ${wheelId} — target angle ${(targetAngle * 180 / Math.PI).toFixed(1)}°`);
}

function handleSpinComplete(ws, clientId, payload) {
  if (!room.spinState.spinning) return;

  const { wheelId, winner } = payload;
  room.spinState.spinning = false;

  // Track win stat if winner matches a player name
  const winnerPlayer = room.players.get(winner);
  if (winnerPlayer) {
    winnerPlayer.stats.totalWins++;
  }

  // ── Base income: $15 per spin for all connected players ──
  for (const [, p] of room.players) {
    if (p.connected) p.points += 15;
  }

  // ── Resolve bets ──
  const betResults = [];
  if (room.bets.size > 0) {
    // Calculate odds using BASE weights (weight=1 for all), ignoring boosts
    // This prevents players from boosting an entry and betting on it for free money
    if (room.config) {
      const wc = room.config.wheels[wheelId];
      if (wc) {
        const entries = (wc.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
        const ew = wc.entryWeights || {};

        // Compute actual weights for each entry (matching client getWeight logic)
        const weights = entries.map((name, idx) => {
          const base = ew[name] != null ? ew[name] : 1;
          const idxKey = '__idx_' + idx;
          const idxBoost = ew[idxKey] != null ? ew[idxKey] : 0;
          return base + idxBoost;
        });
        const totalWeight = weights.reduce((a, b) => a + b, 0);

        // Find which index won
        const winnerIndex = entries.indexOf(winner);

        for (const [betClientId, betMap] of room.bets) {
          const client = room.clients.get(betClientId);
          if (!client) continue;
          const player = room.players.get(client.name);
          if (!player) continue;

          for (const [betKey, amount] of betMap) {
            // Resolve the bet's entry index and name
            let betEntryIndex = null, betEntryName = betKey;
            if (betKey.startsWith('__idx_')) {
              betEntryIndex = parseInt(betKey.slice(6));
              betEntryName = entries[betEntryIndex] || betKey;
            }

            // Odds based on actual weight: totalWeight / betEntryWeight
            // If you boosted an entry to 75% of the wheel, payout is ~1.33x, not 30x
            const betIdx = betEntryIndex != null ? betEntryIndex : entries.indexOf(betEntryName);
            const betWeight = betIdx >= 0 && betIdx < weights.length ? weights[betIdx] : 1;
            const odds = Math.max(1, totalWeight / betWeight);

            // Win check: compare by index if available, otherwise by name
            const won = betEntryIndex != null ? betEntryIndex === winnerIndex : betEntryName === winner;

            if (won) {
              const payout = Math.floor(odds * amount);
              player.points += payout;
              betResults.push({ name: client.name, entry: betEntryName, amount, won: true, payout });
              console.log(`[bet] ${client.name} WON $${payout} (bet $${amount} on "${betEntryName}" idx ${betEntryIndex} at ${odds}x)`);
            } else {
              betResults.push({ name: client.name, entry: betEntryName, amount, won: false, payout: 0 });
              console.log(`[bet] ${client.name} LOST $${amount} (bet on "${betEntryName}" idx ${betEntryIndex})`);
            }
          }
        }
      }
    }
    room.bets.clear();
    savePlayers();
  }

  // Check triggers (per-entry override, then defaultTrigger fallback)
  let nextAction = null;
  if (room.config) {
    const wc = room.config.wheels[wheelId];
    if (wc) {
      const perEntry = wc.triggers && wc.triggers[winner];
      const trigger = perEntry === '__none' ? '' : (perEntry || wc.defaultTrigger || '');
      if (trigger === '__add_entry') {
        nextAction = { type: '__add_entry', wheelId };
      } else if (trigger === '__remove_entry') {
        nextAction = { type: '__remove_entry', wheelId };
      } else if (trigger === '__spin_again') {
        nextAction = { type: '__spin_again', wheelId: room.config.activeWheelId };
      } else if (trigger && room.config.wheels[trigger]) {
        const visited = room.spinState.visitedChain || [];
        if (!visited.includes(trigger)) {
          nextAction = { type: 'subwheel', targetWheelId: trigger, visitedChain: [...visited, wheelId] };
        }
      }
    }
  }

  broadcast({
    type: 'spin_finished',
    payload: { wheelId, winner, nextAction, betResults },
  });
  broadcastPlayerList();

  console.log(`[win] ${winner} on ${wheelId}${nextAction ? ` → ${nextAction.type}` : ''}`);

  // Auto-launch sub-wheel spin after delay (skip ready-up for chains)
  // Delay boost revert so the wheel doesn't visually shift while result is shown
  if (nextAction && nextAction.type === 'subwheel') {
    setTimeout(() => {
      revertBoosts();
      handleSpinRequest(null, room.hostId || 'server', {
        wheelId: nextAction.targetWheelId,
        visitedChain: nextAction.visitedChain,
        skipReadyUp: true,
      });
    }, 2000);
  } else if (nextAction && nextAction.type === '__spin_again') {
    setTimeout(() => {
      revertBoosts();
      handleSpinRequest(null, room.hostId || 'server', {
        wheelId: nextAction.wheelId,
        visitedChain: [],
        skipReadyUp: true,
      });
    }, 2000);
  } else {
    // No chain — revert after a short delay so the result stays visually stable
    setTimeout(() => revertBoosts(), 3000);
  }
}

function handlePointsAdjust(ws, clientId, payload) {
  if (clientId !== room.hostId) {
    send(ws, { type: 'error', payload: { message: 'Only the host can adjust points' } });
    return;
  }
  const { name, delta } = payload;
  const player = room.players.get(name);
  if (!player) return;

  player.points += delta;
  savePlayers();

  broadcast({
    type: 'points_update',
    payload: { name, points: player.points, delta, reason: 'host_adjust' },
  });
  broadcastPlayerList();
}

function handleShopPurchase(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;
  const player = room.players.get(client.name);
  if (!player) return;

  if (!room.config || !room.config.shop) {
    send(ws, { type: 'error', payload: { message: 'No shop configured' } });
    return;
  }

  const item = room.config.shop[payload.itemIndex];
  if (!item) {
    send(ws, { type: 'error', payload: { message: 'Invalid shop item' } });
    return;
  }

  if (player.points < item.cost) {
    send(ws, { type: 'error', payload: { message: 'Not enough funds' } });
    return;
  }

  // Deduct cost
  player.points -= item.cost;

  console.log(`[shop] ${client.name} bought "${item.name}" for $${item.cost}`);

  // Always broadcast shop_purchased so clients can play sound + show toast
  broadcast({
    type: 'shop_purchased',
    payload: {
      buyerName: client.name,
      item,
      itemIndex: payload.itemIndex,
    },
  });

  // Inventory items go into player's inventory instead of executing immediately
  if (item.action === 'inventory') {
    const invItem = { id: 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), itemId: item.id, name: item.name, itemType: item.itemType || 'boost' };
    player.inventory.push(invItem);
    savePlayers();
    broadcast({
      type: 'inventory_update',
      payload: { name: client.name, inventory: player.inventory },
    });
    broadcastPlayerList();
    console.log(`[inv] ${client.name} added "${item.name}" to inventory`);
    return;
  }

  savePlayers();
  broadcastPlayerList();
}

function handleUseItem(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;
  const player = room.players.get(client.name);
  if (!player) return;

  const { inventoryId } = payload;
  const idx = player.inventory.findIndex(i => i.id === inventoryId);
  if (idx === -1) {
    send(ws, { type: 'error', payload: { message: 'Item not found in inventory' } });
    return;
  }

  const item = player.inventory[idx];

  if (item.itemType === 'boost') {
    // Must be spinning and not in last 0.5s
    if (!room.spinState.spinning) {
      send(ws, { type: 'error', payload: { message: 'No spin in progress' } });
      return;
    }

    // Consume item
    player.inventory.splice(idx, 1);
    savePlayers();

    // Generate a small random boost (extra rotation)
    const boostAmount = 0.3 + (crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF) * 0.5; // 0.3 to 0.8 radians

    broadcast({
      type: 'item_used',
      payload: {
        name: client.name,
        itemType: item.itemType,
        itemName: item.name,
        boostAmount,
      },
    });

    // Send inventory update
    broadcast({
      type: 'inventory_update',
      payload: { name: client.name, inventory: player.inventory },
    });
    broadcastPlayerList();

    console.log(`[inv] ${client.name} used boost item "${item.name}" (+${boostAmount.toFixed(2)} rad)`);
  } else {
    send(ws, { type: 'error', payload: { message: 'Unknown item type' } });
  }
}

function handleDisconnect(clientId) {
  const client = room.clients.get(clientId);
  if (!client) return;

  const name = client.name;
  room.clients.delete(clientId);

  // Mark player as disconnected but keep data
  const player = room.players.get(name);
  if (player) {
    player.connected = false;
    player.clientId = null;
  }

  console.log(`[-] ${name} disconnected — ${room.clients.size} connected`);

  // Handle host disconnect
  if (clientId === room.hostId) {
    room.hostId = null;
    // Promote first remaining client
    if (room.clients.size > 0) {
      const [newHostId, newHost] = room.clients.entries().next().value;
      room.hostId = newHostId;
      newHost.isHost = true;
      const newHostPlayer = room.players.get(newHost.name);
      if (newHostPlayer) newHostPlayer.clientId = newHostId;
      send(newHost.ws, { type: 'host_promoted', payload: { clientId: newHostId } });
      console.log(`[host] ${newHost.name} promoted to host`);
    }
  }

  broadcastPlayerList();
}

// ── Connection handler ──
wss.on('connection', (ws) => {
  const clientId = 'c' + (nextClientId++);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'join': handleJoin(ws, clientId, msg.payload || {}); break;
      case 'config_update': handleConfigUpdate(ws, clientId, msg.payload || {}); break;
      case 'spin_request': handleSpinRequest(ws, clientId, msg.payload || {}); break;
      case 'spin_complete': handleSpinComplete(ws, clientId, msg.payload || {}); break;
      case 'ready': handleReady(ws, clientId); break;
      case 'bet': handleBet(ws, clientId, msg.payload || {}); break;
      case 'boost': handleBoost(ws, clientId, msg.payload || {}); break;
      case 'points_adjust': handlePointsAdjust(ws, clientId, msg.payload || {}); break;
      case 'shop_purchase': handleShopPurchase(ws, clientId, msg.payload || {}); break;
      case 'use_item': handleUseItem(ws, clientId, msg.payload || {}); break;
      default: console.log(`[?] Unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => handleDisconnect(clientId));
  ws.on('error', () => handleDisconnect(clientId));
});

// ── Start ──
httpServer.listen(PORT, () => {
  console.log(`Wheel Spinner server running on http://localhost:${PORT}`);
  console.log(`Players can connect from other machines using your IP address and port ${PORT}`);
});

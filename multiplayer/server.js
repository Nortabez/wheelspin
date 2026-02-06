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
    arr.push({ name: p.name, points: p.points, stats: p.stats, inventory: p.inventory || [], portfolio: p.portfolio || {}, costBasis: p.costBasis || {} });
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

// ── Hidden Weight Drift ──
const hiddenWeights = {}; // { wheelId: { 0: weight, 1: weight, ... } }
const HW_MIN = 0.5, HW_MAX = 2.0, HW_DRIFT_MAX = 0.15;

function ensureHiddenWeights(wheelId) {
  if (!hiddenWeights[wheelId]) hiddenWeights[wheelId] = {};
  const wc = room.config && room.config.wheels[wheelId];
  if (!wc) return;
  const entries = (wc.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    if (hiddenWeights[wheelId][i] == null) hiddenWeights[wheelId][i] = 1.0;
  }
  for (const key of Object.keys(hiddenWeights[wheelId])) {
    if (parseInt(key) >= entries.length) delete hiddenWeights[wheelId][key];
  }
}

function driftHiddenWeights(wheelId) {
  ensureHiddenWeights(wheelId);
  const hw = hiddenWeights[wheelId];
  for (const idx of Object.keys(hw)) {
    const drift = (Math.random() - 0.5) * 2 * HW_DRIFT_MAX;
    hw[idx] = Math.max(HW_MIN, Math.min(HW_MAX, hw[idx] + drift));
  }
}

// ── Fatigue System ──
const fatigueWeights = {}; // { wheelId: { index: multiplier } }
const FATIGUE_FLOOR = 0.3, FATIGUE_RECOVERY = 0.12;

function applyFatigue(wheelId, winnerIndex) {
  if (!fatigueWeights[wheelId]) fatigueWeights[wheelId] = {};
  fatigueWeights[wheelId][winnerIndex] = FATIGUE_FLOOR;
}

function advanceFatigue(wheelId, excludeIndex) {
  if (!fatigueWeights[wheelId]) return;
  for (const idx of Object.keys(fatigueWeights[wheelId])) {
    if (parseInt(idx) === excludeIndex) continue;
    fatigueWeights[wheelId][idx] = Math.min(1.0, fatigueWeights[wheelId][idx] + FATIGUE_RECOVERY);
    if (fatigueWeights[wheelId][idx] >= 1.0) delete fatigueWeights[wheelId][idx];
  }
}

// ── Private Boosts ──
const playerBoosts = {}; // { clientId: { wheelId: { weightKey: addedWeight } } }

// ── Stock Market ──
const STOCKS_FILE = path.join(__dirname, 'stocks.json');
const STOCK_INITIAL_PRICE = 100;
const STOCK_ALPHA = 0.15;
const TRADE_IMPACT_BASE = 0.02; // Base price impact per share traded (2%)

function loadStocks() {
  try {
    const data = fs.readFileSync(STOCKS_FILE, 'utf8');
    return JSON.parse(data);
  } catch { return {}; }
}

function saveStocks() {
  fs.writeFile(STOCKS_FILE, JSON.stringify(stockPrices, null, 2), () => {});
}

let stockPrices = loadStocks(); // { entryName: { price, prevPrice, history[] } }

// Calculate volatility from price history (0 = stable, 1+ = volatile)
function calculateVolatility(history) {
  if (!history || history.length < 3) return 0.5; // neutral volatility
  const recent = history.slice(-10); // last 10 prices
  if (recent.length < 2) return 0.5;

  // Calculate average price and standard deviation
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / recent.length;
  const stdDev = Math.sqrt(variance);

  // Normalize: coefficient of variation (stdDev / avg)
  const volatility = avg > 0 ? stdDev / avg : 0;
  return Math.min(1, volatility * 5); // scale so 20% stdDev = 1.0 volatility
}

// Calculate momentum from price history (-1 = strong downtrend, +1 = strong uptrend)
function calculateMomentum(history) {
  if (!history || history.length < 3) return 0;
  const recent = history.slice(-8); // last 8 prices
  if (recent.length < 2) return 0;

  // Simple linear regression slope
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < recent.length; i++) {
    sumX += i;
    sumY += recent[i];
    sumXY += i * recent[i];
    sumX2 += i * i;
  }
  const n = recent.length;
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Normalize slope relative to average price
  const avg = sumY / n;
  const normalizedSlope = avg > 0 ? slope / avg : 0;

  // Clamp to [-1, 1]
  return Math.max(-1, Math.min(1, normalizedSlope * 20));
}

// Calculate resistance (high = hard to move price, low = easy to move)
// Based on volatility: stable prices resist change, volatile prices move easily
function calculateResistance(history) {
  const volatility = calculateVolatility(history);
  // Low volatility = high resistance (0.5 to 2.0 range)
  // High volatility = low resistance
  return 0.5 + (1 - volatility) * 1.5;
}

// Calculate support for price movement in a direction
// Returns a multiplier: >1 = momentum supports this direction, <1 = momentum opposes
function calculateSupport(history, direction) {
  const momentum = calculateMomentum(history);
  // direction: 1 = buying (price up), -1 = selling (price down)
  // If momentum matches direction, support is higher
  const alignment = momentum * direction;
  // Range: 0.5 (opposing momentum) to 1.5 (aligned momentum)
  return 1 + alignment * 0.5;
}

// Apply trade impact to stock price
function applyTradeImpact(entryName, shares, isBuy) {
  const stock = stockPrices[entryName];
  if (!stock) return;

  const direction = isBuy ? 1 : -1;
  const resistance = calculateResistance(stock.history);
  const support = calculateSupport(stock.history, direction);

  // Impact = base * shares * support / resistance
  // Buying pushes price up, selling pushes price down
  const rawImpact = TRADE_IMPACT_BASE * Math.sqrt(shares); // sqrt for diminishing returns
  const adjustedImpact = rawImpact * support / resistance;

  const priceChange = stock.price * adjustedImpact * direction;
  stock.prevPrice = stock.price;
  stock.price = Math.max(1, stock.price + priceChange);
  stock.price = Math.round(stock.price * 100) / 100;

  // Add to history
  stock.history.push(stock.price);
  if (stock.history.length > 50) stock.history.shift();

  saveStocks();

  return {
    priceChange,
    resistance,
    support,
    momentum: calculateMomentum(stock.history),
    volatility: calculateVolatility(stock.history)
  };
}

function ensureStocks(wheelId) {
  const activeWheelId = room.config && room.config.activeWheelId;
  if (wheelId !== activeWheelId) return;
  const wc = room.config && room.config.wheels[wheelId];
  if (!wc) return;
  const entries = (wc.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
  const uniqueNames = [...new Set(entries)];
  for (const name of uniqueNames) {
    if (!stockPrices[name]) {
      stockPrices[name] = { price: STOCK_INITIAL_PRICE, prevPrice: STOCK_INITIAL_PRICE, history: [STOCK_INITIAL_PRICE] };
    }
  }
  for (const name of Object.keys(stockPrices)) {
    if (!uniqueNames.includes(name)) {
      for (const [, player] of room.players) {
        if (player.portfolio && player.portfolio[name]) delete player.portfolio[name];
      }
      delete stockPrices[name];
    }
  }
  saveStocks();
}

function computeEffectiveWeights(wheelId, entries) {
  const wc = room.config && room.config.wheels[wheelId];
  if (!wc) return entries.map(() => 1);
  const ew = wc.entryWeights || {};
  ensureHiddenWeights(wheelId);
  return entries.map((name, idx) => {
    const hidden = hiddenWeights[wheelId][idx] || 1.0;
    const base = ew[name] != null ? ew[name] : 1;
    // Sum all player boosts for this entry
    let totalBoost = 0;
    for (const cid of Object.keys(playerBoosts)) {
      const wb = playerBoosts[cid] && playerBoosts[cid][wheelId];
      if (wb) {
        totalBoost += (wb['__idx_' + idx] || 0);
        totalBoost += (wb[name] || 0);
      }
    }
    const fatigue = fatigueWeights[wheelId] ? (fatigueWeights[wheelId][idx] || 1.0) : 1.0;
    return Math.max(0.01, hidden * (base + totalBoost) * fatigue);
  });
}

function updateStockPrices(wheelId, winnerName) {
  const activeWheelId = room.config && room.config.activeWheelId;
  if (wheelId !== activeWheelId) return;
  const wc = room.config && room.config.wheels[wheelId];
  if (!wc) return;
  const entries = (wc.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (entries.length === 0) return;
  const uniqueNames = [...new Set(entries)];
  ensureStocks(wheelId);

  const effectiveWeights = computeEffectiveWeights(wheelId, entries);
  const totalWeight = effectiveWeights.reduce((a, b) => a + b, 0);

  // Simulate 1000 outcomes
  const simCounts = {};
  for (const name of uniqueNames) simCounts[name] = 0;
  for (let s = 0; s < 1000; s++) {
    const r = Math.random();
    let cum = 0;
    for (let i = 0; i < entries.length; i++) {
      cum += effectiveWeights[i] / totalWeight;
      if (r <= cum) { simCounts[entries[i]]++; break; }
    }
  }
  // Actual winner counts 100x
  simCounts[winnerName] = (simCounts[winnerName] || 0) + 100;
  const totalSim = 1100;

  for (const name of uniqueNames) {
    const stock = stockPrices[name];
    if (!stock) continue;
    stock.prevPrice = stock.price;
    // Expected freq = count of this name / total entries (perceived equal chance)
    const nameCount = entries.filter(e => e === name).length;
    const expectedFreq = nameCount / entries.length;
    const observedFreq = simCounts[name] / totalSim;
    const ratio = expectedFreq > 0 ? observedFreq / expectedFreq : 1;
    stock.price = Math.max(1, stock.price * (1 + STOCK_ALPHA * (ratio - 1)));
    stock.price = Math.round(stock.price * 100) / 100;
    stock.history.push(stock.price);
    if (stock.history.length > 50) stock.history.shift();
  }
  saveStocks();
  broadcastStockPrices();
}

function broadcastStockPrices() {
  const prices = {};
  for (const [name, stock] of Object.entries(stockPrices)) {
    const change = stock.prevPrice > 0 ? ((stock.price - stock.prevPrice) / stock.prevPrice * 100) : 0;
    prices[name] = { price: stock.price, prevPrice: stock.prevPrice, change: Math.round(change * 100) / 100, history: stock.history };
  }
  const portfolios = {};
  const costBases = {};
  for (const [, player] of room.players) {
    if (player.portfolio && Object.keys(player.portfolio).length > 0) {
      portfolios[player.name] = { ...player.portfolio };
    }
    if (player.costBasis && Object.keys(player.costBasis).length > 0) {
      costBases[player.name] = { ...player.costBasis };
    }
  }
  broadcast({ type: 'stock_prices', payload: { prices, portfolios, costBases } });
}

// ── Stock Price Evolution (when idle) ──
const EVOLUTION_INTERVAL = 1000; // 1 second
let lastSpinTime = Date.now(); // Track when last real spin happened

// Check if we're in anchor mode (5+ minutes since last activity)
function isAnchorMode() {
  const elapsed = Date.now() - lastSpinTime;
  return elapsed >= 300000; // 5 minutes
}

// Calculate decay multiplier based on time since last spin
function getEvolutionDecay() {
  const elapsed = Date.now() - lastSpinTime;
  const seconds = elapsed / 1000;

  // First 30 seconds: full activity
  if (seconds < 30) return 1.0;

  // 30s to 2min: decay from 1.0 to 0.5
  if (seconds < 120) {
    return 1.0 - (0.5 * (seconds - 30) / 90);
  }

  // 2min to 5min: decay from 0.5 to 0.1
  if (seconds < 300) {
    return 0.5 - (0.4 * (seconds - 120) / 180);
  }

  // After 5min: switch to anchor mode (handled separately)
  return 0;
}

// Anchor mode: small random fluctuations around current price
function anchorPrices() {
  if (Object.keys(stockPrices).length === 0) return;

  let changed = false;
  for (const [name, stock] of Object.entries(stockPrices)) {
    // Small random fluctuation: +/- 0.5% max
    const fluctuation = (Math.random() - 0.5) * 0.01; // -0.5% to +0.5%
    stock.prevPrice = stock.price;
    stock.price = Math.max(1, stock.price * (1 + fluctuation));
    stock.price = Math.round(stock.price * 100) / 100;

    // Add to history but don't let it grow too large
    stock.history.push(stock.price);
    if (stock.history.length > 50) stock.history.shift();
    changed = true;
  }

  if (changed) {
    saveStocks();
    broadcastStockPrices();
  }
}

function evolveStockPrices() {
  // Don't evolve during countdown or spinning
  if (readyState.active || room.spinState.spinning) return;
  if (!room.config || !room.config.activeWheelId) return;

  // After 5 minutes: switch to anchor mode (small random fluctuations)
  if (isAnchorMode()) {
    anchorPrices();
    return;
  }

  const wheelId = room.config.activeWheelId;
  const wc = room.config.wheels[wheelId];
  if (!wc) return;

  const entries = (wc.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (entries.length < 2) return;
  if (Object.keys(stockPrices).length === 0) return;

  // Compute effective weights (hidden * base, but no player boosts since those are temporary)
  ensureHiddenWeights(wheelId);
  const ew = wc.entryWeights || {};
  const weights = entries.map((name, idx) => {
    const hidden = hiddenWeights[wheelId][idx] || 1.0;
    const base = ew[name] != null ? ew[name] : 1;
    const fatigue = fatigueWeights[wheelId] ? (fatigueWeights[wheelId][idx] || 1.0) : 1.0;
    return Math.max(0.01, hidden * base * fatigue);
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Get decay multiplier based on time since last spin
  const decay = getEvolutionDecay();

  // Simulate multiple wheel spins per tick for more dynamic market activity
  // More entries = more simulations to keep activity spread out
  const numSimulations = Math.min(Math.max(3, Math.floor(entries.length / 2)), 8);

  // Accumulate trades per stock to apply in batch
  const trades = {}; // { entryName: { buy: qty, sell: qty } }

  for (let sim = 0; sim < numSimulations; sim++) {
    // Simulate a wheel spin to pick winner
    const rand = Math.random();
    let cumulative = 0;
    let winnerIndex = entries.length - 1;
    for (let i = 0; i < entries.length; i++) {
      cumulative += weights[i] / totalWeight;
      if (rand <= cumulative) { winnerIndex = i; break; }
    }

    // Find opposite entry (halfway around the wheel)
    const oppositeIndex = (winnerIndex + Math.floor(entries.length / 2)) % entries.length;

    const winnerName = entries[winnerIndex];
    const oppositeName = entries[oppositeIndex];

    // Random buy quantity (1-20) for winner - bullish pressure, scaled by decay
    const baseBuyQty = 1 + Math.floor(Math.random() * 20);
    const buyQty = Math.max(1, Math.round(baseBuyQty * decay));
    // Random sell quantity (1-18) for opposite - bearish pressure, scaled by decay
    const baseSellQty = 1 + Math.floor(Math.random() * 18);
    const sellQty = Math.max(1, Math.round(baseSellQty * decay));

    // Accumulate trades
    if (!trades[winnerName]) trades[winnerName] = { buy: 0, sell: 0 };
    trades[winnerName].buy += buyQty;

    if (oppositeName !== winnerName) {
      if (!trades[oppositeName]) trades[oppositeName] = { buy: 0, sell: 0 };
      trades[oppositeName].sell += sellQty;
    }
  }

  // Add simulated trades to market liquidity pool (for order matching)
  // AND apply as trade impact (for price movement)
  let changed = false;
  for (const [name, trade] of Object.entries(trades)) {
    if (!stockPrices[name]) continue;

    const liquidity = getMarketLiquidity(name);

    // Add volume to liquidity pool
    // Simulated "buys" create buy-side liquidity (can fill player sell orders)
    // Simulated "sells" create sell-side liquidity (can fill player buy orders)
    liquidity.buyVolume += trade.buy;
    liquidity.sellVolume += trade.sell;

    // Net the trades for price impact
    const netBuy = trade.buy - trade.sell;
    if (netBuy > 0) {
      applyTradeImpact(name, netBuy, true);
      changed = true;
    } else if (netBuy < 0) {
      applyTradeImpact(name, -netBuy, false);
      changed = true;
    }
  }

  if (changed) {
    broadcastStockPrices();
  }
}

// Start price evolution timer
setInterval(evolveStockPrices, EVOLUTION_INTERVAL);

// ── Market Liquidity (simulated volume available for order filling) ──
// { entryName: { buyVolume: qty, sellVolume: qty } }
// buyVolume = simulated buys that can fill player sell orders
// sellVolume = simulated sells that can fill player buy orders
const marketLiquidity = {};

function getMarketLiquidity(entryName) {
  if (!marketLiquidity[entryName]) {
    marketLiquidity[entryName] = { buyVolume: 0, sellVolume: 0 };
  }
  return marketLiquidity[entryName];
}

// ── Order History & Pending Orders ──
const pendingOrders = new Map(); // orderId -> order object
let nextOrderId = 1;
const orderHistory = []; // Store recent completed orders for all players
const MAX_ORDER_HISTORY = 50;

function addToOrderHistory(order) {
  orderHistory.unshift({
    id: order.id,
    playerName: order.playerName,
    entryName: order.entryName,
    totalShares: order.totalShares,
    filledShares: order.filledShares,
    isBuy: order.isBuy,
    orderType: order.orderType,
    limitPrice: order.limitPrice,
    status: order.status,
    fills: order.fills,
    completedAt: Date.now()
  });
  if (orderHistory.length > MAX_ORDER_HISTORY) {
    orderHistory.pop();
  }
}

function getPlayerOrders(playerName) {
  const pending = [];
  for (const [, order] of pendingOrders) {
    if (order.playerName === playerName && order.status !== 'filled' && order.status !== 'cancelled') {
      pending.push({
        id: order.id,
        entryName: order.entryName,
        totalShares: order.totalShares,
        filledShares: order.filledShares,
        isBuy: order.isBuy,
        orderType: order.orderType,
        limitPrice: order.limitPrice,
        status: order.status,
        createdAt: order.createdAt
      });
    }
  }
  const history = orderHistory.filter(o => o.playerName === playerName).slice(0, 20);
  return { pending, history };
}

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
    if (!player.portfolio) player.portfolio = {};
    if (!player.costBasis) player.costBasis = {}; // { entryName: { totalCost, shares } }
  } else {
    player = { name, points: 1000, stats: { totalSpins: 0, totalWins: 0 }, inventory: [], portfolio: {}, costBasis: {}, connected: true, clientId };
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

  // Send current stock prices
  if (Object.keys(stockPrices).length > 0) broadcastStockPrices();

  console.log(`[+] ${name} joined${isHost ? ' (host)' : ''} — ${room.clients.size} connected`);
}

function handleConfigUpdate(ws, clientId, payload) {
  if (clientId !== room.hostId) {
    send(ws, { type: 'error', payload: { message: 'Only the host can update config' } });
    return;
  }
  room.config = payload.config;
  // Strip entryWeights from config before broadcasting (hidden from non-host)
  const sanitized = JSON.parse(JSON.stringify(room.config));
  for (const wc of Object.values(sanitized.wheels || {})) {
    delete wc.entryWeights;
  }
  broadcast({ type: 'config_synced', payload: { config: sanitized } }, clientId);
  // Reconcile stocks when entries change
  if (room.config.activeWheelId) {
    ensureStocks(room.config.activeWheelId);
    broadcastStockPrices();
  }
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

  // Reset evolution decay - user is actively engaging with wheel
  lastSpinTime = Date.now();

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

  // Apply boost with diminishing returns: sqrt(cost) * multiplier
  // This means $500 adds less impact per dollar than $100
  // Example with 10 entries: $100 → ~12%, $500 → ~15%, $1000 → ~17%
  const addedWeight = Math.sqrt(cost) * 0.08;
  const weightKey = entryIndex != null ? '__idx_' + entryIndex : entry;
  if (!playerBoosts[clientId]) playerBoosts[clientId] = {};
  if (!playerBoosts[clientId][wheelId]) playerBoosts[clientId][wheelId] = {};
  const current = playerBoosts[clientId][wheelId][weightKey] || 0;
  playerBoosts[clientId][wheelId][weightKey] = current + addedWeight;
  activeBoosts.push({ wheelId, weightKey, addedWeight, playerName: client.name, clientId });

  // Send boost details ONLY to the boosting player
  send(ws, {
    type: 'boost_applied',
    payload: { name: client.name, entry, entryIndex, cost, addedWeight, weightKey },
  });
  // Notify others without weight data
  broadcast({
    type: 'boost_notification',
    payload: { name: client.name, entry, cost },
  }, clientId);
  broadcastPlayerList();
  // Do NOT broadcast config_synced — boosts are private

  console.log(`[boost] ${client.name} boosted "${entry}" (idx ${entryIndex}) by +${addedWeight.toFixed(1)} weight for $${cost}`);
}

function revertBoosts() {
  // Clear boosts from playerBoosts and notify each booster individually
  for (const b of activeBoosts) {
    if (playerBoosts[b.clientId] && playerBoosts[b.clientId][b.wheelId]) {
      const wb = playerBoosts[b.clientId][b.wheelId];
      if (wb[b.weightKey] != null) {
        wb[b.weightKey] -= b.addedWeight;
        if (Math.abs(wb[b.weightKey]) < 0.001) delete wb[b.weightKey];
      }
      if (Object.keys(wb).length === 0) delete playerBoosts[b.clientId][b.wheelId];
      if (Object.keys(playerBoosts[b.clientId]).length === 0) delete playerBoosts[b.clientId];
    }
    const client = room.clients.get(b.clientId);
    if (client && client.ws.readyState === 1) {
      send(client.ws, { type: 'boost_reverted', payload: { wheelId: b.wheelId, weightKey: b.weightKey, amount: b.addedWeight } });
    }
  }
  activeBoosts = [];
}

function executeSpinNow(wheelId, visitedChain, initiatorId) {
  const wc = room.config && room.config.wheels[wheelId];
  if (!wc) return;
  const entries = (wc.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (entries.length < 2) return;

  // Drift hidden weights before each spin
  driftHiddenWeights(wheelId);

  // Compute effective weights (hidden * base * boosts * fatigue)
  const effectiveWeights = computeEffectiveWeights(wheelId, entries);
  const totalWeight = effectiveWeights.reduce((a, b) => a + b, 0);

  // Server-side weighted random selection to pick winner
  const rand = crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF;
  let cumulative = 0;
  let winnerIndex = entries.length - 1;
  for (let i = 0; i < entries.length; i++) {
    cumulative += effectiveWeights[i] / totalWeight;
    if (rand <= cumulative) { winnerIndex = i; break; }
  }

  // Compute targetAngle per-client based on their local boost weights
  // Each client may have different segment sizes due to private boosts
  const duration = 9000 + (crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF) * 3000;
  const minSpins = 6 + Math.floor((crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF) * 5);
  const innerRand = crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF; // same for all clients

  room.spinState = {
    spinning: true,
    wheelId,
    duration,
    minSpins,
    initiator: initiatorId,
    visitedChain,
    predeterminedWinner: entries[winnerIndex],
    predeterminedWinnerIndex: winnerIndex,
    innerRand, // store for per-client angle calculation
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

  // Send personalized spin_start to each client with their own targetAngle
  for (const [clientId, c] of room.clients) {
    // Compute this client's local segment sizes (base weights + their private boosts)
    const ew = wc.entryWeights || {};
    const clientBoosts = playerBoosts[clientId] && playerBoosts[clientId][wheelId] || {};

    const localWeights = entries.map((name, idx) => {
      const base = ew[name] != null ? ew[name] : 1;
      const idxBoost = clientBoosts['__idx_' + idx] || 0;
      const nameBoost = clientBoosts[name] || 0;
      return Math.max(0.01, base + idxBoost + nameBoost);
    });
    const localTotal = localWeights.reduce((a, b) => a + b, 0);

    // Compute segment start and arc for the winner in this client's view
    let segStart = 0;
    for (let i = 0; i < winnerIndex; i++) {
      segStart += (localWeights[i] / localTotal) * Math.PI * 2;
    }
    const segArc = (localWeights[winnerIndex] / localTotal) * Math.PI * 2;
    const padding = segArc * 0.1;
    const targetAngle = segStart + padding + innerRand * (segArc - 2 * padding);

    send(c.ws, {
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
  }

  console.log(`[spin] ${initiatorName} spun ${wheelId} — winner: ${entries[winnerIndex]} (idx ${winnerIndex})`);
}

function handleSpinComplete(ws, clientId, payload) {
  if (!room.spinState.spinning) return;

  const wheelId = room.spinState.wheelId;
  // Use server-determined winner, NOT client-reported winner
  const winner = room.spinState.predeterminedWinner;
  const winnerIndex = room.spinState.predeterminedWinnerIndex;
  room.spinState.spinning = false;

  // Reset evolution decay - real spin just happened
  lastSpinTime = Date.now();

  // Apply fatigue: winner gets cooldown, others recover
  if (winnerIndex != null) {
    applyFatigue(wheelId, winnerIndex);
    advanceFatigue(wheelId, winnerIndex);
  }

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
    // Odds based on equal visual weights (players see equal segments)
    if (room.config) {
      const wc = room.config.wheels[wheelId];
      if (wc) {
        const entries = (wc.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
        // Equal weights: each entry has weight 1, odds = numEntries
        const odds = entries.length;

        for (const [betClientId, betMap] of room.bets) {
          const client = room.clients.get(betClientId);
          if (!client) continue;
          const player = room.players.get(client.name);
          if (!player) continue;

          for (const [betKey, amount] of betMap) {
            let betEntryIndex = null, betEntryName = betKey;
            if (betKey.startsWith('__idx_')) {
              betEntryIndex = parseInt(betKey.slice(6));
              betEntryName = entries[betEntryIndex] || betKey;
            }

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

  // Update stock market
  updateStockPrices(wheelId, winner);
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

// ── Order Queue System ──
function createOrder(playerName, entryName, shares, isBuy, orderType, limitPrice = null) {
  const orderId = 'ord_' + (nextOrderId++);
  const order = {
    id: orderId,
    playerName,
    entryName,
    totalShares: shares,
    filledShares: 0,
    isBuy,
    orderType, // 'market' or 'limit'
    limitPrice,
    createdAt: Date.now(),
    status: 'pending', // 'pending', 'partial', 'filled', 'cancelled'
    fills: [] // { shares, price, timestamp }
  };
  pendingOrders.set(orderId, order);
  return order;
}

function processOrders() {
  let anyProcessed = false;

  for (const [orderId, order] of pendingOrders) {
    if (order.status === 'filled' || order.status === 'cancelled') continue;

    const stock = stockPrices[order.entryName];
    if (!stock) continue;

    const player = room.players.get(order.playerName);
    if (!player) continue;
    if (!player.portfolio) player.portfolio = {};

    // Check if limit order should execute
    if (order.orderType === 'limit') {
      if (order.isBuy && stock.price > order.limitPrice) continue; // Price too high to buy
      if (!order.isBuy && stock.price < order.limitPrice) continue; // Price too low to sell
    }

    // Check market liquidity - orders need counterparty volume to fill
    const liquidity = getMarketLiquidity(order.entryName);

    if (order.isBuy) {
      // Buy orders need sell-side liquidity (simulated sells to buy from)
      if (liquidity.sellVolume <= 0) continue; // No sellers available

      // Determine how many shares to fill (limited by liquidity and gradual filling)
      const remainingShares = order.totalShares - order.filledShares;
      const wantedFill = Math.min(remainingShares, Math.max(1, Math.ceil(remainingShares * 0.3)));
      const fillAmount = Math.min(wantedFill, Math.floor(liquidity.sellVolume));

      if (fillAmount <= 0) continue;

      // Check funds
      const costPerShare = stock.price;
      const totalCost = Math.ceil(costPerShare * fillAmount);
      if (player.points < totalCost) {
        // Not enough funds - cancel order
        order.status = 'cancelled';
        notifyOrderUpdate(order, 'Insufficient funds');
        anyProcessed = true;
        continue;
      }

      // Consume liquidity
      liquidity.sellVolume -= fillAmount;

      // Execute partial fill
      player.points -= totalCost;
      player.portfolio[order.entryName] = (player.portfolio[order.entryName] || 0) + fillAmount;
      order.filledShares += fillAmount;
      order.fills.push({ shares: fillAmount, price: costPerShare, timestamp: Date.now() });

      // Update cost basis
      if (!player.costBasis) player.costBasis = {};
      if (!player.costBasis[order.entryName]) {
        player.costBasis[order.entryName] = { totalCost: 0, shares: 0 };
      }
      player.costBasis[order.entryName].totalCost += totalCost;
      player.costBasis[order.entryName].shares += fillAmount;

      // Apply price impact
      const impact = applyTradeImpact(order.entryName, fillAmount, true);

      console.log(`[order] ${order.playerName} buy fill: ${fillAmount}x ${order.entryName} @ $${costPerShare.toFixed(2)} (liq: ${liquidity.sellVolume.toFixed(0)} left)`);
      anyProcessed = true;
    } else {
      // Sell orders need buy-side liquidity (simulated buys to sell into)
      if (liquidity.buyVolume <= 0) continue; // No buyers available

      // Determine how many shares to fill (limited by liquidity and gradual filling)
      const remainingShares = order.totalShares - order.filledShares;
      const wantedFill = Math.min(remainingShares, Math.max(1, Math.ceil(remainingShares * 0.3)));
      const currentShares = player.portfolio[order.entryName] || 0;

      if (currentShares <= 0) {
        order.status = 'cancelled';
        notifyOrderUpdate(order, 'Insufficient shares');
        anyProcessed = true;
        continue;
      }

      const fillAmount = Math.min(wantedFill, Math.floor(liquidity.buyVolume), currentShares);

      if (fillAmount <= 0) continue;

      // Consume liquidity
      liquidity.buyVolume -= fillAmount;

      // Execute partial fill
      const pricePerShare = stock.price;
      const totalRevenue = Math.floor(pricePerShare * fillAmount);

      player.points += totalRevenue;
      player.portfolio[order.entryName] -= fillAmount;

      // Update cost basis (reduce proportionally when selling)
      if (player.costBasis && player.costBasis[order.entryName]) {
        const cb = player.costBasis[order.entryName];
        if (cb.shares > 0) {
          const avgCost = cb.totalCost / cb.shares;
          cb.totalCost -= avgCost * fillAmount;
          cb.shares -= fillAmount;
          if (cb.shares <= 0) {
            delete player.costBasis[order.entryName];
          }
        }
      }

      if (player.portfolio[order.entryName] <= 0) delete player.portfolio[order.entryName];
      order.filledShares += fillAmount;
      order.fills.push({ shares: fillAmount, price: pricePerShare, timestamp: Date.now() });

      // Apply price impact
      const impact = applyTradeImpact(order.entryName, fillAmount, false);

      console.log(`[order] ${order.playerName} sell fill: ${fillAmount}x ${order.entryName} @ $${pricePerShare.toFixed(2)} (liq: ${liquidity.buyVolume.toFixed(0)} left)`);
      anyProcessed = true;
    }

    // Update order status
    if (order.filledShares >= order.totalShares) {
      order.status = 'filled';
      notifyOrderUpdate(order, 'Order filled');
    } else {
      order.status = 'partial';
      notifyOrderUpdate(order, 'Partial fill');
    }

    savePlayers();
  }

  // Clean up old filled/cancelled orders (keep for 30 seconds for UI)
  const now = Date.now();
  for (const [orderId, order] of pendingOrders) {
    if ((order.status === 'filled' || order.status === 'cancelled') && now - order.createdAt > 30000) {
      pendingOrders.delete(orderId);
    }
  }

  // Decay unused liquidity (50% decay per tick to prevent infinite buildup)
  for (const [name, liq] of Object.entries(marketLiquidity)) {
    liq.buyVolume *= 0.5;
    liq.sellVolume *= 0.5;
    // Clean up tiny amounts
    if (liq.buyVolume < 0.1) liq.buyVolume = 0;
    if (liq.sellVolume < 0.1) liq.sellVolume = 0;
  }

  // Only broadcast if something actually changed
  if (anyProcessed) {
    broadcastPlayerList();
    broadcastStockPrices();
  }
}

function notifyOrderUpdate(order, message) {
  // Add to history if completed
  if (order.status === 'filled' || order.status === 'cancelled') {
    addToOrderHistory(order);
  }

  // Find client for this player
  for (const [clientId, client] of room.clients) {
    if (client.name === order.playerName) {
      const player = room.players.get(client.name);
      const orders = getPlayerOrders(order.playerName);
      send(client.ws, {
        type: 'order_update',
        payload: {
          orderId: order.id,
          entryName: order.entryName,
          isBuy: order.isBuy,
          orderType: order.orderType,
          totalShares: order.totalShares,
          filledShares: order.filledShares,
          status: order.status,
          message,
          lastFill: order.fills.length > 0 ? order.fills[order.fills.length - 1] : null,
          newBalance: player ? player.points : 0,
          newShares: player && player.portfolio ? (player.portfolio[order.entryName] || 0) : 0,
          pendingOrders: orders.pending,
          orderHistory: orders.history
        }
      });
      break;
    }
  }
}

function handleCancelOrder(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;

  const { orderId } = payload;
  const order = pendingOrders.get(orderId);

  if (!order) {
    send(ws, { type: 'cancel_order_result', payload: { success: false, message: 'Order not found' } });
    return;
  }

  if (order.playerName !== client.name) {
    send(ws, { type: 'cancel_order_result', payload: { success: false, message: 'Not your order' } });
    return;
  }

  if (order.status === 'filled' || order.status === 'cancelled') {
    send(ws, { type: 'cancel_order_result', payload: { success: false, message: 'Order already completed' } });
    return;
  }

  order.status = 'cancelled';
  notifyOrderUpdate(order, 'Order cancelled by user');
  send(ws, { type: 'cancel_order_result', payload: { success: true, orderId } });
  console.log(`[order] ${client.name} cancelled order ${orderId}`);
}

function handleGetOrders(ws, clientId) {
  const client = room.clients.get(clientId);
  if (!client) return;

  const orders = getPlayerOrders(client.name);
  send(ws, { type: 'orders_data', payload: orders });
}

// Process orders every 500ms
setInterval(processOrders, 500);

function handleBuyStock(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;
  const player = room.players.get(client.name);
  if (!player) return;
  if (!player.portfolio) player.portfolio = {};

  const { entryName, shares, orderType = 'market', limitPrice } = payload;
  if (!shares || shares <= 0 || !Number.isInteger(shares)) {
    send(ws, { type: 'stock_trade_result', payload: { success: false, message: 'Invalid share count' } });
    return;
  }
  const stock = stockPrices[entryName];
  if (!stock) {
    send(ws, { type: 'stock_trade_result', payload: { success: false, message: 'Stock not found' } });
    return;
  }

  // Validate limit price for limit orders
  if (orderType === 'limit' && (!limitPrice || limitPrice <= 0)) {
    send(ws, { type: 'stock_trade_result', payload: { success: false, message: 'Limit price required for limit orders' } });
    return;
  }

  // Check if player has enough funds for at least the first share
  const estimatedCost = Math.ceil(stock.price * shares);
  if (player.points < Math.ceil(stock.price)) {
    send(ws, { type: 'stock_trade_result', payload: { success: false, message: 'Not enough funds' } });
    return;
  }

  // Create order
  const order = createOrder(client.name, entryName, shares, true, orderType, limitPrice);

  // Get updated pending orders to send back immediately
  const orders = getPlayerOrders(client.name);

  send(ws, {
    type: 'stock_trade_result',
    payload: {
      success: true,
      action: 'buy_order',
      orderId: order.id,
      entryName,
      shares,
      orderType,
      limitPrice,
      estimatedCost,
      message: orderType === 'limit'
        ? `Limit buy order placed for ${shares} shares at $${limitPrice.toFixed(2)}`
        : `Market buy order placed for ${shares} shares`,
      pendingOrders: orders.pending,
      orderHistory: orders.history
    }
  });

  console.log(`[stock] ${client.name} placed ${orderType} buy order: ${shares}x "${entryName}"${orderType === 'limit' ? ` @ $${limitPrice}` : ''}`);
}

function handleSellStock(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;
  const player = room.players.get(client.name);
  if (!player) return;
  if (!player.portfolio) player.portfolio = {};

  const { entryName, shares, orderType = 'market', limitPrice } = payload;
  if (!shares || shares <= 0 || !Number.isInteger(shares)) {
    send(ws, { type: 'stock_trade_result', payload: { success: false, message: 'Invalid share count' } });
    return;
  }
  const currentShares = player.portfolio[entryName] || 0;
  if (currentShares < shares) {
    send(ws, { type: 'stock_trade_result', payload: { success: false, message: 'Not enough shares' } });
    return;
  }
  const stock = stockPrices[entryName];
  if (!stock) {
    send(ws, { type: 'stock_trade_result', payload: { success: false, message: 'Stock not found' } });
    return;
  }

  // Validate limit price for limit orders
  if (orderType === 'limit' && (!limitPrice || limitPrice <= 0)) {
    send(ws, { type: 'stock_trade_result', payload: { success: false, message: 'Limit price required for limit orders' } });
    return;
  }

  // Create order
  const order = createOrder(client.name, entryName, shares, false, orderType, limitPrice);
  const estimatedRevenue = Math.floor(stock.price * shares);

  // Get updated pending orders to send back immediately
  const orders = getPlayerOrders(client.name);

  send(ws, {
    type: 'stock_trade_result',
    payload: {
      success: true,
      action: 'sell_order',
      orderId: order.id,
      entryName,
      shares,
      orderType,
      limitPrice,
      estimatedRevenue,
      message: orderType === 'limit'
        ? `Limit sell order placed for ${shares} shares at $${limitPrice.toFixed(2)}`
        : `Market sell order placed for ${shares} shares`,
      pendingOrders: orders.pending,
      orderHistory: orders.history
    }
  });

  console.log(`[stock] ${client.name} placed ${orderType} sell order: ${shares}x "${entryName}"${orderType === 'limit' ? ` @ $${limitPrice}` : ''}`);
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
      case 'buy_stock': handleBuyStock(ws, clientId, msg.payload || {}); break;
      case 'sell_stock': handleSellStock(ws, clientId, msg.payload || {}); break;
      case 'cancel_order': handleCancelOrder(ws, clientId, msg.payload || {}); break;
      case 'get_orders': handleGetOrders(ws, clientId); break;
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

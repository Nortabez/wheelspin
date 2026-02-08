const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2]) || 8080;

// ── Word Dictionary for Wordle Robbery ──
const WORD_LIST = JSON.parse(fs.readFileSync(path.join(__dirname, 'words.json'), 'utf8'));
const WORD_SET = new Set(WORD_LIST);
const WORDS_BY_LENGTH = {};
for (const w of WORD_LIST) {
  if (!WORDS_BY_LENGTH[w.length]) WORDS_BY_LENGTH[w.length] = [];
  WORDS_BY_LENGTH[w.length].push(w);
}

// ── Serve static files ──
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

const httpServer = http.createServer((req, res) => {
  // API: list existing player names
  if (req.url === '/api/players') {
    const players = loadPlayers();
    const names = [...players.keys()];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(names));
    return;
  }

  if (req.url === '/api/words') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(WORD_LIST));
    return;
  }

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

// ── Config persistence ──
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch { return null; }
}

function saveConfig() {
  if (room.config) {
    fs.writeFile(CONFIG_FILE, JSON.stringify(room.config, null, 2), () => {});
  }
}

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
    arr.push({ name: p.name, points: p.points, stats: p.stats, inventory: p.inventory || [], portfolio: p.portfolio || {}, costBasis: p.costBasis || {}, upgrades: p.upgrades || {} });
  }
  fs.writeFile(PLAYERS_FILE, JSON.stringify(arr, null, 2), () => {});
}

// ── Room state ──
const room = {
  hostId: null,
  config: loadConfig(),
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

// ── Upgrade Definitions ──
const UPGRADE_DEFS = {
  bodyguards: {
    name: 'Bodyguards',
    description: 'Hire protection against robbery attempts',
    baseCost: 500,
    costFormula: (level) => 500 * Math.pow(2, level),
    maxLevel: Infinity,
  },
  criminal_org: {
    name: 'Criminal Organization',
    description: 'Build a network of thieves to rob other players',
    baseCost: 500,
    costFormula: (level) => 500 * Math.pow(2, level),
    maxLevel: Infinity,
  },
};

// ── Robbery System ──
const robberyCooldowns = new Map(); // playerName -> spinsRemaining
const ROBBERY_COOLDOWN_SPINS = 5;
const ROBBERY_MAX_PERCENT = 0.20; // max 20% of total assets
const ROBBERY_MAX_FLAT = 500; // max flat $500

function serializeUpgradeDefs() {
  const defs = {};
  for (const [id, def] of Object.entries(UPGRADE_DEFS)) {
    defs[id] = { name: def.name, description: def.description, baseCost: def.baseCost,
                 maxLevel: def.maxLevel === Infinity ? -1 : def.maxLevel };
  }
  return defs;
}

// ── Stock Market ──
const STOCKS_FILE = path.join(__dirname, 'stocks.json');
const STOCK_INITIAL_PRICE = 100;
const GRAVITY_K = 0.025;            // Pull share price toward real value per tick
const MOMENTUM_EFFECT = 0.5;        // How much momentum moves price per tick
const MOMENTUM_DECAY = 0.95;        // Momentum fades 5% per tick
const PLAYER_TRADE_MOMENTUM = 0.3;  // Momentum per sqrt(shares) from player trades
const SPIN_WIN_MOMENTUM = 2.0;      // Momentum bump for spin winner
const DEVELOPMENT_PER_WIN = 0.05;   // +0.05 development per win
const EVENT_MOMENTUM = 0.5;         // Momentum per tick from events per unit strength
const EVENT_DEVELOPMENT = 0.0005;   // Development change per tick from events (accumulates into real value)
const MOMENTUM_DISTANCE_SCALE = 5;  // How quickly momentum dampens with distance from real value
const BASE_LIQUIDITY = 4;           // Baseline shares available per tick per stock
const ADDITIVE_DECAY = 0.7;         // Boost additives decay multiplier per spin
const NOISE_AMPLITUDE = 0.003;      // Background price noise amplitude
const GRAVITY_DEAD_ZONE = 0.10;     // No gravity pull within ±10% of real value

// Analyst predictions: playerName -> Map(stockName -> { spinsLeft, errorMultiplier })
const analystPredictions = new Map();

function loadStocks() {
  try {
    const data = fs.readFileSync(STOCKS_FILE, 'utf8');
    return JSON.parse(data);
  } catch { return {}; }
}

function saveStocks() {
  fs.writeFile(STOCKS_FILE, JSON.stringify(stockPrices, null, 2), () => {});
}

let stockPrices = loadStocks(); // { entryName: { price, realValue, development, momentum, prevPrice, history[] } }

// Migrate old stock format — backfill new fields
for (const [name, stock] of Object.entries(stockPrices)) {
  if (stock.realValue == null) stock.realValue = stock.price;
  if (stock.development == null) stock.development = 1.0;
  if (stock.momentum == null) stock.momentum = 0;
}

// ── Market Events ──
const BULLISH_HEADLINES = [
  '{STOCK} ANNOUNCES REVOLUTIONARY NEW PRODUCT',
  '{STOCK} CEO BUYS 1 MILLION SHARES',
  '{STOCK} BEATS EARNINGS BY 400%',
  '{STOCK} SIGNS MASSIVE GOVERNMENT CONTRACT',
  '{STOCK} GOES VIRAL ON SOCIAL MEDIA',
  '{STOCK} ACQUIRES MAJOR COMPETITOR',
  '{STOCK} RECEIVES ANALYST UPGRADE TO "STRONG BUY"',
  '{STOCK} DISCOVERS CURE FOR MONDAY MORNINGS',
  '{STOCK} REPORTS RECORD QUARTERLY PROFITS',
  '{STOCK} GETS CELEBRITY ENDORSEMENT DEAL',
  '{STOCK} LAUNCHES SUCCESSFUL IPO OF SUBSIDIARY',
  '{STOCK} WINS PRESTIGIOUS INDUSTRY AWARD',
  '{STOCK} EXPANDS INTO 47 NEW MARKETS',
  '{STOCK} INSIDER BUYING FRENZY DETECTED',
  '{STOCK} PARTNERSHIP WITH MAJOR TECH GIANT ANNOUNCED',
  'BREAKING: {STOCK} STOCK ADDED TO S&P 500',
  '{STOCK} NEW FACTORY OPENS AHEAD OF SCHEDULE',
  'ANALYSTS: {STOCK} IS THE NEXT BIG THING',
  '{STOCK} CUSTOMER SATISFACTION HITS ALL-TIME HIGH',
  '{STOCK} PATENTS GROUNDBREAKING TECHNOLOGY',
];

const BEARISH_HEADLINES = [
  '{STOCK} EXECUTIVES CAUGHT IN PONZI SCHEME',
  '{STOCK} ENTIRE BOARD RESIGNS MYSTERIOUSLY',
  '{STOCK} PRODUCT RECALLED AFTER EXPLODING',
  '{STOCK} RUGPULLED BY EXECUTIVES',
  '{STOCK} CEO ARRESTED FOR TAX FRAUD',
  '{STOCK} FACTORY BURNS DOWN IN SUSPICIOUS FIRE',
  '{STOCK} LOSES MAJOR LAWSUIT - OWES BILLIONS',
  '{STOCK} ACCOUNTING SCANDAL REVEALED',
  '{STOCK} HIT WITH MASSIVE REGULATORY FINE',
  '{STOCK} DATA BREACH EXPOSES MILLIONS OF USERS',
  '{STOCK} PRODUCT FOUND TO CONTAIN TOXIC MATERIALS',
  '{STOCK} CFO SEEN FLEEING COUNTRY WITH BRIEFCASE',
  '{STOCK} DOWNGRADED TO "SELL" BY ALL ANALYSTS',
  '{STOCK} WAREHOUSE FOUND FULL OF UNSOLD INVENTORY',
  'BREAKING: {STOCK} UNDER SEC INVESTIGATION',
  '{STOCK} COMPETITOR RELEASES SUPERIOR PRODUCT',
  '{STOCK} INTERN ACCIDENTALLY DELETES ENTIRE DATABASE',
  '{STOCK} CAUGHT FAKING CUSTOMER REVIEWS',
  '{STOCK} SUPPLY CHAIN COMPLETELY COLLAPSES',
  '{STOCK} LOSES EXCLUSIVE CONTRACT TO RIVAL',
];

// Default world event templates (host can add more via config)
const DEFAULT_WORLD_EVENTS = [
  { headline: 'GLOBAL RECESSION FEARS GRIP MARKETS', affects: 'all', sentiment: -1, strength: 1.5 },
  { headline: 'CENTRAL BANK CUTS INTEREST RATES TO ZERO', affects: 'all', sentiment: 1, strength: 1.5 },
  { headline: 'MASSIVE STIMULUS PACKAGE ANNOUNCED', affects: 'all', sentiment: 1, strength: 2.0 },
  { headline: 'MARKET CRASH - PANIC SELLING EVERYWHERE', affects: 'all', sentiment: -1, strength: 2.0 },
  { headline: 'BULL RUN BEGINS - INVESTORS PILE IN', affects: 'all', sentiment: 1, strength: 1.8 },
  { headline: 'TRADE WAR ESCALATES - TARIFFS DOUBLED', affects: 'all', sentiment: -1, strength: 1.3 },
  { headline: 'ALIEN TECHNOLOGY DISCOVERED - STOCKS SOAR', affects: 'all', sentiment: 1, strength: 2.0 },
  { headline: 'METEOR HEADING FOR EARTH - SELL EVERYTHING', affects: 'all', sentiment: -1, strength: 2.0 },
  { headline: 'FREE MONEY GLITCH FOUND IN THE ECONOMY', affects: 'all', sentiment: 1, strength: 1.5 },
  { headline: 'INFLATION HITS 900% - EVERYTHING IS FINE', affects: 'all', sentiment: -1, strength: 1.8 },
  { headline: 'NEW TAX BREAKS FOR EVERY COMPANY', affects: 'all', sentiment: 1, strength: 1.0 },
  { headline: 'GOVERNMENT BANS SHORT SELLING', affects: 'all', sentiment: 1, strength: 1.2 },
  { headline: 'INTERNET GOES DOWN WORLDWIDE FOR 3 HOURS', affects: 'all', sentiment: -1, strength: 1.0 },
  { headline: 'ELON TWEETS "STOCKS ARE TOO HIGH IMO"', affects: 'all', sentiment: -1, strength: 1.5 },
  { headline: 'GLOBAL PEACE DECLARED - MARKETS CELEBRATE', affects: 'all', sentiment: 1, strength: 1.3 },
];

const MAX_ACTIVE_EVENTS = 4;
const EVENT_MIN_INTERVAL = 15000; // 15 seconds minimum between events
const EVENT_MAX_INTERVAL = 45000; // 45 seconds maximum
const WORLD_EVENT_CHANCE = 0.25; // 25% chance an event is a world event
let activeEvents = []; // { id, stockName, headline, sentiment, strength, spinsRemaining, createdAt, isWorld, affectedStocks[] }
let nextEventId = 1;
let eventTimer = null;

function getWorldEventTemplates() {
  // Merge default world events with host-configured ones
  const custom = (room.config && room.config.worldEvents) || [];
  return [...DEFAULT_WORLD_EVENTS, ...custom];
}

function generateMarketEvent() {
  const stockNames = Object.keys(stockPrices);
  if (stockNames.length === 0) { scheduleNextEvent(); return; }
  if (activeEvents.length >= MAX_ACTIVE_EVENTS) { scheduleNextEvent(); return; }

  const isWorldEvent = Math.random() < WORLD_EVENT_CHANCE;

  if (isWorldEvent) {
    // World event — affects multiple or all stocks
    const templates = getWorldEventTemplates();
    if (templates.length === 0) { generateStockEvent(stockNames); return; }
    const template = templates[Math.floor(Math.random() * templates.length)];

    // Determine affected stocks
    let affectedStocks;
    if (template.affects === 'all') {
      affectedStocks = [...stockNames];
    } else if (Array.isArray(template.affects)) {
      affectedStocks = template.affects.filter(s => stockNames.includes(s));
      if (affectedStocks.length === 0) { generateStockEvent(stockNames); return; }
    } else if (typeof template.affects === 'string' && stockNames.includes(template.affects)) {
      affectedStocks = [template.affects];
    } else {
      affectedStocks = [...stockNames];
    }

    const event = {
      id: nextEventId++,
      stockName: 'WORLD',
      headline: template.headline,
      sentiment: template.sentiment || (Math.random() > 0.5 ? 1 : -1),
      strength: template.strength || 1.5,
      spinsRemaining: 2 + Math.floor(Math.random() * 3), // 2-4 spins (longer for world events)
      createdAt: Date.now(),
      isWorld: true,
      affectedStocks,
    };

    activeEvents.push(event);
    console.log(`[event] WORLD ${event.sentiment > 0 ? 'BULLISH' : 'BEARISH'}: ${event.headline} (strength: ${event.strength.toFixed(1)}, affects: ${affectedStocks.length} stocks, duration: ${event.spinsRemaining} spins)`);
    broadcast({ type: 'market_event', payload: { event } });
  } else {
    generateStockEvent(stockNames);
  }

  scheduleNextEvent();
}

function generateStockEvent(stockNames) {
  // Single-stock event
  const stockName = stockNames[Math.floor(Math.random() * stockNames.length)];
  const isBullish = Math.random() > 0.5;
  const templates = isBullish ? BULLISH_HEADLINES : BEARISH_HEADLINES;
  const template = templates[Math.floor(Math.random() * templates.length)];
  const headline = template.replace('{STOCK}', stockName);

  const event = {
    id: nextEventId++,
    stockName,
    headline,
    sentiment: isBullish ? 1 : -1,
    strength: 0.5 + Math.random() * 1.5,
    spinsRemaining: 1 + Math.floor(Math.random() * 4), // 1-4 spins
    createdAt: Date.now(),
    isWorld: false,
    affectedStocks: [stockName],
  };

  activeEvents.push(event);
  console.log(`[event] ${isBullish ? 'BULLISH' : 'BEARISH'}: ${headline} (strength: ${event.strength.toFixed(1)}, duration: ${event.spinsRemaining} spins)`);
  broadcast({ type: 'market_event', payload: { event } });
}

function scheduleNextEvent() {
  if (eventTimer) clearTimeout(eventTimer);
  const delay = EVENT_MIN_INTERVAL + Math.random() * (EVENT_MAX_INTERVAL - EVENT_MIN_INTERVAL);
  eventTimer = setTimeout(generateMarketEvent, delay);
}

// Start event generation
scheduleNextEvent();

// Compute base weights (without player boosts) for real value calculation
function computeBaseWeights(wheelId, entries) {
  const wc = room.config && room.config.wheels[wheelId];
  if (!wc) return entries.map(() => 1);
  const ew = wc.entryWeights || {};
  ensureHiddenWeights(wheelId);
  return entries.map((name, idx) => {
    const hidden = hiddenWeights[wheelId][idx] || 1.0;
    const base = ew[name] != null ? ew[name] : 1;
    const fatigue = fatigueWeights[wheelId] ? (fatigueWeights[wheelId][idx] || 1.0) : 1.0;
    return Math.max(0.01, hidden * base * fatigue);
  });
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
      const variance = 1 + (Math.random() * 0.1 - 0.05);
      const initPrice = Math.round(STOCK_INITIAL_PRICE * variance * 100) / 100;
      stockPrices[name] = { price: initPrice, prevPrice: initPrice, realValue: initPrice, development: 1.0, momentum: 0, history: [initPrice] };
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

function broadcastStockPrices() {
  const CHANGE_LOOKBACK = 5; // Compare against price from 5 ticks ago
  const prices = {};
  for (const [name, stock] of Object.entries(stockPrices)) {
    // Calculate % change over multiple ticks for a more meaningful number
    const h = stock.history || [];
    const lookbackIdx = Math.max(0, h.length - CHANGE_LOOKBACK - 1);
    const refPrice = h.length > 1 ? h[lookbackIdx] : stock.prevPrice;
    const change = refPrice > 0 ? ((stock.price - refPrice) / refPrice * 100) : 0;
    prices[name] = { price: stock.price, prevPrice: stock.prevPrice, change: Math.round(change * 100) / 100, history: stock.history, momentum: Math.round(stock.momentum * 100) / 100 };
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
  broadcast({ type: 'stock_prices', payload: { prices, portfolios, costBases, events: activeEvents } });

  // Send per-client analyst predictions (estimated values with error)
  for (const [playerName, preds] of analystPredictions) {
    if (preds.size === 0) continue;
    const clientEntry = [...room.clients.entries()].find(([, c]) => c.name === playerName);
    if (!clientEntry) continue;
    const [, client] = clientEntry;
    if (client.ws.readyState !== 1) continue;
    const analystData = {};
    for (const [sn, pred] of preds) {
      const stock = stockPrices[sn];
      if (stock) {
        analystData[sn] = {
          estimatedValue: Math.round(stock.realValue * pred.errorMultiplier * 100) / 100,
          spinsLeft: pred.spinsLeft,
        };
      }
    }
    send(client.ws, { type: 'analyst_update', payload: analystData });
  }
}

// ── Stock Price Evolution ──
const EVOLUTION_INTERVAL = 1000; // 1 second

function evolveStockPrices() {
  if (room.spinState.spinning) return;
  if (!room.config || !room.config.activeWheelId) return;

  const wheelId = room.config.activeWheelId;
  const wc = room.config.wheels[wheelId];
  if (!wc) return;

  const entries = (wc.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (entries.length < 2) return;
  if (Object.keys(stockPrices).length === 0) return;

  // Compute base weights (no player boosts) for real value calculation
  const baseWeights = computeBaseWeights(wheelId, entries);
  const totalWeight = baseWeights.reduce((a, b) => a + b, 0);
  const avgProbability = 1 / entries.length;

  // Build per-stock probability by aggregating duplicate entry weights
  const stockProb = {};
  entries.forEach((name, idx) => {
    const prob = baseWeights[idx] / totalWeight;
    stockProb[name] = (stockProb[name] || 0) + prob;
  });

  // Apply active events: nudge development (real value) + add momentum
  for (const ev of activeEvents) {
    const targets = ev.affectedStocks || [ev.stockName];
    for (const stockName of targets) {
      const stock = stockPrices[stockName];
      if (!stock) continue;
      // Events shift real value via development
      stock.development += ev.sentiment * ev.strength * EVENT_DEVELOPMENT;
      stock.development = Math.max(0.1, stock.development);
      // Events also add momentum (for short-term price pressure)
      stock.momentum += EVENT_MOMENTUM * ev.sentiment * ev.strength;
    }
  }

  for (const [name, stock] of Object.entries(stockPrices)) {
    // Recompute real value from probability and development
    const prob = stockProb[name] || avgProbability;
    const probabilityFactor = prob / avgProbability;
    stock.realValue = STOCK_INITIAL_PRICE * probabilityFactor * stock.development;
    stock.realValue = Math.round(stock.realValue * 100) / 100;

    // Gravity: pull share price toward real value (dead zone: no pull within ±10%)
    const priceDiff = stock.realValue > 0 ? (stock.price - stock.realValue) / stock.realValue : 0;
    const gravity = Math.abs(priceDiff) > GRAVITY_DEAD_ZONE
      ? GRAVITY_K * (stock.realValue - stock.price)
      : 0;

    // Momentum dampening: less effect the further price is from real value
    const deviation = stock.realValue > 0 ? Math.abs(stock.price - stock.realValue) / stock.realValue : 0;
    const momentumDampening = 1 / (1 + deviation * MOMENTUM_DISTANCE_SCALE);
    const effectiveMomentum = stock.momentum * MOMENTUM_EFFECT * momentumDampening;

    // Momentum-driven price changes consume liquidity (AI market trades)
    const liquidity = getMarketLiquidity(name);
    let momentumPriceEffect = 0;
    if (effectiveMomentum > 0 && liquidity.sellVolume > 0) {
      // Positive momentum = AI buys, consumes sell liquidity
      const volumeUsed = Math.min(Math.abs(effectiveMomentum) * 2, liquidity.sellVolume);
      liquidity.sellVolume -= volumeUsed;
      momentumPriceEffect = effectiveMomentum * (volumeUsed / (Math.abs(effectiveMomentum) * 2 || 1));
    } else if (effectiveMomentum < 0 && liquidity.buyVolume > 0) {
      // Negative momentum = AI sells, consumes buy liquidity
      const volumeUsed = Math.min(Math.abs(effectiveMomentum) * 2, liquidity.buyVolume);
      liquidity.buyVolume -= volumeUsed;
      momentumPriceEffect = effectiveMomentum * (volumeUsed / (Math.abs(effectiveMomentum) * 2 || 1));
    }

    // Price change = gravity + volume-limited momentum + noise
    const noise = stock.price * (Math.random() - 0.5) * 2 * NOISE_AMPLITUDE;
    const priceChange = gravity + momentumPriceEffect + noise;

    stock.prevPrice = stock.price;
    stock.price = Math.max(0.01, stock.price + priceChange);
    stock.price = Math.round(stock.price * 100) / 100;

    // Decay momentum
    stock.momentum *= MOMENTUM_DECAY;
    if (Math.abs(stock.momentum) < 0.001) stock.momentum = 0;

    // History
    stock.history.push(stock.price);
    if (stock.history.length > 50) stock.history.shift();
  }

  // Generate liquidity — skewed by how far price is from real value
  for (const name of Object.keys(stockPrices)) {
    const stock = stockPrices[name];
    const liquidity = getMarketLiquidity(name);
    // Deviation: positive = overvalued, negative = undervalued
    const dev = stock.realValue > 0 ? (stock.price - stock.realValue) / stock.realValue : 0;
    // Overvalued → more sell pressure (profit-taking), less buy interest
    // Undervalued → more buy pressure (bargain hunters), less sell interest
    const sellBias = Math.max(0, dev * BASE_LIQUIDITY * 3);  // extra sellers when overvalued
    const buyBias = Math.max(0, -dev * BASE_LIQUIDITY * 3);  // extra buyers when undervalued
    liquidity.buyVolume += BASE_LIQUIDITY + buyBias;
    liquidity.sellVolume += BASE_LIQUIDITY + sellBias;
    // Events increase liquidity for affected stocks
    for (const ev of activeEvents) {
      const targets = ev.affectedStocks || [ev.stockName];
      if (targets.includes(name)) {
        liquidity.buyVolume += ev.strength * 2;
        liquidity.sellVolume += ev.strength * 2;
      }
    }
  }

  saveStocks();
  broadcastStockPrices();
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
    list.push({ name: p.name, points: p.points, stats: p.stats, inventory: p.inventory || [], upgrades: p.upgrades || {}, connected: p.connected, isHost: p.clientId === room.hostId, color: playerColors.get(p.name) || '#888' });
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
    if (!player.upgrades) player.upgrades = {};
  } else {
    player = { name, points: 100, stats: { totalSpins: 0, totalWins: 0 }, inventory: [], portfolio: {}, costBasis: {}, upgrades: {}, connected: true, clientId };
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
      upgradeDefs: serializeUpgradeDefs(),
      activeRobberies: [...activeRobberies.values()].map(r => ({
        id: r.id, attackerName: r.attackerName, targetName: r.targetName,
        attackLevel: r.attackLevel, defenseLevel: r.defenseLevel,
        wordLength: r.wordLength, startedAt: r.startedAt, resolveAt: r.resolveAt,
        guesses: r.guesses, maxGuesses: r.maxGuesses, victimOnline: r.victimOnline,
        durationMs: WORDLE_DURATION_MS,
      })),
      robberyCooldowns: Object.fromEntries(robberyCooldowns),
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
  saveConfig();
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

function decayBoosts() {
  // Multiply all boost weights by ADDITIVE_DECAY, remove when negligible
  for (const [clientId, wheels] of Object.entries(playerBoosts)) {
    const decayed = {}; // track what changed for this client
    for (const [wheelId, weights] of Object.entries(wheels)) {
      for (const [key, value] of Object.entries(weights)) {
        weights[key] = value * ADDITIVE_DECAY;
        if (Math.abs(weights[key]) < 0.01) {
          delete weights[key];
        } else {
          if (!decayed[wheelId]) decayed[wheelId] = {};
          decayed[wheelId][key] = weights[key];
        }
      }
      if (Object.keys(weights).length === 0) delete wheels[wheelId];
    }
    if (Object.keys(wheels).length === 0) delete playerBoosts[clientId];
    // Notify this client of decayed boost values
    const client = room.clients.get(clientId);
    if (client && client.ws.readyState === 1) {
      send(client.ws, { type: 'boosts_decayed', payload: { factor: ADDITIVE_DECAY, remaining: decayed } });
    }
  }
  // Update activeBoosts to reflect decay — scale down addedWeight, remove expired
  activeBoosts = activeBoosts.filter(b => {
    b.addedWeight *= ADDITIVE_DECAY;
    return b.addedWeight >= 0.01;
  });
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

  // Compute base weights (shared config weights, no per-client boosts)
  const ew = wc.entryWeights || {};
  const baseWeights = entries.map((name, idx) => {
    const base = ew[name] != null ? ew[name] : 1;
    return Math.max(0.01, base);
  });

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
    entries,
    baseWeights,
    totalBoostOffset: 0,
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
  // Start with server-predetermined winner
  let winner = room.spinState.predeterminedWinner;
  let winnerIndex = room.spinState.predeterminedWinnerIndex;

  // If boost items were used mid-spin, recalculate winner from boosted angle
  if (room.spinState.totalBoostOffset && room.spinState.baseWeights && room.spinState.entries) {
    const entries = room.spinState.entries;
    const bw = room.spinState.baseWeights;
    const totalWeight = bw.reduce((a, b) => a + b, 0);
    const TWO_PI = Math.PI * 2;

    // Compute original target angle in base layout for the predetermined winner
    let origSegStart = 0;
    for (let i = 0; i < winnerIndex; i++) {
      origSegStart += (bw[i] / totalWeight) * TWO_PI;
    }
    const origSegArc = (bw[winnerIndex] / totalWeight) * TWO_PI;
    const padding = origSegArc * 0.1;
    const origAngle = origSegStart + padding + room.spinState.innerRand * (origSegArc - 2 * padding);

    // Apply boost offset (subtract: adding to wheel rotation moves pointer backwards in segment space)
    let newAngle = (origAngle - room.spinState.totalBoostOffset) % TWO_PI;
    if (newAngle < 0) newAngle += TWO_PI;

    // Find which segment the boosted angle lands in
    let cumAngle = 0;
    let newWinnerIndex = entries.length - 1;
    for (let i = 0; i < entries.length; i++) {
      cumAngle += (bw[i] / totalWeight) * TWO_PI;
      if (newAngle < cumAngle) { newWinnerIndex = i; break; }
    }

    if (newWinnerIndex !== winnerIndex) {
      console.log(`[boost] Winner changed: "${entries[winnerIndex]}" → "${entries[newWinnerIndex]}" (boost ${room.spinState.totalBoostOffset.toFixed(3)} rad)`);
      winnerIndex = newWinnerIndex;
      winner = entries[newWinnerIndex];
    }
  }

  room.spinState.spinning = false;

  // Decrement robbery cooldowns
  for (const [name, cd] of robberyCooldowns) {
    if (cd <= 1) robberyCooldowns.delete(name);
    else robberyCooldowns.set(name, cd - 1);
  }

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

  // ── Stock development & momentum for winner ──
  if (winner && stockPrices[winner]) {
    stockPrices[winner].development += DEVELOPMENT_PER_WIN;
    stockPrices[winner].momentum += SPIN_WIN_MOMENTUM;
  }
  // Opposite entry (across the wheel) takes a small development hit
  if (room.config) {
    const wc2 = room.config.wheels[wheelId];
    if (wc2) {
      const allEntries = (wc2.entries || '').split('\n').map(s => s.trim()).filter(Boolean);
      if (allEntries.length >= 2 && winnerIndex != null) {
        const oppositeIndex = (winnerIndex + Math.floor(allEntries.length / 2)) % allEntries.length;
        const oppName = allEntries[oppositeIndex];
        if (oppName !== winner && stockPrices[oppName]) {
          stockPrices[oppName].development = Math.max(0.1, stockPrices[oppName].development - DEVELOPMENT_PER_WIN * 0.5);
        }
      }
    }
  }

  // ── Decay boosts (multiply by 0.7 instead of removing) ──
  // Delay so the wheel doesn't visually shift while result is shown
  if (nextAction && nextAction.type === 'subwheel') {
    setTimeout(() => {
      decayBoosts();
      handleSpinRequest(null, room.hostId || 'server', {
        wheelId: nextAction.targetWheelId,
        visitedChain: nextAction.visitedChain,
        skipReadyUp: true,
      });
    }, 2000);
  } else if (nextAction && nextAction.type === '__spin_again') {
    setTimeout(() => {
      decayBoosts();
      handleSpinRequest(null, room.hostId || 'server', {
        wheelId: nextAction.wheelId,
        visitedChain: [],
        skipReadyUp: true,
      });
    }, 2000);
  } else {
    setTimeout(() => decayBoosts(), 3000);
  }

  // ── Decrement event spinsRemaining, remove expired ──
  for (let i = activeEvents.length - 1; i >= 0; i--) {
    activeEvents[i].spinsRemaining--;
    if (activeEvents[i].spinsRemaining <= 0) {
      console.log(`[event] Expired: "${activeEvents[i].headline}"`);
      activeEvents.splice(i, 1);
    }
  }

  // ── Decrement analyst predictions, notify players ──
  for (const [playerName, preds] of analystPredictions) {
    for (const [stockName, pred] of preds) {
      pred.spinsLeft--;
      if (pred.spinsLeft <= 0) preds.delete(stockName);
    }
    // Send updated analyst data to this player
    const clientEntry = [...room.clients.entries()].find(([, c]) => c.name === playerName);
    if (clientEntry) {
      const [, cl] = clientEntry;
      if (cl.ws.readyState === 1) {
        const remaining = {};
        for (const [sn, p] of preds) {
          const stock = stockPrices[sn];
          if (stock) remaining[sn] = { estimatedValue: Math.round(stock.realValue * p.errorMultiplier * 100) / 100, spinsLeft: p.spinsLeft };
        }
        send(cl.ws, { type: 'analyst_update', payload: remaining });
      }
    }
    if (preds.size === 0) analystPredictions.delete(playerName);
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

function handleAnalystPurchase(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;
  const player = room.players.get(client.name);
  if (!player) return;

  if (!room.config || !room.config.shop) {
    send(ws, { type: 'error', payload: { message: 'No shop configured' } });
    return;
  }

  const item = room.config.shop[payload.itemIndex];
  if (!item || item.action !== 'analyst') {
    send(ws, { type: 'error', payload: { message: 'Invalid analyst item' } });
    return;
  }

  const stockName = payload.stockName;
  if (!stockName || !stockPrices[stockName]) {
    send(ws, { type: 'error', payload: { message: 'Invalid stock' } });
    return;
  }

  if (player.points < item.cost) {
    send(ws, { type: 'error', payload: { message: 'Not enough funds' } });
    return;
  }

  player.points -= item.cost;

  // Generate error multiplier: ±5% (0.95 to 1.05)
  const errorMultiplier = 1 + (Math.random() * 0.10 - 0.05);

  // Store prediction
  if (!analystPredictions.has(client.name)) analystPredictions.set(client.name, new Map());
  analystPredictions.get(client.name).set(stockName, { spinsLeft: 5, errorMultiplier });

  const stock = stockPrices[stockName];
  const estimatedValue = Math.round(stock.realValue * errorMultiplier * 100) / 100;

  // Notify buyer only
  send(ws, { type: 'analyst_activated', payload: { stockName, estimatedValue, spinsLeft: 5 } });

  // Broadcast purchase for toast/sound
  broadcast({
    type: 'shop_purchased',
    payload: { buyerName: client.name, item, itemIndex: payload.itemIndex },
  });

  savePlayers();
  broadcastPlayerList();
  console.log(`[analyst] ${client.name} bought analyst prediction for "${stockName}" (est: $${estimatedValue}, real: $${stock.realValue})`);
}

function handleUpgradePurchase(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;
  const player = room.players.get(client.name);
  if (!player) return;
  if (!player.upgrades) player.upgrades = {};

  const { upgradeId } = payload;
  const def = UPGRADE_DEFS[upgradeId];
  if (!def) {
    send(ws, { type: 'error', payload: { message: 'Unknown upgrade' } });
    return;
  }

  const currentLevel = player.upgrades[upgradeId] || 0;
  if (currentLevel >= def.maxLevel) {
    send(ws, { type: 'error', payload: { message: 'Upgrade already at max level' } });
    return;
  }

  const cost = def.costFormula(currentLevel);
  if (player.points < cost) {
    send(ws, { type: 'error', payload: { message: 'Not enough funds' } });
    return;
  }

  player.points -= cost;
  player.upgrades[upgradeId] = currentLevel + 1;
  savePlayers();

  console.log(`[upgrade] ${client.name} upgraded "${def.name}" to level ${currentLevel + 1} for $${cost}`);

  broadcast({
    type: 'upgrade_purchased',
    payload: { buyerName: client.name, upgradeId, newLevel: currentLevel + 1, cost },
  });
  broadcastPlayerList();
}

const activeRobberies = new Map(); // robberyId -> robbery state
let nextRobberyId = 1;
const WORDLE_DURATION_MS = 60000; // 60 seconds for victim to guess
const WORDLE_MAX_GUESSES = 6;

function getRequiredWordLength(attackLevel, defenseLevel) {
  const levelDiff = attackLevel - defenseLevel;
  if (levelDiff < 0) return { exact: 3 };
  if (levelDiff === 0) return { exact: 4 };
  const calcLen = 4 + levelDiff;
  if (calcLen >= 8) return { minLength: 8 };
  return { exact: calcLen };
}

function isValidWordLength(word, attackLevel, defenseLevel) {
  const req = getRequiredWordLength(attackLevel, defenseLevel);
  if (req.exact) return word.length === req.exact;
  if (req.minLength) return word.length >= req.minLength;
  return false;
}

function computeWordleFeedback(guess, secret) {
  const feedback = new Array(guess.length).fill('absent');
  const secretLetters = secret.split('');
  const used = new Array(secret.length).fill(false);
  // First pass: correct (green)
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === secretLetters[i]) {
      feedback[i] = 'correct';
      used[i] = true;
    }
  }
  // Second pass: present (yellow)
  for (let i = 0; i < guess.length; i++) {
    if (feedback[i] === 'correct') continue;
    for (let j = 0; j < secretLetters.length; j++) {
      if (!used[j] && guess[i] === secretLetters[j]) {
        feedback[i] = 'present';
        used[j] = true;
        break;
      }
    }
  }
  return feedback;
}

function handleRobbery(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;
  const attacker = room.players.get(client.name);
  if (!attacker) return;
  if (!attacker.upgrades) attacker.upgrades = {};

  const { targetName, word } = payload;
  if (targetName === client.name) {
    send(ws, { type: 'error', payload: { message: "You can't rob yourself" } });
    return;
  }

  const victim = room.players.get(targetName);
  if (!victim) {
    send(ws, { type: 'error', payload: { message: 'Player not found' } });
    return;
  }

  const attackLevel = attacker.upgrades.criminal_org || 0;
  if (attackLevel < 1) {
    send(ws, { type: 'error', payload: { message: 'You need Criminal Organization level 1+' } });
    return;
  }

  // Validate word
  if (!word || typeof word !== 'string') {
    send(ws, { type: 'error', payload: { message: 'You must select a word' } });
    return;
  }
  const normalizedWord = word.toLowerCase().trim();
  if (!WORD_SET.has(normalizedWord)) {
    send(ws, { type: 'error', payload: { message: 'Invalid word' } });
    return;
  }
  const defenseLevel = victim.upgrades ? (victim.upgrades.bodyguards || 0) : 0;
  if (!isValidWordLength(normalizedWord, attackLevel, defenseLevel)) {
    send(ws, { type: 'error', payload: { message: 'Word length does not match level requirements' } });
    return;
  }

  // Check cooldown
  const cd = robberyCooldowns.get(client.name) || 0;
  if (cd > 0) {
    send(ws, { type: 'robbery_result', payload: { success: false, reason: 'cooldown', spinsLeft: cd } });
    return;
  }

  // Check if already has an active robbery
  for (const [, r] of activeRobberies) {
    if (r.attackerName === client.name) {
      send(ws, { type: 'error', payload: { message: 'You already have a robbery in progress' } });
      return;
    }
  }

  // Start cooldown immediately
  robberyCooldowns.set(client.name, ROBBERY_COOLDOWN_SPINS);

  const robberyId = nextRobberyId++;
  const victimOnline = !!victim.connected;

  // If victim is offline, resolve immediately with random chance
  if (!victimOnline) {
    const levelDiff = attackLevel - defenseLevel;
    const successChance = Math.min(0.90, Math.max(0.10, 0.50 + levelDiff * 0.08));
    const roll = Math.random();

    console.log(`[robbery] ${client.name} (Lv${attackLevel}) robbing offline ${targetName} (Def${defenseLevel}) — roll ${roll.toFixed(2)} vs ${successChance.toFixed(2)}`);

    if (roll > successChance) {
      broadcast({
        type: 'robbery_result',
        payload: { robberyId, success: false, reason: 'defended', attackerName: client.name, targetName, attackLevel, defenseLevel, word: normalizedWord },
      });
      return;
    }

    // Offline success — use loot calculation
    resolveRobberyLoot(robberyId, client.name, targetName, attackLevel, defenseLevel, normalizedWord);
    return;
  }

  // Victim is online — start Wordle
  const resolveAt = Date.now() + WORDLE_DURATION_MS;
  const robbery = {
    id: robberyId,
    attackerName: client.name,
    targetName,
    attackLevel,
    defenseLevel,
    word: normalizedWord,
    wordLength: normalizedWord.length,
    startedAt: Date.now(),
    resolveAt,
    guesses: [],
    maxGuesses: WORDLE_MAX_GUESSES,
    victimOnline: true,
    timerId: null,
  };
  activeRobberies.set(robberyId, robbery);

  console.log(`[robbery] ${client.name} (Lv${attackLevel}) started Wordle robbery on ${targetName} (Def${defenseLevel}) — word "${normalizedWord}" (${normalizedWord.length} letters), 60s timer`);

  broadcast({
    type: 'robbery_started',
    payload: {
      robberyId,
      attackerName: client.name,
      targetName,
      attackLevel,
      defenseLevel,
      wordLength: normalizedWord.length,
      durationMs: WORDLE_DURATION_MS,
      maxGuesses: WORDLE_MAX_GUESSES,
      victimOnline: true,
    },
  });

  robbery.timerId = setTimeout(() => resolveRobberyTimeout(robberyId), WORDLE_DURATION_MS);
}

function handleRobberyGuess(ws, clientId, payload) {
  const client = room.clients.get(clientId);
  if (!client) return;

  const { robberyId, guess } = payload;
  const robbery = activeRobberies.get(robberyId);
  if (!robbery) {
    send(ws, { type: 'error', payload: { message: 'Robbery not found or already resolved' } });
    return;
  }

  if (client.name !== robbery.targetName) {
    send(ws, { type: 'error', payload: { message: 'Only the target can guess' } });
    return;
  }

  if (robbery.guesses.length >= robbery.maxGuesses) {
    send(ws, { type: 'error', payload: { message: 'No guesses remaining' } });
    return;
  }

  const normalizedGuess = guess.toLowerCase().trim();
  if (!WORD_SET.has(normalizedGuess)) {
    send(ws, { type: 'robbery_guess_result', payload: { robberyId, valid: false, message: 'Not a valid word' } });
    return;
  }
  if (normalizedGuess.length !== robbery.wordLength) {
    send(ws, { type: 'robbery_guess_result', payload: { robberyId, valid: false, message: `Word must be ${robbery.wordLength} letters` } });
    return;
  }

  const feedback = computeWordleFeedback(normalizedGuess, robbery.word);
  const guessNum = robbery.guesses.length + 1;
  const correct = normalizedGuess === robbery.word;

  robbery.guesses.push({ guess: normalizedGuess, feedback, guessNum });

  broadcast({
    type: 'robbery_guess_result',
    payload: {
      robberyId,
      valid: true,
      guess: normalizedGuess,
      feedback,
      guessNum,
      maxGuesses: robbery.maxGuesses,
      correct,
    },
  });

  if (correct) {
    // Victim guessed correctly — robbery fails
    clearTimeout(robbery.timerId);
    activeRobberies.delete(robberyId);
    console.log(`[robbery] ${robbery.targetName} defended against ${robbery.attackerName} by guessing "${normalizedGuess}" on guess ${guessNum}`);
    broadcast({
      type: 'robbery_result',
      payload: {
        robberyId,
        success: false,
        reason: 'defended',
        attackerName: robbery.attackerName,
        targetName: robbery.targetName,
        attackLevel: robbery.attackLevel,
        defenseLevel: robbery.defenseLevel,
        word: robbery.word,
      },
    });
  } else if (guessNum >= robbery.maxGuesses) {
    // All guesses used — robbery succeeds
    clearTimeout(robbery.timerId);
    resolveRobberySuccess(robberyId);
  }
}

function resolveRobberyTimeout(robberyId) {
  const robbery = activeRobberies.get(robberyId);
  if (!robbery) return;
  console.log(`[robbery] Timer expired for robbery ${robberyId} — ${robbery.attackerName} vs ${robbery.targetName}`);
  resolveRobberySuccess(robberyId);
}

function resolveRobberySuccess(robberyId) {
  const robbery = activeRobberies.get(robberyId);
  if (!robbery) return;
  activeRobberies.delete(robberyId);

  const attacker = room.players.get(robbery.attackerName);
  const victim = room.players.get(robbery.targetName);
  if (!attacker || !victim) {
    broadcast({ type: 'robbery_result', payload: { robberyId, success: false, reason: 'player_gone', attackerName: robbery.attackerName, targetName: robbery.targetName, word: robbery.word } });
    return;
  }

  resolveRobberyLoot(robberyId, robbery.attackerName, robbery.targetName, robbery.attackLevel, robbery.defenseLevel, robbery.word);
}

function resolveRobberyLoot(robberyId, attackerName, targetName, attackLevel, defenseLevel, word) {
  const attacker = room.players.get(attackerName);
  const victim = room.players.get(targetName);
  if (!attacker || !victim) {
    broadcast({ type: 'robbery_result', payload: { robberyId, success: false, reason: 'player_gone', attackerName, targetName, word } });
    return;
  }

  const levelDiff = attackLevel - defenseLevel;

  // Calculate victim's total assets
  if (!victim.portfolio) victim.portfolio = {};
  if (!victim.costBasis) victim.costBasis = {};
  let portfolioValue = 0;
  const victimStocks = {};
  for (const [stockName, shares] of Object.entries(victim.portfolio)) {
    if (shares <= 0) continue;
    const stock = stockPrices[stockName];
    if (!stock) continue;
    const val = shares * stock.price;
    portfolioValue += val;
    victimStocks[stockName] = { shares, price: stock.price, value: val };
  }
  const totalAssets = victim.points + portfolioValue;

  if (totalAssets <= 0) {
    broadcast({
      type: 'robbery_result',
      payload: { robberyId, success: false, reason: 'broke', attackerName, targetName, word },
    });
    return;
  }

  // Loot amount: scale with level diff, randomized
  const lootFraction = Math.min(0.90, Math.max(0.10, 0.30 + levelDiff * 0.05));
  const percentCap = ROBBERY_MAX_PERCENT * totalAssets;
  const maxLoot = Math.max(percentCap, ROBBERY_MAX_FLAT);
  const rawLoot = Math.round((0.3 + Math.random() * 0.7) * lootFraction * maxLoot);
  const actualLoot = Math.min(rawLoot, totalAssets);

  // Distribute theft across cash and stocks proportionally
  let cashStolen = 0;
  const stocksStolen = {};

  if (totalAssets > 0) {
    const cashRatio = victim.points / totalAssets;
    cashStolen = Math.min(victim.points, Math.round(actualLoot * cashRatio));
    let remaining = actualLoot - cashStolen;

    // Steal stocks randomly (shuffle)
    const stockEntries = Object.entries(victimStocks);
    for (let i = stockEntries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [stockEntries[i], stockEntries[j]] = [stockEntries[j], stockEntries[i]];
    }
    for (const [stockName, info] of stockEntries) {
      if (remaining <= 0) break;
      const stealValue = Math.min(remaining, info.value);
      const sharesToSteal = Math.max(1, Math.floor(stealValue / info.price));
      const actualShares = Math.min(sharesToSteal, info.shares);
      if (actualShares <= 0) continue;

      stocksStolen[stockName] = actualShares;
      victim.portfolio[stockName] -= actualShares;
      if (victim.portfolio[stockName] <= 0) delete victim.portfolio[stockName];

      // Transfer to attacker
      if (!attacker.portfolio) attacker.portfolio = {};
      attacker.portfolio[stockName] = (attacker.portfolio[stockName] || 0) + actualShares;

      // Update cost basis
      if (victim.costBasis[stockName]) {
        const vb = victim.costBasis[stockName];
        const avgCost = vb.shares > 0 ? vb.totalCost / vb.shares : info.price;
        vb.totalCost -= avgCost * actualShares;
        vb.shares -= actualShares;
        if (vb.shares <= 0) delete victim.costBasis[stockName];
      }
      if (!attacker.costBasis) attacker.costBasis = {};
      if (!attacker.costBasis[stockName]) attacker.costBasis[stockName] = { totalCost: 0, shares: 0 };
      attacker.costBasis[stockName].totalCost += info.price * actualShares;
      attacker.costBasis[stockName].shares += actualShares;

      remaining -= actualShares * info.price;
    }

    // If we couldn't steal enough stocks, take more cash
    if (remaining > 0) {
      const extraCash = Math.min(victim.points - cashStolen, Math.round(remaining));
      cashStolen += extraCash;
    }
  }

  // Transfer cash
  victim.points -= cashStolen;
  attacker.points += cashStolen;
  savePlayers();

  const totalStolen = cashStolen + Object.entries(stocksStolen).reduce((sum, [name, shares]) => {
    const stock = stockPrices[name];
    return sum + (stock ? shares * stock.price : 0);
  }, 0);

  console.log(`[robbery] ${attackerName} (Lv${attackLevel}) robbed ${targetName} (Def${defenseLevel}) for $${Math.round(totalStolen)} (cash: $${cashStolen}, stocks: ${JSON.stringify(stocksStolen)})`);

  broadcast({
    type: 'robbery_result',
    payload: {
      robberyId,
      success: true,
      attackerName,
      targetName,
      attackLevel,
      defenseLevel,
      cashStolen,
      stocksStolen,
      totalStolen: Math.round(totalStolen),
      word,
    },
  });
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

    // Accumulate scaled boost offset (same scaling as client's applyWheelBoost)
    if (room.spinState.entries && room.spinState.baseWeights) {
      const bw = room.spinState.baseWeights;
      const numEntries = bw.length;
      if (numEntries > 0) {
        const totalWeight = bw.reduce((a, b) => a + b, 0);
        const avgWeight = totalWeight / numEntries;
        const scaleFactor = 1 / Math.max(0.1, avgWeight);
        room.spinState.totalBoostOffset += boostAmount * scaleFactor;
      } else {
        room.spinState.totalBoostOffset += boostAmount;
      }
      console.log(`[boost] Accumulated boost offset: ${room.spinState.totalBoostOffset.toFixed(3)} rad`);
    }

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

      // Apply momentum from trade
      stock.momentum += PLAYER_TRADE_MOMENTUM * Math.sqrt(fillAmount);

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

      // Apply momentum from trade
      stock.momentum -= PLAYER_TRADE_MOMENTUM * Math.sqrt(fillAmount);

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
      case 'analyst_purchase': handleAnalystPurchase(ws, clientId, msg.payload || {}); break;
      case 'use_item': handleUseItem(ws, clientId, msg.payload || {}); break;
      case 'upgrade_purchase': handleUpgradePurchase(ws, clientId, msg.payload || {}); break;
      case 'robbery': handleRobbery(ws, clientId, msg.payload || {}); break;
      case 'robbery_guess': handleRobberyGuess(ws, clientId, msg.payload || {}); break;
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

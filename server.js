const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// ---------------- ИГРОВОЕ СОСТОЯНИЕ ----------------

const COLS = 10;
const ROWS = 5;
const TILE_COUNT = COLS * ROWS;

let gameState = {
  money: 0,
  tiles: [],
  cows: [],
  milk: [],
  zombies: [],
  isNight: false,
  nextTilePrice: 50,
  nextCowId: 1,
  nextMilkId: 1,
  nextZombieId: 1
};

for (let i = 0; i < TILE_COUNT; i++) {
  gameState.tiles.push({
    open: i === Math.floor(TILE_COUNT / 2)
  });
}

let globalWidth = 1000;
let globalHeight = 700;
let lastNightStart = Date.now();

function broadcastState() {
  io.emit("state", gameState);
}

function sendError(socket, msg) {
  socket.emit("errorMessage", msg);
}

function canAfford(cost) {
  return gameState.money >= cost;
}

function spend(cost) {
  if (!canAfford(cost)) return false;
  gameState.money -= cost;
  return true;
}

// ---------------- ЦЕНЫ ----------------

function getCowPrice(type, existingCount) {
  if (type === "normal") {
    if (existingCount === 0) return 0;
    if (existingCount === 1) return 2;
    return Math.pow(2, existingCount);
  } else {
    if (existingCount === 0) return 10;
    return 10 * Math.pow(5, existingCount);
  }
}

function countGoldCows() {
  return gameState.cows.filter(c => c.type === "gold").length;
}

function getCowBaseStats(type) {
  if (type === "normal") {
    return {
      speedLevel: 0,
      healthLevel: 0,
      intervalMs: 40000,
      maxHp: 3
    };
  } else {
    return {
      speedLevel: 0,
      healthLevel: 0,
      intervalMs: 60000,
      maxHp: 5
    };
  }
}

function getSpeedInterval(type, level) {
  if (type === "normal") {
    if (level === 0) return 40000;
    if (level === 1) return 30000;
    if (level === 2) return 20000;
    if (level === 3) return 10000;
    if (level === 4) return 5000;
    return 5000;
  } else {
    if (level === 0) return 60000;
    if (level === 1) return 45000;
    if (level === 2) return 30000;
    if (level === 3) return 15000;
    return 15000;
  }
}

function getHealthMax(type, level) {
  if (type === "normal") {
    if (level === 0) return 3;
    if (level === 1) return 5;
    if (level === 2) return 10;
    return 10;
  } else {
    if (level === 0) return 5;
    if (level === 1) return 12;
    if (level === 2) return 20;
    return 20;
  }
}

function getSpeedUpgradeCost(type, level) {
  if (type === "normal") {
    if (level === 0) return 20;
    if (level === 1) return 100;
    if (level === 2) return 250;
    if (level === 3) return 500;
    return null;
  } else {
    if (level === 0) return 100;
    if (level === 1) return 500;
    if (level === 2) return 1000;
    return null;
  }
}

function getHealthUpgradeCost(type, level) {
  if (type === "normal") {
    if (level === 0) return 50;
    if (level === 1) return 145;
    return null;
  } else {
    if (level === 0) return 100;
    if (level === 1) return 400;
    return null;
  }
}

// ---------------- МОЛОКО ----------------

function spawnMilkForCow(cow) {
  const id = gameState.nextMilkId++;
  const type = cow.type === "normal" ? "normal" : "gold";

  const x = Math.floor(Math.random() * globalWidth);
  const y = Math.floor(Math.random() * globalHeight);

  gameState.milk.push({
    id,
    type,
    x,
    y,
    createdAt: Date.now()
  });

  io.emit("cowShake", cow.tileIndex);
}

function cleanupOldMilk() {
  const now = Date.now();
  gameState.milk = gameState.milk.filter(m => now - m.createdAt < 60000);
}

// ---------------- ЗОМБИ ----------------

function startNight() {
  gameState.isNight = true;
  gameState.zombies = [];

  for (let i = 0; i < 10; i++) {
    const id = gameState.nextZombieId++;
    const corner = i % 4;

    let x = 0, y = 0;
    if (corner === 0) { x = 0; y = 0; }
    if (corner === 1) { x = globalWidth; y = 0; }
    if (corner === 2) { x = 0; y = globalHeight; }
    if (corner === 3) { x = globalWidth; y = globalHeight; }

    const speed = 2 + Math.random() * 3;
    const hp = 5 + Math.floor(Math.random() * 11);
    const dmg = 1 + Math.floor(Math.random() * 2);

    gameState.zombies.push({
      id,
      x,
      y,
      speed,
      hp,
      dmg,
      targetCowId: null
    });
  }

  broadcastState();
}

function endNightIfNoZombies() {
  if (gameState.zombies.length === 0 && gameState.isNight) {
    gameState.isNight = false;
    lastNightStart = Date.now();
    broadcastState();
  }
}

function findNearestCow(zombie) {
  if (gameState.cows.length === 0) return null;

  let best = null;
  let bestDist = Infinity;

  gameState.cows.forEach(cow => {
    const tileIndex = cow.tileIndex;
    const col = tileIndex % COLS;
    const row = Math.floor(tileIndex / COLS);

    const cx = 200 + col * 44;
    const cy = 100 + row * 44;

    const dx = cx - zombie.x;
    const dy = cy - zombie.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < bestDist) {
      bestDist = dist;
      best = { cow, cx, cy, dist };
    }
  });

  return best;
}

function updateZombies(dt) {
  if (!gameState.isNight) return;

  const toRemoveCows = new Set();

  gameState.zombies.forEach(z => {
    const target = findNearestCow(z);
    if (!target) return;

    const { cow, cx, cy, dist } = target;

    if (dist > 5) {
      const vx = (cx - z.x) / dist;
      const vy = (cy - z.y) / dist;
      z.x += vx * z.speed * dt;
      z.y += vy * z.speed * dt;
    } else {
      cow.hp -= z.dmg * dt;
      if (cow.hp <= 0) toRemoveCows.add(cow.id);
    }
  });

  if (toRemoveCows.size > 0) {
    gameState.cows = gameState.cows.filter(c => !toRemoveCows.has(c.id));
  }

  gameState.zombies = gameState.zombies.filter(z => z.hp > 0);

  endNightIfNoZombies();
}

// ---------------- SOCKET.IO ----------------

io.on("connection", socket => {
  socket.on("join", () => {
    socket.emit("state", gameState);
  });

  socket.on("windowSize", ({ width, height }) => {
    if (width && height) {
      globalWidth = width;
      globalHeight = height;
    }
  });

  socket.on("buyTile", ({ tileIndex }) => {
    const tile = gameState.tiles[tileIndex];
    if (!tile || tile.open) return;

    const price = gameState.nextTilePrice;
    if (!spend(price)) return sendError(socket, "Упс! Не хватает денег.");

    tile.open = true;
    gameState.nextTilePrice += 50;
    broadcastState();
  });

  socket.on("placeCow", ({ tileIndex, type }) => {
    const tile = gameState.tiles[tileIndex];
    if (!tile || !tile.open) return;

    if (gameState.cows.find(c => c.tileIndex === tileIndex)) return;

    if (type === "gold" && countGoldCows() >= 10)
      return sendError(socket, "Лимит золотых коров!");

    const existingCount = gameState.cows.filter(c => c.type === type).length;
    const price = getCowPrice(type, existingCount);

    if (!spend(price)) return sendError(socket, "Упс! Не хватает денег.");

    const base = getCowBaseStats(type);

    gameState.cows.push({
      id: gameState.nextCowId++,
      type,
      tileIndex,
      speedLevel: base.speedLevel,
      healthLevel: base.healthLevel,
      hp: base.maxHp,
      maxHp: base.maxHp,
      lastMilkAt: Date.now()
    });

    broadcastState();
  });

  socket.on("upgradeCow", ({ tileIndex, kind }) => {
    const cow = gameState.cows.find(c => c.tileIndex === tileIndex);
    if (!cow) return;

    if (kind === "speed") {
      const cost = getSpeedUpgradeCost(cow.type, cow.speedLevel);
      if (cost == null) return;
      if (!spend(cost)) return sendError(socket, "Не хватает денег.");
      cow.speedLevel++;
    }

    if (kind === "health") {
      const cost = getHealthUpgradeCost(cow.type, cow.healthLevel);
      if (cost == null) return;
      if (!spend(cost)) return sendError(socket, "Не хватает денег.");
      cow.healthLevel++;
      cow.maxHp = getHealthMax(cow.type, cow.healthLevel);
      cow.hp = cow.maxHp;
    }

    broadcastState();
  });

  socket.on("collectMilk", id => {
    const idx = gameState.milk.findIndex(m => m.id === id);
    if (idx === -1) return;

    const m = gameState.milk[idx];
    gameState.money += m.type === "normal" ? 1 : 2;

    gameState.milk.splice(idx, 1);
    broadcastState();
  });

  socket.on("hitZombie", id => {
    const z = gameState.zombies.find(z => z.id === id);
    if (!z) return;

    z.hp -= 1;
    if (z.hp <= 0)
      gameState.zombies = gameState.zombies.filter(zz => zz.id !== id);

    endNightIfNoZombies();
    broadcastState();
  });
});

// ---------------- ИГРОВОЙ ЦИКЛ ----------------

let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  gameState.cows.forEach(cow => {
    const interval = getSpeedInterval(cow.type, cow.speedLevel);
    if (now - cow.lastMilkAt >= interval) {
      cow.lastMilkAt = now;
      spawnMilkForCow(cow);
    }
  });

  cleanupOldMilk();

  if (!gameState.isNight && now - lastNightStart >= 15 * 60 * 1000) {
    startNight();
  }

  updateZombies(dt);

  broadcastState();
}, 1000);

// ---------------- СТАРТ ----------------

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

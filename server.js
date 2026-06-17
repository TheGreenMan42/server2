const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

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
  io.emit('state', gameState);
}

function sendError(socket, msg) {
  socket.emit('errorMessage', msg);
}

function canAfford(cost) {
  return gameState.money >= cost;
}

function spend(cost) {
  if (!canAfford(cost)) return false;
  gameState.money -= cost;
  return true;
}

function getCowPrice(type, existingCount) {
  if (type === 'normal') {
    if (existingCount === 0) return 0;
    if (existingCount === 1) return 2;
    return Math.pow(2, existingCount);
  } else {
    if (existingCount === 0) return 10;
    return 10 * Math.pow(5, existingCount);
  }
}

function countGoldCows() {
  return gameState.cows.filter(c => c.type === 'gold').length;
}

function getCowBaseStats(type) {
  if (type === 'normal') {
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
  if (type === 'normal') {
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
  if (type === 'normal') {
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
  if (type === 'normal') {
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
  if (type === 'normal') {
    if (level === 0) return 50;
    if (level === 1) return 145;
    return null;
  } else {
    if (level === 0) return 100;
    if (level === 1) return 400;
    return null;
  }
}

function spawnMilkForCow(cow) {
  const id = gameState.nextMilkId++;
  const type = cow.type === 'normal' ? 'normal' : 'gold';
  const x = Math.floor(Math.random() * globalWidth);
  const y = Math.floor(Math.random() * globalHeight);
  const milk = {
    id,
    type,
    x,
    y,
    createdAt: Date.now()
  };
  gameState.milk.push(milk);
  io.emit('cowShake', cow.tileIndex);
}

function cleanupOldMilk() {
  const now = Date.now();
  gameState.milk = gameState.milk.filter(m => now - m.createdAt < 60000);
}

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
    const dist = Math.sqrt(dx*dx + dy*dy);
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
    z.targetCowId = cow.id;

    if (dist > 5) {
      const vx = (cx - z.x) / dist;
      const vy = (cy - z.y) / dist;
      z.x += vx * z.speed * dt;
      z.y += vy * z.speed * dt;
    } else {
      const dmg = z.dmg;
      cow.hp -= dmg * dt;
      if (cow.hp <= 0) {
        toRemoveCows.add(cow.id);
      }
    }
  });

  if (toRemoveCows.size > 0) {
    gameState.cows = gameState.cows.filter(c => !toRemoveCows.has(c.id));
  }

  gameState.zombies = gameState.zombies.filter(z => z.hp > 0);

  endNightIfNoZombies();
}

io.on('connection', (socket) => {
  socket.on('join', () => {
    socket.emit('state', gameState);
  });

  socket.on('windowSize', ({ width, height }) => {
    if (width && height) {
      globalWidth = width;
      globalHeight = height;
    }
  });

  socket.on('buyTile', ({ tileIndex }) => {
    const tile = gameState.tiles[tileIndex];
    if (!tile) return;
    if (tile.open) return;

    const price = gameState.nextTilePrice;
    if (!canAfford(price)) {
      sendError(socket, 'Упс! Кажется у вас не хватает денег.');
      return;
    }
    if (!spend(price)) {
      sendError(socket, 'Упс! Кажется у вас не хватает денег.');
      return;
    }
    tile.open = true;
    gameState.nextTilePrice += 50;
    broadcastState();
  });

  socket.on('placeCow', ({ tileIndex, type }) => {
    const tile = gameState.tiles[tileIndex];
    if (!tile || !tile.open) return;

    const existingCow = gameState.cows.find(c => c.tileIndex === tileIndex);
    if (existingCow) return;

    if (type !== 'normal' && type !== 'gold') return;

    if (type === 'gold' && countGoldCows() >= 10) {
      sendError(socket, 'Лимит золотых коров достигнут (10).');
      return;
    }

    const existingCount = gameState.cows.filter(c => c.type === type).length;
    const price = getCowPrice(type, existingCount);
    if (!canAfford(price)) {
      sendError(socket, 'Упс! Кажется у вас не хватает денег.');
      return;
    }
    if (!spend(price)) {
      sendError(socket, 'Упс! Кажется у вас не хватает денег.');
      return;
    }

    const base = getCowBaseStats(type);
    const cow = {
      id: gameState.nextCowId++,
      type,
      tileIndex,
      speedLevel: base.speedLevel,
      healthLevel: base.healthLevel,
      hp: base.maxHp,
      maxHp: base.maxHp,
      lastMilkAt: Date.now()
    };
    gameState.cows.push(cow);
    broadcastState();
  });

  socket.on('upgradeCow', ({ tileIndex, kind }) => {
    const cow = gameState.cows.find(c => c.tileIndex === tileIndex);
    if (!cow) return;

    if (kind === 'speed') {
      const cost = getSpeedUpgradeCost(cow.type, cow.speedLevel);
      if (cost == null) return;
      if (!canAfford(cost)) {
        sendError(socket, 'Упс! Кажется у вас не хватает денег.');
        return;
      }
      if (!spend(cost)) {
        sendError(socket, 'Упс! Кажется у вас не хватает денег.');
        return;
      }
      cow.speedLevel++;
    } else if (kind === 'health') {
      const cost = getHealthUpgradeCost(cow.type, cow.healthLevel);
      if (cost == null) return;
      if (!canAfford(cost)) {
        sendError(socket, 'Упс! Кажется у вас не хватает денег.');
        return;
      }
      if (!spend(cost)) {
        sendError(socket, 'Упс! Кажется у вас не хватает денег.');
        return;
      }
      cow.healthLevel++;
      cow.maxHp = getHealthMax(cow.type, cow.healthLevel);
      cow.hp = cow.maxHp;
    }

    broadcastState();
  });

  socket.on('collectMilk', (milkId) => {
    const idx = gameState.milk.findIndex(m => m.id === milkId);
    if (idx === -1) return;
    const m = gameState.milk[idx];
    gameState.milk.splice(idx, 1);
    gameState.money += (m.type === 'normal' ? 1 : 2);
    broadcastState();
  });

  socket.on('hitZombie', (zombieId) => {
    const z = gameState.zombies.find(z => z.id === zombieId);
    if (!z) return;
    z.hp -= 1;
    if (z.hp <= 0) {
      gameState.zombies = gameState.zombies.filter(zz => zz.id !== zombieId);
    }
    endNightIfNoZombies();
    broadcastState();
  });
});

let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dtSec = (now - lastTick) / 1000;
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

  updateZombies(dtSec);

  broadcastState();
}, 1000);

server.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});

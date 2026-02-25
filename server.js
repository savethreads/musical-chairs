const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 60000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ── ADMIN CREDENTIALS ──────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'chairs2024';

// ── GAME STATE ─────────────────────────────────────────────────────────────
let gameState = {
  phase: 'waiting',      // waiting | music_playing | music_stopped | ended
  roundNumber: 0,
  musicStopTime: null,   // Date.ms when music stopped this round
  roundTimer: null,      // setTimeout handle for music stop
  nextRoundTimer: null,  // setTimeout handle for next round start
  winner: null,
};

// players[id] = { id, name, status, joinedAt, sitTimestamp, socketId }
// status: 'active' | 'disqualified' | 'eliminated' | 'winner'
const players = new Map();  // socketId -> player object
const playersByName = new Map(); // lowercase name -> socketId
const adminSockets = new Set();

// ── HELPERS ────────────────────────────────────────────────────────────────

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getStats() {
  const all = [...players.values()];
  const active = all.filter(p => p.status === 'active');
  const loggedIn = all.length;
  return {
    loggedIn,
    activePlayers: active.length,
    eliminated: all.filter(p => p.status === 'eliminated').length,
    disqualified: all.filter(p => p.status === 'disqualified').length,
  };
}

function getPlayerList() {
  return [...players.values()].map(p => ({
    name: p.name,
    status: p.status,
    joinedAt: p.joinedAt,
  }));
}

function broadcastAdminUpdate() {
  const payload = {
    stats: getStats(),
    players: getPlayerList(),
    phase: gameState.phase,
    roundNumber: gameState.roundNumber,
    winner: gameState.winner,
  };
  for (const sid of adminSockets) {
    io.to(sid).emit('admin:update', payload);
  }
}

function broadcastToActivePlayers(event, data) {
  for (const [sid, player] of players.entries()) {
    if (player.status === 'active') {
      io.to(sid).emit(event, data);
    }
  }
}

function getActiveCount() {
  return [...players.values()].filter(p => p.status === 'active').length;
}

// ── GAME LOGIC ─────────────────────────────────────────────────────────────

function startRound() {
  const activeCount = getActiveCount();
  if (activeCount <= 1) {
    declareWinner();
    return;
  }

  gameState.roundNumber += 1;
  gameState.phase = 'music_playing';
  gameState.musicStopTime = null;

  // Clear sit timestamps for active players
  for (const player of players.values()) {
    if (player.status === 'active') {
      player.sitTimestamp = null;
    }
  }

  const duration = randomBetween(5000, 15000); // ms

  // Tell all active players: music started
  broadcastToActivePlayers('game:musicStart', {
    round: gameState.roundNumber,
    activePlayers: activeCount,
  });
  broadcastAdminUpdate();

  console.log(`[Round ${gameState.roundNumber}] Music playing for ${duration / 1000}s. Active: ${activeCount}`);

  gameState.roundTimer = setTimeout(() => {
    stopMusic();
  }, duration);
}

function stopMusic() {
  gameState.phase = 'music_stopped';
  gameState.musicStopTime = Date.now();

  console.log(`[Round ${gameState.roundNumber}] Music stopped.`);

  broadcastToActivePlayers('game:musicStop', {
    round: gameState.roundNumber,
    activePlayers: getActiveCount(),
  });
  broadcastAdminUpdate();

  // Give players 5 seconds to press Sit
  gameState.nextRoundTimer = setTimeout(() => {
    eliminateAndContinue();
  }, 5000);
}

function eliminateAndContinue() {
  const activeCount = getActiveCount();

  // Gather players who pressed Sit (sorted by time ascending = fastest first)
  const pressers = [...players.values()]
    .filter(p => p.status === 'active' && p.sitTimestamp !== null)
    .sort((a, b) => a.sitTimestamp - b.sitTimestamp);

  // Players who did NOT press Sit are also eliminated this round
  const nonPressers = [...players.values()]
    .filter(p => p.status === 'active' && p.sitTimestamp === null);

  let toEliminate = [];

  if (activeCount > 10) {
    // Remove last 5 (slowest pressers + non-pressers)
    const slowest = pressers.slice(-5); // last 5 from sorted array
    toEliminate = [...nonPressers, ...slowest].slice(0, 5);
    // Make sure we eliminate exactly 5 unique
    const eliminateSet = new Set();
    for (const p of [...nonPressers, ...pressers.slice().reverse()]) {
      eliminateSet.add(p.id);
      if (eliminateSet.size >= 5) break;
    }
    toEliminate = [...players.values()].filter(p => eliminateSet.has(p.id));
  } else {
    // Remove 1 (slowest or non-presser)
    if (nonPressers.length > 0) {
      toEliminate = [nonPressers[nonPressers.length - 1]];
    } else if (pressers.length > 0) {
      toEliminate = [pressers[pressers.length - 1]]; // slowest
    }
  }

  for (const player of toEliminate) {
    player.status = 'eliminated';
    io.to(player.id).emit('game:eliminated', { reason: 'late', round: gameState.roundNumber });
    console.log(`[Round ${gameState.roundNumber}] Eliminated (late): ${player.name}`);
  }

  broadcastAdminUpdate();

  const remaining = getActiveCount();
  console.log(`[Round ${gameState.roundNumber}] Remaining active: ${remaining}`);

  if (remaining <= 1) {
    declareWinner();
  } else {
    // Short pause then start next round
    setTimeout(() => {
      if (gameState.phase !== 'ended') startRound();
    }, 3000);
  }
}

function declareWinner() {
  gameState.phase = 'ended';
  clearTimeout(gameState.roundTimer);
  clearTimeout(gameState.nextRoundTimer);

  const winner = [...players.values()].find(p => p.status === 'active');
  if (winner) {
    winner.status = 'winner';
    gameState.winner = winner.name;
    io.to(winner.id).emit('game:winner', { name: winner.name });
    console.log(`🏆 WINNER: ${winner.name}`);
  }

  // Notify all players game ended
  io.emit('game:ended', { winner: gameState.winner });
  broadcastAdminUpdate();
}

function resetGame() {
  clearTimeout(gameState.roundTimer);
  clearTimeout(gameState.nextRoundTimer);
  gameState = {
    phase: 'waiting',
    roundNumber: 0,
    musicStopTime: null,
    roundTimer: null,
    nextRoundTimer: null,
    winner: null,
  };
  players.clear();
  playersByName.clear();
  io.emit('game:reset');
  broadcastAdminUpdate();
  console.log('Game reset.');
}

// ── SOCKET.IO EVENTS ───────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // ── ADMIN ──────────────────────────────────────────────────────────────

  socket.on('admin:login', ({ password }, cb) => {
    if (password === ADMIN_PASSWORD) {
      adminSockets.add(socket.id);
      socket.emit('admin:loginResult', { success: true });
      // Send current state
      socket.emit('admin:update', {
        stats: getStats(),
        players: getPlayerList(),
        phase: gameState.phase,
        roundNumber: gameState.roundNumber,
        winner: gameState.winner,
      });
      console.log('Admin logged in:', socket.id);
      if (cb) cb({ success: true });
    } else {
      socket.emit('admin:loginResult', { success: false, message: 'Wrong password' });
      if (cb) cb({ success: false });
    }
  });

  socket.on('admin:startGame', () => {
    if (!adminSockets.has(socket.id)) return;
    if (gameState.phase !== 'waiting') return;
    if (getActiveCount() < 2) {
      socket.emit('admin:error', { message: 'Need at least 2 players to start.' });
      return;
    }
    console.log('Game starting...');
    // Notify all logged-in players
    io.emit('game:starting');
    setTimeout(() => startRound(), 3000);
  });

  socket.on('admin:resetGame', () => {
    if (!adminSockets.has(socket.id)) return;
    resetGame();
  });

  // ── PLAYER ─────────────────────────────────────────────────────────────

  socket.on('player:login', ({ name }, cb) => {
    const trimmed = name ? name.trim() : '';
    if (!trimmed || trimmed.length < 2) {
      return cb && cb({ success: false, message: 'Please enter your full name.' });
    }

    // Block login if game already started
    if (gameState.phase !== 'waiting') {
      return cb && cb({ success: false, message: 'Game has already started. You cannot join now.' });
    }

    const key = trimmed.toLowerCase();
    if (playersByName.has(key)) {
      // If same socket reconnecting, allow
      const existingSocketId = playersByName.get(key);
      if (existingSocketId !== socket.id) {
        return cb && cb({ success: false, message: 'This name is already taken. Please use your unique full name.' });
      }
    }

    const player = {
      id: socket.id,
      name: trimmed,
      status: 'active',
      joinedAt: Date.now(),
      sitTimestamp: null,
    };
    players.set(socket.id, player);
    playersByName.set(key, socket.id);

    console.log(`Player joined: ${trimmed} (${socket.id})`);
    if (cb) cb({ success: true, name: trimmed });

    broadcastAdminUpdate();
    // Tell everyone the player count
    io.emit('game:playerCount', { count: getActiveCount() });
  });

  socket.on('player:sit', () => {
    const player = players.get(socket.id);
    if (!player || player.status !== 'active') return;

    if (gameState.phase === 'music_playing') {
      // Early press — disqualified!
      player.status = 'disqualified';
      socket.emit('game:disqualified', { reason: 'early', name: player.name });
      console.log(`Disqualified (early press): ${player.name}`);
      broadcastAdminUpdate();
      io.emit('game:playerCount', { count: getActiveCount() });
    } else if (gameState.phase === 'music_stopped') {
      // Valid press — record timestamp
      if (player.sitTimestamp === null) {
        player.sitTimestamp = Date.now();
        socket.emit('game:sitAcknowledged', { timestamp: player.sitTimestamp });
        console.log(`Sit recorded: ${player.name} at ${player.sitTimestamp}`);
      }
    }
    // Ignore presses in other phases
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    if (adminSockets.has(socket.id)) {
      adminSockets.delete(socket.id);
      console.log('Admin disconnected:', socket.id);
    }

    const player = players.get(socket.id);
    if (player) {
      console.log(`Player disconnected: ${player.name}`);
      // Keep them in the player list but mark status if still active
      // For robustness: if game not started, remove them entirely
      if (gameState.phase === 'waiting') {
        playersByName.delete(player.name.toLowerCase());
        players.delete(socket.id);
        io.emit('game:playerCount', { count: getActiveCount() });
      }
      broadcastAdminUpdate();
    }
  });
});

// ── START SERVER ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎵 Musical Chairs server running at http://localhost:${PORT}`);
  console.log(`   Admin page: http://localhost:${PORT}/admin.html`);
  console.log(`   Admin password: ${ADMIN_PASSWORD}\n`);
});

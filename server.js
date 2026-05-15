const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const Database = require("better-sqlite3");
const path = require("path");

// ─── Setup ────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database("leaderboard.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    username TEXT PRIMARY KEY,
    wins     INTEGER DEFAULT 0,
    losses   INTEGER DEFAULT 0,
    draws    INTEGER DEFAULT 0
  )
`);

const getPlayer = db.prepare("SELECT * FROM players WHERE username = ?");
const upsertPlayer = db.prepare(`
  INSERT INTO players (username, wins, losses, draws) VALUES (?, 0, 0, 0)
  ON CONFLICT(username) DO NOTHING
`);
const addWin    = db.prepare("UPDATE players SET wins   = wins   + 1 WHERE username = ?");
const addLoss   = db.prepare("UPDATE players SET losses = losses + 1 WHERE username = ?");
const addDraw   = db.prepare("UPDATE players SET draws  = draws  + 1 WHERE username = ?");
const topPlayers = db.prepare(`
  SELECT username, wins, losses, draws,
         ROUND(CAST(wins AS FLOAT) / MAX(wins+losses+draws,1) * 100, 1) AS win_pct
  FROM players
  ORDER BY wins DESC, win_pct DESC
  LIMIT 20
`);

// ─── Game State ───────────────────────────────────────────────────────────────
// rooms: Map<roomId, { players: [{id, username, choice}], code?: string }>
const rooms = new Map();
// queue: waiting socket for random matchmaking
let queue = null;

function getLeaderboard() {
  return topPlayers.all();
}

function resolveRound(a, b) {
  if (a === b) return "draw";
  if (
    (a === "rock" && b === "scissors") ||
    (a === "scissors" && b === "paper") ||
    (a === "paper" && b === "rock")
  ) return "win";
  return "loss";
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("connect:", socket.id);

  // Register username
  socket.on("register", (username) => {
    if (!username || typeof username !== "string") return;
    username = username.trim().slice(0, 20);
    if (!username) return;
    socket.username = username;
    upsertPlayer.run(username);
    socket.emit("registered", { username, leaderboard: getLeaderboard() });
  });

  // ── Random matchmaking ──
  socket.on("join_queue", () => {
    if (!socket.username) return;
    if (queue && queue.id !== socket.id && queue.connected) {
      // Match found
      const roomId = uuidv4();
      const opponent = queue;
      queue = null;

      rooms.set(roomId, {
        players: [
          { id: socket.id, username: socket.username, choice: null },
          { id: opponent.id, username: opponent.username, choice: null },
        ],
      });

      socket.join(roomId);
      opponent.join(roomId);
      socket.roomId = roomId;
      opponent.roomId = roomId;

      io.to(roomId).emit("match_found", {
        roomId,
        players: [socket.username, opponent.username],
      });
    } else {
      queue = socket;
      socket.emit("in_queue");
    }
  });

  socket.on("leave_queue", () => {
    if (queue && queue.id === socket.id) queue = null;
  });

  // ── Private room ──
  socket.on("create_room", () => {
    if (!socket.username) return;
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const roomId = uuidv4();

    rooms.set(roomId, {
      code,
      players: [{ id: socket.id, username: socket.username, choice: null }],
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit("room_created", { roomId, code });
  });

  socket.on("join_room", (code) => {
    if (!socket.username || !code) return;
    code = code.toUpperCase().trim();

    let found = null;
    for (const [roomId, room] of rooms) {
      if (room.code === code && room.players.length === 1) {
        found = { roomId, room };
        break;
      }
    }

    if (!found) {
      socket.emit("error", "Room not found or already full.");
      return;
    }

    const { roomId, room } = found;
    room.players.push({ id: socket.id, username: socket.username, choice: null });
    socket.join(roomId);
    socket.roomId = roomId;

    io.to(roomId).emit("match_found", {
      roomId,
      players: room.players.map((p) => p.username),
    });
  });

  // ── Choice ──
  socket.on("choose", (choice) => {
    if (!["rock", "paper", "scissors"].includes(choice)) return;
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.choice) return; // already chose
    player.choice = choice;

    // Notify opponent that this player has chosen (without revealing choice)
    socket.to(roomId).emit("opponent_chose");

    // Both chose?
    if (room.players.every((p) => p.choice)) {
      const [p1, p2] = room.players;
      const result = resolveRound(p1.choice, p2.choice);

      // Update DB
      if (result === "win") {
        addWin.run(p1.username);
        addLoss.run(p2.username);
      } else if (result === "loss") {
        addLoss.run(p1.username);
        addWin.run(p2.username);
      } else {
        addDraw.run(p1.username);
        addDraw.run(p2.username);
      }

      const lb = getLeaderboard();

      // Send result to each player individually
      io.to(p1.id).emit("round_result", {
        yourChoice: p1.choice,
        opponentChoice: p2.choice,
        result,
        leaderboard: lb,
      });
      io.to(p2.id).emit("round_result", {
        yourChoice: p2.choice,
        opponentChoice: p1.choice,
        result: result === "win" ? "loss" : result === "loss" ? "win" : "draw",
        leaderboard: lb,
      });

      // Reset choices for next round
      room.players.forEach((p) => (p.choice = null));
    }
  });

  // ── Play again ──
  socket.on("play_again", () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (player) player.readyAgain = true;

    if (room.players.every((p) => p.readyAgain)) {
      room.players.forEach((p) => (p.readyAgain = false));
      io.to(roomId).emit("new_round");
    } else {
      socket.to(roomId).emit("opponent_ready_again");
    }
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    console.log("disconnect:", socket.id);
    if (queue && queue.id === socket.id) queue = null;

    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit("opponent_left");
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`RPS server running on http://localhost:${PORT}`);
});

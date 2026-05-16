// server.js
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const { v4: uuid } = require("uuid");
const nodemailer = require("nodemailer");
const path       = require("path");
const cfg        = require("./config");
const db         = require("./db");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Mailer ────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport(cfg.EMAIL);

function sendOTP(email, code) {
  return transporter.sendMail({
    from: cfg.EMAIL.from,
    to: email,
    subject: "Your RPS Login Code",
    html: `
      <div style="font-family:monospace;background:#07070f;color:#e2e2f0;padding:32px;border-radius:12px;max-width:400px">
        <h2 style="color:#f5c542;letter-spacing:.1em">ROCK · PAPER · SCISSORS</h2>
        <p style="margin:16px 0;color:#8888aa">Your one-time login code:</p>
        <div style="font-size:2.4rem;letter-spacing:.3em;color:#fff;font-weight:700">${code}</div>
        <p style="margin-top:16px;color:#4a4a6a;font-size:.8rem">Expires in 10 minutes. Don't share this code.</p>
      </div>
    `,
  });
}

// ── Auth REST routes ───────────────────────────────────────────────────────

// POST /auth/request-otp
app.post("/auth/request-otp", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return res.json({ ok: false, error: "Invalid email." });

  const code    = String(Math.floor(100000 + Math.random() * 900000));
  const expires = Date.now() + cfg.OTP_EXPIRY_MS;
  try {
    await db.upsertOTP(email, code, expires);
    await sendOTP(email, code);
    res.json({ ok: true });
  } catch (e) {
    console.error("OTP error:", e.message);
    res.json({ ok: false, error: "Failed to send email. Check server config." });
  }
});

// POST /auth/verify-otp
app.post("/auth/verify-otp", async (req, res) => {
  const email          = (req.body.email    || "").trim().toLowerCase();
  const code           = (req.body.code     || "").trim();
  const wantedUsername = (req.body.username || "").trim().slice(0, 20);

  try {
    const row = await db.getOTP(email);
    if (!row || row.code !== code) return res.json({ ok: false, error: "Invalid code." });
    if (Date.now() > Number(row.expires)) return res.json({ ok: false, error: "Code expired." });
    await db.deleteOTP(email);

    let user = await db.getUserByEmail(email);
    if (!user) {
      if (!wantedUsername) return res.json({ ok: false, needUsername: true });
      if (await db.getUserByUsername(wantedUsername))
        return res.json({ ok: false, error: "Username taken. Choose another." });
      await db.createUser(email, wantedUsername);
      user = await db.getUserByEmail(email);
    }

    res.json({ ok: true, user: { email: user.email, username: user.username } });
  } catch (e) {
    console.error("verify-otp error:", e.message);
    res.json({ ok: false, error: "Server error." });
  }
});

// GET /leaderboard
app.get("/leaderboard", async (req, res) => {
  try { res.json(await db.getLeaderboard()); }
  catch (e) { res.json([]); }
});

// ── Helpers ───────────────────────────────────────────────────────────────
function getIP(socket) {
  return (
    socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    socket.handshake.address
  );
}

function resolveRound(a, b) {
  if (a === b) return "draw";
  if (
    (a === "rock"     && b === "scissors") ||
    (a === "scissors" && b === "paper")    ||
    (a === "paper"    && b === "rock")
  ) return "win";
  return "loss";
}

async function recordResult(player, result) {
  try {
    if (player.type === "registered") {
      if (result === "win")  await db.addUserWin(player.email);
      if (result === "loss") await db.addUserLoss(player.email);
      if (result === "draw") await db.addUserDraw(player.email);
    } else {
      if (result === "win")  await db.addGuestWin(player.ip);
      if (result === "loss") await db.addGuestLoss(player.ip);
      if (result === "draw") await db.addGuestDraw(player.ip);
    }
  } catch (e) { console.error("recordResult error:", e.message); }
}

// ── Room state ─────────────────────────────────────────────────────────────
const rooms = new Map();
let queue   = null;

function makePlayer(socket) {
  return {
    id:         socket.id,
    username:   socket.identity.username,
    type:       socket.identity.type,
    email:      socket.identity.email || null,
    ip:         socket.identity.ip,
    choice:     null,
    score:      0,
    history:    [],
    readyAgain: false,
    goalAgreed: false,
  };
}

// ── Socket.io ─────────────────────────────────────────────────────────────
io.on("connection", socket => {
  socket.identity = null;

  // ── Identify ──
  socket.on("identify", async ({ type, email, username }) => {
    try {
      if (type === "registered") {
        const user = await db.getUserByEmail(email);
        if (!user) return socket.emit("auth_error", "User not found.");
        socket.identity = { type: "registered", email, username: user.username, ip: getIP(socket) };
      } else {
        const guestIP = getIP(socket);
        await db.upsertGuest(guestIP, username);
        socket.identity = { type: "guest", ip: guestIP, username };
      }
      const leaderboard = await db.getLeaderboard();
      socket.emit("identified", { username: socket.identity.username, leaderboard });
    } catch (e) {
      console.error("identify error:", e.message);
      socket.emit("auth_error", "Server error during login.");
    }
  });

  // ── Queue ──
  socket.on("join_queue", () => {
    if (!socket.identity) return;
    if (queue && queue.id !== socket.id && queue.connected) {
      const roomId = uuid();
      const p1 = makePlayer(queue);
      const p2 = makePlayer(socket);
      rooms.set(roomId, { players: [p1, p2], goal: null, goalProposed: null, goalProposedBy: null });
      socket.join(roomId);
      queue.join(roomId);
      socket.roomId = roomId;
      queue.roomId  = roomId;
      queue = null;
      io.to(roomId).emit("match_found", {
        roomId,
        players: rooms.get(roomId).players.map(p => ({ username: p.username, type: p.type })),
        needGoal: true,
      });
    } else {
      queue = socket;
      socket.emit("in_queue");
    }
  });

  socket.on("leave_queue", () => {
    if (queue?.id === socket.id) queue = null;
    socket.emit("left_queue");
  });

  // ── Private room ──
  socket.on("create_room", ({ goal }) => {
    if (!socket.identity) return;
    const code   = Math.random().toString(36).slice(2, 8).toUpperCase();
    const roomId = uuid();
    const p1     = makePlayer(socket);
    rooms.set(roomId, {
      players: [p1], code,
      goal: goal || null,
      goalProposed: goal || null,
      goalProposedBy: socket.id,
    });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit("room_created", { roomId, code, goal });
  });

  socket.on("join_room", ({ code }) => {
    if (!socket.identity || !code) return;
    code = code.toUpperCase().trim();
    let found = null;
    for (const [roomId, room] of rooms) {
      if (room.code === code && room.players.length === 1) { found = { roomId, room }; break; }
    }
    if (!found) return socket.emit("room_error", "Room not found or already full.");
    const { roomId, room } = found;
    room.players.push(makePlayer(socket));
    socket.join(roomId);
    socket.roomId = roomId;
    io.to(roomId).emit("match_found", {
      roomId,
      players: room.players.map(p => ({ username: p.username, type: p.type })),
      needGoal: !room.goal,
      goal: room.goal,
    });
  });

  // ── Goal negotiation ──
  socket.on("propose_goal", ({ goal }) => {
    goal = parseInt(goal);
    if (!goal || goal < 1 || goal > 99) return;
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.goalProposed   = goal;
    room.goalProposedBy = socket.id;
    room.players.forEach(p => p.goalAgreed = false);
    const proposer = room.players.find(p => p.id === socket.id);
    socket.to(socket.roomId).emit("goal_proposed", { goal, by: proposer?.username });
    socket.emit("goal_proposed_self", { goal });
  });

  socket.on("accept_goal", () => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.goalProposed) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.goalAgreed = true;
    if (room.players.every(p => p.goalAgreed || p.id === room.goalProposedBy)) {
      room.goal = room.goalProposed;
      io.to(socket.roomId).emit("goal_set", { goal: room.goal });
    }
  });

  // ── Choice ──
  socket.on("choose", async choice => {
    if (!["rock","paper","scissors"].includes(choice)) return;
    const room = rooms.get(socket.roomId);
    if (!room || !room.goal) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.choice) return;
    player.choice = choice;
    socket.to(socket.roomId).emit("opponent_chose");

    if (room.players.every(p => p.choice)) {
      const [p1, p2] = room.players;
      const r1 = resolveRound(p1.choice, p2.choice);
      const r2 = r1 === "win" ? "loss" : r1 === "loss" ? "win" : "draw";

      if (r1 === "win")  p1.score++;
      if (r2 === "win")  p2.score++;
      p1.history.push(r1 === "win" ? "W" : r1 === "loss" ? "L" : "D");
      p2.history.push(r2 === "win" ? "W" : r2 === "loss" ? "L" : "D");

      const gameOver = p1.score >= room.goal || p2.score >= room.goal;

      const sendResult = (p, result, oppChoice) => {
        io.to(p.id).emit("round_result", {
          yourChoice: p.choice, opponentChoice: oppChoice, result,
          score:   { you: p.score, opp: room.players.find(x => x.id !== p.id).score },
          history: p.history, goal: room.goal, gameOver,
          winner:  gameOver ? (result === "win" ? "you" : result === "loss" ? "opp" : null) : null,
        });
      };
      sendResult(p1, r1, p2.choice);
      sendResult(p2, r2, p1.choice);

      if (gameOver) {
        const winner = p1.score >= room.goal ? p1 : p2.score >= room.goal ? p2 : null;
        const loser  = winner ? room.players.find(p => p.id !== winner.id) : null;
        if (winner && loser) {
          await recordResult(winner, "win");
          await recordResult(loser,  "loss");
        } else {
          await Promise.all(room.players.map(p => recordResult(p, "draw")));
        }
        try {
          const lb = await db.getLeaderboard();
          io.to(socket.roomId).emit("leaderboard_update", lb);
        } catch (e) {}
      }

      room.players.forEach(p => p.choice = null);
    }
  });

  // ── Play again ──
  socket.on("play_again", () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.readyAgain = true;

    if (room.players.every(p => p.readyAgain)) {
      room.players.forEach(p => { p.readyAgain=false; p.score=0; p.history=[]; p.goalAgreed=false; });
      room.goal = null; room.goalProposed = null; room.goalProposedBy = null;
      io.to(socket.roomId).emit("new_game");
    } else {
      socket.to(socket.roomId).emit("opponent_wants_rematch");
    }
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    if (queue?.id === socket.id) queue = null;
    const roomId = socket.roomId;
    if (roomId) { socket.to(roomId).emit("opponent_left"); rooms.delete(roomId); }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
db.init().then(() => {
  server.listen(cfg.PORT, () => console.log(`RPS server → http://localhost:${cfg.PORT}`));
}).catch(e => { console.error("DB init failed:", e.message); process.exit(1); });

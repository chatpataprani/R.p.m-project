// server.js
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const { v4: uuid } = require("uuid");
const nodemailer = require("nodemailer");
const webpush    = require("web-push");
const path       = require("path");
const cfg        = require("./config");
const db         = require("./db");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ── Admin config (hardcoded) ───────────────────────────────────────────────
const ADMIN_USERNAME = "dumber.4mir";
const ADMIN_PASSWORD = "rps@admin2026";

// ── Web Push VAPID setup ───────────────────────────────────────────────────
// Generate once: node -e "const wp=require('web-push');console.log(wp.generateVAPIDKeys())"
// Then set VAPID_PUBLIC and VAPID_PRIVATE in Render env vars
if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.SMTP_USER || 'admin@rps.com'),
    process.env.VAPID_PUBLIC,
    process.env.VAPID_PRIVATE
  );
}

async function sendPushNotification(username, title, body, data = {}) {
  if (!process.env.VAPID_PUBLIC) return; // push not configured
  try {
    const sub = await db.getPushSub(username);
    if (!sub) return;
    await webpush.sendNotification(sub, JSON.stringify({ title, body, data }));
  } catch (e) {
    if (e.statusCode === 410) await db.deletePushSub(username); // expired
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Mailer ────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport(cfg.EMAIL);

async function sendOTP(email, code) {
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

// ══════════════════════════════════════════════════════════════════ AUTH API

// POST /auth/check-username  { username }
// Step 1: user enters username first — check if taken, check if admin-created
app.post("/auth/check-username", async (req, res) => {
  const username = (req.body.username || "").trim().slice(0, 20);
  if (!username) return res.json({ ok: false, error: "Enter a username." });

  // Admin shortcut
  if (username === ADMIN_USERNAME)
    return res.json({ ok: true, isAdmin: true });

  try {
    const existing = await db.getUserByUsername(username);
    if (existing) {
      if (existing.banned) return res.json({ ok: false, error: "This account has been banned." });
      if (existing.admin_created) {
        // user exists, was added by admin — they can login without email
        return res.json({ ok: true, adminException: true, username });
      }
      // existing registered user — send OTP to their email
      return res.json({ ok: true, existingUser: true, email: existing.email, username });
    }
    // New user — username is free
    return res.json({ ok: true, newUser: true, username });
  } catch (e) {
    console.error("check-username:", e.message);
    res.json({ ok: false, error: "Server error." });
  }
});

// POST /auth/request-otp  { email, username }
app.post("/auth/request-otp", async (req, res) => {
  const email    = (req.body.email || "").trim().toLowerCase();
  const username = (req.body.username || "").trim();
  if (!email || !email.includes("@")) return res.json({ ok: false, error: "Invalid email." });

  // If registering new user, confirm username isn't taken
  if (username) {
    const taken = await db.getUserByUsername(username);
    if (taken) return res.json({ ok: false, error: "Username already taken." });
  }

  const code    = String(Math.floor(100000 + Math.random() * 900000));
  const expires = Date.now() + cfg.OTP_EXPIRY_MS;

  try {
    await db.upsertOTP(email, code, expires);
    await sendOTP(email, code);
    console.log(`OTP for ${email}: ${code}`); // visible in Render logs for debugging
    res.json({ ok: true });
  } catch (e) {
    console.error("sendOTP error:", e.message);
    // Still save OTP so admin can check logs — return specific error
    res.json({ ok: false, error: `Email failed: ${e.message}. Check SMTP config in Render env vars.` });
  }
});

// POST /auth/verify-otp  { email, code, username }
app.post("/auth/verify-otp", async (req, res) => {
  const email    = (req.body.email    || "").trim().toLowerCase();
  const code     = (req.body.code     || "").trim();
  const username = (req.body.username || "").trim().slice(0, 20);

  try {
    const row = await db.getOTP(email);
    if (!row || row.code !== code) return res.json({ ok: false, error: "Invalid code." });
    if (Date.now() > Number(row.expires)) return res.json({ ok: false, error: "Code expired. Request a new one." });
    await db.deleteOTP(email);

    let user = await db.getUserByEmail(email);
    if (!user) {
      // New registration
      if (!username) return res.json({ ok: false, error: "Username missing." });
      await db.createUser(email, username, false);
      user = await db.getUserByEmail(email);
    }

    res.json({ ok: true, user: { email: user.email, username: user.username } });
  } catch (e) {
    console.error("verify-otp:", e.message);
    res.json({ ok: false, error: "Server error." });
  }
});

// POST /auth/admin-login  { password }
app.post("/auth/admin-login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD)
    return res.json({ ok: true });
  res.json({ ok: false, error: "Wrong password." });
});

// ══════════════════════════════════════════════════════════════════ ADMIN API

function requireAdminHeader(req, res, next) {
  if (req.headers["x-admin-password"] === ADMIN_PASSWORD) return next();
  res.status(403).json({ ok: false, error: "Unauthorized." });
}

// GET /admin/users
app.get("/admin/users", requireAdminHeader, async (req, res) => {
  try { res.json(await db.getAllUsers()); }
  catch (e) { res.json([]); }
});

// GET /admin/rooms  — live room count
app.get("/admin/rooms", requireAdminHeader, (req, res) => {
  const roomList = [];
  for (const [id, room] of rooms) {
    roomList.push({
      id,
      code: room.code || null,
      goal: room.goal,
      players: room.players.map(p => ({ username: p.username, score: p.score, type: p.type })),
    });
  }
  res.json({ rooms: roomList, queue: queue ? queue.identity?.username : null });
});

// POST /admin/add-user  { username }
app.post("/admin/add-user", requireAdminHeader, async (req, res) => {
  const username = (req.body.username || "").trim().slice(0, 20);
  if (!username) return res.json({ ok: false, error: "Username required." });
  try {
    const exists = await db.getUserByUsername(username);
    if (exists) return res.json({ ok: false, error: "Username already exists." });
    await db.createUser(null, username, true);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /admin/ban  { username }
app.post("/admin/ban", requireAdminHeader, async (req, res) => {
  try { await db.banUser(req.body.username); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// POST /admin/unban  { username }
app.post("/admin/unban", requireAdminHeader, async (req, res) => {
  try { await db.unbanUser(req.body.username); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// POST /admin/delete  { username }
app.post("/admin/delete", requireAdminHeader, async (req, res) => {
  try { await db.deleteUser(req.body.username); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// GET /leaderboard
app.get("/leaderboard", async (req, res) => {
  try { res.json(await db.getLeaderboard()); }
  catch (e) { res.json([]); }
});

// ══════════════════════════════════════════════════════════════════ PROFILE API

// GET /profile/:username
app.get("/profile/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const user = await db.getProfile(username);
    if (!user) return res.status(404).json({ error: "User not found." });
    const badges  = await db.getUserBadges(username);
    const history = await db.getMatchHistory(username, 20);
    const total   = user.wins + user.losses + user.draws;
    res.json({
      username:     user.username,
      bio:          user.bio || '',
      avatar_emoji: user.avatar_emoji || '🎮',
      avatar_color: user.avatar_color || '#7c6aff',
      wins:         user.wins,
      losses:       user.losses,
      draws:        user.draws,
      win_pct:      total ? Math.round(user.wins / total * 100) : 0,
      win_streak:   user.win_streak,
      best_streak:  user.best_streak,
      created:      user.created,
      badges: badges.map(b => {
        const def = db.BADGE_DEFS.find(d => d.key === b.badge_key);
        return { ...def, earned_at: b.earned_at };
      }).filter(Boolean),
      history,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /profile/update  { username, bio, avatar_emoji, avatar_color }
app.post("/profile/update", async (req, res) => {
  const { username, bio, avatar_emoji, avatar_color } = req.body;
  if (!username) return res.json({ ok: false });
  try {
    await db.updateProfile(username, { bio, avatar_emoji, avatar_color });
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// GET /profile/:username/history
app.get("/profile/:username/history", async (req, res) => {
  try {
    const history = await db.getMatchHistory(req.params.username, 20);
    res.json(history);
  } catch(e) { res.json([]); }
});

// ══════════════════════════════════════════════════════════════════ PUSH API

// GET /push/vapid-public-key
app.get("/push/vapid-public-key", (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC || null });
});

// POST /push/subscribe  { username, subscription }
app.post("/push/subscribe", async (req, res) => {
  const { username, subscription } = req.body;
  if (!username || !subscription) return res.json({ ok: false });
  try {
    await db.savePushSub(username, subscription);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// POST /push/unsubscribe  { username }
app.post("/push/unsubscribe", async (req, res) => {
  try { await db.deletePushSub(req.body.username); res.json({ ok: true }); }
  catch(e) { res.json({ ok: false }); }
});

// ══════════════════════════════════════════════════════════════════ FRIENDS API

// online map: username → { socketId, status: 'online'|'playing' }
const onlineUsers = new Map();

function notifyFriendsStatus(username) {
  // push updated status to all online friends of this user
  db.getFriends(username).then(rows => {
    const accepted = rows.filter(r => r.status === 'accepted').map(r => r.friend);
    accepted.forEach(friend => {
      const s = onlineUsers.get(friend);
      if (s) {
        io.to(s.socketId).emit('friend_status', {
          username,
          status: onlineUsers.get(username)?.status || 'offline',
        });
      }
    });
  }).catch(() => {});
}

// GET /friends  (requires x-username header)
app.get("/friends", async (req, res) => {
  const username = req.headers["x-username"];
  if (!username) return res.json([]);
  try {
    const rows = await db.getFriends(username);
    const pending = await db.getPendingRequests(username);
    const unseen = await db.getUnseenCounts(username);
    const unseenMap = Object.fromEntries(unseen.map(u => [u.sender, parseInt(u.cnt)]));

    const friends = rows
      .filter(r => r.status === 'accepted')
      .map(r => ({
        username: r.friend,
        nickname: r.nickname,
        status: onlineUsers.get(r.friend)?.status || 'offline',
        unseen: unseenMap[r.friend] || 0,
      }));

    res.json({ friends, pending: pending.map(p => p.requester) });
  } catch (e) { res.json({ friends: [], pending: [] }); }
});

// POST /friends/search  { query }
app.post("/friends/search", async (req, res) => {
  const { query, me } = req.body;
  if (!query || query.length < 2) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT username FROM users WHERE username ILIKE $1 AND username != $2 LIMIT 10`,
      [`%${query}%`, me || '']);
    res.json(r.rows.map(u => ({ username: u.username, status: onlineUsers.get(u.username)?.status || 'offline' })));
  } catch (e) { res.json([]); }
});

// POST /friends/request  { from, to }
app.post("/friends/request", async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || from === to) return res.json({ ok: false });
  try {
    await db.sendFriendRequest(from, to);
    const toSocket = onlineUsers.get(to);
    if (toSocket) io.to(toSocket.socketId).emit('friend_request', { from });
    // push notification if offline
    await sendPushNotification(to, '👋 Friend Request', `@${from} wants to be your friend!`, { type:'friend_request', from });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// POST /friends/respond  { from, to, accept }
app.post("/friends/respond", async (req, res) => {
  const { from, to, accept } = req.body;
  try {
    await db.respondFriendRequest(from, to, accept);
    if (accept) {
      const fromSocket = onlineUsers.get(from);
      if (fromSocket) io.to(fromSocket.socketId).emit('friend_accepted', { by: to });
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// POST /friends/remove  { me, friend }
app.post("/friends/remove", async (req, res) => {
  try { await db.removeFriend(req.body.me, req.body.friend); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false }); }
});

// POST /friends/nickname  { me, friend, nickname }
app.post("/friends/nickname", async (req, res) => {
  const { me, friend, nickname } = req.body;
  try { await db.setNickname(me, friend, nickname); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false }); }
});

// GET /friends/messages?a=&b=
app.get("/friends/messages", async (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) return res.json([]);
  try {
    const msgs = await db.getMessages(a, b);
    await db.markSeen(b, a); // mark messages from b as seen by a
    res.json(msgs);
  } catch (e) { res.json([]); }
});

// POST /friends/messages  { sender, receiver, body }
app.post("/friends/messages", async (req, res) => {
  const { sender, receiver, body } = req.body;
  if (!sender || !receiver || !body?.trim()) return res.json({ ok: false });
  try {
    const isFriend = await db.areFriends(sender, receiver);
    if (!isFriend) return res.json({ ok: false, error: "Not friends." });
    const msg = await db.saveMessage(sender, receiver, body.trim().slice(0, 500));
    const toSocket = onlineUsers.get(receiver);
    if (toSocket) io.to(toSocket.socketId).emit('chat_message', msg);
    else await sendPushNotification(receiver, `💬 ${sender}`, body.trim().slice(0, 80), { type:'message', from: sender });
    res.json({ ok: true, msg });
  } catch (e) { res.json({ ok: false }); }
});

// POST /friends/play-invite  { from, to }
app.post("/friends/play-invite", async (req, res) => {
  const { from, to } = req.body;
  try {
    const toSocket = onlineUsers.get(to);
    if (!toSocket || toSocket.status === 'playing')
      return res.json({ ok: false, error: toSocket ? `${to} is already in a game.` : `${to} is offline.` });
    io.to(toSocket.socketId).emit('play_invite', { from });
    await sendPushNotification(to, '⚔️ Challenge!', `@${from} wants to play Rock Paper Scissors!`, { type:'play_invite', from });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// ══════════════════════════════════════════════════════════════════ HELPERS
function getIP(socket) {
  return socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim() || socket.handshake.address;
}

function resolveRound(a, b) {
  if (a === b) return "draw";
  if ((a==="rock"&&b==="scissors")||(a==="scissors"&&b==="paper")||(a==="paper"&&b==="rock")) return "win";
  return "loss";
}

async function recordResult(player, result, opponent, myScore, oppScore, goal) {
  try {
    if (player.type === "registered") {
      if (result==="win") {
        player.email ? await db.addUserWin(player.email) : await db.addUserWinByName(player.username);
        await db.recordStreakWin(player.username);
      }
      if (result==="loss") {
        player.email ? await db.addUserLoss(player.email) : await db.addUserLossByName(player.username);
        await db.resetStreak(player.username);
      }
      if (result==="draw") {
        player.email ? await db.addUserDraw(player.email) : await db.addUserDrawByName(player.username);
      }
      // Match history
      await db.addMatchHistory(player.username, opponent, result, myScore, oppScore, goal);
      // Check + award badges, notify if new
      const newBadges = await db.checkAndAwardBadges(player.username);
      if (newBadges.length > 0) {
        const s = onlineUsers.get(player.username);
        if (s) {
          const defs = newBadges.map(k => db.BADGE_DEFS.find(d=>d.key===k)).filter(Boolean);
          io.to(s.socketId).emit('badges_earned', defs);
        }
      }
    } else {
      if (result==="win")  await db.addGuestWin(player.ip);
      if (result==="loss") await db.addGuestLoss(player.ip);
      if (result==="draw") await db.addGuestDraw(player.ip);
    }
  } catch (e) { console.error("recordResult:", e.message); }
}

// ══════════════════════════════════════════════════════════════════ ROOMS
const rooms = new Map();
let queue   = null;

function makePlayer(socket) {
  return {
    id: socket.id, username: socket.identity.username,
    type: socket.identity.type, email: socket.identity.email||null,
    ip: socket.identity.ip, choice: null, score: 0,
    history: [], readyAgain: false, goalAgreed: false,
  };
}

// ══════════════════════════════════════════════════════════════════ SOCKET.IO
io.on("connection", socket => {
  socket.identity = null;

  socket.on("identify", async ({ type, email, username }) => {
    try {
      if (type === "admin") {
        socket.identity = { type:"admin", username: ADMIN_USERNAME, email:null, ip: getIP(socket) };
        socket.emit("identified", { username: ADMIN_USERNAME, leaderboard: await db.getLeaderboard(), isAdmin: true });
        return;
      }
      if (type === "registered") {
        const user = email
          ? await db.getUserByEmail(email)
          : await db.getUserByUsername(username);
        if (!user) return socket.emit("auth_error", "User not found.");
        if (user.banned) return socket.emit("auth_error", "Your account has been banned.");
        socket.identity = { type:"registered", email: user.email||null, username: user.username, ip: getIP(socket) };
      } else {
        const guestIP = getIP(socket);
        await db.upsertGuest(guestIP, username);
        socket.identity = { type:"guest", ip: getIP(socket), username };
      }
      const lb = await db.getLeaderboard();
      // track online
      onlineUsers.set(socket.identity.username, { socketId: socket.id, status: 'online' });
      notifyFriendsStatus(socket.identity.username);
      socket.emit("identified", { username: socket.identity.username, leaderboard: lb });
    } catch (e) {
      console.error("identify:", e.message);
      socket.emit("auth_error", "Server error.");
    }
  });

  socket.on("join_queue", () => {
    if (!socket.identity || socket.identity.type==="admin") return;
    if (queue && queue.id !== socket.id && queue.connected) {
      const roomId = uuid();
      const p1 = makePlayer(queue), p2 = makePlayer(socket);
      rooms.set(roomId, { players:[p1,p2], goal:null, goalProposed:null, goalProposedBy:null });
      socket.join(roomId); queue.join(roomId);
      socket.roomId = roomId; queue.roomId = roomId;
      // mark both playing
      if(onlineUsers.get(p1.username)) onlineUsers.get(p1.username).status='playing';
      if(onlineUsers.get(p2.username)) onlineUsers.get(p2.username).status='playing';
      notifyFriendsStatus(p1.username); notifyFriendsStatus(p2.username);
      queue = null;
      io.to(roomId).emit("match_found", {
        roomId, needGoal:true,
        players: rooms.get(roomId).players.map(p=>({username:p.username,type:p.type})),
      });
    } else { queue = socket; socket.emit("in_queue"); }
  });

  socket.on("leave_queue", () => { if(queue?.id===socket.id) queue=null; socket.emit("left_queue"); });

  socket.on("create_room", ({ goal }) => {
    if (!socket.identity || socket.identity.type==="admin") return;
    const code=Math.random().toString(36).slice(2,8).toUpperCase(), roomId=uuid();
    rooms.set(roomId,{ players:[makePlayer(socket)], code, goal:goal||null, goalProposed:goal||null, goalProposedBy:socket.id });
    socket.join(roomId); socket.roomId=roomId;
    socket.emit("room_created",{ roomId, code, goal });
  });

  socket.on("join_room", ({ code }) => {
    if (!socket.identity || socket.identity.type==="admin" || !code) return;
    code = code.toUpperCase().trim();
    let found=null;
    for (const [roomId,room] of rooms) {
      if (room.code===code && room.players.length===1) { found={roomId,room}; break; }
    }
    if (!found) return socket.emit("room_error","Room not found or already full.");
    const {roomId,room}=found;
    room.players.push(makePlayer(socket));
    socket.join(roomId); socket.roomId=roomId;
    // mark both playing
    room.players.forEach(p => {
      if(onlineUsers.get(p.username)) onlineUsers.get(p.username).status='playing';
      notifyFriendsStatus(p.username);
    });
    io.to(roomId).emit("match_found",{
      roomId, needGoal:!room.goal, goal:room.goal,
      players:room.players.map(p=>({username:p.username,type:p.type})),
    });
  });

  // accept play invite from friend — join their room or create one
  socket.on("accept_play_invite", ({ from }) => {
    if (!socket.identity) return;
    const me = socket.identity.username;
    // Create a private room for them
    const code = Math.random().toString(36).slice(2,8).toUpperCase();
    const roomId = uuid();
    rooms.set(roomId, { players:[makePlayer(socket)], code, goal:null, goalProposed:null, goalProposedBy:socket.id });
    socket.join(roomId); socket.roomId = roomId;
    // tell the inviter the code
    const fromSocket = onlineUsers.get(from);
    if (fromSocket) io.to(fromSocket.socketId).emit('play_invite_accepted', { by: me, code });
    socket.emit("room_created", { roomId, code, goal: null });
  });

  socket.on("propose_goal", ({ goal }) => {
    goal=parseInt(goal); if(!goal||goal<1||goal>99) return;
    const room=rooms.get(socket.roomId); if(!room) return;
    room.goalProposed=goal; room.goalProposedBy=socket.id;
    room.players.forEach(p=>p.goalAgreed=false);
    const proposer=room.players.find(p=>p.id===socket.id);
    socket.to(socket.roomId).emit("goal_proposed",{goal,by:proposer?.username});
    socket.emit("goal_proposed_self",{goal});
  });

  socket.on("accept_goal", () => {
    const room=rooms.get(socket.roomId); if(!room||!room.goalProposed) return;
    const player=room.players.find(p=>p.id===socket.id); if(!player) return;
    player.goalAgreed=true;
    if (room.players.every(p=>p.goalAgreed||p.id===room.goalProposedBy)) {
      room.goal=room.goalProposed;
      io.to(socket.roomId).emit("goal_set",{goal:room.goal});
    }
  });

  socket.on("choose", async choice => {
    if (!["rock","paper","scissors"].includes(choice)) return;
    const room=rooms.get(socket.roomId); if(!room||!room.goal) return;
    const player=room.players.find(p=>p.id===socket.id); if(!player||player.choice) return;
    player.choice=choice;
    socket.to(socket.roomId).emit("opponent_chose");
    if (!room.players.every(p=>p.choice)) return;

    const [p1,p2]=room.players;
    const r1=resolveRound(p1.choice,p2.choice);
    const r2=r1==="win"?"loss":r1==="loss"?"win":"draw";
    if(r1==="win") p1.score++; if(r2==="win") p2.score++;
    p1.history.push(r1==="win"?"W":r1==="loss"?"L":"D");
    p2.history.push(r2==="win"?"W":r2==="loss"?"L":"D");
    const gameOver=p1.score>=room.goal||p2.score>=room.goal;

    const emit=(p,result,oppChoice)=>io.to(p.id).emit("round_result",{
      yourChoice:p.choice, opponentChoice:oppChoice, result,
      score:{you:p.score,opp:room.players.find(x=>x.id!==p.id).score},
      history:p.history, goal:room.goal, gameOver,
      winner:gameOver?(result==="win"?"you":result==="loss"?"opp":null):null,
    });
    emit(p1,r1,p2.choice); emit(p2,r2,p1.choice);

    if (gameOver) {
      const winner=p1.score>=room.goal?p1:p2.score>=room.goal?p2:null;
      const loser=winner?room.players.find(p=>p.id!==winner.id):null;
      if(winner&&loser){
        await recordResult(winner,"win",  loser.username,  winner.score, loser.score,  room.goal);
        await recordResult(loser, "loss", winner.username, loser.score,  winner.score, room.goal);
      } else {
        await Promise.all(room.players.map(p=>
          recordResult(p,"draw",room.players.find(x=>x.id!==p.id).username,p.score,p.score,room.goal)
        ));
      }
      try { io.to(socket.roomId).emit("leaderboard_update",await db.getLeaderboard()); } catch(e){}
      // reset playing status
      room.players.forEach(p=>{
        const u=onlineUsers.get(p.username);
        if(u) u.status='online';
        notifyFriendsStatus(p.username);
      });
    }
    room.players.forEach(p=>p.choice=null);
  });

  // ── Reactions ──
  socket.on("send_reaction", emoji => {
    const allowed=['👊','🔥','😭','😂','🤝','💀','👑','😤'];
    if(!allowed.includes(emoji)||!socket.roomId) return;
    socket.to(socket.roomId).emit("reaction_received",{ emoji, from: socket.identity?.username });
  });

  socket.on("play_again", () => {
    const room=rooms.get(socket.roomId); if(!room) return;
    const player=room.players.find(p=>p.id===socket.id); if(player) player.readyAgain=true;
    if (room.players.every(p=>p.readyAgain)) {
      room.players.forEach(p=>{p.readyAgain=false;p.score=0;p.history=[];p.goalAgreed=false;});
      room.goal=null; room.goalProposed=null; room.goalProposedBy=null;
      io.to(socket.roomId).emit("new_game");
    } else { socket.to(socket.roomId).emit("opponent_wants_rematch"); }
  });

  socket.on("disconnect", () => {
    if(queue?.id===socket.id) queue=null;
    if(socket.roomId){ socket.to(socket.roomId).emit("opponent_left"); rooms.delete(socket.roomId); }
    if(socket.identity?.username){
      onlineUsers.delete(socket.identity.username);
      notifyFriendsStatus(socket.identity.username);
    }
  });
});

// ══════════════════════════════════════════════════════════════════ START
Promise.all([db.init(), db.initFriends()]).then(()=>{
  server.listen(cfg.PORT,()=>console.log(`RPS → http://localhost:${cfg.PORT}`));
}).catch(e=>{ console.error("DB init failed:",e.message); process.exit(1); });

// db.js — PostgreSQL via Render's DATABASE_URL
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE,
      username      TEXT UNIQUE NOT NULL,
      created       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
      wins          INTEGER DEFAULT 0,
      losses        INTEGER DEFAULT 0,
      draws         INTEGER DEFAULT 0,
      banned        BOOLEAN DEFAULT FALSE,
      admin_created BOOLEAN DEFAULT FALSE,
      bio           TEXT DEFAULT '',
      avatar_emoji  TEXT DEFAULT 'game',
      avatar_color  TEXT DEFAULT '#7c6aff',
      win_streak    INTEGER DEFAULT 0,
      best_streak   INTEGER DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guests (
      ip           TEXT PRIMARY KEY,
      username     TEXT NOT NULL,
      wins         INTEGER DEFAULT 0,
      losses       INTEGER DEFAULT 0,
      draws        INTEGER DEFAULT 0,
      win_streak   INTEGER DEFAULT 0,
      best_streak  INTEGER DEFAULT 0,
      bio          TEXT DEFAULT '',
      avatar_emoji TEXT DEFAULT '🎮',
      avatar_color TEXT DEFAULT '#7c6aff',
      updated      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  // Migrate existing guest rows
  const guestAlters = [
    `ALTER TABLE guests ADD COLUMN IF NOT EXISTS win_streak INTEGER DEFAULT 0`,
    `ALTER TABLE guests ADD COLUMN IF NOT EXISTS best_streak INTEGER DEFAULT 0`,
    `ALTER TABLE guests ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''`,
    `ALTER TABLE guests ADD COLUMN IF NOT EXISTS avatar_emoji TEXT DEFAULT '🎮'`,
    `ALTER TABLE guests ADD COLUMN IF NOT EXISTS avatar_color TEXT DEFAULT '#7c6aff'`,
  ];
  for (const sql of guestAlters) {
    await pool.query(sql).catch(()=>{});
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS otps (
      email   TEXT PRIMARY KEY,
      code    TEXT NOT NULL,
      expires BIGINT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_history (
      id         SERIAL PRIMARY KEY,
      username   TEXT NOT NULL,
      opponent   TEXT NOT NULL,
      result     TEXT NOT NULL,
      my_score   INTEGER DEFAULT 0,
      opp_score  INTEGER DEFAULT 0,
      goal       INTEGER DEFAULT 0,
      played_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS badges (
      id         SERIAL PRIMARY KEY,
      username   TEXT NOT NULL,
      badge_key  TEXT NOT NULL,
      earned_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
      UNIQUE(username, badge_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subs (
      username TEXT PRIMARY KEY,
      sub      TEXT NOT NULL,
      updated  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audio_clips (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      emoji      TEXT DEFAULT '🔊',
      data       TEXT NOT NULL,
      mimetype   TEXT DEFAULT 'audio/mpeg',
      type       TEXT DEFAULT 'chat',
      created    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  // Migrate existing deployments — add new columns one by one safely
  const alters = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_created BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_emoji TEXT DEFAULT 'game'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color TEXT DEFAULT '#7c6aff'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS win_streak INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS best_streak INTEGER DEFAULT 0`,
    `ALTER TABLE users ALTER COLUMN email DROP NOT NULL`,
  ];
  for (const sql of alters) {
    await pool.query(sql).catch(() => {}); // ignore if column already exists
  }

  console.log("DB tables ready.");
}

// ── Users ─────────────────────────────────────────────────────────────────
const q = (sql, p) => pool.query(sql, p);

async function getUserByEmail(email)       { return (await q("SELECT * FROM users WHERE email=$1",[email])).rows[0]||null; }
async function getUserByUsername(username) { return (await q("SELECT * FROM users WHERE username=$1",[username])).rows[0]||null; }
async function createUser(email,username,adminCreated=false){
  await q("INSERT INTO users(email,username,admin_created) VALUES($1,$2,$3)",[email||null,username,adminCreated]);
}
async function addUserWin(email)   { await q("UPDATE users SET wins=wins+1 WHERE email=$1",[email]); }
async function addUserLoss(email)  { await q("UPDATE users SET losses=losses+1 WHERE email=$1",[email]); }
async function addUserDraw(email)  { await q("UPDATE users SET draws=draws+1 WHERE email=$1",[email]); }
async function addUserWinByName(u)  { await q("UPDATE users SET wins=wins+1 WHERE username=$1",[u]); }
async function addUserLossByName(u) { await q("UPDATE users SET losses=losses+1 WHERE username=$1",[u]); }
async function addUserDrawByName(u) { await q("UPDATE users SET draws=draws+1 WHERE username=$1",[u]); }
async function banUser(username)   { await q("UPDATE users SET banned=TRUE WHERE username=$1",[username]); }
async function unbanUser(username) { await q("UPDATE users SET banned=FALSE WHERE username=$1",[username]); }
async function deleteUser(username){ await q("DELETE FROM users WHERE username=$1",[username]); }
async function getAllUsers()       { return (await q("SELECT id,email,username,wins,losses,draws,banned,admin_created,created FROM users ORDER BY created DESC")).rows; }

// ── Guests ────────────────────────────────────────────────────────────────
async function upsertGuest(ip, username){
  await q(`
    INSERT INTO guests(ip, username) VALUES($1, $2)
    ON CONFLICT(ip) DO UPDATE SET username=$2, updated=EXTRACT(EPOCH FROM NOW())
  `, [ip, username]);
}
async function getGuest(ip){ return (await q("SELECT * FROM guests WHERE ip=$1",[ip])).rows[0]||null; }
async function getGuestByUsername(username){ return (await q("SELECT * FROM guests WHERE username=$1",[username])).rows[0]||null; }
async function addGuestWin(ip)  { await q("UPDATE guests SET wins=wins+1, win_streak=win_streak+1, best_streak=GREATEST(best_streak,win_streak+1), updated=EXTRACT(EPOCH FROM NOW()) WHERE ip=$1",[ip]); }
async function addGuestLoss(ip) { await q("UPDATE guests SET losses=losses+1, win_streak=0, updated=EXTRACT(EPOCH FROM NOW()) WHERE ip=$1",[ip]); }
async function addGuestDraw(ip) { await q("UPDATE guests SET draws=draws+1, updated=EXTRACT(EPOCH FROM NOW()) WHERE ip=$1",[ip]); }
async function updateGuestProfile(ip, { bio, avatar_emoji, avatar_color }){
  await q("UPDATE guests SET bio=$2, avatar_emoji=$3, avatar_color=$4, updated=EXTRACT(EPOCH FROM NOW()) WHERE ip=$1",
    [ip, (bio||'').slice(0,160), avatar_emoji||'🎮', avatar_color||'#7c6aff']);
}

// Free guest usernames inactive for 5+ days
async function expireInactiveGuests(){
  const fiveDaysAgo = Math.floor(Date.now()/1000) - (5 * 24 * 60 * 60);
  const r = await q("DELETE FROM guests WHERE updated < $1 RETURNING username", [fiveDaysAgo]);
  if(r.rows.length > 0) console.log(`Expired ${r.rows.length} inactive guest(s):`, r.rows.map(x=>x.username));
}

// Check if a guest username is currently active (within 5 days)
async function getActiveGuestByUsername(username){
  const fiveDaysAgo = Math.floor(Date.now()/1000) - (5 * 24 * 60 * 60);
  const r = await q("SELECT * FROM guests WHERE username=$1 AND updated >= $2", [username, fiveDaysAgo]);
  return r.rows[0]||null;
}

// Admin force-release a guest username
async function releaseGuestUsername(username){
  await q("DELETE FROM guests WHERE username=$1", [username]);
}

// ── OTPs ──────────────────────────────────────────────────────────────────
async function upsertOTP(email,code,expires){
  await q(`INSERT INTO otps(email,code,expires) VALUES($1,$2,$3)
    ON CONFLICT(email) DO UPDATE SET code=$2,expires=$3`,[email,code,expires]);
}
async function getOTP(email)    { return (await q("SELECT * FROM otps WHERE email=$1",[email])).rows[0]||null; }
async function deleteOTP(email) { await q("DELETE FROM otps WHERE email=$1",[email]); }

// ── Leaderboard ───────────────────────────────────────────────────────────
async function getLeaderboard() {
  const r = await pool.query(`
    SELECT username, wins, losses, draws, 'registered' AS type,
      ROUND((CAST(wins AS NUMERIC) / GREATEST(wins+losses+draws, 1) * 100)::NUMERIC, 1) AS win_pct
    FROM users WHERE banned=FALSE
    UNION ALL
    SELECT username, wins, losses, draws, 'guest' AS type,
      ROUND((CAST(wins AS NUMERIC) / GREATEST(wins+losses+draws, 1) * 100)::NUMERIC, 1) AS win_pct
    FROM guests
    ORDER BY wins DESC, win_pct DESC LIMIT 20
  `);
  return r.rows;
}

module.exports = {
  init,
  getUserByEmail,getUserByUsername,createUser,
  addUserWin,addUserLoss,addUserDraw,
  addUserWinByName,addUserLossByName,addUserDrawByName,
  banUser,unbanUser,deleteUser,getAllUsers,
  upsertGuest,getGuest,getGuestByUsername,
  addGuestWin,addGuestLoss,addGuestDraw,
  updateGuestProfile,expireInactiveGuests,
  getActiveGuestByUsername,releaseGuestUsername,
  upsertOTP,getOTP,deleteOTP,
  getLeaderboard,
};

// ── Friends & Messages ────────────────────────────────────────────────────
async function initFriends() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id         SERIAL PRIMARY KEY,
      requester  TEXT NOT NULL,
      addressee  TEXT NOT NULL,
      status     TEXT DEFAULT 'pending',
      nickname   TEXT DEFAULT NULL,
      created    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
      UNIQUE(requester, addressee)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      sender     TEXT NOT NULL,
      receiver   TEXT NOT NULL,
      body       TEXT NOT NULL,
      seen       BOOLEAN DEFAULT FALSE,
      created    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);
}

async function sendFriendRequest(from, to) {
  await pool.query(
    `INSERT INTO friendships (requester, addressee) VALUES ($1, $2)
     ON CONFLICT (requester, addressee) DO NOTHING`, [from, to]);
}

async function respondFriendRequest(from, to, accept) {
  if (accept) {
    await pool.query(
      `UPDATE friendships SET status='accepted' WHERE requester=$1 AND addressee=$2`, [from, to]);
  } else {
    await pool.query(
      `DELETE FROM friendships WHERE requester=$1 AND addressee=$2`, [from, to]);
  }
}

async function removeFriend(a, b) {
  await pool.query(
    `DELETE FROM friendships WHERE (requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1)`, [a, b]);
}

async function setNickname(me, friend, nickname) {
  // store nickname on the row where I am requester or addressee
  await pool.query(`
    UPDATE friendships SET nickname=$3
    WHERE (requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1)
      AND status='accepted'
  `, [me, friend, nickname || null]);
}

async function getFriends(username) {
  const r = await pool.query(`
    SELECT
      CASE WHEN requester=$1 THEN addressee ELSE requester END AS friend,
      status,
      requester,
      addressee,
      nickname,
      created
    FROM friendships
    WHERE (requester=$1 OR addressee=$1)
    ORDER BY created DESC
  `, [username]);
  return r.rows;
}

async function getPendingRequests(username) {
  const r = await pool.query(`
    SELECT requester, created FROM friendships
    WHERE addressee=$1 AND status='pending'
    ORDER BY created DESC
  `, [username]);
  return r.rows;
}

async function areFriends(a, b) {
  const r = await pool.query(
    `SELECT 1 FROM friendships WHERE ((requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1)) AND status='accepted'`,
    [a, b]);
  return r.rows.length > 0;
}

async function saveMessage(sender, receiver, body) {
  const r = await pool.query(
    `INSERT INTO messages (sender, receiver, body) VALUES ($1, $2, $3) RETURNING *`,
    [sender, receiver, body]);
  return r.rows[0];
}

async function getMessages(a, b, limit = 50) {
  const r = await pool.query(`
    SELECT * FROM messages
    WHERE (sender=$1 AND receiver=$2) OR (sender=$2 AND receiver=$1)
    ORDER BY created DESC LIMIT $3
  `, [a, b, limit]);
  return r.rows.reverse();
}

async function markSeen(sender, receiver) {
  await pool.query(
    `UPDATE messages SET seen=TRUE WHERE sender=$1 AND receiver=$2 AND seen=FALSE`,
    [sender, receiver]);
}

async function getUnseenCounts(username) {
  const r = await pool.query(`
    SELECT sender, COUNT(*) AS cnt FROM messages
    WHERE receiver=$1 AND seen=FALSE
    GROUP BY sender
  `, [username]);
  return r.rows; // [{sender, cnt}]
}

module.exports.initFriends          = initFriends;
module.exports.sendFriendRequest    = sendFriendRequest;
module.exports.respondFriendRequest = respondFriendRequest;
module.exports.removeFriend         = removeFriend;
module.exports.setNickname          = setNickname;
module.exports.getFriends           = getFriends;
module.exports.getPendingRequests   = getPendingRequests;
module.exports.areFriends           = areFriends;
module.exports.saveMessage          = saveMessage;
module.exports.getMessages          = getMessages;
module.exports.markSeen             = markSeen;
module.exports.getUnseenCounts      = getUnseenCounts;

// ── Profile ───────────────────────────────────────────────────────────────
async function getProfile(username) {
  const r = await pool.query(`SELECT * FROM users WHERE username=$1`, [username]);
  return r.rows[0] || null;
}

async function updateProfile(username, { bio, avatar_emoji, avatar_color }) {
  await pool.query(
    `UPDATE users SET bio=$2, avatar_emoji=$3, avatar_color=$4 WHERE username=$1`,
    [username, (bio||'').slice(0,160), avatar_emoji||'🎮', avatar_color||'#7c6aff']);
}

// ── Match history ─────────────────────────────────────────────────────────
async function addMatchHistory(username, opponent, result, myScore, oppScore, goal) {
  await pool.query(
    `INSERT INTO match_history (username,opponent,result,my_score,opp_score,goal)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [username, opponent, result, myScore, oppScore, goal]);
}

async function getMatchHistory(username, limit=20) {
  const r = await pool.query(
    `SELECT * FROM match_history WHERE username=$1 ORDER BY played_at DESC LIMIT $2`,
    [username, limit]);
  return r.rows;
}

// ── Streaks ───────────────────────────────────────────────────────────────
async function recordStreakWin(username) {
  await pool.query(`
    UPDATE users
    SET win_streak = win_streak + 1,
        best_streak = GREATEST(best_streak, win_streak + 1)
    WHERE username=$1`, [username]);
}
async function resetStreak(username) {
  await pool.query(`UPDATE users SET win_streak=0 WHERE username=$1`, [username]);
}

// ── Badges ────────────────────────────────────────────────────────────────
const BADGE_DEFS = [
  { key:'first_win',    label:'First Blood',    icon:'🩸', desc:'Win your first match' },
  { key:'wins_10',      label:'Rising Star',    icon:'⭐', desc:'Win 10 matches' },
  { key:'wins_50',      label:'Veteran',        icon:'🎖️', desc:'Win 50 matches' },
  { key:'wins_100',     label:'Legend',         icon:'🏆', desc:'Win 100 matches' },
  { key:'streak_5',     label:'On Fire',        icon:'🔥', desc:'Win 5 in a row' },
  { key:'streak_10',    label:'Unstoppable',    icon:'⚡', desc:'Win 10 in a row' },
  { key:'draw_master',  label:'Draw Master',    icon:'🤝', desc:'Draw 10 matches' },
  { key:'centurion',    label:'Centurion',      icon:'⚔️', desc:'Play 100 matches' },
  { key:'social',       label:'Social Butterfly',icon:'🦋', desc:'Add 5 friends' },
];
module.exports.BADGE_DEFS = BADGE_DEFS;

async function awardBadge(username, badge_key) {
  await pool.query(
    `INSERT INTO badges (username, badge_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [username, badge_key]);
}

async function getUserBadges(username) {
  const r = await pool.query(
    `SELECT badge_key, earned_at FROM badges WHERE username=$1 ORDER BY earned_at ASC`,
    [username]);
  return r.rows;
}

async function checkAndAwardBadges(username, playerType='registered', ip=null) {
  // Get stats from right table
  let stats;
  if (playerType === 'guest' && ip) {
    stats = await getGuest(ip);
  } else {
    stats = await getProfile(username);
  }
  if (!stats) return [];

  const existing = (await getUserBadges(username)).map(b=>b.badge_key);
  const newBadges = [];
  const total = (stats.wins||0) + (stats.losses||0) + (stats.draws||0);

  const check = async (key) => {
    if (!existing.includes(key)) { await awardBadge(username, key); newBadges.push(key); }
  };

  if ((stats.wins||0) >= 1)   await check('first_win');
  if ((stats.wins||0) >= 10)  await check('wins_10');
  if ((stats.wins||0) >= 50)  await check('wins_50');
  if ((stats.wins||0) >= 100) await check('wins_100');
  if ((stats.win_streak||0) >= 5)  await check('streak_5');
  if ((stats.win_streak||0) >= 10) await check('streak_10');
  if ((stats.draws||0) >= 10) await check('draw_master');
  if (total >= 100)            await check('centurion');

  // social badge — check friend count (guests can add friends too)
  const fc = await pool.query(
    `SELECT COUNT(*) FROM friendships WHERE (requester=$1 OR addressee=$1) AND status='accepted'`,
    [username]);
  if (parseInt(fc.rows[0].count) >= 5) await check('social');

  return newBadges;
}

// ── Push subscriptions ────────────────────────────────────────────────────
async function savePushSub(username, sub) {
  await pool.query(
    `INSERT INTO push_subs (username, sub) VALUES ($1,$2)
     ON CONFLICT (username) DO UPDATE SET sub=$2, updated=EXTRACT(EPOCH FROM NOW())`,
    [username, JSON.stringify(sub)]);
}

async function getPushSub(username) {
  const r = await pool.query(`SELECT sub FROM push_subs WHERE username=$1`, [username]);
  return r.rows[0] ? JSON.parse(r.rows[0].sub) : null;
}

async function deletePushSub(username) {
  await pool.query(`DELETE FROM push_subs WHERE username=$1`, [username]);
}

module.exports.getProfile          = getProfile;
module.exports.updateProfile       = updateProfile;
module.exports.addMatchHistory     = addMatchHistory;
module.exports.getMatchHistory     = getMatchHistory;
module.exports.recordStreakWin     = recordStreakWin;
module.exports.resetStreak         = resetStreak;
module.exports.awardBadge          = awardBadge;
module.exports.getUserBadges       = getUserBadges;
module.exports.checkAndAwardBadges = checkAndAwardBadges;
module.exports.savePushSub         = savePushSub;
module.exports.getPushSub          = getPushSub;
module.exports.deletePushSub       = deletePushSub;
module.exports.pool                = pool;

// ── Audio Clips ───────────────────────────────────────────────────────────
async function getAudioClips() {
  // Don't return data field in list — too large
  const r = await pool.query(`SELECT id, name, emoji, mimetype, type, created FROM audio_clips ORDER BY created ASC`);
  return r.rows;
}

async function getAudioClipData(id) {
  const r = await pool.query(`SELECT * FROM audio_clips WHERE id=$1`, [id]);
  return r.rows[0] || null;
}

async function addAudioClip(name, emoji, data, mimetype, type) {
  const r = await pool.query(
    `INSERT INTO audio_clips (name, emoji, data, mimetype, type) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, emoji, mimetype, type, created`,
    [name, emoji||'🔊', data, mimetype||'audio/mpeg', type||'chat']);
  return r.rows[0];
}

async function deleteAudioClip(id) {
  await pool.query(`DELETE FROM audio_clips WHERE id=$1`, [id]);
}

async function getSystemSounds() {
  const r = await pool.query(`SELECT id, name, emoji, mimetype, type FROM audio_clips WHERE type IN ('win','lose','draw') ORDER BY created ASC`);
  return r.rows;
}

module.exports.getAudioClips    = getAudioClips;
module.exports.getAudioClipData = getAudioClipData;
module.exports.addAudioClip     = addAudioClip;
module.exports.deleteAudioClip  = deleteAudioClip;
module.exports.getSystemSounds  = getSystemSounds;

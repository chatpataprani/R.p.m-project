// db.js — PostgreSQL via Render's DATABASE_URL
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required on Render
});

// ── Boot: create tables if they don't exist ───────────────────────────────
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id        SERIAL PRIMARY KEY,
      email     TEXT UNIQUE NOT NULL,
      username  TEXT UNIQUE NOT NULL,
      created   BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
      wins      INTEGER DEFAULT 0,
      losses    INTEGER DEFAULT 0,
      draws     INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS guests (
      ip        TEXT PRIMARY KEY,
      username  TEXT NOT NULL,
      wins      INTEGER DEFAULT 0,
      losses    INTEGER DEFAULT 0,
      draws     INTEGER DEFAULT 0,
      updated   BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    );

    CREATE TABLE IF NOT EXISTS otps (
      email     TEXT PRIMARY KEY,
      code      TEXT NOT NULL,
      expires   BIGINT NOT NULL
    );
  `);
  console.log("DB tables ready.");
}

// ── Users ─────────────────────────────────────────────────────────────────
async function getUserByEmail(email) {
  const r = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return r.rows[0] || null;
}

async function getUserByUsername(username) {
  const r = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  return r.rows[0] || null;
}

async function createUser(email, username) {
  await pool.query("INSERT INTO users (email, username) VALUES ($1, $2)", [email, username]);
}

async function addUserWin(email)  { await pool.query("UPDATE users SET wins   = wins   + 1 WHERE email = $1", [email]); }
async function addUserLoss(email) { await pool.query("UPDATE users SET losses = losses + 1 WHERE email = $1", [email]); }
async function addUserDraw(email) { await pool.query("UPDATE users SET draws  = draws  + 1 WHERE email = $1", [email]); }

// ── Guests ────────────────────────────────────────────────────────────────
async function getGuest(ip) {
  const r = await pool.query("SELECT * FROM guests WHERE ip = $1", [ip]);
  return r.rows[0] || null;
}

async function upsertGuest(ip, username) {
  await pool.query(`
    INSERT INTO guests (ip, username) VALUES ($1, $2)
    ON CONFLICT (ip) DO UPDATE SET username = $2, updated = EXTRACT(EPOCH FROM NOW())
  `, [ip, username]);
}

async function addGuestWin(ip)  { await pool.query("UPDATE guests SET wins   = wins   + 1 WHERE ip = $1", [ip]); }
async function addGuestLoss(ip) { await pool.query("UPDATE guests SET losses = losses + 1 WHERE ip = $1", [ip]); }
async function addGuestDraw(ip) { await pool.query("UPDATE guests SET draws  = draws  + 1 WHERE ip = $1", [ip]); }

// ── OTPs ──────────────────────────────────────────────────────────────────
async function upsertOTP(email, code, expires) {
  await pool.query(`
    INSERT INTO otps (email, code, expires) VALUES ($1, $2, $3)
    ON CONFLICT (email) DO UPDATE SET code = $2, expires = $3
  `, [email, code, expires]);
}

async function getOTP(email) {
  const r = await pool.query("SELECT * FROM otps WHERE email = $1", [email]);
  return r.rows[0] || null;
}

async function deleteOTP(email) {
  await pool.query("DELETE FROM otps WHERE email = $1", [email]);
}

// ── Leaderboard ───────────────────────────────────────────────────────────
async function getLeaderboard() {
  const r = await pool.query(`
    SELECT username, wins, losses, draws,
      ROUND(CAST(wins AS FLOAT) / GREATEST(wins+losses+draws, 1) * 100, 1) AS win_pct
    FROM users
    ORDER BY wins DESC, win_pct DESC
    LIMIT 20
  `);
  return r.rows;
}

module.exports = {
  init,
  getUserByEmail, getUserByUsername, createUser,
  addUserWin, addUserLoss, addUserDraw,
  getGuest, upsertGuest,
  addGuestWin, addGuestLoss, addGuestDraw,
  upsertOTP, getOTP, deleteOTP,
  getLeaderboard,
};

# 🪨 Rock Paper Scissors — Render Deploy Guide

## 📁 Files
```
rps-game-v2/
├── server.js        # Express + Socket.io (async, PostgreSQL)
├── db.js            # PostgreSQL queries via pg
├── config.js        # Email / SMTP config
├── package.json
└── public/
    └── index.html   # Full frontend
```

---

## 🚀 Deploy on Render (Step by Step)

### Step 1 — Push to GitHub
Render deploys from Git. Push your project to a GitHub repo:
```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/rps-game.git
git push -u origin main
```

### Step 2 — Create PostgreSQL Database on Render
1. Go to [render.com](https://render.com) → **New** → **PostgreSQL**
2. Give it a name (e.g. `rps-db`)
3. Choose the **Free** plan
4. Click **Create Database**
5. Once created, copy the **Internal Database URL** (starts with `postgres://`)

### Step 3 — Create Web Service on Render
1. **New** → **Web Service**
2. Connect your GitHub repo
3. Fill in:
   - **Name**: `rps-game`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free

### Step 4 — Set Environment Variables
In your Web Service → **Environment** tab, add these:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | (paste the Internal DB URL from Step 2) |
| `PORT` | `10000` |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `your@gmail.com` |
| `SMTP_PASS` | `your-gmail-app-password` |
| `SMTP_FROM` | `"RPS Game" <your@gmail.com>` |
| `SESSION_SECRET` | any long random string |

> **Gmail App Password**: Google Account → Security → 2-Step Verification → App Passwords → generate one

### Step 5 — Deploy
Click **Deploy** — Render will install deps, connect to Postgres, and go live.

Your app will be at: `https://rps-game.onrender.com`

---

## ⚠️ Render Free Tier Notes
- Web services **spin down after 15 min of inactivity** — first load after sleep takes ~30s
- PostgreSQL free tier has a **90-day limit** then you need to recreate it
- Upgrade to a paid plan ($7/mo) to avoid spindown

---

## ✨ Features
| Feature | Details |
|---|---|
| 📧 Email OTP | 6-digit code, 10-min expiry |
| 👤 Guest Mode | Saved by IP + localStorage |
| 🔐 Private Rooms | 6-char code, host sets goal |
| 🎲 Matchmaking | Queue-based random pairing |
| 🤝 Goal Negotiation | Propose / accept / counter |
| ✊ Hand Animations | Shake + bounce reveal |
| 📊 Round History | W/L/D dots + live score |
| 🏆 Leaderboard | Registered players, all-time wins |
| 💾 PostgreSQL | Persistent data on Render |

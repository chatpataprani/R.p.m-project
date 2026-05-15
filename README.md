# 🪨 Rock Paper Scissors — Online Multiplayer

Real-time multiplayer RPS with random matchmaking, private rooms, and a persistent all-time leaderboard.

## Stack
- **Backend**: Node.js + Express + Socket.io
- **Database**: SQLite (via better-sqlite3) — zero config, file-based
- **Frontend**: Vanilla HTML/CSS/JS (served statically)

---

## 🚀 Deploy on Your VPS

### 1. Install Node.js (if not already)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Upload the project
```bash
# From your local machine:
scp -r rps-game/ user@YOUR_VPS_IP:/home/user/rps-game
```
Or clone/copy however you prefer.

### 3. Install dependencies
```bash
cd /home/user/rps-game
npm install
```

### 4. Run it
```bash
node server.js
# Runs on port 3000 by default
```

---

## 🔁 Keep it running with PM2 (recommended)

```bash
npm install -g pm2
pm2 start server.js --name rps
pm2 save
pm2 startup   # Follow the printed command to auto-start on reboot
```

---

## 🌐 Expose it with Nginx (optional but recommended)

Install Nginx:
```bash
sudo apt install nginx
```

Create a site config at `/etc/nginx/sites-available/rps`:
```nginx
server {
    listen 80;
    server_name yourdomain.com;   # or your VPS IP

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable it:
```bash
sudo ln -s /etc/nginx/sites-available/rps /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Add HTTPS (free with Let's Encrypt):
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Port to listen on |

Set via: `PORT=8080 node server.js` or in PM2 config.

---

## 📁 File Structure
```
rps-game/
├── server.js          # Backend (Express + Socket.io + SQLite)
├── package.json
├── leaderboard.db     # Auto-created on first run
└── public/
    └── index.html     # Frontend (served statically)
```

---

## 🎮 Features
- **Random matchmaking** — join a queue, get paired with anyone online
- **Private rooms** — create a room, get a 6-character code, share with friend
- **Live leaderboard** — updates after every round, shows W/L/D + win%
- **Play again** — both players can rematch without leaving
- **Disconnect handling** — opponent is notified if you leave

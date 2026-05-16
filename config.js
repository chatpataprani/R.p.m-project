// config.js — Edit these before deploying!
module.exports = {
  PORT: process.env.PORT || 3000,

  // ── Email (for OTP) ──────────────────────────────────────────────────────
  // Use Gmail with an App Password, or any SMTP provider (Mailgun, Resend, etc.)
  EMAIL: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER || "your@gmail.com",
      pass: process.env.SMTP_PASS || "your-app-password",
    },
    from: process.env.SMTP_FROM || '"RPS Game" <your@gmail.com>',
  },

  // ── OTP settings ─────────────────────────────────────────────────────────
  OTP_EXPIRY_MS: 10 * 60 * 1000, // 10 minutes

  // ── Session secret ───────────────────────────────────────────────────────
  SESSION_SECRET: process.env.SESSION_SECRET || "change-this-secret-in-production",
};

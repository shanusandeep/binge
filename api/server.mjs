/* ============================================================
   BINGE API — Google sign-in + watched list.
   Zero npm dependencies: node:http + node:sqlite + HMAC cookies.
   Runs behind the edge Caddy at binge.shanuva.com/api/*.
   ============================================================ */
import http from "node:http";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || "/data/binge.db";
const SECRET = process.env.SESSION_SECRET;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ||
  "379841086954-8kkvbj33cbri67e2fldki07tldk61arq.apps.googleusercontent.com";
if (!SECRET) { console.error("SESSION_SECRET required"); process.exit(1); }

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sub TEXT UNIQUE NOT NULL,
    email TEXT, name TEXT, picture TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS watched (
    user_id INTEGER NOT NULL REFERENCES users(id),
    title_key TEXT NOT NULL,
    watched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, title_key)
  );
`);
try { db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT"); } catch { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0"); } catch { /* exists */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );
`);

/* ---------- password hashing: scrypt + per-user salt ---------- */
const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return `s2:${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
};
const verifyPassword = (pw, stored) => {
  const [v, salt, hash] = (stored || "").split(":");
  if (v !== "s2" || !salt || !hash) return false;
  try {
    return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 32), Buffer.from(hash, "hex"));
  } catch { return false; }
};

/* ---------- crude per-IP rate limit for auth endpoints ---------- */
const attempts = new Map();
const rateLimited = (ip) => {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 10 * 60_000) { a.n = 0; a.t = now; }
  a.n++;
  attempts.set(ip, a);
  return a.n > 25;
};

/* ---------- session cookie: "<uid>.<hmac>" ---------- */
const sign = (uid) =>
  `${uid}.${crypto.createHmac("sha256", SECRET).update(String(uid)).digest("base64url")}`;
const verify = (cookieHeader) => {
  const m = /(?:^|;\s*)binge_session=([^;]+)/.exec(cookieHeader || "");
  if (!m) return null;
  const [uid, mac] = m[1].split(".");
  if (!uid || !mac) return null;
  const good = crypto.createHmac("sha256", SECRET).update(uid).digest("base64url");
  try {
    if (crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return Number(uid);
  } catch { /* length mismatch */ }
  return null;
};
const cookie = (v, maxAge) =>
  `binge_session=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/* ---------- helpers ---------- */
const json = (res, code, obj, headers = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 64_000) { reject(new Error("too big")); req.destroy(); } });
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  req.on("error", reject);
});

const userWatched = (uid) =>
  db.prepare("SELECT title_key FROM watched WHERE user_id = ?").all(uid).map((r) => r.title_key);

/* ---------- admin allowlist ----------
   No manual DB flip needed: any account whose email is in ADMIN_EMAILS
   (comma-separated, set in /srv/binge/.env) is promoted the moment it signs
   in — via Google or a normal email/password account, whichever the owner
   already uses. Re-checked on every login so the allowlist can grow later. */
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const syncAdminFlag = (uid, email) => {
  const shouldBeAdmin = ADMIN_EMAILS.has(String(email || "").toLowerCase()) ? 1 : 0;
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ? AND is_admin != ?").run(shouldBeAdmin, uid, shouldBeAdmin);
  return !!shouldBeAdmin;
};

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if (path === "/api/health") return json(res, 200, { ok: true });

    /* trigger the catalogue sync workflow on demand (the same job the 7am
       cron runs). Needs GITHUB_TOKEN with actions:write on the repo. */
    if (path === "/api/sync" && req.method === "POST") {
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
      if (rateLimited(ip)) return json(res, 429, { error: "too many requests — try later" });
      const token = process.env.GITHUB_TOKEN;
      const repo = process.env.GITHUB_REPO || "shanusandeep/binge";
      if (!token)
        return json(res, 503, { error: "sync not configured — add GITHUB_TOKEN on the server" });
      const gh = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/sync.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "binge-api",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main" }),
        }
      );
      if (gh.status === 204)
        return json(res, 200, { ok: true, message: "Sync started — new titles appear within ~30 minutes." });
      return json(res, 502, { error: `GitHub said ${gh.status}` });
    }

    if (path === "/api/auth/google" && req.method === "POST") {
      const { credential } = await readBody(req);
      if (!credential) return json(res, 400, { error: "credential required" });
      const g = await (await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
      )).json();
      if (g.aud !== CLIENT_ID || !g.sub) return json(res, 401, { error: "invalid token" });
      db.prepare(`INSERT INTO users (sub, email, name, picture) VALUES (?, ?, ?, ?)
        ON CONFLICT(sub) DO UPDATE SET email=excluded.email, name=excluded.name, picture=excluded.picture`)
        .run(g.sub, g.email || "", g.name || "", g.picture || "");
      const uid = db.prepare("SELECT id FROM users WHERE sub = ?").get(g.sub).id;
      const isAdmin = syncAdminFlag(uid, g.email);
      return json(res, 200,
        { user: { name: g.name, email: g.email, picture: g.picture, isAdmin }, watched: userWatched(uid) },
        { "Set-Cookie": cookie(sign(uid), 60 * 60 * 24 * 180) });
    }

    if (path === "/api/auth/signup" && req.method === "POST") {
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
      if (rateLimited(ip)) return json(res, 429, { error: "too many attempts — try later" });
      const { name, email, password } = await readBody(req);
      const em = String(email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return json(res, 400, { error: "valid email required" });
      if (typeof password !== "string" || password.length < 8)
        return json(res, 400, { error: "password must be at least 8 characters" });
      const nm = String(name || "").trim().slice(0, 80);
      if (!nm) return json(res, 400, { error: "name required" });
      const existing = db.prepare("SELECT id, password_hash FROM users WHERE lower(email) = ?").get(em);
      if (existing)
        return json(res, 409, { error: existing.password_hash
          ? "account already exists — sign in instead"
          : "this email uses Google sign-in" });
      db.prepare("INSERT INTO users (sub, email, name, password_hash) VALUES (?, ?, ?, ?)")
        .run("email:" + em, em, nm, hashPassword(password));
      const uid = db.prepare("SELECT id FROM users WHERE sub = ?").get("email:" + em).id;
      const isAdmin = syncAdminFlag(uid, em);
      return json(res, 200, { user: { name: nm, email: em, picture: null, isAdmin }, watched: [] },
        { "Set-Cookie": cookie(sign(uid), 60 * 60 * 24 * 180) });
    }

    if (path === "/api/auth/login" && req.method === "POST") {
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
      if (rateLimited(ip)) return json(res, 429, { error: "too many attempts — try later" });
      const { email, password } = await readBody(req);
      const em = String(email || "").trim().toLowerCase();
      const u = db.prepare("SELECT id, name, email, picture, password_hash FROM users WHERE lower(email) = ?").get(em);
      if (!u || !u.password_hash)
        return json(res, 401, { error: u ? "this email uses Google sign-in" : "no account with that email" });
      if (!verifyPassword(String(password || ""), u.password_hash))
        return json(res, 401, { error: "wrong password" });
      const isAdmin = syncAdminFlag(u.id, u.email);
      return json(res, 200,
        { user: { name: u.name, email: u.email, picture: u.picture, isAdmin }, watched: userWatched(u.id) },
        { "Set-Cookie": cookie(sign(u.id), 60 * 60 * 24 * 180) });
    }

    if (path === "/api/auth/forgot" && req.method === "POST") {
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
      if (rateLimited(ip)) return json(res, 429, { error: "too many attempts — try later" });
      const { email } = await readBody(req);
      const em = String(email || "").trim().toLowerCase();
      const u = db.prepare("SELECT id, name, password_hash FROM users WHERE lower(email) = ?").get(em);
      if (u?.password_hash) {
        const token = crypto.randomBytes(32).toString("base64url");
        const th = crypto.createHash("sha256").update(token).digest("hex");
        db.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
          .run(th, u.id, Date.now() + 60 * 60_000);
        const link = `${process.env.RESET_BASE_URL || "https://binge.shanuva.com"}/reset?token=${token}`;
        if (process.env.RESEND_API_KEY) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: process.env.MAIL_FROM || "Binge <onboarding@resend.dev>",
              to: em,
              subject: "Reset your Binge password",
              html: `<p>Hi ${u.name || ""},</p><p><a href="${link}">Reset your Binge password</a> (link valid for 1 hour).</p><p>If you didn't ask for this, ignore this email.</p>`,
            }),
          }).catch((e) => console.error("resend failed", e));
        } else {
          // no mail provider configured — surface the link in server logs so
          // the admin can pass it on manually:  docker logs binge-api
          console.log(`[reset-link] ${em} → ${link}`);
        }
      }
      /* same answer whether or not the account exists — no user enumeration */
      return json(res, 200, { ok: true });
    }

    if (path === "/api/auth/reset" && req.method === "POST") {
      const { token, password } = await readBody(req);
      if (typeof password !== "string" || password.length < 8)
        return json(res, 400, { error: "password must be at least 8 characters" });
      const th = crypto.createHash("sha256").update(String(token || "")).digest("hex");
      const row = db.prepare("SELECT user_id, expires_at, used FROM password_resets WHERE token_hash = ?").get(th);
      if (!row || row.used || row.expires_at < Date.now())
        return json(res, 400, { error: "reset link is invalid or expired — request a new one" });
      db.prepare("UPDATE password_resets SET used = 1 WHERE token_hash = ?").run(th);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), row.user_id);
      const u = db.prepare("SELECT id, name, email, picture FROM users WHERE id = ?").get(row.user_id);
      const isAdmin = syncAdminFlag(u.id, u.email);
      return json(res, 200,
        { user: { name: u.name, email: u.email, picture: u.picture, isAdmin }, watched: userWatched(u.id) },
        { "Set-Cookie": cookie(sign(u.id), 60 * 60 * 24 * 180) });
    }

    if (path === "/api/auth/change-password" && req.method === "POST") {
      const cuid = verify(req.headers.cookie);
      if (!cuid) return json(res, 401, { error: "not signed in" });
      const { current, next } = await readBody(req);
      if (typeof next !== "string" || next.length < 8)
        return json(res, 400, { error: "new password must be at least 8 characters" });
      const u = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(cuid);
      if (!u?.password_hash) return json(res, 400, { error: "this account uses Google sign-in" });
      if (!verifyPassword(String(current || ""), u.password_hash))
        return json(res, 401, { error: "current password is wrong" });
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(next), cuid);
      return json(res, 200, { ok: true });
    }

    if (path === "/api/logout" && req.method === "POST")
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });

    /* everything below needs a session */
    const uid = verify(req.headers.cookie);
    if (!uid) return json(res, 401, { error: "not signed in" });
    const u = db.prepare("SELECT name, email, picture, is_admin FROM users WHERE id = ?").get(uid);
    if (!u) return json(res, 401, { error: "not signed in" });

    if (path === "/api/me")
      return json(res, 200,
        { user: { name: u.name, email: u.email, picture: u.picture, isAdmin: !!u.is_admin }, watched: userWatched(uid) });

    if (path === "/api/admin/stats") {
      if (!u.is_admin) return json(res, 403, { error: "admin only" });

      const totalUsers = db.prepare("SELECT COUNT(*) n FROM users").get().n;
      const newUsers7d = db.prepare("SELECT COUNT(*) n FROM users WHERE created_at >= datetime('now','-7 days')").get().n;
      const googleUsers = db.prepare("SELECT COUNT(*) n FROM users WHERE password_hash IS NULL").get().n;
      const totalWatchMarks = db.prepare("SELECT COUNT(*) n FROM watched").get().n;
      const usersWithWatched = db.prepare("SELECT COUNT(DISTINCT user_id) n FROM watched").get().n;
      const recentUsers = db.prepare(
        "SELECT name, email, created_at, is_admin, (password_hash IS NULL) as google FROM users ORDER BY created_at DESC LIMIT 12"
      ).all();

      // catalogue counts + last sync time live in the static site's data
      // file, not this DB — read it over the shared docker network rather
      // than duplicating the numbers into sqlite.
      let catalogue = null;
      try {
        const webHost = process.env.WEB_INTERNAL_URL || "http://binge-web:80";
        const txt = await (await fetch(`${webHost}/data/titles.js`)).text();
        const jsonText = txt.slice(txt.indexOf("{", txt.indexOf("window.BINGE_DB")), txt.lastIndexOf("}") + 1);
        const dbFile = (0, eval)("(" + jsonText + ")");
        const titles = dbFile.titles || [];
        catalogue = {
          syncedAt: dbFile.syncedAt || null,
          total: titles.length,
          movies: titles.filter((t) => t.type === "movie").length,
          series: titles.filter((t) => t.type === "series").length,
          hindi: titles.filter((t) => t.lang === "hi").length,
          english: titles.filter((t) => t.lang === "en").length,
          withPoster: titles.filter((t) => t.poster).length,
        };
      } catch (e) { console.error("catalogue fetch failed", e.message); }

      return json(res, 200, {
        users: { total: totalUsers, newLast7Days: newUsers7d, viaGoogle: googleUsers, viaPassword: totalUsers - googleUsers },
        watched: { totalMarks: totalWatchMarks, usersWithAtLeastOne: usersWithWatched },
        catalogue,
        recentUsers: recentUsers.map((r) => ({
          name: r.name, email: r.email, joinedAt: r.created_at,
          method: r.google ? "Google" : "Email", isAdmin: !!r.is_admin,
        })),
      });
    }

    if (path === "/api/watched" && req.method === "POST") {
      const { key, watched } = await readBody(req);
      if (typeof key !== "string" || !key || key.length > 200)
        return json(res, 400, { error: "key required" });
      if (watched)
        db.prepare("INSERT OR IGNORE INTO watched (user_id, title_key) VALUES (?, ?)").run(uid, key);
      else
        db.prepare("DELETE FROM watched WHERE user_id = ? AND title_key = ?").run(uid, key);
      return json(res, 200, { watched: userWatched(uid) });
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: "server error" });
  }
});

server.listen(PORT, () => console.log(`binge-api on :${PORT}`));

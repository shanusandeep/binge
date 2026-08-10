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

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if (path === "/api/health") return json(res, 200, { ok: true });

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
      return json(res, 200,
        { user: { name: g.name, email: g.email, picture: g.picture }, watched: userWatched(uid) },
        { "Set-Cookie": cookie(sign(uid), 60 * 60 * 24 * 180) });
    }

    if (path === "/api/logout" && req.method === "POST")
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });

    /* everything below needs a session */
    const uid = verify(req.headers.cookie);
    if (!uid) return json(res, 401, { error: "not signed in" });
    const u = db.prepare("SELECT name, email, picture FROM users WHERE id = ?").get(uid);
    if (!u) return json(res, 401, { error: "not signed in" });

    if (path === "/api/me")
      return json(res, 200, { user: u, watched: userWatched(uid) });

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

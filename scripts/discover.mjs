#!/usr/bin/env node
/* ============================================================
   BINGE — release discovery via Gemini + Google Search
   Finds notable recent Hindi/English movies & web series and
   merges them into data/titles.js (no TMDB key needed).

   Usage:
     GEMINI_API_KEY=xxx node scripts/discover.mjs             # last ~12 months
     GEMINI_API_KEY=xxx node scripts/discover.mjs --year 2026
     GEMINI_API_KEY=xxx node scripts/discover.mjs --dry-run   # print, don't write

   After discovering, run:  node scripts/enrich.mjs --only-missing
   ============================================================ */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_KEY) { console.error("✗ GEMINI_API_KEY required"); process.exit(1); }
// alias that tracks the current flash model — pinned versions get sunset
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const DRY = process.argv.includes("--dry-run");
const yearArg = process.argv[process.argv.indexOf("--year") + 1];
const YEAR = process.argv.includes("--year") ? Number(yearArg) : null;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_FILE = path.join(ROOT, "data", "titles.js");
const GENRES = ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gemini = async (prompt, tries = 4) => {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
      }
    );
    if (res.status === 429 || res.status >= 500) {
      // the API says how long to wait — honour it (plus a little margin)
      const body = await res.text().catch(() => "");
      const hint = body.match(/retry in ([\d.]+)s/i);
      await sleep(hint ? (parseFloat(hint[1]) + 5) * 1000 : 65000);
      continue;
    }
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const d = await res.json();
    return (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  }
  throw new Error("gemini: retries exhausted");
};

/* ---------- load DB ---------- */
const src = await readFile(DB_FILE, "utf8");
const db = (0, eval)("(" + src.slice(src.indexOf("{", src.indexOf("window.BINGE_DB")), src.lastIndexOf("}") + 1) + ")");
const key = (t) => `${t.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}|${t.year}`;
const seen = new Set(db.titles.map(key));
console.log(`● ${db.titles.length} titles in DB`);

/* ---------- ask Gemini per language × type ---------- */
const window_ = YEAR
  ? `released between January and December ${YEAR} (already released only, not upcoming)`
  : `released in the last 12 months (already released only, not upcoming)`;

const asks = [
  ["Hindi", "movie", `the 15 most notable Hindi-language films (Bollywood) ${window_}`],
  ["Hindi", "series", `the 10 most notable Hindi-language Indian web series (new shows or major new seasons) ${window_}`],
  ["English", "movie", `the 8 most notable English-language Hollywood films ${window_}`],
  ["English", "series", `the 6 most notable English-language web/TV series ${window_}`],
];

const found = [];
for (const [lang, type, what] of asks) {
  const prompt = `Use Google Search. List ${what}. Reply with ONLY a JSON array, no markdown fences, where each item has exactly:
{"title": string, "year": number (first release year), "rating": number (current IMDb rating, null if unknown), "genres": array of up to 3 from ${JSON.stringify(GENRES)}, "platform": string (main streaming platform in India: Netflix / Prime Video / JioHotstar / SonyLIV / ZEE5 / Apple TV+ / Theatres), "plot": string (one spoiler-free sentence)}.
Only include titles that actually released; verify each IMDb rating with search. Prefer titles with IMDb rating above 6.`;
  try {
    const text = await gemini(prompt);
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) { console.warn(`  ⚠ no JSON for ${lang} ${type}`); continue; }
    const items = JSON.parse(m[0]);
    for (const it of items) {
      if (!it.title || !Number.isFinite(it.year)) continue;
      const t = {
        title: String(it.title).trim(),
        type,
        year: it.year,
        lang: lang === "Hindi" ? "hi" : "en",
        genres: (Array.isArray(it.genres) ? it.genres.filter((g) => GENRES.includes(g)) : []).slice(0, 3),
        rating: Number.isFinite(it.rating) ? Math.round(it.rating * 10) / 10 : 6.5,
        platform: typeof it.platform === "string" && it.platform ? it.platform : "Theatres",
        plot: typeof it.plot === "string" && it.plot ? it.plot.slice(0, 160) : "Recently released.",
      };
      if (!t.genres.length) t.genres = ["Drama"];
      if (t.rating < 1 || t.rating > 10) t.rating = 6.5;
      if (YEAR && t.year !== YEAR) continue;
      if (seen.has(key(t))) continue;
      seen.add(key(t));
      found.push(t);
    }
    console.log(`  ✓ ${lang} ${type}: ${items.length} returned`);
  } catch (e) {
    console.warn(`  ⚠ ${lang} ${type} failed: ${e.message}`);
  }
  await sleep(7000); // free-tier RPM
}

console.log(`● ${found.length} new titles:`);
for (const t of found) console.log(`  + ${t.title} (${t.year}, ${t.lang}, ${t.rating}) — ${t.platform}`);

if (DRY || !found.length) { console.log(DRY ? "dry run — not writing" : "nothing to add"); process.exit(0); }

/* ---------- write back (same format as enrich.mjs) ---------- */
db.titles.push(...found);
const entry = (t) => {
  const o = {
    title: t.title, type: t.type, year: t.year, lang: t.lang, genres: t.genres,
    rating: t.rating, platform: t.platform, plot: t.plot,
    ...(t.poster && { poster: t.poster }),
    ...(t.desc && { desc: t.desc }),
    ...(t.imdb && { imdb: t.imdb }),
    ...(t.director && { director: t.director }),
    ...(t.cast?.length && { cast: t.cast }),
    ...(t.runtime && { runtime: t.runtime }),
    ...(t.cert && { cert: t.cert }),
    ...(t.collection && { collection: t.collection }),
    ...(t.released && { released: t.released }),
    ...(t.tags?.length && { tags: t.tags }),
    ...(t.episodes && { episodes: t.episodes }),
    ...(t.seasons && { seasons: t.seasons }),
  };
  return "    " + JSON.stringify(o);
};
const out = `/* ============================================================
   BINGE — Title Database (see scripts/sync.mjs, discover.mjs, enrich.mjs)
   ============================================================ */
window.BINGE_DB = {
  syncedAt: ${JSON.stringify(new Date().toISOString().slice(0, 10))},
  titles: [
${db.titles.map(entry).join(",\n")}
  ]
};
`;
await writeFile(DB_FILE, out, "utf8");
console.log(`✓ ${db.titles.length} total → data/titles.js  (now run: node scripts/enrich.mjs --only-missing)`);

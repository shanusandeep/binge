#!/usr/bin/env node
/* ============================================================
   BINGE — catalogue sync
   Pulls latest Hindi + English movies/series from TMDB and
   merges them into data/titles.js (curated entries preserved).

   Usage:
     TMDB_API_KEY=xxxx node scripts/sync.mjs
     TMDB_API_KEY=xxxx OMDB_API_KEY=yyyy node scripts/sync.mjs   # real IMDb ratings

   Keys:
     TMDB — free at https://www.themoviedb.org/settings/api  (v3 key)
     OMDb — free at https://www.omdbapi.com/apikey.aspx      (optional, 1000 req/day)
   ============================================================ */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TMDB_KEY = process.env.TMDB_API_KEY;
const OMDB_KEY = process.env.OMDB_API_KEY;
if (!TMDB_KEY) {
  console.error("✗ TMDB_API_KEY env var is required. Get a free key: https://www.themoviedb.org/settings/api");
  process.exit(1);
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_FILE = path.join(ROOT, "data", "titles.js");
const TMDB = "https://api.themoviedb.org/3";
const MIN_VOTES = 25;          // ignore titles with too few TMDB votes
const LOOKBACK_DAYS = 400;     // how far back "latest" reaches
const PAGES = 3;               // TMDB pages per discover query

const tmdb = async (p, params = {}) => {
  const url = new URL(TMDB + p);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${p} → ${res.status} ${await res.text()}`);
  return res.json();
};

/* ---------- load existing DB ---------- */
const src = await readFile(DB_FILE, "utf8");
const jsonText = src.slice(src.indexOf("{", src.indexOf("window.BINGE_DB")), src.lastIndexOf("}") + 1);
const db = (0, eval)("(" + jsonText + ")"); // our own file, structured as an object literal
const existing = new Map(db.titles.map((t) => [`${t.title.toLowerCase()}|${t.year}`, t]));
console.log(`● Loaded ${existing.size} existing titles`);

/* ---------- genre maps ---------- */
const [gm, gt] = await Promise.all([tmdb("/genre/movie/list"), tmdb("/genre/tv/list")]);
const GENRE_BY_ID = new Map([...gm.genres, ...gt.genres].map((g) => [g.id, g.name]));
const GENRE_NORMALISE = {
  "Science Fiction": "Sci-Fi", "Sci-Fi & Fantasy": "Sci-Fi",
  "Action & Adventure": "Action", "War & Politics": "War",
  "TV Movie": "Drama", Western: "Action", Documentary: "Biography",
  Kids: "Family", Soap: "Drama", Talk: "Drama", News: "Drama", Reality: "Drama",
};
const mapGenres = (ids) =>
  [...new Set(ids.map((id) => GENRE_BY_ID.get(id)).filter(Boolean)
    .map((g) => GENRE_NORMALISE[g] || g))].slice(0, 3);

/* ---------- discover ---------- */
const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
const queries = [
  // Hindi-first: this is the heart of the catalogue
  ...Array.from({ length: PAGES }, (_, i) => ["movie", { with_original_language: "hi", sort_by: "popularity.desc", "primary_release_date.gte": since, page: i + 1 }]),
  ...Array.from({ length: PAGES }, (_, i) => ["tv", { with_original_language: "hi", sort_by: "popularity.desc", "first_air_date.gte": since, page: i + 1 }]),
  // English: just the cream
  ["movie", { with_original_language: "en", sort_by: "vote_average.desc", "vote_count.gte": 500, "primary_release_date.gte": since, page: 1 }],
  ["tv", { with_original_language: "en", sort_by: "vote_average.desc", "vote_count.gte": 300, "first_air_date.gte": since, page: 1 }],
];

const found = [];
for (const [kind, params] of queries) {
  const data = await tmdb(`/discover/${kind}`, params);
  for (const r of data.results || []) {
    const title = (r.title || r.name || "").trim();
    const date = r.release_date || r.first_air_date || "";
    const year = Number(date.slice(0, 4));
    if (!title || !year || r.vote_count < MIN_VOTES) continue;
    const lang = r.original_language === "hi" ? "hi" : "en";
    found.push({
      title,
      type: kind === "movie" ? "movie" : "series",
      year,
      lang,
      genres: mapGenres(r.genre_ids || []),
      rating: Math.round(r.vote_average * 10) / 10,
      platform: "Streaming",
      plot: (r.overview || "").split(/(?<=\.)\s/)[0].slice(0, 140) || "Recently released — synopsis coming soon.",
    });
  }
}
console.log(`● TMDB returned ${found.length} candidate titles since ${since}`);

/* ---------- optional: real IMDb ratings via OMDb ---------- */
const omdbRating = async (t) => {
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB_KEY);
  url.searchParams.set("t", t.title);
  url.searchParams.set("y", String(t.year));
  try {
    const d = await (await fetch(url)).json();
    const r = parseFloat(d.imdbRating);
    return Number.isFinite(r) ? r : null;
  } catch { return null; }
};

/* ---------- merge ---------- */
let added = 0, refreshed = 0;
for (const t of found) {
  const key = `${t.title.toLowerCase()}|${t.year}`;
  const prev = existing.get(key);
  if (prev) {
    // refresh rating only when OMDb gives us a true IMDb score
    if (OMDB_KEY) {
      const r = await omdbRating(t);
      if (r && r !== prev.rating) { prev.rating = r; refreshed++; }
    }
    continue;
  }
  if (t.genres.length === 0) t.genres = ["Drama"];
  if (OMDB_KEY) {
    const r = await omdbRating(t);
    if (r) t.rating = r;
  }
  existing.set(key, t);
  added++;
}

/* ---------- write ---------- */
const titles = [...existing.values()].sort((a, b) =>
  a.lang.localeCompare(b.lang) || a.type.localeCompare(b.type) || b.rating - a.rating);

const entry = (t) => {
  const o = {
    title: t.title, type: t.type, year: t.year, lang: t.lang, genres: t.genres,
    rating: t.rating, platform: t.platform, plot: t.plot,
    // keep fields added by scripts/enrich.mjs
    ...(t.poster && { poster: t.poster }),
    ...(t.desc && { desc: t.desc }),
    ...(t.imdb && { imdb: t.imdb }),
    ...(t.director && { director: t.director }),
    ...(t.cast?.length && { cast: t.cast }),
    ...(t.runtime && { runtime: t.runtime }),
  };
  return "    " + JSON.stringify(o);
};

const out = `/* ============================================================
   BINGE — Title Database (auto-generated by scripts/sync.mjs)
   Ratings are IMDb scores${OMDB_KEY ? "" : " (TMDB scores used for newly synced titles)"}.
   Last sync: ${new Date().toISOString()}
   ============================================================ */
window.BINGE_DB = {
  syncedAt: ${JSON.stringify(new Date().toISOString().slice(0, 10))},
  titles: [
${titles.map(entry).join(",\n")}
  ]
};
`;
await writeFile(DB_FILE, out, "utf8");
console.log(`✓ Sync complete — ${added} added, ${refreshed} ratings refreshed, ${titles.length} total → data/titles.js`);

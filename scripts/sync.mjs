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
// TMDB's userbase is Western-skewed: Hindi web series get single-digit vote
// counts even when hugely popular in India — so the floor must be language-
// and type-aware or Indian series never make it in.
const minVotes = (lang, kind) => (lang === "hi" ? (kind === "tv" ? 3 : 10) : 25);
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
    const lang = r.original_language === "hi" ? "hi" : "en";
    if (!title || !year || r.vote_count < minVotes(lang, kind)) continue;
    let imdb = null;
    try {
      const ext = await tmdb(`/${kind}/${r.id}/external_ids`);
      if (/^tt\d+$/.test(ext.imdb_id || "")) imdb = ext.imdb_id;
    } catch { /* fine — enrich can find it later */ }
    found.push({
      ...(imdb && { imdb }),
      title,
      type: kind === "movie" ? "movie" : "series",
      year,
      lang,
      genres: mapGenres(r.genre_ids || []),
      rating: Math.round(r.vote_average * 10) / 10,
      platform: "Streaming",
      ...(date && { released: date }),
      plot: (r.overview || "").split(/(?<=\.)\s/)[0].slice(0, 140) || "Recently released — synopsis coming soon.",
      ...(r.poster_path && { poster: `https://image.tmdb.org/t/p/w500${r.poster_path}` }),
      ...(r.overview && { desc: r.overview.replace(/\s+/g, " ").trim().slice(0, 550) }),
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

/* ---------- backfill: posters, IMDb ids, episodes, certifications ---------- */
/* prefer the Indian CBFC certificate, fall back to US/GB */
const pickCert = (list) => {
  for (const cc of ["IN", "US", "GB"]) {
    const row = list.find((r) => r.iso_3166_1 === cc);
    const cert = row?.rating || row?.release_dates?.find((x) => x.certification)?.certification;
    if (cert) return cert;
  }
  return null;
};

let backfilled = 0, imdbFilled = 0, epsFilled = 0, certFilled = 0, relFilled = 0;
for (const t of existing.values()) {
  if (t.poster && t.imdb && t.cert && t.released && (t.type === "movie" || t.episodes)) continue;
  try {
    const kind = t.type === "movie" ? "movie" : "tv";
    const params = { query: t.title, [t.type === "movie" ? "year" : "first_air_date_year"]: String(t.year) };
    const d = await tmdb(`/search/${kind}`, params);
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const hit = (d.results || []).find((r) => norm(r.title || r.name).includes(norm(t.title).slice(0, 14)));
    if (!hit) continue;
    if (!t.poster && hit.poster_path) {
      t.poster = `https://image.tmdb.org/t/p/w500${hit.poster_path}`;
      if (!t.desc && hit.overview) t.desc = hit.overview.replace(/\s+/g, " ").trim().slice(0, 550);
      backfilled++;
    }
    if (!t.imdb) {
      const ext = await tmdb(`/${kind}/${hit.id}/external_ids`);
      if (/^tt\d+$/.test(ext.imdb_id || "")) { t.imdb = ext.imdb_id; imdbFilled++; }
    }
    if (t.type === "series" && !t.episodes) {
      const det = await tmdb(`/tv/${hit.id}`);
      if (det.number_of_episodes) { t.episodes = det.number_of_episodes; epsFilled++; }
      if (det.number_of_seasons) t.seasons = det.number_of_seasons;
    }
    if (!t.cert) {
      const cd = t.type === "movie"
        ? await tmdb(`/movie/${hit.id}/release_dates`)
        : await tmdb(`/tv/${hit.id}/content_ratings`);
      const cert = pickCert(cd.results || []);
      if (cert) { t.cert = cert.trim(); certFilled++; }
    }
    if (!t.released) {
      const rd = hit.release_date || hit.first_air_date;
      if (rd) { t.released = rd; relFilled++; }
    }
  } catch { /* leave as-is */ }
}
console.log(`● backfill: ${backfilled} posters, ${imdbFilled} imdb ids, ${epsFilled} episode counts, ${certFilled} certifications, ${relFilled} release dates`);

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
    ...(t.cert && { cert: t.cert }),
    ...(t.released && { released: t.released }),
    ...(t.tags?.length && { tags: t.tags }),
    ...(t.episodes && { episodes: t.episodes }),
    ...(t.seasons && { seasons: t.seasons }),
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

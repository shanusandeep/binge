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
import { gunzipSync } from "node:zlib";

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
// and type-aware or Indian series never make it in. Brand-new Hindi releases
// are even worse (IMDb can have 1.5K votes while TMDB has 2 — Operation
// Safed Sagar case), so anything under ~45 days old needs just one vote;
// the IMDb-dataset step replaces the unreliable early rating anyway.
const minVotes = (lang, kind, date) => {
  const days = date ? (Date.now() - new Date(date).getTime()) / 864e5 : 999;
  if (lang === "hi" && days <= 45) return 1;
  return lang === "hi" ? (kind === "tv" ? 3 : 10) : 25;
};
const LOOKBACK_DAYS = 400;     // how far back "latest" reaches
const PAGES = 3;               // TMDB pages per discover query

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// External-call tally, published to data/sync-stats.json at the end of the
// run so the admin dashboard can show real pipeline usage per service.
const RUN_T0 = Date.now();
const CALLS = { tmdb: 0, omdb: 0, imdbDataset: 0 };

// Backfill re-checks 100+ titles a run with several calls each — without
// retry, a single transient 429/5xx silently aborts that title's update for
// the whole run (this is why Cocktail 2's Netflix arrival got missed: the
// data was there, the request just failed once and nothing tried again).
const tmdb = async (p, params = {}, tries = 4) => {
  const url = new URL(TMDB + p);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let i = 0; i < tries; i++) {
    CALLS.tmdb++;
    const res = await fetch(url);
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) {
      await sleep(800 * 2 ** i + Math.random() * 400);
      continue;
    }
    throw new Error(`TMDB ${p} → ${res.status} ${await res.text()}`);
  }
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
  // ALL-TIME back catalogue — the sweeps above only look at recent releases,
  // which is why classics and franchise entries (Rocky, Batman Begins, The
  // Godfather II…) never arrived. No date filter here on purpose.
  ...Array.from({ length: 6 }, (_, i) => ["movie", { sort_by: "vote_count.desc", page: i + 1 }]),
  ...Array.from({ length: 4 }, (_, i) => ["tv", { sort_by: "vote_count.desc", page: i + 1 }]),
  ...Array.from({ length: 5 }, (_, i) => ["movie", { with_original_language: "hi", sort_by: "vote_count.desc", page: i + 1 }]),
  ...Array.from({ length: 3 }, (_, i) => ["tv", { with_original_language: "hi", sort_by: "vote_count.desc", page: i + 1 }]),
  // Kids & family — 16=Animation, 10751=Family; these rarely surface in the
  // popularity/rating sweeps above, so ask for them explicitly (all-time,
  // not just recent, since family favourites are evergreen)
  ...Array.from({ length: 2 }, (_, i) => ["movie", { with_genres: "16,10751", sort_by: "vote_count.desc", "vote_count.gte": 400, page: i + 1 }]),
  ...Array.from({ length: 2 }, (_, i) => ["movie", { with_genres: "16,10751", with_original_language: "hi", sort_by: "popularity.desc", page: i + 1 }]),
  ["tv", { with_genres: "16,10751", sort_by: "vote_count.desc", "vote_count.gte": 200, page: 1 }],
];

const found = [];
for (const [kind, params] of queries) {
  const data = await tmdb(`/discover/${kind}`, params);
  for (const r of data.results || []) {
    const title = (r.title || r.name || "").trim();
    const date = r.release_date || r.first_air_date || "";
    const year = Number(date.slice(0, 4));
    const lang = r.original_language === "hi" ? "hi" : "en";
    if (!title || !year || r.vote_count < minVotes(lang, kind, date)) continue;
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
    CALLS.omdb++;
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
    if (OMDB_KEY) {
      // true IMDb score wins when available
      const r = await omdbRating(t);
      if (r && r !== prev.rating) { prev.rating = r; refreshed++; }
    } else if (prev.platform === "Streaming" && t.rating && t.rating !== prev.rating) {
      // TMDB-sourced entries: at least track TMDB's own drift
      // (curated entries with named platforms keep their IMDb ratings)
      prev.rating = t.rating;
      refreshed++;
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

/* ---------- streaming platform (India) via TMDB watch providers ---------- */
const PROVIDER_NORMALISE = {
  "Amazon Prime Video": "Prime Video", "Amazon Video": "Prime Video",
  "Netflix basic with Ads": "Netflix", "Netflix Standard with Ads": "Netflix",
  "Hotstar": "JioHotstar", "Disney Plus Hotstar": "JioHotstar",
  "JioCinema": "JioHotstar", "Jio Cinema": "JioHotstar",
  "Sony Liv": "SonyLIV", "Zee5": "ZEE5",
  "Amazon miniTV": "Amazon MX Player", "MX Player": "Amazon MX Player",
  "Apple TV Plus": "Apple TV+", "Apple TV": "Apple TV+",
  "Disney Plus": "Disney+", "Paramount Plus": "Paramount+",
  "Peacock Premium": "Peacock", "HBO Max": "Max",
};
// TMDB tacks on distributor/tier suffixes ("HBO Max Amazon Channel",
// "Paramount Plus Premium") that only add noise to a card label — strip
// them before the exact-match table above, so those still normalise cleanly.
const cleanProviderName = (raw) => {
  const stripped = raw
    .replace(/\s+Amazon Channels?$/i, "")
    .replace(/\s+(Premium|Essential|Basic)$/i, "")
    .trim();
  return PROVIDER_NORMALISE[stripped] || PROVIDER_NORMALISE[raw] || stripped;
};
/* Reads a single TMDB /watch/providers response for BOTH regions at once
   (no extra request) and returns { in, us }, each either null or
   { name, kind: "stream" | "buy" }. Subscription streaming (flatrate/ads/
   free) is reported separately from rent/buy — conflating the two is what
   caused old catalog titles (Rocky 1976, Se7en, Casino Royale — rent/buy
   only in India) to get mislabeled as if they were still in theatres. */
const pickRegion = (region) => {
  if (!region) return null;
  const stream = region.flatrate?.[0] || region.ads?.[0] || region.free?.[0];
  if (stream?.provider_name) return { name: cleanProviderName(stream.provider_name), kind: "stream" };
  const buy = region.buy?.[0] || region.rent?.[0];
  if (buy?.provider_name) return { name: cleanProviderName(buy.provider_name), kind: "buy" };
  return null;
};
const regionPlatforms = async (kind, id) => {
  try {
    const d = await tmdb(`/${kind}/${id}/watch/providers`);
    return { in: pickRegion(d.results?.IN), us: pickRegion(d.results?.US) };
  } catch { return { in: null, us: null }; }
};
// back-compat shim: existing call sites only need the India side
const indianPlatform = async (kind, id) => (await regionPlatforms(kind, id)).in;

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

let backfilled = 0, imdbFilled = 0, epsFilled = 0, certFilled = 0, relFilled = 0, platFilled = 0, usPlatFilled = 0;
for (const t of existing.values()) {
  if (t.poster && t.imdb && t.cert && t.released && t.usChecked &&
      !["Streaming", "Theatres"].includes(t.platform) && // re-check until OTT arrival
      (t.type === "movie" || t.episodes)) continue;
  try {
    const kind = t.type === "movie" ? "movie" : "tv";
    const params = { query: t.title, [t.type === "movie" ? "year" : "first_air_date_year"]: String(t.year) };
    const d = await tmdb(`/search/${kind}`, params);
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    // strict prefix match in EITHER direction — a plain .includes() let
    // "Sitaare Zameen Par" swallow "Taare Zameen Par" (and Rambo III / Rambo)
    // because the substring happened to appear inside the longer title
    const nt = norm(t.title);
    const hit = (d.results || []).find((r) => {
      const nr = norm(r.title || r.name);
      if (!(nr === nt || nr.startsWith(nt) || nt.startsWith(nr))) return false;
      const ry = Number((r.release_date || r.first_air_date || "").slice(0, 4));
      return !ry || Math.abs(ry - t.year) <= 1; // TMDB's year param isn't strictly enforced
    });
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
    if (!t.usChecked || ["Streaming", "Theatres"].includes(t.platform)) {
      const { in: plat, us } = await regionPlatforms(kind, hit.id);
      if (plat?.kind === "stream") { t.platform = plat.name; platFilled++; }
      else if (plat?.kind === "buy") { t.platform = `${plat.name} (Buy/Rent)`; platFilled++; }
      else if (["Streaming", "Theatres"].includes(t.platform)) {
        // No India provider info anywhere. "Theatres" is only a truthful
        // label for a genuinely recent release still awaiting OTT — never
        // stamp it on an old catalog title just because TMDB lacks data.
        const days = t.released ? (Date.now() - new Date(t.released).getTime()) / 864e5 : 9999;
        if (t.type === "movie" && days >= 0 && days <= 180) t.platform = "Theatres";
      }
      // US availability, shown to US visitors in place of the India platform
      // (JioHotstar/ZEE5/SonyLIV mean nothing outside India) — separate field
      // so the India-facing majority of the catalogue is untouched.
      if (us?.kind === "stream") { t.platformUs = us.name; usPlatFilled++; }
      else if (us?.kind === "buy") { t.platformUs = `${us.name} (Buy/Rent)`; usPlatFilled++; }
      else delete t.platformUs;
      t.usChecked = true;
    }
  } catch { /* leave as-is — will retry next sync */ }
  await sleep(60); // stay well clear of TMDB's rate limit across ~100+ rechecks
}
console.log(`● backfill: ${backfilled} posters, ${imdbFilled} imdb ids, ${epsFilled} episode counts, ${certFilled} certifications, ${relFilled} release dates, ${platFilled} IN platforms, ${usPlatFilled} US platforms`);

/* ---------- seed iconic franchises ----------
   Collection expansion can only follow films we already hold, so seed the
   series that the popularity sweeps miss. Each seed pulls in its whole
   collection in the step below. */
const FRANCHISE_SEEDS = [
  "Rocky", "Rambo: First Blood", "Star Wars", "The Lord of the Rings: The Fellowship of the Ring",
  "Harry Potter and the Philosopher's Stone", "Mission: Impossible", "John Wick",
  "The Fast and the Furious", "Jurassic Park", "Raiders of the Lost Ark", "The Terminator",
  "Alien", "Die Hard", "Back to the Future", "Ghostbusters", "Men in Black",
  "Pirates of the Caribbean: The Curse of the Black Pearl", "X-Men", "Deadpool",
  "Thor", "Guardians of the Galaxy", "Doctor Strange", "Black Panther", "Ant-Man",
  "Casino Royale", "The Bourne Identity", "The Hunger Games", "Planet of the Apes",
  "Sherlock Holmes", "Ocean's Eleven", "Shrek", "Despicable Me", "Home Alone",
  "Kung Fu Panda", "How to Train Your Dragon", "Ice Age", "Madagascar", "Frozen",
  "Cars", "Finding Nemo", "Monsters, Inc.", "Inside Out", "Zootopia", "Moana",
  "The Conjuring", "Insidious", "Scream", "Saw", "Rush Hour", "Bad Boys",
  // Hindi franchises
  "Dhoom", "Golmaal", "Housefull", "Krrish", "Don", "Race", "Singham", "Baaghi",
  "Ek Tha Tiger", "Dabangg", "Welcome", "Gadar: Ek Prem Katha", "Sooryavanshi",
  "Tanhaji", "Raid", "De De Pyaar De", "Fukrey", "Student of the Year",
];
let seeded = 0;
for (const name of FRANCHISE_SEEDS) {
  try {
    const s = await tmdb("/search/movie", { query: name });
    const hit = (s.results || []).find((r) => r.vote_count > 200);
    if (!hit) continue;
    const date = hit.release_date || "";
    const year = Number(date.slice(0, 4));
    const title = (hit.title || "").trim();
    if (!title || !year) continue;
    const key = `${title.toLowerCase()}|${year}`;
    if (existing.has(key)) continue;
    existing.set(key, {
      title, type: "movie", year,
      lang: hit.original_language === "hi" ? "hi" : "en",
      genres: mapGenres(hit.genre_ids || []).length ? mapGenres(hit.genre_ids || []) : ["Drama"],
      rating: Math.round((hit.vote_average || 7) * 10) / 10,
      platform: "Streaming",
      ...(date && { released: date }),
      plot: (hit.overview || "").split(/(?<=\.)\s/)[0].slice(0, 140) || "A modern classic.",
      ...(hit.poster_path && { poster: `https://image.tmdb.org/t/p/w500${hit.poster_path}` }),
      ...(hit.overview && { desc: hit.overview.replace(/\s+/g, " ").trim().slice(0, 550) }),
    });
    seeded++;
  } catch { /* skip */ }
}
console.log(`● franchise seeds: ${seeded} added`);

/* ---------- franchise expansion via TMDB collections ----------
   A film that belongs to a collection (Rocky, The Dark Knight Trilogy,
   The Matrix, The Godfather, MCU entries…) drags in all of its siblings,
   so searching "Batman" or "Rocky" returns the whole series. */
const seenCollections = new Set();
let franchiseAdded = 0;
for (const t of [...existing.values()]) {
  if (t.type !== "movie" || t.lang !== "en") continue; // Hindi films rarely use collections
  try {
    const s = await tmdb("/search/movie", { query: t.title, year: String(t.year) });
    const hit = (s.results || [])[0];
    if (!hit) continue;
    const det = await tmdb(`/movie/${hit.id}`);
    const col = det.belongs_to_collection;
    if (!col) continue;
    /* remember the franchise name on the seed film so searching the series
       name ("Batman") finds every entry ("The Dark Knight") */
    const colName = col.name.replace(/\s*(Collection|Series|Saga|Trilogy)\s*$/i, "").trim();
    if (colName) t.collection = colName;
    if (seenCollections.has(col.id)) continue;
    seenCollections.add(col.id);
    const parts = (await tmdb(`/collection/${col.id}`)).parts || [];
    for (const p of parts) {
      const date = p.release_date || "";
      const year = Number(date.slice(0, 4));
      const title = (p.title || "").trim();
      if (!title || !year || year > new Date().getFullYear()) continue;
      if (p.vote_count < 50) continue;               // skip obscure spin-offs
      const key = `${title.toLowerCase()}|${year}`;
      if (existing.has(key)) continue;
      existing.set(key, {
        title, type: "movie", year,
        lang: p.original_language === "hi" ? "hi" : "en",
        genres: mapGenres(p.genre_ids || []).length ? mapGenres(p.genre_ids || []) : ["Drama"],
        rating: Math.round((p.vote_average || 6.5) * 10) / 10,
        platform: "Streaming",
        ...(date && { released: date }),
        ...(colName && { collection: colName }),
        plot: (p.overview || "").split(/(?<=\.)\s/)[0].slice(0, 140) || "Part of the series.",
        ...(p.poster_path && { poster: `https://image.tmdb.org/t/p/w500${p.poster_path}` }),
        ...(p.overview && { desc: p.overview.replace(/\s+/g, " ").trim().slice(0, 550) }),
      });
      franchiseAdded++;
    }
  } catch { /* skip this title */ }
}
console.log(`● franchises: ${franchiseAdded} sequels/prequels added from ${seenCollections.size} collections`);

/* ---------- universe tags (Marvel / DC) ----------
   TMDB's "collection" is per-franchise (Iron Man, Thor, The Avengers…) with
   no umbrella grouping, so searching "Marvel" or "DC" found nothing even
   though every MCU film was already in the catalogue under its own series.
   Stamp a shared tag across every collection in each universe so the
   existing tag-search picks the whole universe up in one query. Runs every
   sync, so any newly-discovered franchise entry gets tagged immediately. */
const MCU_COLLECTIONS = new Set([
  "Iron Man", "Captain America", "The Avengers", "Thor", "Doctor Strange",
  "Black Panther", "Ant-Man", "Guardians of the Galaxy", "Spider-Man (MCU)",
  "Captain Marvel", "Eternals", "Shang-Chi", "Black Widow",
]);
const MARVEL_ONLY_COLLECTIONS = new Set([
  "X-Men", "The Wolverine", "Deadpool", "Venom", "Fantastic Four",
  "Spider-Man", "The Amazing Spider-Man", "Spider-Man: Spider-Verse",
]);
const DC_COLLECTIONS = new Set([
  "The Dark Knight", "The Batman", "Man of Steel", "Wonder Woman",
  "Suicide Squad", "Superman (DCU)", "Aquaman", "Shazam", "Joker",
]);
let universeTagged = 0;
for (const t of existing.values()) {
  if (!t.collection) continue;
  const tags = new Set(t.tags || []);
  const before = tags.size;
  if (MCU_COLLECTIONS.has(t.collection)) { tags.add("Marvel"); tags.add("MCU"); }
  else if (MARVEL_ONLY_COLLECTIONS.has(t.collection)) { tags.add("Marvel"); }
  else if (DC_COLLECTIONS.has(t.collection)) { tags.add("DC"); }
  if (tags.size !== before) { t.tags = [...tags]; universeTagged++; }
}
console.log(`● universe tags: ${universeTagged} titles tagged Marvel/DC`);

/* ---------- de-dup by IMDb id ----------
   The title-matching used to be loose enough that TMDB re-titling a show
   between syncs (Operation Safed Sagar's subtitle changed) — or a stray
   fuzzy-match false positive (Taare Zameen Par ⊂ Sitaare Zameen Par) —
   could attach the same IMDb id to two different rows, or the wrong id to
   two genuinely different films. Same year + same id = one release, listed
   twice → merge. Different year + same id = the id was mis-assigned to at
   least one of them → clear it from both so the next run re-resolves each
   independently under the now-stricter matcher above. */
const byImdb = new Map();
for (const [key, t] of existing) {
  if (!t.imdb) continue;
  if (!byImdb.has(t.imdb)) byImdb.set(t.imdb, []);
  byImdb.get(t.imdb).push([key, t]);
}
let merged = 0, clearedMismatch = 0;
for (const rows of byImdb.values()) {
  if (rows.length < 2) continue;
  const sameYear = rows.every(([, t]) => t.year === rows[0][1].year);
  if (sameYear) {
    // keep the most complete row, folding in any field only the others have
    const score = (t) => ["poster", "desc", "director", "cast", "cert", "runtime", "episodes", "collection"]
      .reduce((n, f) => n + (t[f] && (!Array.isArray(t[f]) || t[f].length) ? 1 : 0), 0);
    rows.sort((a, b) => score(b[1]) - score(a[1]) || a[1].title.length - b[1].title.length);
    const [keepKey, keep] = rows[0];
    for (const [dropKey, drop] of rows.slice(1)) {
      for (const f of ["poster", "desc", "director", "cast", "cert", "runtime", "episodes", "seasons", "collection", "released", "tags", "platformUs", "usChecked"])
        if (keep[f] == null || (Array.isArray(keep[f]) && !keep[f].length)) keep[f] = drop[f];
      existing.delete(dropKey);
      merged++;
    }
  } else {
    for (const [, t] of rows) delete t.imdb;
    clearedMismatch += rows.length;
  }
}
if (merged || clearedMismatch)
  console.log(`● de-dup: ${merged} duplicate rows merged, ${clearedMismatch} mismatched imdb ids cleared for re-resolution`);

/* ---------- true IMDb ratings from IMDb's official daily dataset ----------
   https://datasets.imdbws.com/title.ratings.tsv.gz — no key, exact scores
   for every tt id we hold. Overrides TMDB approximations everywhere. */
try {
  CALLS.imdbDataset++;
  const res = await fetch("https://datasets.imdbws.com/title.ratings.tsv.gz");
  if (!res.ok) throw new Error(`dataset ${res.status}`);
  const tsv = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
  const wanted = new Map();
  for (const t of existing.values()) if (t.imdb) wanted.set(t.imdb, t);
  let imdbExact = 0;
  for (const line of tsv.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const t = wanted.get(line.slice(0, tab));
    if (!t) continue;
    const rating = Number(line.slice(tab + 1, line.indexOf("\t", tab + 1)));
    if (rating >= 1 && rating <= 10 && rating !== t.rating) { t.rating = rating; imdbExact++; }
  }
  console.log(`● IMDb dataset: ${imdbExact} ratings set to exact IMDb scores (${wanted.size} ids matched against)`);
} catch (e) {
  console.warn(`⚠ IMDb dataset unavailable (${e.message}) — keeping existing ratings`);
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
    ...(t.cert && { cert: t.cert }),
    ...(t.collection && { collection: t.collection }),
    ...(t.released && { released: t.released }),
    ...(t.tags?.length && { tags: t.tags }),
    ...(t.episodes && { episodes: t.episodes }),
    ...(t.seasons && { seasons: t.seasons }),
    ...(t.platformUs && { platformUs: t.platformUs }),
    ...(t.usChecked && { usChecked: 1 }),
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

/* publish run stats for the admin dashboard — keep the previous enrich
   section (enrich.mjs runs after us and overwrites its own section) */
const STATS_FILE = path.join(ROOT, "data", "sync-stats.json");
let prevStats = {};
try { prevStats = JSON.parse(await readFile(STATS_FILE, "utf8")); } catch { /* first run */ }
await writeFile(STATS_FILE, JSON.stringify({
  ...prevStats,
  sync: {
    at: new Date().toISOString(),
    durationSec: Math.round((Date.now() - RUN_T0) / 1000),
    added, refreshed, total: titles.length,
    calls: CALLS,
  },
}, null, 2) + "\n", "utf8");

console.log(`✓ Sync complete — ${added} added, ${refreshed} ratings refreshed, ${titles.length} total → data/titles.js`);

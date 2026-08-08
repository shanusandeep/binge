#!/usr/bin/env node
/* ============================================================
   BINGE — catalogue enrichment
   Adds poster, description, cast, director, runtime and IMDb id
   to every title in data/titles.js.

   Sources (in order):
     1. Wikipedia  — poster thumbnail + intro synopsis (free, no key)
     2. Wikidata   — IMDb id, director, cast, runtime   (free, no key)
     3. Gemini 2.5 Flash + Google Search — fills whatever is still
        missing (requires GEMINI_API_KEY)

   Usage:
     node scripts/enrich.mjs                # wiki/wikidata only
     GEMINI_API_KEY=xxx node scripts/enrich.mjs
     node scripts/enrich.mjs --only-missing # skip already-enriched titles
   ============================================================ */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const ONLY_MISSING = process.argv.includes("--only-missing");
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_FILE = path.join(ROOT, "data", "titles.js");
const UA = { "User-Agent": "binge.shanuva.com catalogue bot (personal project)" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jfetch = async (url, opts = {}, tries = 5) => {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: UA, ...opts });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) {
      const body = await res.text().catch(() => "");
      const hint = body.match(/retry in ([\d.]+)s/i); // Gemini says how long
      await sleep(hint ? (parseFloat(hint[1]) + 5) * 1000 : 1500 * 2 ** i + Math.random() * 1000);
      continue;
    }
    throw new Error(`${res.status} ${url}`);
  }
};

/* Gemini free tier ≈ 10 req/min — serialize calls with a spacing gap */
let geminiChain = Promise.resolve();
const geminiSlot = () => {
  const wait = geminiChain.then(() => sleep(6500));
  geminiChain = wait;
  return wait;
};

/* ---------- load DB ---------- */
const src = await readFile(DB_FILE, "utf8");
const jsonText = src.slice(src.indexOf("{", src.indexOf("window.BINGE_DB")), src.lastIndexOf("}") + 1);
const db = (0, eval)("(" + jsonText + ")");
console.log(`● ${db.titles.length} titles loaded${GEMINI_KEY ? " · Gemini fallback ON" : " · no Gemini key (wiki only)"}`);

/* ---------- source 1+2: Wikipedia / Wikidata ---------- */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* Does this text read like an article about THIS film/series?
   Must talk about a film/series AND actually mention the title —
   catches both the wrong-topic case (Kota Factory → the city of Kota)
   and the wrong-show case (Gullak → an intro about Panchayat). */
const looksLikeTitlePage = (text, t) =>
  !!text &&
  /\b(film|series|show|sitcom|miniseries|drama|thriller|comedy|documentary|anthology|season)\b/i.test(text) &&
  // An article ABOUT a title STARTS with it ("Dupahiya is a …"), while an
  // actor's bio merely mentions it later ("Sparsh Shrivastava … known for
  // Dupahiya (2025)") — so the title must appear in the opening words.
  // First two words is enough: wiki page names sometimes drop subtitles
  // ("Mumbai Diaries 26/11" → "Mumbai Diaries").
  norm(text).slice(0, 80).includes(norm(t.title).split(" ").slice(0, 2).join(" "));

const wikiSearch = async (t) => {
  const kind = t.type === "movie" ? "film" : "TV series";
  const target = norm(t.title).split(" ").slice(0, 2).join(" ");
  const queries = [
    `${t.title} ${t.year} ${t.lang === "hi" ? "Hindi" : ""} ${kind}`,
    `intitle:"${t.title}" ${kind}`, // second pass: exact-title pages only
  ];
  const candidates = [];
  for (const q of queries) {
    const d = await jfetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=8&format=json&origin=*`);
    // NEVER fall back to an unrelated first hit (that's how Kota Factory
    // once became the city of Kota) — the page title must contain the title
    for (const h of d.query?.search || [])
      if (norm(h.title).includes(target) && !candidates.includes(h.title)) candidates.push(h.title);
    if (candidates.length >= 3) break;
  }
  return candidates.slice(0, 3);
};

/* REST summary: CDN-cached (gentler than the action API) and, unlike
   pageimages, it returns fair-use lead images — i.e. actual film posters. */
const wikiPage = async (pageTitle, t) => {
  const d = await jfetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`);
  const desc = (d.extract || "").replace(/\s+/g, " ").trim().slice(0, 550) || null;
  // reject the whole page (poster, desc AND wikidata id) if the intro
  // doesn't read like an article about this film/series
  if (!looksLikeTitlePage(desc, t)) return { poster: null, desc: null, qid: null };
  const img = (d.originalimage?.width || 9999) <= 1200 ? d.originalimage?.source : d.thumbnail?.source;
  return {
    poster: img ? img.split("?")[0] : null,
    desc,
    qid: d.wikibase_item || null,
  };
};

const wikidata = async (qid) => {
  const d = await jfetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json&origin=*`);
  const claims = d.entities?.[qid]?.claims || {};
  const val = (p) => claims[p]?.[0]?.mainsnak?.datavalue?.value;
  const ids = (p, n) => (claims[p] || []).slice(0, n).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  const dirIds = ids("P57", 2), castIds = ids("P161", 6);
  let labels = {};
  const all = [...new Set([...dirIds, ...castIds])];
  if (all.length) {
    const ld = await jfetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${all.join("|")}&props=labels&languages=en&format=json&origin=*`);
    labels = Object.fromEntries(Object.entries(ld.entities || {}).map(([k, v]) => [k, v.labels?.en?.value]));
  }
  const dur = val("P2047");
  const imdbId = val("P345");
  return {
    // people carry nm… ids in P345 — only tt… title ids build valid links
    imdb: /^tt\d+$/.test(imdbId || "") ? imdbId : null,
    director: dirIds.map((i) => labels[i]).filter(Boolean).join(", ") || null,
    cast: castIds.map((i) => labels[i]).filter(Boolean),
    runtime: dur ? Math.round(Number(dur.amount)) : null,
  };
};

/* ---------- source 3: Gemini 2.5 Flash w/ search grounding ---------- */
let geminiDead = 0; // consecutive hard failures → assume daily quota gone
const gemini = async (t, missing) => {
  if (!GEMINI_KEY || geminiDead >= 3) return {};
  await geminiSlot();
  const kind = t.type === "movie" ? "film" : "web series";
  const lang = t.lang === "hi" ? "Hindi" : "English";
  const prompt = `For the ${lang} ${kind} "${t.title}" (${t.year}), reply with ONLY a JSON object, no markdown, with exactly these keys: ${missing.map((m) => ({
    imdb: `"imdb": the IMDb title id like "tt1234567"`,
    director: `"director": director name(s) as one string`,
    cast: `"cast": array of the top 5 actor names`,
    runtime: `"runtime": ${t.type === "movie" ? "runtime in minutes as integer" : "average episode length in minutes as integer"}`,
    desc: `"desc": a 2-sentence spoiler-free synopsis that MUST begin with "${t.title} is a ${lang} ${kind}"`,
  }[m])).join(", ")}. Use null when unknown.`;
  try {
    const d = await jfetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...UA },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
        }),
      }
    );
    geminiDead = 0;
    const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return {};
    const j = JSON.parse(m[0]);
    return {
      imdb: typeof j.imdb === "string" && /^tt\d+$/.test(j.imdb) ? j.imdb : null,
      director: j.director || null,
      cast: Array.isArray(j.cast) ? j.cast.filter((c) => typeof c === "string").slice(0, 6) : null,
      runtime: Number.isFinite(j.runtime) ? Math.round(j.runtime) : null,
      desc: typeof j.desc === "string" ? j.desc.slice(0, 550) : null,
    };
  } catch (e) {
    geminiDead++;
    if (geminiDead === 3) console.warn("  ⚠ gemini disabled for this run (repeated failures — likely daily quota)");
    else console.warn(`  ⚠ gemini failed for ${t.title}: ${e.message.slice(0, 80)}`);
    return {};
  }
};

/* ---------- poster fallback: TVmaze (free, keyless, strong series
   coverage incl. Indian web series) ---------- */
const tvmazePoster = async (t) => {
  if (t.type !== "series") return null;
  try {
    const d = await jfetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(t.title)}`);
    const yr = Number((d.premiered || "").slice(0, 4));
    if (yr && Math.abs(yr - t.year) > 1) return null;
    return d.image?.original || d.image?.medium || null;
  } catch { return null; }
};

/* ---------- poster fallback: iTunes artwork (free, keyless).
   100x100 thumb URL upscales cleanly to 600x600. ---------- */
const itunesPoster = async (t) => {
  const media = t.type === "movie" ? "movie" : "tvShow";
  for (const country of ["in", "us"]) {
    try {
      const d = await jfetch(`https://itunes.apple.com/search?term=${encodeURIComponent(t.title)}&media=${media}&country=${country}&limit=5`);
      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const hit = (d.results || []).find((r) => {
        const name = r.trackName || r.collectionName || "";
        const yr = new Date(r.releaseDate || 0).getFullYear();
        return norm(name).includes(norm(t.title)) && Math.abs(yr - t.year) <= 1;
      });
      if (hit?.artworkUrl100) return hit.artworkUrl100.replace("100x100", "600x600");
    } catch { /* try next country */ }
  }
  return null;
};

/* ---------- enrich one title ---------- */
const FIELDS = ["poster", "desc", "imdb", "director", "cast", "runtime"];
let geminiCalls = 0;

const enrich = async (t) => {
  // repair pass: wipe fields that came from a mismatched page (a city, an
  // actor's bio, another show). Every legitimate desc — wiki or Gemini —
  // opens with the title, so failing validation means pollution.
  if (t.desc && !looksLikeTitlePage(t.desc, t)) {
    for (const f of ["poster", "desc", "imdb", "director", "cast", "runtime"]) delete t[f];
  }
  if (ONLY_MISSING && t.poster && t.imdb && t.director) return "skip";
  try {
    for (const page of await wikiSearch(t)) {
      const w = await wikiPage(page, t);
      if (!w.desc) continue; // page didn't validate — try the next candidate
      t.poster = t.poster || w.poster;
      t.desc = t.desc || w.desc;
      if (w.qid) {
        const wd = await wikidata(w.qid);
        t.imdb = t.imdb || wd.imdb;
        t.director = t.director || wd.director;
        t.cast = t.cast?.length ? t.cast : wd.cast;
        t.runtime = t.runtime || wd.runtime;
      }
      break;
    }
  } catch (e) {
    console.warn(`  ⚠ wiki failed for ${t.title}: ${e.message.slice(0, 80)}`);
  }
  // series: prefer TVmaze art (high-res) — small wiki posters over-zoom on cards
  if (t.type === "series") {
    const tm = await tvmazePoster(t);
    if (tm) t.poster = tm;
  }
  if (!t.poster) t.poster = await itunesPoster(t);
  const missing = FIELDS.filter((f) => f !== "poster" && (t[f] == null || (Array.isArray(t[f]) && !t[f].length)));
  if (missing.length && GEMINI_KEY) {
    geminiCalls++;
    const g = await gemini(t, missing);
    for (const f of missing) if (g[f]) t[f] = g[f];
  }
  return t.poster ? "ok" : "no-poster";
};

/* ---------- run with small concurrency pool ---------- */
const queue = [...db.titles];
let done = 0, noPoster = [];
/* single worker + generous spacing — Wikipedia 429s anonymous bursts hard */
await Promise.all(Array.from({ length: 1 }, async () => {
  while (queue.length) {
    const t = queue.shift();
    await sleep(600); // stay polite with the wiki APIs
    const r = await enrich(t);
    if (r === "no-poster") noPoster.push(t.title);
    done++;
    if (done % 25 === 0) console.log(`  … ${done}/${db.titles.length}`);
  }
}));

/* ---------- write back ---------- */
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
  };
  return "    " + JSON.stringify(o);
};

const out = `/* ============================================================
   BINGE — Title Database (enriched by scripts/enrich.mjs)
   Ratings are IMDb scores. Posters/synopses via Wikipedia,
   credits via Wikidata, gaps filled by Gemini + Google Search.
   ============================================================ */
window.BINGE_DB = {
  syncedAt: ${JSON.stringify(db.syncedAt || new Date().toISOString().slice(0, 10))},
  titles: [
${db.titles.map(entry).join(",\n")}
  ]
};
`;
await writeFile(DB_FILE, out, "utf8");

const have = (f) => db.titles.filter((t) => t[f] && (!Array.isArray(t[f]) || t[f].length)).length;
console.log(`✓ Enriched ${db.titles.length} titles → data/titles.js`);
console.log(`  posters ${have("poster")} · imdb ${have("imdb")} · director ${have("director")} · cast ${have("cast")} · runtime ${have("runtime")} · desc ${have("desc")}`);
console.log(`  gemini calls: ${geminiCalls}`);
if (noPoster.length) console.log(`  no poster (gradient fallback): ${noPoster.join(", ")}`);

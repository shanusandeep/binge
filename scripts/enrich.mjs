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
      await sleep(1500 * 2 ** i + Math.random() * 1000); // backoff on rate limits
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
const wikiSearch = async (t) => {
  const kind = t.type === "movie" ? "film" : "TV series";
  const q = `${t.title} ${t.year} ${t.lang === "hi" ? "Hindi" : ""} ${kind}`;
  const d = await jfetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=5&format=json&origin=*`);
  const hits = d.query?.search || [];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(t.title);
  // prefer a hit whose page title actually contains the movie title
  return (hits.find((h) => norm(h.title).includes(target)) || hits[0])?.title || null;
};

const wikiPage = async (pageTitle) => {
  const d = await jfetch(`https://en.wikipedia.org/w/api.php?action=query&prop=pageimages|extracts|pageprops&titles=${encodeURIComponent(pageTitle)}&piprop=thumbnail&pithumbsize=600&exintro=1&explaintext=1&ppprop=wikibase_item&redirects=1&format=json&origin=*`);
  const page = Object.values(d.query?.pages || {})[0] || {};
  return {
    poster: page.thumbnail?.source || null,
    desc: (page.extract || "").replace(/\s+/g, " ").trim().slice(0, 550) || null,
    qid: page.pageprops?.wikibase_item || null,
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
  return {
    imdb: val("P345") || null,
    director: dirIds.map((i) => labels[i]).filter(Boolean).join(", ") || null,
    cast: castIds.map((i) => labels[i]).filter(Boolean),
    runtime: dur ? Math.round(Number(dur.amount)) : null,
  };
};

/* ---------- source 3: Gemini 2.5 Flash w/ search grounding ---------- */
const gemini = async (t, missing) => {
  if (!GEMINI_KEY) return {};
  await geminiSlot();
  const kind = t.type === "movie" ? "film" : "web series";
  const lang = t.lang === "hi" ? "Hindi" : "English";
  const prompt = `For the ${lang} ${kind} "${t.title}" (${t.year}), reply with ONLY a JSON object, no markdown, with exactly these keys: ${missing.map((m) => ({
    imdb: `"imdb": the IMDb title id like "tt1234567"`,
    director: `"director": director name(s) as one string`,
    cast: `"cast": array of the top 5 actor names`,
    runtime: `"runtime": ${t.type === "movie" ? "runtime in minutes as integer" : "average episode length in minutes as integer"}`,
    desc: `"desc": a 2-sentence spoiler-free synopsis`,
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
    console.warn(`  ⚠ gemini failed for ${t.title}: ${e.message.slice(0, 80)}`);
    return {};
  }
};

/* ---------- enrich one title ---------- */
const FIELDS = ["poster", "desc", "imdb", "director", "cast", "runtime"];
let geminiCalls = 0;

const enrich = async (t) => {
  if (ONLY_MISSING && t.poster && t.imdb && t.director) return "skip";
  try {
    const page = await wikiSearch(t);
    if (page) {
      const w = await wikiPage(page);
      t.poster = t.poster || w.poster;
      t.desc = t.desc || w.desc;
      if (w.qid) {
        const wd = await wikidata(w.qid);
        t.imdb = t.imdb || wd.imdb;
        t.director = t.director || wd.director;
        t.cast = t.cast?.length ? t.cast : wd.cast;
        t.runtime = t.runtime || wd.runtime;
      }
    }
  } catch (e) {
    console.warn(`  ⚠ wiki failed for ${t.title}: ${e.message.slice(0, 80)}`);
  }
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
await Promise.all(Array.from({ length: 3 }, async () => {
  while (queue.length) {
    const t = queue.shift();
    await sleep(120); // stay polite with the wiki APIs
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

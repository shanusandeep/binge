/* ============================================================
   BINGE — app logic
   Filtering, sorting, personalisation (fav genres), rendering.
   ============================================================ */
(function () {
  "use strict";

  /* snapshot the incoming URL before any render can rewrite it */
  const BOOT_PARAMS = new URLSearchParams(location.search);

  const DB = window.BINGE_DB || { titles: [], syncedAt: "" };
  const TITLES = DB.titles.map((t, i) => ({ ...t, _id: i }));

  const LS_GENRES = "binge.favGenres";
  const LS_SEEN = "binge.onboarded";
  const LS_THEME = "binge.theme";
  const MAX_FAV = 4;

  /* ---------- state ---------- */
  const state = {
    type: "all",
    lang: "all",
    genres: new Set(),
    year: "all",
    age: "all",
    minRating: 0,
    sort: "rating",
    platform: "all",
    q: "",
    watchedOnly: false,
  };
  /* what the current view (Recent / All-time hits / none) sets by itself —
     the mobile chips and funnel badge only count filters beyond this */
  let presetBase = { year: "all", sort: "rating", minRating: 7 };
  /* mobile "See all" from a shelf: "new" | "picks" | null — forces the grid
     view and labels it; cleared by Home / a preset change / Back */
  let seeAll = null;
  const setBase = () => { presetBase = { year: state.year, sort: state.sort, minRating: state.minRating }; };

  /* ---------- els ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  /* ---------- theme (system by default, user can override) ---------- */
  const ICON_SUN = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/><line x1="4.9" y1="4.9" x2="6.6" y2="6.6"/><line x1="17.4" y1="17.4" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="6.6" y2="17.4"/><line x1="17.4" y1="6.6" x2="19.1" y2="4.9"/></g></svg>`;
  const ICON_MOON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const systemPrefersLight = () => matchMedia("(prefers-color-scheme: light)").matches;
  const effectiveTheme = () => localStorage.getItem(LS_THEME) || (systemPrefersLight() ? "light" : "dark");
  const themeBtn = $("#btn-theme");
  const paintThemeBtn = () => {
    const eff = effectiveTheme();
    themeBtn.innerHTML = eff === "light" ? ICON_MOON : ICON_SUN;
    themeBtn.title = eff === "light" ? "Switch to dark theme" : "Switch to light theme";
    themeBtn.setAttribute("aria-label", themeBtn.title);
    const mt = $("#menu-theme");
    if (mt) mt.textContent = eff === "light" ? "🌙 Dark theme" : "☀ Light theme";
  };
  paintThemeBtn();
  const toggleTheme = () => {
    const next = effectiveTheme() === "light" ? "dark" : "light";
    localStorage.setItem(LS_THEME, next);
    document.documentElement.setAttribute("data-theme", next);
    paintThemeBtn();
  };
  themeBtn.addEventListener("click", toggleTheme);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!localStorage.getItem(LS_THEME)) paintThemeBtn();
  });

  const grid = $("#grid");
  const emptyState = $("#empty-state");
  const resultsCount = $("#results-count");
  const genreRow = $("#genre-row");
  const forYouSection = $("#foryou-section");
  const forYouRail = $("#foryou-rail");
  const forYouNote = $("#foryou-note");
  const thisWeekSection = $("#thisweek-section");
  const thisWeekRail = $("#thisweek-rail");
  const modalVeil = $("#modal-veil");
  const modalGenres = $("#modal-genres");
  const modalSave = $("#modal-save");

  /* ---------- account & watched ---------- */
  const GOOGLE_CLIENT_ID = "379841086954-8kkvbj33cbri67e2fldki07tldk61arq.apps.googleusercontent.com";
  let user = null;
  const watchedSet = new Set();
  const titleKey = (t) => t.imdb || t.title.toLowerCase().replace(/[^a-z0-9]+/g, "") + "|" + t.year;

  /* ---------- personalisation ---------- */
  const loadFavs = () => {
    try { return JSON.parse(localStorage.getItem(LS_GENRES)) || []; }
    catch { return []; }
  };
  const saveFavs = (arr) => localStorage.setItem(LS_GENRES, JSON.stringify(arr));
  let favGenres = loadFavs();

  /* ---------- genre helpers ---------- */
  const GENRE_HUES = {
    Action: 12, Adventure: 28, Comedy: 44, Crime: 340, Drama: 210,
    Thriller: 262, Romance: 330, Horror: 285, "Sci-Fi": 190, Biography: 160,
    Mystery: 245, War: 20, History: 35, Sport: 145, Music: 310,
    Family: 95, Fantasy: 270, Animation: 175,
  };

  const allGenres = [...new Set(TITLES.flatMap((t) => t.genres))].sort((a, b) => a.localeCompare(b));

  /* ---------- people index (for search autosuggest) ---------- */
  const PEOPLE = (() => {
    const m = new Map(); // name -> { count, bestRating }
    for (const t of TITLES) {
      const names = [...(t.cast || []), ...(t.director || "").split(",").map((s) => s.trim())].filter(Boolean);
      for (const name of names) {
        const p = m.get(name) || { count: 0, bestRating: 0 };
        p.count++;
        p.bestRating = Math.max(p.bestRating, t.rating);
        m.set(name, p);
      }
    }
    return [...m.entries()].map(([name, p]) => ({ name, ...p }));
  })();

  const posterBg = (t) => {
    const h1 = GENRE_HUES[t.genres[0]] ?? 30;
    const h2 = GENRE_HUES[t.genres[1]] ?? (h1 + 40) % 360;
    const tilt = (t.title.length * 7 + t.year) % 30 - 15;
    return `linear-gradient(${135 + tilt}deg,
      hsl(${h1} 52% 26%) 0%,
      hsl(${(h1 + h2) / 2} 48% 17%) 55%,
      hsl(${h2} 55% 11%) 100%)`;
  };

  /* ---------- filtering ---------- */
  /* normalise the raw certificate (CBFC / MPAA / US-TV) into 3 buckets */
  const ageBucket = (cert) => {
    if (!cert) return null;
    const c = cert.toUpperCase().replace(/\s+/g, "");
    if (/^(U|G|TV-Y7?(FV)?|TV-G|ALL|0\+?|6\+?|7\+?)$/.test(c)) return "u";
    if (/^(A|R|NC-17|TV-MA|X|18|18\+)$/.test(c)) return "a";
    return "ua"; // U/A variants, PG, PG-13, TV-14, 12–16 etc.
  };

  /* show every certificate in the Indian system, so the chips and the
     age filter speak the same language (TV-PG → U/A 7+, TV-MA → A, …) */
  const CERT_LABEL = {
    G: "U", "TV-Y": "U", "TV-Y7": "U", "TV-Y7-FV": "U", "TV-G": "U", ALL: "U",
    PG: "U/A 7+", "TV-PG": "U/A 7+", "7+": "U/A 7+", "6+": "U/A 7+",
    "PG-13": "U/A 13+", "TV-14": "U/A 13+", "13+": "U/A 13+", "12+": "U/A 13+",
    "16+": "U/A 16+", UA: "U/A",
    R: "A", "TV-MA": "A", "NC-17": "A", X: "A", "18": "A", "18+": "A",
  };
  const certLabel = (cert) =>
    cert ? (CERT_LABEL[cert.toUpperCase().replace(/\s+/g, "")] || cert) : "";

  /* kid-friendly: family/animation content that isn't adult-rated */
  const isKids = (t) =>
    (t.genres.includes("Animation") || t.genres.includes("Family")) &&
    ageBucket(t.cert) !== "a";

  const daysAgo = (d) => (Date.now() - new Date(d + "T00:00:00").getTime()) / 864e5;
  /* just released — no IMDb score yet, so the rating bar mustn't hide it */
  const isFresh = (t) => !!t.released && daysAgo(t.released) <= 30;

  const yearMatch = (t) => {
    const y = t.year, f = state.year;
    if (f === "all") return true;
    if (f === "2020s") return y >= 2020;
    if (f === "2010s") return y >= 2010 && y < 2020;
    if (f === "2000s") return y >= 2000 && y < 2010;
    if (f === "1990s") return y >= 1990 && y < 2000;
    if (f === "classic") return y < 1990;
    return y === Number(f);
  };

  const applyFilters = () => {
    /* name search is a global lookup — never let filters hide the title
       someone is explicitly searching for */
    let list = state.watchedOnly
      ? TITLES.filter((t) => watchedSet.has(titleKey(t)))
      : state.q !== ""
      ? (() => {
          const direct = TITLES.filter((t) =>
            t.title.toLowerCase().includes(state.q) ||
            (t.collection || "").toLowerCase().includes(state.q) ||
            (t.director || "").toLowerCase().includes(state.q) ||
            (t.tags || []).some((tag) => tag.toLowerCase().includes(state.q)) ||
            (t.cast || []).some((actor) => actor.toLowerCase().includes(state.q)));
          /* pull in the rest of any franchise a match belongs to, so
             "batman" also returns The Dark Knight and its sequel */
          const cols = new Set(direct.map((t) => t.collection).filter(Boolean));
          if (!cols.size) return direct;
          const ids = new Set(direct.map((t) => t._id));
          return direct.concat(
            TITLES.filter((t) => t.collection && cols.has(t.collection) && !ids.has(t._id)));
        })()
      : TITLES.filter((t) =>
          (state.type === "all" || t.type === state.type) &&
          (state.lang === "all" || t.lang === state.lang) &&
          (state.platform === "all" || platformKey(t) === state.platform) &&
          (!state.minRating || t.rating >= state.minRating || (!t.rating && isFresh(t))) &&
          (state.age === "all" ||
            (state.age === "kids" ? isKids(t) : ageBucket(t.cert) === state.age)) &&
          yearMatch(t) &&
          (state.genres.size === 0 || t.genres.some((g) => state.genres.has(g))));
    /* release-date key: full dates rank above bare years within the same year */
    const rel = (t) => t.released || String(t.year);
    switch (state.sort) {
      case "rating": list.sort((a, b) => b.rating - a.rating || b.year - a.year); break;
      case "newest": list.sort((a, b) => rel(b).localeCompare(rel(a)) || b.rating - a.rating); break;
      case "oldest": list.sort((a, b) => rel(a).localeCompare(rel(b)) || b.rating - a.rating); break;
      case "az": list.sort((a, b) => a.title.localeCompare(b.title)); break;
    }
    return list;
  };

  /* ---------- card rendering ---------- */
  const IMDB_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17l-6.1 3.6 1.4-6.8L2.2 9.1l6.9-.8z" fill="#140d02"/></svg>`;

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  /* analytics — no-op if GA is blocked or absent */
  const ga = (...args) => { try { window.gtag && window.gtag(...args); } catch {} };

  const imdbURL = (t) => t.imdb
    ? `https://www.imdb.com/title/${t.imdb}/`
    : `https://www.imdb.com/find/?q=${encodeURIComponent(t.title + " " + t.year)}`;

  /* ---------- platform link ----------
     TMDB doesn't expose a direct per-title deep link into Netflix/Prime/etc
     (that's JustWatch's paid affiliate data) — so instead build each
     service's own search URL. One extra click, but lands right where the
     title actually is, on the actual service, not a middleman page. */
  const PLATFORM_SEARCH = {
    "Netflix": (q) => `https://www.netflix.com/search?q=${q}`,
    "Prime Video": (q) => `https://www.primevideo.com/search?phrase=${q}`,
    "Amazon MX Player": (q) => `https://www.primevideo.com/search?phrase=${q}`,
    "JioHotstar": (q) => `https://www.hotstar.com/in/search?q=${q}`,
    "Disney+": (q) => `https://www.disneyplus.com/search?q=${q}`,
    "Max": (q) => `https://www.max.com/search?q=${q}`,
    "Hulu": (q) => `https://www.hulu.com/search?q=${q}`,
    "SonyLIV": (q) => `https://www.sonyliv.com/search?searchTerm=${q}`,
    "ZEE5": (q) => `https://www.zee5.com/search?q=${q}`,
    "Apple TV+": (q) => `https://tv.apple.com/search?term=${q}`,
    "Apple TV Store": (q) => `https://tv.apple.com/search?term=${q}`,
    "Paramount+": (q) => `https://www.paramountplus.com/search?query=${q}`,
    "Peacock": (q) => `https://www.peacocktv.com/search?q=${q}`,
    "Lionsgate Play": (q) => `https://www.lionsgateplay.com/search?q=${q}`,
    "Lionsgate+": (q) => `https://www.lionsgateplay.com/search?q=${q}`,
    "YouTube": (q) => `https://www.youtube.com/results?search_query=${q}`,
    "YouTube Free": (q) => `https://www.youtube.com/results?search_query=${q}`,
    "YouTube TV": (q) => `https://www.youtube.com/results?search_query=${q}`,
    "Google Play Movies": (q) => `https://play.google.com/store/search?q=${q}&c=movies`,
    "Tubi TV": (q) => `https://tubitv.com/search/${q}`,
    "The Roku Channel": (q) => `https://therokuchannel.roku.com/search?query=${q}`,
    "Crunchyroll": (q) => `https://www.crunchyroll.com/search?q=${q}`,
    "Pluto TV": (q) => `https://pluto.tv/en/search/${q}`,
    "Plex": (q) => `https://watch.plex.tv/search?query=${q}`,
  };
  const platformURL = (t) => {
    const raw = regionPlatform(t);
    const q = encodeURIComponent(t.title);
    if (raw === "Theatres") return `https://www.google.com/search?q=${encodeURIComponent(t.title + " showtimes")}`;
    if (raw === "Streaming") return null; // not yet resolved to a real service
    const base = raw.replace(/\s*\(Buy\/Rent\)$/, "");
    if (PLATFORM_SEARCH[base]) return PLATFORM_SEARCH[base](q);
    // long-tail services without a template: a search still gets close
    return `https://www.google.com/search?q=${encodeURIComponent(`watch "${t.title}" on ${base}`)}`;
  };

  /* ---------- region-aware platform ----------
     JioHotstar/ZEE5/SonyLIV mean nothing outside India, so a US visitor
     shouldn't see them as if they were watchable there. No IP lookup (extra
     request, a privacy ask for a personal recs site) — the visitor's own
     timezone is a free, client-side, good-enough signal: IST readers are
     overwhelmingly the India audience this site is built for. */
  const isIndiaTZ = /^Asia\/(Kolkata|Calcutta)$/.test(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "");
  const regionPlatform = (t) =>
    (!isIndiaTZ && t.platformUs) ? t.platformUs : t.platform;
  /* "Prime Video (Buy/Rent)" and "Prime Video" are the same filter choice */
  const platformKey = (t) => regionPlatform(t).replace(/\s*\(Buy\/Rent\)$/, "");
  const PLATFORMS = (() => {
    const n = new Map();
    for (const t of TITLES) {
      const k = platformKey(t);
      if (k && k !== "Streaming") n.set(k, (n.get(k) || 0) + 1);
    }
    return [...n.entries()].filter(([, c]) => c >= 8).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
  })();

  const cardHTML = (t, i, tagArg) => {
    const tag = typeof tagArg === "string" ? tagArg : ""; // .map() hands us the array as arg 3
    const langTag = t.lang === "hi" ? "हिंदी" : "English";
    const typeTag = t.type === "movie" ? "Film" : "Series";
    const topBadge = tag ? `<span class="badge-top">${esc(tag)}</span>`
      : t.rating >= 8.5 ? `<span class="badge-top">All-time great</span>` : "";
    const glyph = t.title.trim()[0].toUpperCase();
    // TMDB posters: serve the 342px rendition to phones (two-column grid ≈ 180px)
    const tmdb500 = !!t.poster && t.poster.includes("image.tmdb.org/t/p/w500/");
    const img = t.poster
      ? `<img class="poster-img" src="${esc(t.poster)}"${tmdb500 ? ` srcset="${esc(t.poster.replace("/w500/", "/w342/"))} 342w, ${esc(t.poster)} 500w" sizes="(max-width: 720px) 46vw, 240px"` : ""} alt="" loading="lazy" decoding="async" onerror="this.remove();this.closest('.poster').classList.remove('has-img')">`
      : "";
    const isWatched = watchedSet.has(titleKey(t));
    return `
    <article class="card ${isWatched ? "is-watched" : ""}" style="animation-delay:${Math.min(i * 40, 400)}ms" data-id="${t._id}" tabindex="0" role="button" aria-label="${esc(t.title)} — details">
      <div class="poster ${t.poster ? "has-img" : ""}" style="--poster-bg:${posterBg(t).replace(/\n\s*/g, " ")}">
        ${img}
        <span class="poster-glyph" aria-hidden="true">${glyph}</span>
        ${t.rating
          ? `<a class="badge-rating" href="${imdbURL(t)}" target="_blank" rel="noopener" title="Open on IMDb" aria-label="IMDb rating ${t.rating.toFixed(1)} — open on IMDb">${IMDB_SVG}${t.rating.toFixed(1)}</a>`
          : `<span class="badge-rating badge-new" title="Just released — not rated yet">New</span>`}
        ${topBadge}
        ${isWatched ? `<span class="watched-badge">✓ Watched</span>` : ""}
        <h3 class="poster-word">${esc(t.title)}</h3>
      </div>
      <div class="card-body">
        <h3 class="card-title">${esc(t.title)}</h3>
        <p class="card-meta">
          <span class="type-tag">${typeTag}</span><span class="dot">·</span>
          <span class="year-tag">${t.year}</span><span class="dot">·</span>
          <span class="lang-tag">${langTag}</span>
          ${t.seasons ? `<span class="se-tag" title="${t.seasons} season${t.seasons > 1 ? "s" : ""}, ${t.episodes} episodes">${t.seasons}S · ${t.episodes}Ep</span>` : ""}
          ${t.cert ? `<span class="se-tag" title="Age rating (${esc(t.cert)})">${esc(certLabel(t.cert))}</span>` : ""}
        </p>
        <p class="card-foot">
          <span class="card-genres">${t.genres.slice(0, 2).join(" / ")}</span>
          ${(() => {
            const url = platformURL(t);
            return url
              ? `<a class="card-platform" href="${url}" target="_blank" rel="noopener" title="Find on ${esc(regionPlatform(t))}">${esc(regionPlatform(t))}</a>`
              : `<span class="card-platform">${esc(regionPlatform(t))}</span>`;
          })()}
        </p>
      </div>
    </article>`;
  };

  /* ---------- render: grid ---------- */
  const renderGrid = () => {
    const list = applyFilters();
    grid.innerHTML = list.map(cardHTML).join("");
    emptyState.hidden = list.length > 0;
    const hi = list.filter((t) => t.lang === "hi").length;
    resultsCount.innerHTML = state.watchedOnly
      ? `<b>${list.length}</b> watched title${list.length === 1 ? "" : "s"}`
      : `<b>${list.length}</b> title${list.length === 1 ? "" : "s"}` +
      (list.length ? ` · ${hi} Hindi / ${list.length - hi} English` : "");
    $("#btn-clear").hidden = !isFiltered();
    const wc = $("#watched-count");
    if (wc) wc.textContent = watchedSet.size ? `(${watchedSet.size})` : "";
    /* focused mode: the visitor is actively narrowing (filters beyond what the
       current view sets itself, a search, the watchlist) → hide hero & rails,
       results on top. The view's own defaults (Recent = this year, newest)
       are not "focus" — otherwise the home page would never show the rails. */
    const extras = extraFilters();
    document.body.classList.toggle("is-focused",
      extras.length > 0 || state.q !== "" || state.watchedOnly || seeAll !== null);
    syncURL();

    /* the 7+ toggles (header + mobile toolbar) mirror the min-rating filter */
    for (const seven of $$("#btn-seven")) {
      seven.classList.toggle("is-on", state.minRating >= 7);
      seven.setAttribute("aria-pressed", state.minRating >= 7);
    }

    /* mobile: funnel badge, removable chips and the single count — "extra"
       means beyond what the current view (Recent / All-time hits) sets itself */
    const badge = $("#filter-count");
    badge.hidden = !extras.length;
    badge.textContent = extras.length;
    $("#sheet-apply").textContent = `Show ${list.length} title${list.length === 1 ? "" : "s"}`;
    $("#sheet-summary").textContent = extras.length
      ? "Active: " + extras.map((f) => f.label).join(" · ")
      : "No extra filters — showing this view's defaults.";
    document.body.classList.toggle("has-filters", extras.length > 0 || state.q !== "" || seeAll !== null);
    renderFeatured(list, extras);
    renderGridHead(extras);
  };

  /* ---------- mobile: featured banner ----------
     One real title from the current view's own list (so it never contradicts
     the mode or the 7+ toggle); hidden whenever the visitor is filtering.
     Stable for the day — no auto-rotation. */
  let featuredTitle = null;
  const renderFeatured = (list, extras) => {
    const sec = $("#featured");
    if (!mqMobile.matches || extras.length || state.q || state.watchedOnly || seeAll) { sec.hidden = true; featuredTitle = null; return; }
    // Only titles you can actually stream tonight: a named subscription
    // platform for this visitor's region (not "Theatres", not the generic
    // "Streaming" placeholder, not buy/rent). Then the best-rated of the
    // view's first dozen such titles, preferring landscape art.
    const streamable = (t) => {
      const p = regionPlatform(t) || "";
      return p && !["Streaming", "Theatres"].includes(p) && !/\(Buy\/Rent\)$/.test(p);
    };
    const pool = list.filter((t) => t.poster && t.rating && streamable(t)).slice(0, 12)
      .sort((a, b) => b.rating - a.rating).slice(0, 5);
    if (!pool.length) { sec.hidden = true; featuredTitle = null; return; }
    const withArt = pool.filter((t) => t.backdrop);
    const cands = withArt.length ? withArt : pool;
    featuredTitle = cands[Math.floor(Date.now() / 864e5) % cands.length];
    const t = featuredTitle, art = $("#featured-art");
    const src = t.backdrop || t.poster;
    if (art.src !== src) art.src = src;
    art.classList.toggle("is-poster", !t.backdrop); // portrait fallback: crop from the top-right
    $("#featured-title").textContent = t.title;
    $("#featured-platform").textContent = regionPlatform(t);
    $("#featured-meta").textContent = [t.year, t.lang === "hi" ? "हिंदी" : "English", t.genres[0]].filter(Boolean).join(" · ");
    $("#featured-card").setAttribute("aria-label", `Featured: ${t.title} — view details`);
    sec.hidden = false;
  };
  $("#featured-card").addEventListener("click", () => { if (featuredTitle) openDetail(featuredTitle); });

  /* mobile: heading over the grid (and a way back from a "See all" view) */
  const renderGridHead = (extras) => {
    const focused = extras.length > 0 || state.q !== "" || state.watchedOnly || seeAll !== null;
    $("#grid-head").hidden = !mqMobile.matches;
    $("#grid-title").textContent =
      state.watchedOnly ? "Watched" :
      state.q ? `Results for “${$("#search-input").value.trim()}”` :
      seeAll === "new" ? "New arrivals" :
      seeAll === "picks" ? "Picked for you" :
      extras.length ? "Filtered titles" :
      presetBase.sort === "newest" ? "Recent releases" : "All-time hits";
    $("#grid-back").hidden = !focused;
  };

  const extraFilters = () => {
    const opt = (sel, v) => $(`${sel} option[value="${v}"]`)?.textContent || v;
    const x = [];
    if (state.type !== "all") x.push({ key: "type", label: state.type === "movie" ? "Movies" : "Series" });
    if (state.lang !== "all") x.push({ key: "lang", label: state.lang === "hi" ? "हिंदी" : "English" });
    if (state.year !== presetBase.year) x.push({ key: "year", label: opt("#year-select", state.year) });
    if (state.age !== "all") x.push({ key: "age", label: opt("#age-select", state.age) });
    if (state.minRating !== presetBase.minRating) x.push({ key: "min", label: state.minRating ? `IMDb ${state.minRating}+` : "Any rating" });
    if (state.sort !== presetBase.sort) x.push({ key: "sort", label: opt("#sort-select", state.sort) });
    for (const g of state.genres) x.push({ key: "genre", value: g, label: g });
    if (state.platform !== "all") x.push({ key: "platform", label: state.platform });
    return x;
  };

  /* ---------- shareable filter URLs ---------- */
  /* the current filters live in the query string, so any view can be sent
     to someone and it loads identically (defaults are omitted) */
  const syncURL = () => {
    if (location.pathname === "/reset") return; // never clobber a reset token
    const p = new URLSearchParams();
    if (state.type !== "all") p.set("type", state.type);
    if (state.lang !== "all") p.set("lang", state.lang);
    if (state.year !== "all") p.set("year", state.year);
    if (state.sort !== "rating") p.set("sort", state.sort);
    if (state.age !== "all") p.set("age", state.age);
    if (state.minRating !== 7) p.set("min", String(state.minRating));
    if (state.platform !== "all") p.set("pf", state.platform);
    if (state.genres.size) p.set("g", [...state.genres].join(","));
    if (state.q) p.set("q", state.q);
    const qs = p.toString();
    const url = location.pathname + (qs ? "?" + qs : "");
    if (url !== location.pathname + location.search) history.replaceState({}, "", url);
  };

  const applyParams = () => {
    if (location.pathname === "/reset") return;
    const p = BOOT_PARAMS;
    if (![...p.keys()].length) return;
    const t = p.get("type"); if (["movie", "series"].includes(t)) state.type = t;
    const l = p.get("lang"); if (["hi", "en"].includes(l)) state.lang = l;
    const y = p.get("year");
    if (y && [...$("#year-select").options].some((o) => o.value === y)) state.year = y;
    const s = p.get("sort"); if (["rating", "newest", "oldest", "az"].includes(s)) state.sort = s;
    const a = p.get("age"); if (["kids", "u", "ua", "a"].includes(a)) state.age = a;
    const m = p.get("min");
    if (["0", "6", "7", "7.5", "8", "8.5", "9"].includes(m)) state.minRating = Number(m);
    const g = p.get("g");
    if (g) {
      const gs = g.split(",").filter((x) => allGenres.includes(x));
      if (gs.length) state.genres = new Set(gs);
    }
    const pf = p.get("pf");
    if (pf && PLATFORMS.includes(pf)) state.platform = pf;
    const q = p.get("q");
    if (q) {
      state.q = q.toLowerCase();
      $("#search-input").value = q;
      document.body.classList.add("is-searching");
      $("#search-clear").hidden = false;
    }
    syncControls();
    renderChips();
    renderGrid();
  };

  /* reflect the filter state in every control widget */
  const syncControls = () => {
    $$(".seg-btn[data-type]").forEach((b) => b.classList.toggle("is-active", b.dataset.type === state.type));
    $$(".seg-btn[data-lang]").forEach((b) => b.classList.toggle("is-active", b.dataset.lang === state.lang));
    $("#year-select").value = state.year;
    $("#sort-select").value = state.sort;
    $("#age-select").value = state.age;
    $("#rating-select").value = String(state.minRating || 0);
    $("#rating-select").classList.toggle("is-set", state.minRating > 0);
    renderPlatformRow();
  };

  /* remembered between visits: the browsing preferences that are about the
     person, not the moment — type, language, platform. Year/sort/rating
     follow the view (Recent / All-time hits) instead. */
  const LS_FILTERS = "binge.filters";
  const savePrefs = () => {
    try { localStorage.setItem(LS_FILTERS, JSON.stringify({ type: state.type, lang: state.lang, platform: state.platform })); } catch {}
  };
  const loadPrefs = () => {
    try {
      const p = JSON.parse(localStorage.getItem(LS_FILTERS) || "{}");
      if (["movie", "series"].includes(p.type)) state.type = p.type;
      if (["hi", "en"].includes(p.lang)) state.lang = p.lang;
      if (PLATFORMS.includes(p.platform)) state.platform = p.platform;
    } catch {}
  };

  const isFiltered = () =>
    state.type !== "all" || state.lang !== "all" || state.genres.size > 0 || state.platform !== "all" ||
    state.year !== "all" || state.age !== "all" || state.minRating > 0 ||
    state.q !== "" || state.watchedOnly;

  /* ---------- render: genre chips ---------- */
  const renderChips = () => {
    /* dropdown label reflects the selection */
    const picked = [...state.genres];
    const label = $("#genre-label");
    if (label) {
      label.textContent = picked.length === 0 ? "All genres"
        : picked.length === 1 ? picked[0]
        : `${picked.length} genres`;
      $("#genre-toggle").classList.toggle("is-set", picked.length > 0);
    }
    genreRow.innerHTML = allGenres.map((g) => `
      <button class="chip ${state.genres.has(g) ? "is-active" : ""}" data-genre="${g}">
        ${g}${favGenres.includes(g) ? `<span class="chip-heart">♥</span>` : ""}
      </button>`).join("");
  };

  /* ---------- render: for-you rail ---------- */
  const renderForYou = () => {
    const seeAllBtn = forYouSection.querySelector(".see-all");
    if (!favGenres.length) {
      // phones keep the shelf as a nudge to pick genres; desktop hides it
      forYouSection.hidden = !mqMobile.matches;
      forYouNote.textContent = "tell us what you love";
      forYouRail.classList.add("is-cta");
      forYouRail.innerHTML = `<button type="button" class="rail-cta" id="foryou-cta">✦ Pick up to 4 favourite genres and we'll line up picks for you</button>`;
      if (seeAllBtn) seeAllBtn.hidden = true;
      return;
    }
    forYouRail.classList.remove("is-cta");
    if (seeAllBtn) seeAllBtn.hidden = false;
    const picks = TITLES
      .filter((t) => t.rating >= 7.3 && !watchedSet.has(titleKey(t)) &&
        t.genres.some((g) => favGenres.includes(g)))
      .sort((a, b) =>
        b.genres.filter((g) => favGenres.includes(g)).length -
        a.genres.filter((g) => favGenres.includes(g)).length ||
        b.rating - a.rating)
      .slice(0, 12);
    if (!picks.length) { forYouSection.hidden = true; return; }
    forYouSection.hidden = false;
    forYouNote.textContent = `because you love ${favGenres.join(", ")}`;
    forYouRail.innerHTML = picks.map(cardHTML).join("");
  };

  /* ---------- render: new-this-week rail ----------
     brand-new films/series by release date, plus running series that
     aired an episode in the window (lastAired, refreshed nightly) */
  const renderThisWeek = () => {
    const WINDOW = 10;
    const inWindow = (d) => !!d && daysAgo(d) >= -1 && daysAgo(d) <= WINDOW;
    const picks = TITLES
      .map((t) => {
        if (inWindow(t.released))
          return { t, on: t.released, tag: t.type === "movie" ? "New release" : "New series" };
        if (t.type === "series" && inWindow(t.lastAired))
          return { t, on: t.lastAired, tag: "New episodes" };
        return null;
      })
      .filter((p) => p && !watchedSet.has(titleKey(p.t)))
      .sort((a, b) => b.on.localeCompare(a.on) || b.t.rating - a.t.rating)
      .slice(0, 14);
    thisWeekSection.hidden = !picks.length;
    if (!picks.length) return;
    thisWeekRail.innerHTML = picks.map((p, i) => cardHTML(p.t, i, p.tag)).join("");
  };

  /* ---------- render: hero ---------- */
  const renderHero = () => {
    const movies = TITLES.filter((t) => t.type === "movie").length;
    const series = TITLES.length - movies;
    const hindi = TITLES.filter((t) => t.lang === "hi").length;
    const great = TITLES.filter((t) => t.rating >= 8).length;
    $("#hero-stats").innerHTML = `
      <div class="stat"><b>${movies}<em>+</em></b><span>Movies</span></div>
      <div class="stat"><b>${series}<em>+</em></b><span>Web series</span></div>
      <div class="stat"><b>${Math.round((hindi / TITLES.length) * 100)}<em>%</em></b><span>Hindi-first</span></div>
      <div class="stat"><b>${great}</b><span>Rated 8.0+</span></div>`;

    /* floating poster deck — top-rated Hindi picks, clickable */
    const deck = $("#hero-deck");
    if (deck) {
      const picks = TITLES
        .filter((t) => t.poster && t.rating >= 8.2 && t.lang === "hi")
        .sort((a, b) => b.rating - a.rating)
        .filter((_, i) => i % 2 === 0) // skip alternates for variety
        .slice(0, 5);
      deck.innerHTML = picks.map((t) => `
        <div class="deck-card" data-id="${t._id}" role="button" tabindex="-1"
          aria-label="${esc(t.title)} — details" title="${esc(t.title)}"
          style="background-image:url('${esc(t.poster)}')"></div>`).join("");
    }

    const feed = [...TITLES].sort((a, b) => b.rating - a.rating).slice(0, 22)
      .map((t) => `<span>${t.title}<i>✦</i></span>`).join("");
    $("#marquee-track").innerHTML = feed + feed; /* doubled for seamless loop */
    $("#synced-at").textContent = DB.syncedAt || "—";
  };

  /* ---------- title detail popup ---------- */
  const detailVeil = $("#detail-veil");

  const openDetail = (t) => {
    const media = $("#detail-media");
    if (t.poster) {
      /* posters carry faces in the upper half — anchor there, not center */
      media.style.background = `url("${t.poster}") top center / cover no-repeat, ${posterBg(t).replace(/\n\s*/g, " ")}`;
      media.innerHTML = "";
    } else {
      media.style.background = posterBg(t).replace(/\n\s*/g, " ");
      media.innerHTML = `<span class="poster-glyph" aria-hidden="true">${t.title.trim()[0].toUpperCase()}</span>
        <span class="fallback-word">${esc(t.title)}</span>`;
    }
    $("#detail-kicker").textContent =
      (t.type === "movie" ? "Film" : "Web Series") + " · " + (t.lang === "hi" ? "हिंदी" : "English");
    $("#detail-title").textContent = t.title;
    const runtime = t.runtime
      ? (t.type === "movie"
          ? `${Math.floor(t.runtime / 60)}h ${t.runtime % 60}m`
          : `~${t.runtime}m / episode`)
      : null;
    const relDate = t.released
      ? new Date(t.released + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
      : String(t.year);
    $("#detail-meta").innerHTML =
      [`<span title="Release date">${relDate}</span>`, runtime && `<span>${runtime}</span>`,
       t.cert && `<span class="cert-tag" title="${esc(t.cert)}">${esc(certLabel(t.cert))}</span>`]
        .filter(Boolean).join(`<span class="dot">·</span>`) +
      `<span class="detail-genres">${t.genres.map((g) => `<span class="chip is-active">${g}</span>`).join("")}</span>`;
    $("#detail-desc").textContent = t.desc || t.plot;
    const epInfo = t.episodes
      ? (t.seasons > 1 ? `${t.seasons} seasons · ${t.episodes} episodes` : `${t.episodes} episodes`)
      : null;
    /* every name is a link: click → all titles with that person */
    const person = (name) => `<button type="button" class="credit-link" data-person="${esc(name)}">${esc(name)}</button>`;
    $("#detail-credits").innerHTML =
      (t.director ? `<dt>Director</dt><dd>${t.director.split(",").map((s) => s.trim()).filter(Boolean).map(person).join(", ")}</dd>` : "") +
      (t.cast?.length ? `<dt>Cast</dt><dd>${t.cast.map(person).join(", ")}</dd>` : "") +
      (epInfo ? `<dt>Episodes</dt><dd>${epInfo}</dd>` : "") +
      (t.tags?.length ? `<dt>Studio</dt><dd>${t.tags.map(esc).join(", ")}</dd>` : "");
    const watch = $("#detail-watch");
    if (t.platform === "YouTube") {
      watch.hidden = false;
      watch.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(t.title + " " + (t.tags?.[0] || "") + " full episodes")}`;
    } else {
      watch.hidden = true;
    }
    const link = $("#detail-imdb");
    link.href = imdbURL(t);
    $("#detail-imdb-rating").textContent = t.rating ? t.rating.toFixed(1) + " / 10" : "Not rated yet";
    const platEl = $("#detail-platform");
    platEl.textContent = regionPlatform(t);
    const platUrl = platformURL(t);
    if (platUrl) { platEl.href = platUrl; platEl.classList.remove("is-plain"); }
    else { platEl.removeAttribute("href"); platEl.classList.add("is-plain"); }
    currentDetail = t;
    updateWatchedBtn(t);
    ga("event", "view_title", { item_name: t.title, item_id: t.imdb || "", rating: t.rating, lang: t.lang });
    detailVeil.hidden = false;
    document.body.style.overflow = "hidden";
    $("#detail-close").focus({ preventScroll: true });
  };

  /* ---------- watched toggle + sign-in ---------- */
  let currentDetail = null;
  const updateWatchedBtn = (t) => {
    const b = $("#detail-watched");
    const on = watchedSet.has(titleKey(t));
    b.textContent = on ? "✓ Watched" : "✓ Mark watched";
    b.classList.toggle("is-on", on);
  };

  $("#detail-watched").addEventListener("click", async () => {
    if (!currentDetail) return;
    if (!user) { openSignin(); return; }
    const key = titleKey(currentDetail);
    const on = !watchedSet.has(key);
    on ? watchedSet.add(key) : watchedSet.delete(key);
    ga("event", "mark_watched", { item_name: currentDetail.title, watched: on });
    updateWatchedBtn(currentDetail);
    renderGrid();
    renderForYou(); renderThisWeek();
    try {
      await fetch("/api/watched", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, watched: on }),
      });
    } catch { /* offline — local state still applied */ }
  });

  const accountBtn = $("#btn-account");
  const accountMenu = $("#account-menu");
  const refreshAccount = () => {
    if (user) {
      accountBtn.innerHTML = user.picture
        ? `<img class="avatar" src="${esc(user.picture)}" alt="${esc(user.name || "account")}">`
        : esc((user.name || "Account").split(" ")[0]);
      accountBtn.classList.add("is-user");
      $("#account-name").textContent = user.name || user.email || "";
      $("#btn-admin").hidden = !user.isAdmin;
    } else {
      accountBtn.textContent = "Sign in";
      accountBtn.classList.remove("is-user");
      accountMenu.hidden = true;
      $("#btn-admin").hidden = true;
    }
  };
  const toggleAccountMenu = () => {
    // desktop guests go straight to sign-in; on mobile the menu also holds
    // theme / refresh, so it opens for everyone (with a Sign in entry)
    if (!user && !mqMobile.matches) return openSignin();
    accountMenu.classList.toggle("is-guest", !user);
    accountMenu.hidden = !accountMenu.hidden;
  };
  accountBtn.addEventListener("click", toggleAccountMenu);
  $("#menu-signin").addEventListener("click", () => { accountMenu.hidden = true; openSignin(); });
  $("#menu-theme").addEventListener("click", toggleTheme);
  $("#menu-sync").addEventListener("click", () => { accountMenu.hidden = true; $("#btn-sync").click(); });
  $("#btn-signout").addEventListener("click", async () => {
    try { await fetch("/api/logout", { method: "POST" }); } catch {}
    user = null;
    watchedSet.clear();
    refreshAccount();
    renderGrid();
    renderForYou(); renderThisWeek();
    if (currentDetail) updateWatchedBtn(currentDetail);
  });
  $("#btn-watchlist").addEventListener("click", () => showWatchlist());
  document.addEventListener("click", (e) => {
    if (e.target.closest(".account-wrap, #account-menu, #nav-profile")) return;
    if (!accountMenu.hidden) { accountMenu.hidden = true; setNav("home"); }
  });

  /* admin dashboard lives on its own page — /admin (admin.html) */
  $("#btn-admin").addEventListener("click", () => { location.href = "/admin"; });

  const signinVeil = $("#signin-veil");
  let gsiLoaded = false;

  const postAuth = (d, method = "email") => {
    ga("event", "login", { method });
    user = d.user;
    watchedSet.clear();
    (d.watched || []).forEach((k) => watchedSet.add(k));
    refreshAccount();
    renderGrid();
    renderForYou(); renderThisWeek();
    if (currentDetail) updateWatchedBtn(currentDetail);
    closeSignin();
  };

  const onCredential = async (resp) => {
    try {
      const r = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: resp.credential }),
      });
      if (!r.ok) throw new Error();
      postAuth(await r.json(), "google");
    } catch { alert("Sign-in failed — please try again."); }
  };

  /* ---------- email / password auth (login · signup · forgot · reset · change) ---------- */
  let authMode = "login";
  let resetToken = null;
  const authError = $("#auth-error");
  const authOk = $("#auth-ok");
  const signinTitle = signinVeil.querySelector(".modal-title");

  const AUTH_UI = {
    login:  { title: "Sign in to Binge", submit: "Sign in", fields: ["email", "password"], switchTo: "signup", switchLabel: "New to Binge? ", switchBtn: "Create an account", forgot: true, google: true },
    signup: { title: "Create your account", submit: "Create account", fields: ["name", "email", "password"], switchTo: "login", switchLabel: "Already have an account? ", switchBtn: "Sign in instead", google: true },
    forgot: { title: "Reset your password", submit: "Send reset link", fields: ["email"], switchTo: "login", switchLabel: "Remembered it? ", switchBtn: "Sign in instead" },
    reset:  { title: "Choose a new password", submit: "Set new password", fields: ["password"] },
    change: { title: "Change password", submit: "Change password", fields: ["current", "password"] },
  };
  const setAuthMode = (mode) => {
    authMode = mode;
    const ui = AUTH_UI[mode];
    signinTitle.textContent = ui.title;
    $("#auth-name").hidden = !ui.fields.includes("name");
    $("#auth-email").hidden = !ui.fields.includes("email");
    $("#auth-current").hidden = !ui.fields.includes("current");
    $("#auth-password").hidden = !ui.fields.includes("password");
    $("#auth-password").placeholder =
      mode === "reset" || mode === "change" ? "New password (8+ characters)" : "Password (8+ characters)";
    $("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("#auth-submit").textContent = ui.submit;
    $("#auth-forgot").parentElement.hidden = !ui.forgot;
    const sw = document.querySelector(".auth-switch");
    sw.hidden = !ui.switchTo;
    if (ui.switchTo) {
      sw.firstChild.textContent = ui.switchLabel;
      $("#auth-mode").textContent = ui.switchBtn;
      $("#auth-mode").dataset.to = ui.switchTo;
    }
    $("#gsi-button").parentElement === null || ($("#gsi-button").style.display = ui.google ? "" : "none");
    document.querySelector(".auth-divider").style.display = ui.google ? "" : "none";
    authError.hidden = true;
    authOk.hidden = true;
  };
  $("#auth-mode").addEventListener("click", () => setAuthMode($("#auth-mode").dataset.to || "login"));
  $("#auth-forgot").addEventListener("click", () => setAuthMode("forgot"));
  $("#btn-changepw").addEventListener("click", () => {
    accountMenu.hidden = true;
    signinVeil.hidden = false;
    document.body.style.overflow = "hidden";
    setAuthMode("change");
  });

  const showAuthError = (msg) => { authError.textContent = msg; authError.hidden = false; };
  const showAuthOk = (msg) => { authOk.textContent = msg; authOk.hidden = false; };

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.hidden = true;
    authOk.hidden = true;
    const ui = AUTH_UI[authMode];
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const name = $("#auth-name").value.trim();
    if (ui.fields.includes("email") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return showAuthError("enter a valid email");
    if (ui.fields.includes("password") && password.length < 8)
      return showAuthError("password must be at least 8 characters");
    if (authMode === "signup" && !name) return showAuthError("enter your name");
    const btn = $("#auth-submit");
    btn.disabled = true;
    try {
      const [url, body] = {
        login:  ["/api/auth/login", { email, password }],
        signup: ["/api/auth/signup", { name, email, password }],
        forgot: ["/api/auth/forgot", { email }],
        reset:  ["/api/auth/reset", { token: resetToken, password }],
        change: ["/api/auth/change-password", { current: $("#auth-current").value, next: password }],
      }[authMode];
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) return showAuthError(d.error || "something went wrong");
      $("#auth-password").value = "";
      $("#auth-current").value = "";
      if (authMode === "forgot")
        return showAuthOk("If that account exists, a reset link is on its way — valid for 1 hour.");
      if (authMode === "change") return showAuthOk("Password changed ✓");
      if (authMode === "reset") history.replaceState({}, "", "/");
      postAuth(d, authMode);
    } catch { showAuthError("network error — try again"); }
    finally { btn.disabled = false; }
  });
  const openSignin = () => {
    setAuthMode("login");
    signinVeil.hidden = false;
    document.body.style.overflow = "hidden";
    if (!gsiLoaded) {
      gsiLoaded = true;
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = () => {
        window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential });
        window.google.accounts.id.renderButton($("#gsi-button"),
          { theme: "filled_black", size: "large", width: 280, text: "signin_with" });
      };
      document.head.append(s);
    }
  };
  const closeSignin = () => { signinVeil.hidden = true; document.body.style.overflow = ""; };
  $("#signin-close").addEventListener("click", closeSignin);
  signinVeil.addEventListener("click", (e) => { if (e.target === signinVeil) closeSignin(); });

  /* restore session on load */
  fetch("/api/me")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      user = d.user;
      (d.watched || []).forEach((k) => watchedSet.add(k));
      refreshAccount();
      renderGrid();
      renderForYou(); renderThisWeek();
      if (location.pathname === "/watched" && watchedSet.size)
        showWatchlist({ push: false });
    })
    .catch(() => { /* api offline (local dev) — feature simply idle */ });

  const closeDetail = () => {
    detailVeil.hidden = true;
    // back into the search overlay if that's where we came from
    document.body.style.overflow = $("#msearch").hidden ? "" : "hidden";
  };

  /* open on card click / Enter — rating badge and platform links are left alone */
  document.addEventListener("click", (e) => {
    const badge = e.target.closest("a.badge-rating"); // the "New" badge is a span — let it open the card
    if (badge) {
      const c = badge.closest("[data-id]");
      if (c) ga("event", "imdb_click", { item_name: TITLES[Number(c.dataset.id)]?.title || "" });
      e.stopPropagation();
      return;
    }
    const platLink = e.target.closest("a.card-platform");
    if (platLink) {
      const c = platLink.closest("[data-id]");
      if (c) ga("event", "platform_click", { item_name: TITLES[Number(c.dataset.id)]?.title || "", platform: platLink.textContent });
      e.stopPropagation();
      return;
    }
    const card = e.target.closest(".card[data-id], .deck-card[data-id]");
    if (card) openDetail(TITLES[Number(card.dataset.id)]);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches?.(".card[data-id]"))
      openDetail(TITLES[Number(e.target.dataset.id)]);
  });
  $("#detail-close").addEventListener("click", closeDetail);
  detailVeil.addEventListener("click", (e) => { if (e.target === detailVeil) closeDetail(); });

  /* ---------- modal ---------- */
  let modalSelection = new Set(favGenres);

  const renderModalChips = () => {
    modalGenres.innerHTML = allGenres.map((g) => `
      <button class="chip ${modalSelection.has(g) ? "is-active" : ""}" data-mgenre="${g}">${g}</button>`).join("");
    modalSave.disabled = modalSelection.size === 0;
    modalSave.textContent = modalSelection.size
      ? `Save ${modalSelection.size} genre${modalSelection.size > 1 ? "s" : ""}`
      : "Save my genres";
  };

  const openModal = () => {
    modalSelection = new Set(favGenres);
    renderModalChips();
    modalVeil.hidden = false;
    document.body.style.overflow = "hidden";
  };
  const closeModal = () => {
    if (!modalVeil.hidden) setNav("home");
    modalVeil.hidden = true;
    document.body.style.overflow = "";
    localStorage.setItem(LS_SEEN, "1");
  };

  /* ---------- events ---------- */
  $$(".seg-btn[data-type]").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".seg-btn[data-type]").forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      state.type = b.dataset.type;
      renderGrid();
    }));

  $$(".seg-btn[data-lang]").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".seg-btn[data-lang]").forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      state.lang = b.dataset.lang;
      renderGrid();
    }));

  $("#year-select").addEventListener("change", (e) => { state.year = e.target.value; renderGrid(); });
  $("#age-select").addEventListener("change", (e) => { state.age = e.target.value; renderGrid(); });
  $("#sort-select").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
  $("#rating-select").addEventListener("change", (e) => {
    state.minRating = Number(e.target.value);
    e.target.classList.toggle("is-set", state.minRating > 0);
    renderGrid();
  });

  /* ---------- search autosuggest (titles + people) ---------- */
  const suggestBox = $("#search-suggest");
  const searchInput = $("#search-input");
  let suggestItems = []; // flat list backing keyboard nav; each {type,value,el}
  let suggestActive = -1;

  const closeSuggest = () => {
    suggestBox.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    suggestItems = []; suggestActive = -1;
  };

  const runSearch = (text) => {
    searchInput.value = text;
    state.q = text.trim().toLowerCase();
    const searching = state.q !== "";
    document.body.classList.toggle("is-searching", searching);
    $("#search-clear").hidden = !searching;
    if (searching) window.scrollTo({ top: 0 });
    renderGrid();
    closeSuggest();
  };

  /* cast / director names in the detail popup → search for that person */
  $("#detail-credits").addEventListener("click", (e) => {
    const b = e.target.closest(".credit-link");
    if (!b) return;
    closeDetail();
    runSearch(b.dataset.person);
    ga("event", "search", { search_term: b.dataset.person, source: "credits" });
  });

  const renderSuggest = (raw) => {
    const q = raw.trim().toLowerCase();
    if (q.length < 2) return closeSuggest();

    const words = (s) => s.toLowerCase().split(/\s+/);
    const people = PEOPLE
      .filter((p) => words(p.name).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q))
      .sort((a, b) => b.count - a.count || b.bestRating - a.bestRating)
      .slice(0, 5);
    const titles = TITLES
      .filter((t) => t.title.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.title.toLowerCase().startsWith(q) ? 1 : 0;
        const bStarts = b.title.toLowerCase().startsWith(q) ? 1 : 0;
        return bStarts - aStarts || b.rating - a.rating;
      })
      .slice(0, 6);

    if (!people.length && !titles.length) return closeSuggest();

    suggestItems = [
      ...people.map((p) => ({ type: "person", value: p.name })),
      ...titles.map((t) => ({ type: "title", value: t.title, t })),
    ];
    suggestActive = -1;

    const initials = (name) => name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    suggestBox.innerHTML =
      (people.length ? `<p class="suggest-label">People</p>` +
        people.map((p, i) => `
          <button type="button" class="suggest-row" role="option" data-idx="${i}">
            <span class="suggest-thumb" style="display:grid;place-items:center;font-size:0.72rem;font-weight:700;color:var(--text-faint)">${esc(initials(p.name))}</span>
            <span class="suggest-meta">
              <span class="suggest-name">${esc(p.name)}</span>
              <span class="suggest-sub">${p.count} title${p.count === 1 ? "" : "s"}</span>
            </span>
          </button>`).join("") : "") +
      (titles.length ? `<p class="suggest-label">Titles</p>` +
        titles.map((t, i) => `
          <button type="button" class="suggest-row" role="option" data-idx="${people.length + i}">
            ${t.poster ? `<img class="suggest-poster" src="${esc(t.poster)}" alt="" loading="lazy">` : `<span class="suggest-poster"></span>`}
            <span class="suggest-meta">
              <span class="suggest-name">${esc(t.title)}</span>
              <span class="suggest-sub">${t.year} · ★ ${t.rating.toFixed(1)}</span>
            </span>
          </button>`).join("") : "");

    suggestBox.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
  };

  suggestBox.addEventListener("mousedown", (e) => {
    // mousedown (not click) fires before the input's blur, so the row is
    // still in the DOM when we read it
    const row = e.target.closest(".suggest-row");
    if (!row) return;
    e.preventDefault();
    const item = suggestItems[Number(row.dataset.idx)];
    if (!item) return;
    runSearch(item.type === "person" ? item.value : item.value);
    if (item.type === "title") openDetail(item.t);
    ga("event", "search_suggest_click", { type: item.type, value: item.value });
  });

  const highlightSuggest = () => {
    $$(".suggest-row", suggestBox).forEach((el, i) =>
      el.classList.toggle("is-active", i === suggestActive));
  };

  let qTimer;
  $("#search-input").addEventListener("input", (e) => {
    renderSuggest(e.target.value);
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.q = e.target.value.trim().toLowerCase();
      // search mode: hide hero/rail so results sit right under the box
      const searching = state.q !== "";
      document.body.classList.toggle("is-searching", searching);
      $("#search-clear").hidden = !searching;
      if (searching) window.scrollTo({ top: 0 });
      renderGrid();
    }, 120);
    clearTimeout(gaQTimer);
    gaQTimer = setTimeout(() => {
      if (state.q) ga("event", "search", { search_term: state.q });
    }, 1500);
  });
  let gaQTimer;

  $("#search-input").addEventListener("keydown", (e) => {
    if (suggestBox.hidden || !suggestItems.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); suggestActive = Math.min(suggestActive + 1, suggestItems.length - 1); highlightSuggest(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); suggestActive = Math.max(suggestActive - 1, 0); highlightSuggest(); }
    else if (e.key === "Enter" && suggestActive >= 0) {
      e.preventDefault();
      const item = suggestItems[suggestActive];
      runSearch(item.value);
      if (item.type === "title") openDetail(item.t);
    } else if (e.key === "Escape") { closeSuggest(); }
  });
  $("#search-input").addEventListener("blur", () => setTimeout(closeSuggest, 150));
  $("#search-input").addEventListener("focus", (e) => { if (e.target.value.trim().length >= 2) renderSuggest(e.target.value); });

  $("#search-clear").addEventListener("click", () => {
    const inp = $("#search-input");
    inp.value = "";
    state.q = "";
    document.body.classList.remove("is-searching");
    $("#search-clear").hidden = true;
    renderGrid();
    closeSuggest();
    inp.focus();
  });

  genreRow.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-genre]");
    if (!btn) return;
    const g = btn.dataset.genre;
    state.genres.has(g) ? state.genres.delete(g) : state.genres.add(g);
    renderChips();
    renderGrid();
  });

  const resetRoute = () => {
    if (PATH_PRESET?.[location.pathname]) history.pushState({}, "", "/");
  };

  /* ---------- manual catalogue sync ---------- */
  const syncBtn = $("#btn-sync");
  syncBtn.addEventListener("click", async () => {
    if (syncBtn.classList.contains("is-busy")) return;
    syncBtn.classList.add("is-busy");
    try {
      const r = await fetch("/api/sync", { method: "POST" });
      const d = await r.json();
      alert(r.ok ? d.message : (d.error || "Could not start the sync."));
      ga("event", "manual_sync", { ok: r.ok });
    } catch {
      alert("Could not reach the server — try again in a moment.");
    } finally {
      setTimeout(() => syncBtn.classList.remove("is-busy"), 2000);
    }
  });

  /* ---------- genre dropdown ---------- */
  const genreToggle = $("#genre-toggle");
  const closeGenres = () => {
    genreRow.hidden = true;
    genreToggle.setAttribute("aria-expanded", "false");
  };
  genreToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    closePlatforms();
    const open = genreRow.hidden;
    genreRow.hidden = !open;
    genreToggle.setAttribute("aria-expanded", String(open));
  });
  genreRow.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => closeGenres());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeGenres(); });

  /* platform dropdown — same look as genres, single choice */
  const platformToggle = $("#platform-toggle"), platformRow = $("#platform-row");
  const renderPlatformRow = () => {
    $("#platform-label").textContent = state.platform === "all" ? "All platforms" : state.platform;
    platformToggle.classList.toggle("is-set", state.platform !== "all");
    platformRow.innerHTML = [["all", "All platforms"], ...PLATFORMS.map((p) => [p, p])].map(([v, l]) =>
      `<button type="button" class="chip ${state.platform === v ? "is-active" : ""}" data-platform="${esc(v)}">${esc(l)}</button>`).join("");
  };
  const closePlatforms = () => { platformRow.hidden = true; platformToggle.setAttribute("aria-expanded", "false"); };
  platformToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    closeGenres();
    const open = platformRow.hidden;
    platformRow.hidden = !open;
    platformToggle.setAttribute("aria-expanded", String(open));
  });
  platformRow.addEventListener("click", (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-platform]");
    if (!b) return;
    state.platform = b.dataset.platform;
    renderPlatformRow();
    closePlatforms();
    renderGrid();
  });
  document.addEventListener("click", closePlatforms);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePlatforms(); });
  renderPlatformRow();

  /* mobile "Recent ▾" mode dropdown — the options are [data-preset] buttons,
     so the preset listener below already applies them */
  const modeToggle = $("#mode-toggle"), modePanel = $("#mode-panel");
  const closeMode = () => { modePanel.hidden = true; modeToggle.setAttribute("aria-expanded", "false"); };
  modeToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    closeGenres(); closePlatforms();
    const open = modePanel.hidden;
    modePanel.hidden = !open;
    modeToggle.setAttribute("aria-expanded", String(open));
  });
  modePanel.addEventListener("click", (e) => { e.stopPropagation(); if (e.target.closest("[data-preset]")) closeMode(); });
  document.addEventListener("click", closeMode);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMode(); });

  const clearAll = () => {
    state.type = "all"; state.lang = "all"; state.year = "all"; state.age = "all"; state.platform = "all";
    $("#age-select").value = "all";
    $$("[data-preset]").forEach((b) => b.classList.remove("is-active"));
    state.minRating = 0; state.q = ""; state.genres.clear();
    state.watchedOnly = false;
    document.body.classList.remove("is-watchlist");
    document.body.classList.remove("is-searching");
    $("#search-input").value = "";
    $("#search-clear").hidden = true;
    $("#year-select").value = "all";
    $("#rating-select").value = "0";
    $("#rating-select").classList.remove("is-set");
    $$(".seg-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.type === "all" || b.dataset.lang === "all"));
    setBase();
    syncControls();
    renderChips();
    renderGrid();
  };
  $("#btn-clear").addEventListener("click", () => { clearAll(); resetRoute(); });
  $("#btn-empty-clear").addEventListener("click", () => { clearAll(); resetRoute(); });

  /* ---------- quick-view presets (header links) + routes ---------- */
  const PRESET_PATH = { recent: "/recent", hits: "/all-time" };
  const PATH_PRESET = { "/recent": "recent", "/all-time": "hits" };

  const applyPreset = (name, { push = true, scroll = true } = {}) => {
    clearAll();
    if (name === "recent") {
      /* this year's releases, newest first (falls back to all years early in Jan) */
      const yr = String(new Date().getFullYear());
      if ($(`#year-select option[value="${yr}"]`)) {
        state.year = yr;
        $("#year-select").value = yr;
      }
      state.sort = "newest";
      $("#sort-select").value = "newest";
      applyDefaultRating(); // site default: quality bar stays on
    } else { /* hits: the all-time greats */
      state.sort = "rating";
      $("#sort-select").value = "rating";
      state.minRating = 8;
      $("#rating-select").value = "8";
      $("#rating-select").classList.add("is-set");
    }
    setBase();
    seeAll = null;
    $("#mode-label").textContent = name === "recent" ? "Recent" : "All-time hits";
    renderGrid();
    $$("[data-preset]").forEach((b) => b.classList.toggle("is-active", b.dataset.preset === name));
    if (push) ga("event", "select_content", { content_type: "preset", item_id: name }); // not on every home load
    if (push && location.pathname !== PRESET_PATH[name])
      history.pushState({}, "", PRESET_PATH[name]);
    if (scroll) $("#filterbar").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $$("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => applyPreset(b.dataset.preset)));

  /* header 7+ toggle: one tap to hide anything under IMDb 7 */
  for (const b of $$("#btn-seven")) b.addEventListener("click", () => {
    state.minRating = state.minRating >= 7 ? 0 : 7;
    $("#rating-select").value = String(state.minRating || 0);
    $("#rating-select").classList.toggle("is-set", state.minRating > 0);
    renderGrid();
  });

  const showWatchlist = ({ push = true } = {}) => {
    clearAll();
    if (!watchedSet.size) {
      alert("You haven't marked anything as watched yet — open a title and tap “Mark watched”.");
      return;
    }
    state.watchedOnly = true;
    state.sort = "rating";
    $("#sort-select").value = "rating";
    document.body.classList.add("is-watchlist");
    accountMenu.hidden = true;
    renderGrid();
    if (push && location.pathname !== "/watched") history.pushState({}, "", "/watched");
    $("#filterbar").scrollIntoView({ behavior: "smooth", block: "start" });
    ga("event", "select_content", { content_type: "preset", item_id: "watched" });
  };

  const routeHome = (push) => {
    applyPreset("recent", { push: false, scroll: false }); // home = Recent
    if (push && location.pathname !== "/") history.pushState({}, "", "/");
  };
  window.addEventListener("popstate", () => {
    const preset = PATH_PRESET[location.pathname];
    if (location.pathname === "/watched") showWatchlist({ push: false });
    else if (preset) applyPreset(preset, { push: false, scroll: false });
    else routeHome(false);
  });

  $("#btn-my-genres").addEventListener("click", openModal);
  $("#modal-skip").addEventListener("click", closeModal);
  modalVeil.addEventListener("click", (e) => { if (e.target === modalVeil) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const sheet = $("#sheet-veil");
    if (!detailVeil.hidden) closeDetail();
    else if (!signinVeil.hidden) closeSignin();
    else if (!$("#msearch").hidden) closeMSearch();
    else if (sheet && !sheet.hidden) closeSheet();
    else if (!modalVeil.hidden) closeModal();
  });

  modalGenres.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mgenre]");
    if (!btn) return;
    const g = btn.dataset.mgenre;
    if (modalSelection.has(g)) modalSelection.delete(g);
    else if (modalSelection.size < MAX_FAV) modalSelection.add(g);
    renderModalChips();
  });

  modalSave.addEventListener("click", () => {
    favGenres = [...modalSelection];
    saveFavs(favGenres);
    closeModal();
    renderForYou(); renderThisWeek();
    renderChips();
    forYouSection.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  /* ---------- mobile search overlay ----------
     Full-screen, opened from the header icon. Runs on the in-memory
     catalogue so results are immediate; the homepage's own filters and
     scroll position are never touched, so closing it is a clean return. */
  const msearch = $("#msearch"), msInput = $("#msearch-input"), msResults = $("#msearch-results"), msClear = $("#msearch-clear");
  let msReturnTo = null, msScrollY = 0;
  const matchesQuery = (t, q) =>
    t.title.toLowerCase().includes(q) ||
    (t.collection || "").toLowerCase().includes(q) ||
    (t.director || "").toLowerCase().includes(q) ||
    (t.cast || []).some((a) => a.toLowerCase().includes(q));
  const msRow = (t) => {
    const src = t.poster && t.poster.includes("image.tmdb.org/t/p/w500/") ? t.poster.replace("/w500/", "/w92/") : t.poster;
    const thumb = t.poster
      ? `<img class="msr-thumb" src="${esc(src)}" alt="" loading="lazy" width="40" height="60">`
      : `<span class="msr-thumb" aria-hidden="true">${esc(t.title.trim()[0].toUpperCase())}</span>`;
    const plat = platformKey(t);
    return `<button type="button" class="msr" role="option" data-id="${t._id}">
      ${thumb}
      <span class="msr-meta">
        <span class="msr-title">${esc(t.title)}</span>
        <span class="msr-sub">${t.year} · ${t.type === "movie" ? "Film" : "Series"} · <span class="lang-tag">${t.lang === "hi" ? "हिंदी" : "English"}</span>${plat && plat !== "Streaming" ? ` · ${esc(plat)}` : ""}</span>
      </span>
      ${t.rating ? `<span class="msr-rating">★ ${t.rating.toFixed(1)}</span>` : `<span class="msr-rating is-new">New</span>`}
    </button>`;
  };
  const renderMSearch = () => {
    const raw = msInput.value, q = raw.trim().toLowerCase();
    msClear.hidden = !raw;
    if (!TITLES.length) {
      msResults.innerHTML = `<p class="msearch-state is-error"><b>The catalogue didn't load</b>Check your connection, then <button type="button" class="auth-link" onclick="location.reload()">reload</button>.</p>`;
      return;
    }
    if (!q) {
      msResults.innerHTML = `<p class="msearch-state"><b>Search Binge</b>Titles, actors, directors — try “Pankaj Tripathi” or “Mirzapur”.</p>`;
      return;
    }
    const rank = (t) => t.title.toLowerCase().startsWith(q) ? 2 : t.title.toLowerCase().includes(q) ? 1 : 0;
    const list = TITLES.filter((t) => matchesQuery(t, q))
      .sort((a, b) => rank(b) - rank(a) || b.rating - a.rating)
      .slice(0, 40);
    msResults.innerHTML = list.length
      ? list.map(msRow).join("")
      : `<p class="msearch-state"><b>No matches</b>Nothing for “${esc(raw.trim())}” — try a shorter word or another spelling.</p>`;
  };
  const fitMSearch = () => {
    const vv = window.visualViewport;
    msearch.style.setProperty("--vvh", vv ? `${vv.height}px` : "100dvh");
  };
  const openMSearch = () => {
    msReturnTo = document.activeElement;
    msScrollY = window.scrollY;
    msearch.hidden = false;
    document.body.classList.add("msearch-open"); // hides the bottom bar
    setNav("search");
    document.body.style.overflow = "hidden";
    fitMSearch();
    window.visualViewport?.addEventListener("resize", fitMSearch);
    renderMSearch();
    msInput.focus(); // synchronous, inside the tap → the phone's keyboard opens
  };
  const closeMSearch = () => {
    if (msearch.hidden) return;
    msearch.hidden = true;
    document.body.classList.remove("msearch-open");
    setNav("home");
    document.body.style.overflow = "";
    window.visualViewport?.removeEventListener("resize", fitMSearch);
    window.scrollTo(0, msScrollY);
    // iOS Safari doesn't focus a tapped button, so the opener is often <body>
    const back = msReturnTo && msReturnTo !== document.body && !msearch.contains(msReturnTo) ? msReturnTo : $("#nav-search");
    back.focus();
  };
  $("#msearch-back").addEventListener("click", closeMSearch);
  msClear.addEventListener("click", () => { msInput.value = ""; renderMSearch(); msInput.focus(); });
  msInput.addEventListener("input", renderMSearch);
  msInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); msInput.blur(); }   // tuck the keyboard away; results fill the screen
    if (e.key === "Escape") { e.preventDefault(); closeMSearch(); }
  });
  msResults.addEventListener("click", (e) => {
    const row = e.target.closest(".msr");
    if (!row) return;
    const t = TITLES[Number(row.dataset.id)];
    if (!t) return;
    openDetail(t);
    ga("event", "search_suggest_click", { type: "title", value: t.title, source: "mobile" });
  });
  msearch.addEventListener("keydown", (e) => { // keep Tab inside the dialog
    if (e.key !== "Tab") return;
    const f = $$("button:not([hidden]), input", msearch);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ---------- mobile bottom navigation ---------- */
  const setNav = (id) => $$(".bnav").forEach((b) => {
    const on = b.id === `nav-${id}`;
    b.classList.toggle("is-active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  $("#nav-home").addEventListener("click", () => {
    closeMSearch(); closeModal(); accountMenu.hidden = true;
    routeHome(true);
    window.scrollTo({ top: 0 });
    setNav("home");
  });
  $("#nav-search").addEventListener("click", openMSearch);
  $("#nav-genres").addEventListener("click", () => { accountMenu.hidden = true; openModal(); setNav("genres"); });
  $("#nav-profile").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAccountMenu();
    setNav(accountMenu.hidden ? "home" : "profile");
  });

  /* shelf "See all" → the full grid for that shelf; Home / Back returns */
  document.addEventListener("click", (e) => {
    if (e.target.closest("#foryou-cta")) { openModal(); setNav("genres"); return; }
    if (e.target.closest("#grid-back")) { routeHome(false); window.scrollTo({ top: 0 }); return; }
    const b = e.target.closest("[data-seeall]");
    if (!b) return;
    history.pushState({ seeAll: b.dataset.seeall }, "", location.pathname + location.search);
    if (b.dataset.seeall === "picks") {
      state.genres = new Set(favGenres);
      state.sort = "rating";
      syncControls(); renderChips();
      seeAll = "picks";
    } else {
      applyPreset("recent", { push: false, scroll: false });
      seeAll = "new";
    }
    renderGrid();
    $("#grid-head").scrollIntoView({ behavior: "smooth", block: "start" });
    ga("event", "select_content", { content_type: "shelf", item_id: b.dataset.seeall });
  });

  /* ---------- mobile filter sheet ---------- */
  const sheetVeil = $("#sheet-veil");
  const sheetBody = $("#sheet-body");
  const filterbar = $("#filterbar");
  const rowTop = $(".filter-row-top");
  const mobileRow = $("#mobile-filter-row");
  const mqMobile = matchMedia("(max-width: 720px)");

  /* Draft semantics: the controls in the sheet edit the live state (so the
     "Show N titles" count is exact and the grid behind is honest), but a
     snapshot taken on open is restored if the sheet is dismissed rather
     than applied. */
  const snapshotState = () => ({ ...state, genres: new Set(state.genres) });
  const restoreState = (s) => { Object.assign(state, s, { genres: new Set(s.genres) }); };
  let sheetSnapshot = null;
  const openSheet = () => {
    sheetSnapshot = snapshotState();
    sheetVeil.hidden = false;
    document.body.style.overflow = "hidden";
    renderGrid(); // refresh the "Show N titles" label
  };
  const closeSheet = ({ apply = false } = {}) => {
    if (sheetVeil.hidden) return;
    if (!apply && sheetSnapshot) { restoreState(sheetSnapshot); syncControls(); renderChips(); }
    sheetSnapshot = null;
    sheetVeil.hidden = true;
    document.body.style.overflow = "";
    renderGrid();
    if (apply) { savePrefs(); ga("event", "filters_apply", { count: extraFilters().length }); }
  };

  /* the real filter controls MOVE between the bar and the sheet, so all
     listeners and state stay intact — nothing is duplicated */
  const layoutFilters = () => {
    const mobile = mqMobile.matches;
    mobileRow.hidden = !mobile;
    if (mobile === sheetBody.contains(rowTop) && mobile === $(".site-header").contains($(".mtoolbar"))) return; // already in place
    if (mobile) {
      sheetBody.append(rowTop);
      $(".header-actions").append($(".mtoolbar")); // Recent ▾ + funnel share the header row
      document.body.append(accountMenu);           // menu rises above the bottom bar (header's backdrop-filter would trap position:fixed)
    } else {
      closeSheet();
      filterbar.append(rowTop);
      mobileRow.append($(".mtoolbar"));
      $(".account-wrap").append(accountMenu);
    }
    renderGrid(); // featured banner / grid heading are viewport-dependent
  };
  mqMobile.addEventListener("change", layoutFilters);
  window.addEventListener("resize", layoutFilters);
  setInterval(layoutFilters, 1000); // belt & braces: some webviews fire neither event

  $("#btn-filters").addEventListener("click", openSheet);
  $("#sheet-apply").addEventListener("click", () => closeSheet({ apply: true }));
  /* Reset = every control in this sheet back to the view's own defaults;
     still a draft until Show is tapped. Keeps Recent / All-time hits. */
  $("#sheet-reset").addEventListener("click", () => {
    state.type = "all"; state.lang = "all"; state.age = "all"; state.platform = "all";
    state.genres.clear();
    state.year = presetBase.year; state.sort = presetBase.sort; state.minRating = presetBase.minRating;
    syncControls(); renderChips(); renderGrid();
  });
  sheetVeil.addEventListener("click", (e) => { if (e.target === sheetVeil) closeSheet(); });


  /* ---------- boot ---------- */
  const applyDefaultRating = () => {
    state.minRating = 7;
    $("#rating-select").value = "7";
    $("#rating-select").classList.add("is-set");
  };
  applyDefaultRating(); // 7+ is the site default — Clear ✕ removes it
  renderHero();
  renderChips();
  renderForYou(); renderThisWeek();
  renderGrid();
  layoutFilters();
  setTimeout(layoutFilters, 400); // re-check once metrics settle (webview quirk)
  /* the home page IS the "Recent" view — newest first, this year's releases */
  const bootPreset = PATH_PRESET[location.pathname] || (["/", "/index.html"].includes(location.pathname) ? "recent" : null);
  if (bootPreset) applyPreset(bootPreset, { push: false, scroll: false });
  if (![...BOOT_PARAMS.keys()].length) { loadPrefs(); syncControls(); renderChips(); renderGrid(); } // remembered type / language / platform
  applyParams(); // shared-URL filters layer on top of any preset defaults
  /* password-reset deep link: /reset?token=… */
  if (location.pathname === "/reset") {
    resetToken = new URLSearchParams(location.search).get("token");
    if (resetToken) {
      signinVeil.hidden = false;
      document.body.style.overflow = "hidden";
      setAuthMode("reset");
    } else history.replaceState({}, "", "/");
  }
  if (!localStorage.getItem(LS_SEEN) && !favGenres.length) {
    setTimeout(openModal, 1400);
  }
})();

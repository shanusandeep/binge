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
    q: "",
  };

  /* ---------- els ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const grid = $("#grid");
  const emptyState = $("#empty-state");
  const resultsCount = $("#results-count");
  const genreRow = $("#genre-row");
  const forYouSection = $("#foryou-section");
  const forYouRail = $("#foryou-rail");
  const forYouNote = $("#foryou-note");
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

  const allGenres = [...new Set(TITLES.flatMap((t) => t.genres))].sort(
    (a, b) => TITLES.filter((t) => t.genres.includes(b)).length -
              TITLES.filter((t) => t.genres.includes(a)).length
  );

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
  /* normalise the raw certificate (CBFC / MPAA / TV) into 3 buckets */
  const ageBucket = (cert) => {
    if (!cert) return null;
    const c = cert.toUpperCase().replace(/\s+/g, "");
    if (/^(U|G|TV-Y7?(FV)?|TV-G|ALL|0\+?|6\+?|7\+?)$/.test(c)) return "u";
    if (/^(A|R|NC-17|TV-MA|X|18|18\+)$/.test(c)) return "a";
    return "ua"; // U/A variants, PG, PG-13, TV-14, 12–16 etc.
  };

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
    let list = state.q !== ""
      ? TITLES.filter((t) =>
          t.title.toLowerCase().includes(state.q) ||
          (t.tags || []).some((tag) => tag.toLowerCase().includes(state.q)))
      : TITLES.filter((t) =>
          (state.type === "all" || t.type === state.type) &&
          (state.lang === "all" || t.lang === state.lang) &&
          (!state.minRating || t.rating >= state.minRating) &&
          (state.age === "all" || ageBucket(t.cert) === state.age) &&
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

  const imdbURL = (t) => t.imdb
    ? `https://www.imdb.com/title/${t.imdb}/`
    : `https://www.imdb.com/find/?q=${encodeURIComponent(t.title + " " + t.year)}`;

  const cardHTML = (t, i) => {
    const langTag = t.lang === "hi" ? "हिंदी" : "English";
    const typeTag = t.type === "movie" ? "Film" : "Series";
    const topBadge = t.rating >= 8.5 ? `<span class="badge-top">All-time great</span>` : "";
    const glyph = t.title.trim()[0].toUpperCase();
    const img = t.poster
      ? `<img class="poster-img" src="${esc(t.poster)}" alt="" loading="lazy" onerror="this.remove();this.closest('.poster').classList.remove('has-img')">`
      : "";
    const isWatched = watchedSet.has(titleKey(t));
    return `
    <article class="card ${isWatched ? "is-watched" : ""}" style="animation-delay:${Math.min(i * 40, 400)}ms" data-id="${t._id}" tabindex="0" role="button" aria-label="${esc(t.title)} — details">
      <div class="poster ${t.poster ? "has-img" : ""}" style="--poster-bg:${posterBg(t).replace(/\n\s*/g, " ")}">
        ${img}
        <span class="poster-glyph" aria-hidden="true">${glyph}</span>
        <a class="badge-rating" href="${imdbURL(t)}" target="_blank" rel="noopener" title="Open on IMDb" aria-label="IMDb rating ${t.rating.toFixed(1)} — open on IMDb">${IMDB_SVG}${t.rating.toFixed(1)}</a>
        ${topBadge}
        ${isWatched ? `<span class="watched-badge">✓ Watched</span>` : ""}
        <h3 class="poster-word">${esc(t.title)}</h3>
      </div>
      <div class="card-body">
        <p class="card-meta">
          <span class="type-tag">${typeTag}</span><span class="dot">·</span>
          <span>${t.year}</span><span class="dot">·</span>
          <span class="lang-tag">${langTag}</span>
          ${t.seasons ? `<span class="se-tag" title="${t.seasons} season${t.seasons > 1 ? "s" : ""}, ${t.episodes} episodes">${t.seasons}S · ${t.episodes}Ep</span>` : ""}
        </p>
        <p class="card-foot">
          <span class="card-genres">${t.genres.slice(0, 2).join(" / ")}</span>
          <span class="card-platform">${t.platform}</span>
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
    resultsCount.innerHTML =
      `<b>${list.length}</b> title${list.length === 1 ? "" : "s"}` +
      (list.length ? ` · ${hi} Hindi / ${list.length - hi} English` : "");
    $("#btn-clear").hidden = !isFiltered();
    /* focused mode: filters/preset active → hide hero & rail, results on top.
       The 7+ toggle's two home states (on=7 / off=0) don't count as focus. */
    document.body.classList.toggle("is-focused",
      state.type !== "all" || state.lang !== "all" || state.year !== "all" ||
      state.age !== "all" || state.genres.size > 0 || state.q !== "" ||
      ![0, 7].includes(state.minRating));
    syncURL();

    /* header 7+ toggle mirrors the min-rating filter */
    const seven = $("#btn-seven");
    seven.classList.toggle("is-on", state.minRating >= 7);
    seven.setAttribute("aria-pressed", state.minRating >= 7);

    /* mobile funnel badge + inline count */
    const activeCount =
      (state.type !== "all") + (state.lang !== "all") + (state.year !== "all") +
      (state.age !== "all") + (state.minRating > 0) + (state.genres.size > 0);
    const badge = $("#filter-count");
    badge.hidden = !activeCount;
    badge.textContent = activeCount;
    $("#mobile-results").textContent =
      `${list.length} title${list.length === 1 ? "" : "s"}`;
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
    const a = p.get("age"); if (["u", "ua", "a"].includes(a)) state.age = a;
    const m = p.get("min");
    if (["0", "6", "7", "7.5", "8", "8.5", "9"].includes(m)) state.minRating = Number(m);
    const g = p.get("g");
    if (g) {
      const gs = g.split(",").filter((x) => allGenres.includes(x));
      if (gs.length) state.genres = new Set(gs);
    }
    const q = p.get("q");
    if (q) {
      state.q = q.toLowerCase();
      $("#search-input").value = q;
      document.body.classList.add("is-searching");
      $("#search-clear").hidden = false;
    }
    /* reflect everything in the widgets */
    $$(".seg-btn[data-type]").forEach((b) => b.classList.toggle("is-active", b.dataset.type === state.type));
    $$(".seg-btn[data-lang]").forEach((b) => b.classList.toggle("is-active", b.dataset.lang === state.lang));
    $("#year-select").value = state.year;
    $("#sort-select").value = state.sort;
    $("#age-select").value = state.age;
    $("#rating-select").value = String(state.minRating || 0);
    $("#rating-select").classList.toggle("is-set", state.minRating > 0);
    renderChips();
    renderGrid();
  };

  const isFiltered = () =>
    state.type !== "all" || state.lang !== "all" || state.genres.size > 0 ||
    state.year !== "all" || state.age !== "all" || state.minRating > 0 || state.q !== "";

  /* ---------- render: genre chips ---------- */
  const renderChips = () => {
    genreRow.innerHTML = allGenres.map((g) => `
      <button class="chip ${state.genres.has(g) ? "is-active" : ""}" data-genre="${g}">
        ${g}${favGenres.includes(g) ? `<span class="chip-heart">♥</span>` : ""}
      </button>`).join("");
  };

  /* ---------- render: for-you rail ---------- */
  const renderForYou = () => {
    if (!favGenres.length) { forYouSection.hidden = true; return; }
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
       t.cert && `<span class="cert-tag">${esc(t.cert)}</span>`]
        .filter(Boolean).join(`<span class="dot">·</span>`) +
      `<span class="detail-genres">${t.genres.map((g) => `<span class="chip is-active">${g}</span>`).join("")}</span>`;
    $("#detail-desc").textContent = t.desc || t.plot;
    const epInfo = t.episodes
      ? (t.seasons > 1 ? `${t.seasons} seasons · ${t.episodes} episodes` : `${t.episodes} episodes`)
      : null;
    $("#detail-credits").innerHTML =
      (t.director ? `<dt>Director</dt><dd>${esc(t.director)}</dd>` : "") +
      (t.cast?.length ? `<dt>Cast</dt><dd>${t.cast.map(esc).join(", ")}</dd>` : "") +
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
    $("#detail-imdb-rating").textContent = t.rating.toFixed(1) + " / 10";
    $("#detail-platform").textContent = t.platform;
    currentDetail = t;
    updateWatchedBtn(t);
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
    updateWatchedBtn(currentDetail);
    renderGrid();
    renderForYou();
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
    } else {
      accountBtn.textContent = "Sign in";
      accountBtn.classList.remove("is-user");
      accountMenu.hidden = true;
    }
  };
  accountBtn.addEventListener("click", () => {
    if (!user) openSignin();
    else accountMenu.hidden = !accountMenu.hidden;
  });
  $("#btn-signout").addEventListener("click", async () => {
    try { await fetch("/api/logout", { method: "POST" }); } catch {}
    user = null;
    watchedSet.clear();
    refreshAccount();
    renderGrid();
    renderForYou();
    if (currentDetail) updateWatchedBtn(currentDetail);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".account-wrap")) accountMenu.hidden = true;
  });

  const signinVeil = $("#signin-veil");
  let gsiLoaded = false;

  const postAuth = (d) => {
    user = d.user;
    watchedSet.clear();
    (d.watched || []).forEach((k) => watchedSet.add(k));
    refreshAccount();
    renderGrid();
    renderForYou();
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
      postAuth(await r.json());
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
      postAuth(d);
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
      renderForYou();
    })
    .catch(() => { /* api offline (local dev) — feature simply idle */ });

  const closeDetail = () => {
    detailVeil.hidden = true;
    document.body.style.overflow = "";
  };

  /* open on card click / Enter — rating badge link is left alone */
  document.addEventListener("click", (e) => {
    if (e.target.closest(".badge-rating")) { e.stopPropagation(); return; }
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

  let qTimer;
  $("#search-input").addEventListener("input", (e) => {
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
  });

  $("#search-clear").addEventListener("click", () => {
    const inp = $("#search-input");
    inp.value = "";
    state.q = "";
    document.body.classList.remove("is-searching");
    $("#search-clear").hidden = true;
    renderGrid();
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

  const clearAll = () => {
    state.type = "all"; state.lang = "all"; state.year = "all"; state.age = "all";
    $("#age-select").value = "all";
    $$(".top-link").forEach((b) => b.classList.remove("is-active"));
    state.minRating = 0; state.q = ""; state.genres.clear();
    document.body.classList.remove("is-searching");
    $("#search-input").value = "";
    $("#search-clear").hidden = true;
    $("#year-select").value = "all";
    $("#rating-select").value = "0";
    $("#rating-select").classList.remove("is-set");
    $$(".seg-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.type === "all" || b.dataset.lang === "all"));
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
    renderGrid();
    $$(".top-link").forEach((b) => b.classList.toggle("is-active", b.dataset.preset === name));
    if (push && location.pathname !== PRESET_PATH[name])
      history.pushState({}, "", PRESET_PATH[name]);
    if (scroll) $("#filterbar").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $$(".top-link[data-preset]").forEach((b) =>
    b.addEventListener("click", () => applyPreset(b.dataset.preset)));

  /* header 7+ toggle: one tap to hide anything under IMDb 7 */
  $("#btn-seven").addEventListener("click", () => {
    state.minRating = state.minRating >= 7 ? 0 : 7;
    $("#rating-select").value = String(state.minRating || 0);
    $("#rating-select").classList.toggle("is-set", state.minRating > 0);
    renderGrid();
  });

  const routeHome = (push) => {
    clearAll();
    if (push && location.pathname !== "/") history.pushState({}, "", "/");
  };
  window.addEventListener("popstate", () => {
    const preset = PATH_PRESET[location.pathname];
    preset ? applyPreset(preset, { push: false, scroll: false }) : routeHome(false);
  });

  $("#btn-my-genres").addEventListener("click", openModal);
  $("#modal-skip").addEventListener("click", closeModal);
  modalVeil.addEventListener("click", (e) => { if (e.target === modalVeil) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const sheet = $("#sheet-veil");
    if (!detailVeil.hidden) closeDetail();
    else if (!signinVeil.hidden) closeSignin();
    else if (sheet && !sheet.hidden) { sheet.hidden = true; document.body.style.overflow = ""; }
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
    renderForYou();
    renderChips();
    forYouSection.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  /* ---------- mobile filter sheet ---------- */
  const sheetVeil = $("#sheet-veil");
  const sheetBody = $("#sheet-body");
  const filterbar = $("#filterbar");
  const rowTop = $(".filter-row-top");
  const mobileRow = $("#mobile-filter-row");
  const mqMobile = matchMedia("(max-width: 720px)");

  const openSheet = () => { sheetVeil.hidden = false; document.body.style.overflow = "hidden"; };
  const closeSheet = () => {
    if (sheetVeil.hidden) return;
    sheetVeil.hidden = true;
    document.body.style.overflow = "";
  };

  /* the real filter controls MOVE between the bar and the sheet, so all
     listeners and state stay intact — nothing is duplicated */
  const layoutFilters = () => {
    const mobile = mqMobile.matches;
    mobileRow.hidden = !mobile;
    if (mobile === sheetBody.contains(rowTop)) return; // already in place
    if (mobile) {
      sheetBody.append(rowTop, genreRow);
    } else {
      closeSheet();
      filterbar.append(rowTop, genreRow);
    }
  };
  mqMobile.addEventListener("change", layoutFilters);
  window.addEventListener("resize", layoutFilters);
  setInterval(layoutFilters, 1000); // belt & braces: some webviews fire neither event

  $("#btn-filters").addEventListener("click", openSheet);
  $("#sheet-apply").addEventListener("click", closeSheet);
  $("#sheet-reset").addEventListener("click", () => { clearAll(); resetRoute(); });
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
  renderForYou();
  renderGrid();
  layoutFilters();
  setTimeout(layoutFilters, 400); // re-check once metrics settle (webview quirk)
  const bootPreset = PATH_PRESET[location.pathname];
  if (bootPreset) applyPreset(bootPreset, { push: false, scroll: false });
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

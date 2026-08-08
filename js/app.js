/* ============================================================
   BINGE — app logic
   Filtering, sorting, personalisation (fav genres), rendering.
   ============================================================ */
(function () {
  "use strict";

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
    let list = TITLES.filter((t) =>
      (state.type === "all" || t.type === state.type) &&
      (state.lang === "all" || t.lang === state.lang) &&
      (!state.minRating || t.rating >= state.minRating) &&
      yearMatch(t) &&
      (state.genres.size === 0 || t.genres.some((g) => state.genres.has(g))) &&
      (state.q === "" || t.title.toLowerCase().includes(state.q))
    );
    switch (state.sort) {
      case "rating": list.sort((a, b) => b.rating - a.rating || b.year - a.year); break;
      case "newest": list.sort((a, b) => b.year - a.year || b.rating - a.rating); break;
      case "oldest": list.sort((a, b) => a.year - b.year || b.rating - a.rating); break;
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
    return `
    <article class="card" style="animation-delay:${Math.min(i * 40, 400)}ms" data-id="${t._id}" tabindex="0" role="button" aria-label="${esc(t.title)} — details">
      <div class="poster ${t.poster ? "has-img" : ""}" style="--poster-bg:${posterBg(t).replace(/\n\s*/g, " ")}">
        ${img}
        <span class="poster-glyph" aria-hidden="true">${glyph}</span>
        <a class="badge-rating" href="${imdbURL(t)}" target="_blank" rel="noopener" title="Open on IMDb" aria-label="IMDb rating ${t.rating.toFixed(1)} — open on IMDb">${IMDB_SVG}${t.rating.toFixed(1)}</a>
        ${topBadge}
        <h3 class="poster-word">${esc(t.title)}</h3>
      </div>
      <div class="card-body">
        <p class="card-meta">
          <span class="type-tag">${typeTag}</span><span class="dot">·</span>
          <span>${t.year}</span><span class="dot">·</span>
          <span class="lang-tag">${langTag}</span>
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
  };

  const isFiltered = () =>
    state.type !== "all" || state.lang !== "all" || state.genres.size > 0 ||
    state.year !== "all" || state.minRating > 0 || state.q !== "";

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
      .filter((t) => t.rating >= 7.3 && t.genres.some((g) => favGenres.includes(g)))
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
      media.style.background = `url("${t.poster}") center / cover no-repeat, ${posterBg(t).replace(/\n\s*/g, " ")}`;
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
    $("#detail-meta").innerHTML =
      [`<span>${t.year}</span>`, runtime && `<span>${runtime}</span>`]
        .filter(Boolean).join(`<span class="dot">·</span>`) +
      `<span class="detail-genres">${t.genres.map((g) => `<span class="chip is-active">${g}</span>`).join("")}</span>`;
    $("#detail-desc").textContent = t.desc || t.plot;
    $("#detail-credits").innerHTML =
      (t.director ? `<dt>Director</dt><dd>${esc(t.director)}</dd>` : "") +
      (t.cast?.length ? `<dt>Cast</dt><dd>${t.cast.map(esc).join(", ")}</dd>` : "");
    const link = $("#detail-imdb");
    link.href = imdbURL(t);
    $("#detail-imdb-rating").textContent = t.rating.toFixed(1) + " / 10";
    $("#detail-platform").textContent = t.platform;
    detailVeil.hidden = false;
    document.body.style.overflow = "hidden";
    $("#detail-close").focus({ preventScroll: true });
  };

  const closeDetail = () => {
    detailVeil.hidden = true;
    document.body.style.overflow = "";
  };

  /* open on card click / Enter — rating badge link is left alone */
  document.addEventListener("click", (e) => {
    if (e.target.closest(".badge-rating")) { e.stopPropagation(); return; }
    const card = e.target.closest(".card[data-id]");
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
      renderGrid();
    }, 120);
  });

  genreRow.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-genre]");
    if (!btn) return;
    const g = btn.dataset.genre;
    state.genres.has(g) ? state.genres.delete(g) : state.genres.add(g);
    renderChips();
    renderGrid();
  });

  const clearAll = () => {
    state.type = "all"; state.lang = "all"; state.year = "all";
    state.minRating = 0; state.q = ""; state.genres.clear();
    $("#search-input").value = "";
    $("#year-select").value = "all";
    $("#rating-select").value = "0";
    $("#rating-select").classList.remove("is-set");
    $$(".seg-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.type === "all" || b.dataset.lang === "all"));
    renderChips();
    renderGrid();
  };
  $("#btn-clear").addEventListener("click", clearAll);
  $("#btn-empty-clear").addEventListener("click", clearAll);

  $("#btn-my-genres").addEventListener("click", openModal);
  $("#modal-skip").addEventListener("click", closeModal);
  modalVeil.addEventListener("click", (e) => { if (e.target === modalVeil) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!detailVeil.hidden) closeDetail();
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

  /* ---------- boot ---------- */
  renderHero();
  renderChips();
  renderForYou();
  renderGrid();
  if (!localStorage.getItem(LS_SEEN) && !favGenres.length) {
    setTimeout(openModal, 1400);
  }
})();

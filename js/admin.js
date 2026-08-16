/* ============================================================
   BINGE — Control Room (admin dashboard)
   Auth-gated via /api/me; sections lazy-load from /api/admin/*.
   ============================================================ */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- formatting ---------- */
  const parseTs = (ts) => {
    if (!ts) return null;
    // sqlite "YYYY-MM-DD HH:MM:SS" is UTC; bare dates are calendar days
    if (ts.length <= 10) return new Date(ts + "T00:00:00");
    return new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  };
  const fmtDate = (ts) => {
    const d = parseTs(ts);
    return d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
  };
  const fmtTime = (ts) => {
    const d = parseTs(ts);
    return d ? d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
  };
  const fmtAgo = (ts) => {
    const d = parseTs(ts);
    if (!d) return "—";
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return fmtDate(ts);
  };
  const fmtDur = (sec) => {
    if (sec == null) return "—";
    if (sec < 90) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
  };
  const num = (n) => (n ?? 0).toLocaleString("en-IN");

  /* resolve watched title_keys (imdb id or slug|year) to display names */
  const KEY_TO_TITLE = new Map();
  for (const t of (window.BINGE_DB?.titles || [])) {
    const key = t.imdb || t.title.toLowerCase().replace(/[^a-z0-9]+/g, "") + "|" + t.year;
    KEY_TO_TITLE.set(key, t.title);
  }
  const titleFor = (key) => KEY_TO_TITLE.get(key) || key;

  const api = async (path, opts) => {
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
    return data;
  };

  let toastTimer;
  const toast = (msg, isErr = false) => {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const el = document.createElement("div");
    el.className = "toast" + (isErr ? " is-err" : "");
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 4000);
  };

  /* ================= auth gate ================= */
  const boot = async () => {
    try {
      const me = await api("/api/me");
      if (!me.user?.isAdmin) {
        $("#gate-status").textContent = "This booth is for projectionists only.";
        $("#gate-card").insertAdjacentHTML("beforeend",
          `<p class="gate-sub">Signed in as ${esc(me.user?.email || "guest")} — this account doesn't have admin access.</p>`);
        return;
      }
      $("#gate").hidden = true;
      $("#shell").hidden = false;
      const u = me.user;
      $("#side-user").innerHTML = `
        ${u.picture ? `<img src="${esc(u.picture)}" alt="">`
          : `<span class="su-fallback">${esc((u.name || u.email || "?")[0].toUpperCase())}</span>`}
        <div><b>${esc(u.name || "Admin")}</b><span>${esc(u.email || "")}</span></div>`;
      route();
    } catch {
      $("#gate-status").textContent = "You're not signed in.";
      $("#gate-card").insertAdjacentHTML("beforeend",
        `<p class="gate-sub">Sign in on the main site first, then come back to /admin.</p>`);
    }
  };

  /* ================= hash router ================= */
  const SECTIONS = ["overview", "users", "sync", "integrations"];
  const loaded = new Set();
  const LOADERS = { overview: loadOverview, users: loadUsers, sync: loadSync, integrations: loadTech };
  const route = () => {
    const sec = SECTIONS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
    for (const s of SECTIONS) $(`#sec-${s}`).hidden = s !== sec;
    document.querySelectorAll("#side-nav a").forEach((a) =>
      a.classList.toggle("is-on", a.dataset.sec === sec));
    if (!loaded.has(sec)) { loaded.add(sec); LOADERS[sec]().catch((e) => showErr(sec, e)); }
  };
  window.addEventListener("hashchange", route);
  const showErr = (sec, e) => {
    const body = { overview: "#overview-body", users: "#users-body", sync: "#sync-body", integrations: "#tech-body" }[sec];
    $(body).innerHTML = `<p class="err">${esc(e.message)}</p>`;
    loaded.delete(sec);
  };

  /* ================= overview ================= */
  async function loadOverview() {
    const s = await api("/api/admin/stats");
    const c = s.catalogue;

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5);
      days.push(d.toISOString().slice(0, 10));
    }
    const spark = (rows) => {
      const by = Object.fromEntries(rows.map((r) => [r.d, r.n]));
      const max = Math.max(1, ...rows.map((r) => r.n));
      return days.map((d) => {
        const n = by[d] || 0;
        return `<i style="height:${Math.max(4, (n / max) * 100)}%" class="${n ? "" : "spark-zero"}" title="${d}: ${n}"></i>`;
      }).join("");
    };
    const sparkTotal = (rows) => rows.reduce((a, r) => a + r.n, 0);

    $("#overview-body").innerHTML = `
      <div class="panel-title">Registered users</div>
      <div class="tiles">
        <div class="tile"><b>${num(s.users.total)}</b><span>Total accounts</span></div>
        <div class="tile"><b>${num(s.users.newLast7Days)}<em>+</em></b><span>New (7 days)</span></div>
        <div class="tile"><b>${num(s.users.viaGoogle)}</b><span>Via Google</span></div>
        <div class="tile"><b>${num(s.users.viaPassword)}</b><span>Via email</span></div>
        <div class="tile"><b>${num(s.users.admins)}</b><span>Admins</span></div>
      </div>

      <div class="panel-title">Catalogue</div>
      ${c ? `
      <div class="tiles">
        <div class="tile"><b>${num(c.total)}</b><span>Total titles</span></div>
        <div class="tile"><b>${num(c.movies)}</b><span>Movies</span></div>
        <div class="tile"><b>${num(c.series)}</b><span>Series</span></div>
        <div class="tile"><b>${num(c.hindi)}</b><span>Hindi</span></div>
        <div class="tile"><b>${num(c.english)}</b><span>English</span></div>
        <div class="tile"><b>${fmtDate(c.syncedAt)}</b><span>Last synced</span></div>
      </div>` : `<p class="err">Catalogue data unavailable right now.</p>`}

      <div class="panel-title">Last 14 days</div>
      <div class="charts">
        <div class="chart-card">
          <h4>Signups <span class="chart-legend">· ${num(sparkTotal(s.signupsByDay))} total</span></h4>
          <div class="spark">${spark(s.signupsByDay)}</div>
          <div class="spark-x"><span>${fmtDate(days[0])}</span><span>today</span></div>
        </div>
        <div class="chart-card">
          <h4>Watched marks <span class="chart-legend">· ${num(sparkTotal(s.watchedByDay))} total</span></h4>
          <div class="spark">${spark(s.watchedByDay)}</div>
          <div class="spark-x"><span>${fmtDate(days[0])}</span><span>today</span></div>
        </div>
      </div>

      <div class="panel-title">Recent activity</div>
      ${s.activity.length ? `<ul class="feed">
        ${s.activity.map((a) => `
          <li>
            <span class="f-dot led ${a.kind === "signup" ? "led-ok" : "led-run"}" style="animation:none"></span>
            <span class="f-who">${esc(a.name || a.email || "someone")}</span>
            <span class="f-what">${a.kind === "signup" ? "joined Binge"
              : `watched <b>${esc(titleFor(a.detail))}</b>`}</span>
            <span class="f-when">${fmtAgo(a.at)}</span>
          </li>`).join("")}
      </ul>` : `<p class="loading">No activity yet.</p>`}`;
  }

  /* ================= users ================= */
  let allUsers = [], myEmail = "";
  async function loadUsers() {
    const d = await api("/api/admin/users");
    allUsers = d.users; myEmail = d.me.email;
    renderUsers();
  }
  const renderUsers = () => {
    const q = ($("#user-search").value || "").trim().toLowerCase();
    const rows = allUsers.filter((u) =>
      !q || (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q));
    $("#users-count").textContent = `${rows.length} of ${allUsers.length}`;
    $("#users-body").innerHTML = `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>User</th><th>Email</th><th>Via</th><th>Watched</th><th>Joined</th><th>Role</th><th></th></tr></thead>
        <tbody>${rows.map((u) => `
          <tr data-id="${u.id}">
            <td class="t-name">${u.picture ? `<img class="t-avatar" src="${esc(u.picture)}" alt="">`
              : `<span class="t-avatar-fb">${esc((u.name || u.email || "?")[0].toUpperCase())}</span>`}${esc(u.name || "—")}</td>
            <td>${esc(u.email || "—")}</td>
            <td>${esc(u.method)}</td>
            <td class="t-num">${num(u.watched)}</td>
            <td>${fmtDate(u.joinedAt)}</td>
            <td>${u.isOwner ? `<span class="pill pill-owner">Owner</span>`
              : u.isAdmin ? `<span class="pill pill-admin">Admin</span>`
              : `<span class="pill pill-dim">Member</span>`}</td>
            <td>${u.isOwner ? ""
              : `<button class="btn-flip ${u.isAdmin ? "" : "is-promote"}" data-flip="${u.id}" data-admin="${u.isAdmin ? 0 : 1}">
                  ${u.isAdmin ? "Demote" : "Make admin"}</button>`}</td>
          </tr>`).join("")}</tbody>
      </table></div>`;
  };
  $("#user-search").addEventListener("input", () => { if (allUsers.length) renderUsers(); });

  /* promote/demote with a two-step confirm on the same button */
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-flip]");
    if (!btn) return;
    const makeAdmin = btn.dataset.admin === "1";
    if (!btn.classList.contains("is-confirm")) {
      btn.classList.add("is-confirm");
      btn.textContent = makeAdmin ? "Confirm promote?" : "Confirm demote?";
      setTimeout(() => {
        btn.classList.remove("is-confirm");
        btn.textContent = makeAdmin ? "Make admin" : "Demote";
      }, 3500);
      return;
    }
    btn.disabled = true;
    try {
      await api("/api/admin/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: Number(btn.dataset.flip), admin: makeAdmin }),
      });
      const u = allUsers.find((x) => x.id === Number(btn.dataset.flip));
      if (u) u.isAdmin = makeAdmin;
      toast(makeAdmin ? `${u?.name || u?.email} is now an admin` : `${u?.name || u?.email} demoted to member`);
      if (u?.email === myEmail && !makeAdmin) { location.reload(); return; }
      renderUsers();
      loaded.delete("overview"); // admin count changed
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.classList.remove("is-confirm");
      btn.textContent = makeAdmin ? "Make admin" : "Demote";
    }
  });

  /* ================= sync ================= */
  async function loadSync() {
    const d = await api("/api/admin/sync");
    if (!d.configured) {
      $("#sync-body").innerHTML = `<p class="err">GitHub token not configured on the server — run history unavailable.</p>`;
      return;
    }
    const runs = d.runs;
    const last = runs.find((r) => r.status === "completed");
    const lastOk = runs.find((r) => r.conclusion === "success");
    const maxDur = Math.max(1, ...runs.map((r) => r.durationSec || 0));
    const ledFor = (r) => r.status !== "completed" ? "led-run" : r.conclusion === "success" ? "led-ok" : "led-fail";
    const labelFor = (r) => r.status !== "completed" ? "running…"
      : r.conclusion === "success" ? "success" : (r.conclusion || "failed");

    $("#sync-body").innerHTML = `
      <div class="sync-hero">
        <div class="sh-item"><span class="sh-label">Last successful sync</span>
          <div class="sh-big">${lastOk ? fmtAgo(lastOk.updatedAt) : "never"}</div>
          <div class="mono" style="color:var(--text-faint);font-size:.74rem">${lastOk ? fmtTime(lastOk.updatedAt) : ""}</div></div>
        <div class="sh-item"><span class="sh-label">Last run</span>
          <div class="sh-mono"><span class="led ${last ? ledFor(last) : "led-idle"}"></span> ${last ? labelFor(last) : "—"}</div></div>
        <div class="sh-item"><span class="sh-label">Typical duration</span>
          <div class="sh-mono">${last ? fmtDur(last.durationSec) : "—"}</div></div>
        <div class="sh-item"><span class="sh-label">Schedule</span>
          <div class="sh-mono">daily · 07:00 IST</div></div>
      </div>

      <div class="panel-title">Run history <span class="mono" style="letter-spacing:0;text-transform:none">(${esc(d.repo)})</span></div>
      <ul class="runs">
        ${runs.map((r) => `
          <li>
            <span class="led ${ledFor(r)}"></span>
            <span class="r-event">${r.event === "schedule" ? "scheduled" : r.event === "workflow_dispatch" ? "manual" : esc(r.event)}</span>
            <span class="r-when">${fmtTime(r.startedAt)}<small>${labelFor(r)}</small></span>
            <span class="r-dur"><i style="width:${Math.max(6, ((r.durationSec || 0) / maxDur) * 90)}px"></i>${fmtDur(r.durationSec)}</span>
            <a href="${esc(r.url)}" target="_blank" rel="noopener">logs ↗</a>
          </li>`).join("")}
      </ul>`;
  }

  $("#btn-run-sync").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "⟳ Starting…";
    try {
      const d = await api("/api/sync", { method: "POST" });
      toast(d.message || "Sync started");
      setTimeout(() => { loaded.delete("sync"); if (location.hash.slice(1) === "sync" || !location.hash) route(); }, 4000);
    } catch (err) { toast(err.message, true); }
    setTimeout(() => { btn.disabled = false; btn.textContent = "⟳ Run sync now"; }, 5000);
  });

  /* ================= integrations ================= */
  async function loadTech() {
    const d = await api("/api/admin/tech");
    const pipelineCalls = {
      ...(d.pipeline?.sync?.calls || {}),
      ...(d.pipeline?.enrich?.calls || {}),
    };
    const pipelineAt = { ...(d.pipeline?.sync ? { sync: d.pipeline.sync.at } : {}), ...(d.pipeline?.enrich ? { enrich: d.pipeline.enrich.at } : {}) };
    const syncMeta = d.pipeline?.sync;

    const WHERE = { pipeline: "sync pipeline", server: "api server", browser: "browser" };
    const card = (svc) => {
      const ctr = d.counters[svc.id];
      const isPipeline = svc.runsIn === "pipeline";
      const used = isPipeline ? pipelineCalls[svc.id] : ctr ? ctr.today : null;
      const usedLabel = isPipeline ? "last run" : "today";
      const totals = ctr ? `${num(ctr.ok)}<span> ok</span>${ctr.fail ? ` · ${num(ctr.fail)}<span> failed</span>` : ""}` : null;
      const lastTouch = isPipeline
        ? (pipelineAt[svc.id === "wikipedia" || svc.id === "wikidata" || svc.id === "gemini" ? "enrich" : "sync"])
        : (ctr?.lastOk || ctr?.lastFail);
      const failed = !isPipeline && ctr && ctr.lastFail && (!ctr.lastOk || ctr.lastFail > ctr.lastOk);
      const led = used == null && !ctr ? "led-idle" : failed ? "led-fail" : "led-ok";

      const quota = svc.quota;
      const pct = quota.limit && used != null ? Math.min(100, (used / quota.limit) * 100) : null;
      const hot = pct > 80 && quota.period !== "run"; // per-run quotas are expected to fill
      return `
        <div class="svc">
          <div class="svc-top">
            <span class="led ${led}"></span>
            <h3>${esc(svc.name)}</h3>
            <span class="svc-where">${WHERE[svc.runsIn]}</span>
          </div>
          <p class="svc-role">${esc(svc.role)}</p>
          <div class="svc-stats">
            <div>${used != null ? num(used) : "—"}<span> calls ${usedLabel}</span></div>
            ${totals ? `<div>${totals}<span> · 30d</span></div>` : ""}
            ${lastTouch ? `<div><span>seen </span>${fmtAgo(lastTouch)}</div>` : ""}
          </div>
          ${quota.limit ? `
          <div class="svc-quota">
            <div class="q-bar"><div class="q-fill ${hot ? "q-hot" : ""}" style="width:${pct ?? 0}%"></div></div>
            <div class="q-text"><span>${used != null ? num(used) : 0} used</span><span>${num(quota.limit)} / ${quota.period}</span></div>
          </div>` : `<p class="svc-note">${esc(quota.note)}</p>`}
          ${quota.limit ? `<p class="svc-note">${esc(quota.note)}</p>` : ""}
          ${!isPipeline && ctr?.lastError && failed ? `<div class="svc-err" title="${esc(ctr.lastError)}">${esc(ctr.lastError)}</div>` : ""}
        </div>`;
    };

    $("#tech-body").innerHTML = `
      ${syncMeta ? `
      <div class="sync-hero" style="margin-bottom:24px">
        <div class="sh-item"><span class="sh-label">Last pipeline run</span><div class="sh-big">${fmtAgo(syncMeta.at)}</div></div>
        <div class="sh-item"><span class="sh-label">Duration</span><div class="sh-mono">${fmtDur(syncMeta.durationSec)}</div></div>
        <div class="sh-item"><span class="sh-label">Titles added</span><div class="sh-mono">${num(syncMeta.added)}</div></div>
        <div class="sh-item"><span class="sh-label">Ratings refreshed</span><div class="sh-mono">${num(syncMeta.refreshed)}</div></div>
        <div class="sh-item"><span class="sh-label">TMDB calls</span><div class="sh-mono">${num(pipelineCalls.tmdb)}</div></div>
      </div>` : `<p class="loading" style="padding-bottom:18px">Pipeline call counts appear after the next sync run publishes data/sync-stats.json.</p>`}
      <div class="svc-grid">${d.services.map(card).join("")}</div>`;
  }

  boot();
})();

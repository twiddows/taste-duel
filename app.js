// Taste Duel: show two site templates, learn from each pick, steer the next pair.
//
// The model is a small logistic preference model (Bradley-Terry with features):
//   score(site) = w · features(site) + bias[site]
// A pick of A over B nudges w toward A's features and away from B's, and moves the two biases
// apart, by how surprised the model was. Pairs come from sites not yet shown: a few far-apart
// pairs to start, then mostly two sites the model already rates highly that still differ in
// several features, so each pick teaches it something.
//
// Each scope (what the design is for) is its own run: its own pool, model and saved progress.
// A project round (?request=<id>, made by tools/request.mjs) is a fresh, shorter run of one scope
// for one project, saved under its own key; its results go back to the project's folder.

(function () {
  "use strict";

  const ALL = (window.TASTE_POOL || []).filter((s) => s.preview).map((s) => ({ ...s, id: String(s.id) }));
  const MAX_ROUNDS = 50;        // 50 pairs = 100 sites, fewer when the scope's pool is smaller
  const EXTRA_ROUNDS = 10;      // "Keep going"
  const EXPLORE_ROUNDS = 6;     // far-apart pairs before the model steers
  const EXPLORE_RATE = 0.2;     // chance of a wildcard pair after that
  const LR_W = 0.35;
  const LR_B = 0.6;
  const DECAY = 0.01;
  const STORE_PREFIX = "taste-duel-v2:";

  const SCOPES = [
    {
      id: "dashboards", label: "Dashboards & internal tools", short: "Dashboards",
      blurb: "Cockpits, signage, reports, admin screens. Dashboard templates plus dashboard pieces: KPI cards, layouts, data tables.",
      filter: (s) => s.kind === "dashboard",
    },
    {
      id: "marketing", label: "Marketing site", short: "Marketing",
      blurb: "A public site for a business or product: SaaS, agency, local-business, shop and event sites.",
      filter: (s) => s.source !== "component" && ["saas", "agency", "business", "shop", "event"].includes(s.kind),
    },
    {
      id: "all", label: "Anything", short: "Anything",
      blurb: "Every full site in the pool, all kinds mixed, portfolios included.",
      filter: (s) => s.source !== "component",
    },
  ];

  const TAGS = ["dark", "light", "motion", "minimal", "serif", "playful", "photo", "product", "corporate", "bold", "dense"];
  const KINDS = ["saas", "agency", "portfolio", "dashboard", "business", "shop", "event"];
  const FEATURES = TAGS.map((t) => "tag:" + t).concat(KINDS.map((k) => "kind:" + k));
  const LABELS = {
    "tag:dark": "Dark theme", "tag:light": "Light theme", "tag:motion": "Heavy motion / 3D",
    "tag:minimal": "Minimal", "tag:serif": "Editorial serif type", "tag:playful": "Playful / illustrated",
    "tag:photo": "Photo & video led", "tag:product": "Shows product UI", "tag:corporate": "Stock business layout",
    "tag:bold": "Bold type & colour", "tag:dense": "Data-dense",
    "kind:saas": "SaaS marketing", "kind:agency": "Agency / studio", "kind:portfolio": "Portfolio",
    "kind:dashboard": "Dashboard / app", "kind:business": "Local & business", "kind:shop": "Shop", "kind:event": "Event",
  };
  const TAG_LABELS = { dark: "dark", light: "light", motion: "motion", minimal: "minimal", serif: "serif",
    playful: "playful", photo: "photo", product: "product UI", corporate: "corporate", bold: "bold", dense: "data-dense" };

  const byId = new Map(ALL.map((s) => [s.id, s]));
  const X = new Map(ALL.map((s) => [s.id, featureVector(s)]));

  let scope = null;             // the SCOPES entry being played (a copy with key/pairs in a project round)
  let request = null;           // the project round from ?request=, else null
  let pool = [];                // that scope's sites
  let state = null;
  let undoStack = [];
  let current = null;           // { a, b, mode }
  let busy = false;
  let meanCache = null;

  // ---------- model ----------

  function featureVector(site) {
    return FEATURES.map((f) => {
      const [type, value] = f.split(":");
      return type === "tag" ? (site.tags.includes(value) ? 1 : 0) : (site.kind === value ? 1 : 0);
    });
  }

  function roundsFor(scopeDef) {
    return Math.min(MAX_ROUNDS, Math.floor(ALL.filter(scopeDef.filter).length / 2));
  }

  function fresh() {
    return { w: FEATURES.map(() => 0), b: {}, seen: [], picks: [], round: 0, target: scope.pairs || roundsFor(scope) };
  }

  function score(id) {
    const x = X.get(id);
    let s = state.b[id] || 0;
    for (let i = 0; i < x.length; i++) s += state.w[i] * x[i];
    return s;
  }

  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  function learnPair(winner, loser) {
    const g = 1 - sigmoid(score(winner) - score(loser));
    const xw = X.get(winner), xl = X.get(loser);
    for (let i = 0; i < state.w.length; i++) {
      state.w[i] = state.w[i] * (1 - DECAY) + LR_W * g * (xw[i] - xl[i]);
    }
    state.b[winner] = (state.b[winner] || 0) + LR_B * g;
    state.b[loser] = (state.b[loser] || 0) - LR_B * g;
  }

  // "Both good" / "Neither": move both sites the same way, relative to the scope's average site.
  function learnBoth(a, b, sign) {
    const mean = averageFeatures();
    const xa = X.get(a), xb = X.get(b);
    for (let i = 0; i < state.w.length; i++) {
      state.w[i] = state.w[i] * (1 - DECAY) + sign * LR_W * 0.5 * ((xa[i] + xb[i]) / 2 - mean[i]);
    }
    state.b[a] = (state.b[a] || 0) + sign * LR_B * 0.5;
    state.b[b] = (state.b[b] || 0) + sign * LR_B * 0.5;
  }

  function averageFeatures() {
    if (meanCache) return meanCache;
    meanCache = FEATURES.map((_, i) => pool.reduce((t, s) => t + X.get(s.id)[i], 0) / pool.length);
    return meanCache;
  }

  function distance(a, b) {
    const xa = X.get(a), xb = X.get(b);
    let d = 0;
    for (let i = 0; i < xa.length; i++) d += xa[i] !== xb[i] ? 1 : 0;
    return d;
  }

  // ---------- pair selection ----------

  function unseen() {
    const seen = new Set(state.seen);
    return pool.filter((s) => !seen.has(s.id)).map((s) => s.id);
  }

  function pickFrom(list) { return list[Math.floor(Math.random() * list.length)]; }

  function farthestFrom(a, candidates) {
    let best = [], bestD = -1;
    for (const c of candidates) {
      if (c === a) continue;
      const d = distance(a, c);
      if (d > bestD) { bestD = d; best = [c]; } else if (d === bestD) best.push(c);
    }
    return pickFrom(best);
  }

  function nextPair() {
    const ids = unseen();
    if (ids.length < 2) return null;
    const explore = state.round < EXPLORE_ROUNDS || Math.random() < EXPLORE_RATE;
    if (explore) {
      const a = pickFrom(ids);
      return { a, b: farthestFrom(a, ids), mode: "explore" };
    }
    const ranked = ids.slice().sort((x, y) => score(y) - score(x));
    const a = pickFrom(ranked.slice(0, Math.min(5, ranked.length)));
    const shortlist = ranked.slice(0, Math.min(15, ranked.length)).filter((id) => id !== a);
    // Prefer a close rival that still differs in at least two features.
    let b = null, bestValue = -Infinity;
    for (const id of shortlist) {
      const d = distance(a, id);
      const value = (d >= 2 ? d : d - 5) + Math.random() * 0.75;
      if (value > bestValue) { bestValue = value; b = id; }
    }
    return { a, b, mode: "steer" };
  }

  // ---------- persistence ----------

  function save() {
    try { localStorage.setItem(STORE_PREFIX + (scope.key || scope.id), JSON.stringify(state)); } catch (e) { /* private window */ }
  }

  function load(key) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!Array.isArray(s.w) || s.w.length !== FEATURES.length) return null;
      s.seen = s.seen.filter((id) => byId.has(id));
      return s;
    } catch (e) { return null; }
  }

  // ---------- rendering ----------

  const $ = (sel) => document.querySelector(sel);

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function priceText(p) { return p > 0 ? "$" + p : "Free"; }

  function kindText(site) { return site.source === "component" ? "Dashboard piece" : LABELS["kind:" + site.kind]; }

  function show(view) {
    for (const id of ["start", "duel", "results"]) $("#" + id).hidden = id !== view;
    const inRun = view !== "start";
    for (const id of ["undo", "restart", "switch"]) $("#" + id).hidden = !inRun;
    $(".progress").hidden = !inRun;
  }

  function renderStart() {
    show("start");
    $("#round").textContent = "";
    $("#scopes").innerHTML = SCOPES.map((sc) => {
      const n = ALL.filter(sc.filter).length;
      const saved = load(sc.id);
      let status = "Start";
      if (saved && saved.round >= saved.target) status = `Done: ${saved.round} pairs. See results`;
      else if (saved && saved.round > 0) status = `Resume at pair ${saved.round + 1} of ${saved.target}`;
      return `<button class="scope" data-scope="${sc.id}">
        <h3>${esc(sc.label)}</h3>
        <p>${esc(sc.blurb)}</p>
        <span class="count">${n} to compare · ${roundsFor(sc)} pairs</span>
        <span class="state">${esc(status)} →</span>
      </button>`;
    }).join("");
  }

  function startScope(id) {
    request = null;
    enterScope(SCOPES.find((s) => s.id === id) || SCOPES[0]);
    try { localStorage.setItem(STORE_PREFIX + "last", scope.id); } catch (e) { /* ignore */ }
  }

  function enterScope(def) {
    scope = def;
    pool = ALL.filter(scope.filter);
    meanCache = null;
    state = load(scope.key || scope.id) || fresh();
    undoStack = [];
    current = null;
    renderDuel();
  }

  function startRequest(id) {
    fetch("api/request?id=" + encodeURIComponent(id)).then((r) => (r.ok ? r.json() : null)).then((info) => {
      if (!info) return renderStart();
      request = info;
      const base = SCOPES.find((s) => s.id === info.scope) || SCOPES[SCOPES.length - 1];
      enterScope({ ...base, key: "req:" + info.id, label: `${info.project} (${base.label})`, short: info.project,
        pairs: Math.min(info.pairs || 20, roundsFor(base)) });
    }).catch(() => renderStart());
  }

  function cardHTML(site, side) {
    const key = side === "a" ? "←" : "→";
    const tags = site.tags.map((t) => `<span class="tag">${esc(TAG_LABELS[t])}</span>`).join("");
    return `
      <button class="shot" data-zoom="${esc(site.id)}" title="See the full preview">
        <img src="${esc(site.preview)}" alt="Preview of ${esc(site.name)}" loading="eager" referrerpolicy="no-referrer">
        <span class="zoom-hint">Full preview</span>
      </button>
      <div class="meta">
        <h3>${esc(site.name)}</h3>
        <div class="line"><span>${esc(kindText(site))}</span><span>·</span><span>${priceText(site.price)}</span><span>·</span>
          <a href="${esc(site.url)}" target="_blank" rel="noopener">Open on 21st ↗</a></div>
        <p>${esc(site.blurb)}</p>
        <div class="tags">${tags}</div>
        <button class="pick" data-pick="${side}">I like this one <kbd>${key}</kbd></button>
      </div>`;
  }

  function wireImages(root) {
    root.querySelectorAll("img").forEach((img) => {
      img.addEventListener("error", () => img.closest(".shot")?.classList.add("broken"), { once: true });
    });
  }

  function renderDuel() {
    if (!current) current = nextPair();
    if (!current || state.round >= state.target) return renderResults();
    show("duel");

    const a = byId.get(current.a), b = byId.get(current.b);
    $("#card-a").innerHTML = cardHTML(a, "a");
    $("#card-b").innerHTML = cardHTML(b, "b");
    $("#card-a").classList.remove("picked");
    $("#card-b").classList.remove("picked");
    wireImages($("#duel"));

    $("#round").textContent = `${scope.short} · pair ${state.round + 1} of ${state.target}`;
    $("#progress-fill").style.width = (100 * state.round / state.target) + "%";
    $("#undo").disabled = undoStack.length === 0;
    renderLeaning();
    preloadNext();
  }

  function renderLeaning() {
    const el = $("#leaning");
    const ranked = FEATURES.map((f, i) => ({ f, v: state.w[i] }))
      .filter((x) => Math.abs(x.v) >= 0.15)
      .sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
      .slice(0, 8);
    if (!ranked.length) {
      el.innerHTML = `<span class="empty">Nothing yet. The first few pairs are deliberately far apart.</span>`;
      return;
    }
    el.innerHTML = ranked.map((x) =>
      `<span class="chip ${x.v > 0 ? "up" : "down"}">${x.v > 0 ? "More" : "Less"}: ${esc(LABELS[x.f])}</span>`).join("");
  }

  // Warm the cache with the sites the model is most likely to show next.
  function preloadNext() {
    const ids = unseen().filter((id) => id !== current.a && id !== current.b)
      .sort((x, y) => score(y) - score(x)).slice(0, 6);
    ids.forEach((id) => { const img = new Image(); img.referrerPolicy = "no-referrer"; img.src = byId.get(id).preview; });
  }

  function choose(kind) {
    if (busy || !current) return;
    busy = true;
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 30) undoStack.shift();

    const { a, b } = current;
    if (kind === "a") learnPair(a, b);
    else if (kind === "b") learnPair(b, a);
    else if (kind === "both") learnBoth(a, b, +1);
    else learnBoth(a, b, -1);

    state.seen.push(a, b);
    state.picks.push({ a, b, pick: kind, round: state.round + 1, mode: current.mode });
    state.round += 1;
    save();

    if (kind === "a" || kind === "b") $("#card-" + kind).classList.add("picked");
    setTimeout(() => { current = null; busy = false; renderDuel(); }, kind === "a" || kind === "b" ? 160 : 0);
  }

  function undo() {
    if (!undoStack.length || busy) return;
    // Show the pair that was just undone again, then roll the model back to before it.
    const last = state.picks[state.picks.length - 1];
    state = JSON.parse(undoStack.pop());
    current = last ? { a: last.a, b: last.b, mode: last.mode } : null;
    save();
    renderDuel();
  }

  // ---------- results ----------

  function liked() {
    // Every site picked (or marked "both good") at least once, best first.
    const ids = new Set();
    for (const p of state.picks) {
      if (p.pick === "a") ids.add(p.a);
      else if (p.pick === "b") ids.add(p.b);
      else if (p.pick === "both") { ids.add(p.a); ids.add(p.b); }
    }
    return [...ids].sort((x, y) => score(y) - score(x));
  }

  function profileRows() {
    return FEATURES.map((f, i) => ({ f, v: state.w[i] }))
      .filter((x) => Math.abs(x.v) >= 0.05)
      .sort((x, y) => y.v - x.v);
  }

  function localDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function briefText(top, rows) {
    const likes = rows.filter((r) => r.v > 0.15).map((r) => LABELS[r.f].toLowerCase());
    const avoids = rows.filter((r) => r.v < -0.15).map((r) => LABELS[r.f].toLowerCase());
    const lines = [
      `Taste Duel, ${scope.label}: ${state.round} pairs (${localDate()}).`,
      `Leans toward: ${likes.join(", ") || "nothing strong yet"}.`,
      `Leans away from: ${avoids.join(", ") || "nothing strong yet"}.`,
      "Favourites (21st.dev):",
      ...top.slice(0, 8).map((id, i) => `${i + 1}. ${byId.get(id).name}: ${byId.get(id).url}`),
    ];
    return lines.join("\n");
  }

  function miniCard(id, rank) {
    const s = byId.get(id);
    return `<article class="card">
      <button class="shot" data-zoom="${esc(s.id)}" title="See the full preview">
        <img src="${esc(s.preview)}" alt="Preview of ${esc(s.name)}" loading="lazy" referrerpolicy="no-referrer">
        <span class="zoom-hint">Full preview</span>
      </button>
      <div class="meta">
        <h3>${rank ? `<span class="rank">${rank}</span>` : ""}${esc(s.name)}</h3>
        <div class="line"><span>${esc(kindText(s))}</span><span>·</span><span>${priceText(s.price)}</span><span>·</span>
          <a href="${esc(s.url)}" target="_blank" rel="noopener">Open ↗</a></div>
      </div>
    </article>`;
  }

  function renderResults() {
    show("results");
    const el = $("#results");
    $("#round").textContent = `${scope.short} · ${state.round} pairs done`;
    $("#progress-fill").style.width = "100%";
    $("#undo").disabled = undoStack.length === 0;

    const top = liked().slice(0, 12);
    const rows = profileRows();
    const maxAbs = Math.max(0.5, ...rows.map((r) => Math.abs(r.v)));
    const suggestions = unseen().sort((x, y) => score(y) - score(x)).slice(0, 6);
    const canContinue = unseen().length >= 2;

    el.innerHTML = `
      <h2>Your taste so far: ${esc(scope.label)}</h2>
      <p class="lede">${state.round} pairs, ${state.seen.length} seen. Bars to the right are what you picked toward, to the left what you passed over.</p>
      <div class="actions">
        ${canContinue ? `<button class="primary" id="more">Keep going (${EXTRA_ROUNDS} more)</button>` : ""}
        <button class="primary" id="send-folder" hidden></button>
        <button class="ghost" id="copy-brief">Copy brief</button>
        <button class="ghost" id="export">Download results (JSON)</button>
      </div>
      <p class="vault-hint" id="vault-hint">To file your favourites as screenshots (for Taste Vault or any inspiration folder), download the results and run
        <code>node tools/to-taste-vault.mjs &lt;results file&gt; &lt;folder&gt;</code>, or start the app with <code>node tools/serve.mjs</code> to get a save button here.</p>

      <h3>Taste profile</h3>
      <div class="profile">
        ${rows.map((r) => {
          const pct = 50 * Math.abs(r.v) / maxAbs;
          const left = r.v >= 0 ? 50 : 50 - pct;
          const color = r.v >= 0 ? "var(--like)" : "var(--dislike)";
          return `<div class="label">${esc(LABELS[r.f])}</div>
            <div class="track"><span class="mid"></span><span class="fill" style="left:${left}%;width:${pct}%;background:${color}"></span></div>
            <div class="val">${r.v >= 0 ? "+" : ""}${r.v.toFixed(2)}</div>`;
        }).join("") || `<div class="label">No signal yet.</div><div></div><div></div>`}
      </div>

      <h3>Your favourites</h3>
      <div class="grid">${top.map((id, i) => miniCard(id, i + 1)).join("") || `<p class="lede">No picks yet.</p>`}</div>

      ${suggestions.length ? `<h3>Not shown yet, but your profile says you'd like</h3>
      <div class="grid">${suggestions.map((id) => miniCard(id)).join("")}</div>` : ""}

      <h3>Brief for a design prompt</h3>
      <textarea class="brief" id="brief" readonly>${esc(briefText(top, rows))}</textarea>`;

    wireImages(el);
    $("#more")?.addEventListener("click", () => { state.target = state.round + EXTRA_ROUNDS; save(); current = null; renderDuel(); });
    $("#copy-brief").addEventListener("click", () => copyBrief());
    $("#export").addEventListener("click", () => exportJSON(top, rows));
    if (top.length) offerSave(top, rows);
  }

  // The save button only exists when tools/serve.mjs is serving the page with a folder set.
  function offerSave(top, rows) {
    fetch("api/config").then((r) => (r.ok ? r.json() : null)).then((cfg) => {
      const btn = $("#send-folder");
      if (!cfg || !btn) return;
      if (request) {
        btn.textContent = `Send to ${request.project}`;
        btn.title = `Saves your top ${top.length} as screenshots in ${request.folder}`;
        btn.hidden = false;
        $("#vault-hint").textContent = `Saves your top ${top.length} as screenshots, with the brief and profile, under ${request.folder}` +
          (cfg.folder ? ` and ${cfg.folder}.` : ".") + " Whoever started this round picks them up from there.";
        btn.addEventListener("click", () => sendToFolder(top, rows));
        return;
      }
      if (!cfg.folder) return;
      btn.textContent = cfg.label;
      btn.title = `Saves your top ${top.length} as screenshots in ${cfg.folder}`;
      btn.hidden = false;
      $("#vault-hint").textContent = `Saves your top ${top.length} as screenshots, with the brief and profile, under ${cfg.folder}.`;
      btn.addEventListener("click", () => sendToFolder(top, rows));
    }).catch(() => {});
  }

  function sendToFolder(top, rows) {
    const btn = $("#send-folder");
    const hint = $("#vault-hint");
    btn.disabled = true;
    btn.textContent = "Saving…";
    fetch("api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(resultsData(top, rows)) })
      .then((r) => r.json())
      .then((out) => {
        if (out.error) throw new Error(out.error);
        btn.textContent = out.failed ? `Saved ${out.saved + out.skipped}, ${out.failed} failed` : "Saved";
        btn.disabled = !out.failed;
        hint.textContent = `${out.saved} saved, ${out.skipped} already there${out.failed ? `, ${out.failed} failed (click to retry)` : ""} → ${out.outDir}` +
          (out.vaultDir ? ` (copy in ${out.vaultDir})` : "");
      })
      .catch((e) => { btn.textContent = "Try again"; btn.disabled = false; hint.textContent = `Couldn't save: ${e.message}`; });
  }

  function copyBrief() {
    const ta = $("#brief");
    const done = () => { $("#copy-brief").textContent = "Copied"; };
    if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(done, () => { ta.select(); document.execCommand("copy"); done(); });
    else { ta.select(); document.execCommand("copy"); done(); }
  }

  function resultsData(top, rows) {
    return {
      tool: "taste-duel",
      generated: new Date().toISOString(),
      date: localDate(),
      scope: scope.id,
      scopeLabel: scope.label,
      ...(request ? { request: request.id, project: request.project } : {}),
      rounds: state.round,
      profile: Object.fromEntries(rows.map((r) => [r.f, Number(r.v.toFixed(3))])),
      brief: briefText(top, rows),
      favourites: top.map((id) => ({ id, name: byId.get(id).name, url: byId.get(id).url, preview: byId.get(id).preview, score: Number(score(id).toFixed(3)) })),
      picks: state.picks.map((p) => ({ ...p, a_name: byId.get(p.a).name, b_name: byId.get(p.b).name })),
    };
  }

  function exportJSON(top, rows) {
    const data = resultsData(top, rows);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `taste-duel-${scope.id}-${data.date}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ---------- lightbox ----------

  function openLightbox(id) {
    const s = byId.get(String(id));
    if (!s) return;
    $("#lightbox-img").src = s.preview;
    $("#lightbox-img").alt = "Full preview of " + s.name;
    $("#lightbox").hidden = false;
    $(".lightbox-inner").scrollTop = 0;
  }

  function closeLightbox() { $("#lightbox").hidden = true; }

  // ---------- events ----------

  document.addEventListener("click", (e) => {
    const sc = e.target.closest("[data-scope]");
    if (sc) return startScope(sc.dataset.scope);
    const pick = e.target.closest("[data-pick]");
    if (pick) return choose(pick.dataset.pick);
    const zoom = e.target.closest("[data-zoom]");
    if (zoom) return openLightbox(zoom.dataset.zoom);
  });
  $("#both").addEventListener("click", () => choose("both"));
  $("#neither").addEventListener("click", () => choose("neither"));
  $("#undo").addEventListener("click", undo);
  $("#switch").addEventListener("click", () => { current = null; renderStart(); });
  $("#restart").addEventListener("click", () => {
    if (!confirm(`Start the ${scope.short} run over? Its picks so far will be cleared.`)) return;
    state = fresh(); undoStack = []; current = null; save(); renderDuel();
  });
  $("#lightbox-close").addEventListener("click", closeLightbox);
  $("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches?.("textarea, input")) return;
    if (!$("#lightbox").hidden) { if (e.key === "Escape") closeLightbox(); return; }
    if (!$("#results").hidden) { if (e.key === "Backspace") { e.preventDefault(); undo(); } return; }
    if ($("#duel").hidden) return;
    if (e.key === "ArrowLeft") choose("a");
    else if (e.key === "ArrowRight") choose("b");
    else if (e.key === "ArrowUp") { e.preventDefault(); choose("both"); }
    else if (e.key === "ArrowDown") { e.preventDefault(); choose("neither"); }
    else if (e.key === "Backspace") { e.preventDefault(); undo(); }
  });

  const requestId = new URLSearchParams(location.search).get("request");
  if (requestId) startRequest(requestId); else renderStart();
})();

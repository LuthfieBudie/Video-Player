{
const CFG = window.VG_CONFIG;
// folder boleh ditulis sebagai link lengkap atau ID saja
const toId = s => String(s || "").trim().replace(/^.*\/folders\/([^/?#]+).*$/, "$1").replace(/^.*[?&]id=([^&#]+).*$/, "$1");
// API key & folder diisi pengunjung lewat Profile dan disimpan di browser masing-masing
let KEYS = [], FOLDERS = [], FOLDER_NAMES = {};
function loadSources() {
  const k = load("vg-keys", null), f = load("vg-folders", null);
  KEYS = [...new Set((k ?? CFG.API_KEYS ?? []).map(x => String(x).trim()).filter(Boolean))];
  const list = (f ?? [...(CFG.FOLDERS || []), CFG.FOLDER_ID].filter(Boolean).map(x => ({ id: x, name: "" })))
    .map(x => ({ id: toId(x.id ?? x), name: String(x.name || "").trim() })).filter(x => x.id);
  FOLDERS = [...new Set(list.map(x => x.id))];
  FOLDER_NAMES = Object.fromEntries(list.map(x => [x.id, x.name]));
}
const saveSources = () => { store("vg-keys", KEYS); store("vg-folders", FOLDERS.map(id => ({ id, name: FOLDER_NAMES[id] || "" }))); };
const API = "https://www.googleapis.com/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
// pastel accents from the design: pink, sage, butter, lavender, mist
const COLORS = ["#efc9de", "#cfdcc8", "#eef0b2", "#d3d3f1", "#e9e9e4"];

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch (e) { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
loadSources();

/* ---------- pemakaian API (dihitung di browser ini) ---------- */
// kuota harian Google Cloud di-reset tengah malam waktu Pasifik (America/Los_Angeles)
const ptParts = () => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(p => [p.type, p.value]));
const ptDay = () => { const p = ptParts(); return `${p.year}-${p.month}-${p.day}`; };
const msToReset = () => { const p = ptParts(); return (86400 - (+p.hour * 3600 + +p.minute * 60 + +p.second)) * 1000; };
function trackPlay(key) {
  const u = load("vg-usage", {}); const day = ptDay();
  const d = u.day === day ? u : { day, plays: 0, keys: {}, minute: [] };
  d.plays++; const k = "…" + String(key).slice(-4); d.keys[k] = (d.keys[k] || 0) + 1;
  d.minute = [...(d.minute || []).filter(t => Date.now() - t < 60000), Date.now()];
  store("vg-usage", d);
}

/* ---------- state ---------- */
let library = [], byId = new Map(), order = [];
let driveFav = new Set();                          // Starred akun1 + akun2 (dari videos.json)
let localFav = new Set(load("vg-favs", []));       // hati yang ditekan di website
let hiddenFav = new Set(load("vg-hidden", []));    // Starred Drive yang disembunyikan dari Favorit website
let drivePl = [];                                  // playlist otomatis per folder (Akun 1, Akun 2, ...)
let userPl = load("vg-playlists", []);             // playlist buatan sendiri [{id,name,ids}]
let cats = ["All"];
let cat = "All", q = "", sort = "acak";
let mode = "home", curPl = "";                     // home | fav | playlists | playlist
let view = [], shown = 0, loading = true;
let driveAccounts = [], syncedAt = "";              // penyimpanan per akun + waktu sinkron (dari videos.json)

const saveFav = () => { store("vg-favs", [...localFav]); store("vg-hidden", [...hiddenFav]); };
const savePl = () => store("vg-playlists", userPl);
const isFav = id => (driveFav.has(id) && !hiddenFav.has(id)) || localFav.has(id);
const allPl = () => [...drivePl, ...userPl];
const findPl = id => allPl().find(p => p.id === id);

/* ---------- Google Drive API (cadangan kalau videos.json tidak ada) ---------- */
// folder ke-1 mulai dari key ke-1, folder ke-2 dari key ke-2, dst. Key yang error/kena kuota dilewati.
async function api(params, keyStart = 0, path = "") {
  if (!KEYS.length) throw new Error("No API key yet. Add one in Profile.");
  let keyIdx = keyStart % KEYS.length, lastErr;
  for (let tries = 0; tries < KEYS.length; tries++) {
    const url = API + path + "?" + new URLSearchParams({ ...params, key: KEYS[keyIdx] });
    let res;
    try { res = await fetch(url); }
    catch (e) { throw new Error("Can't reach Google Drive. Check your internet connection."); }
    if (res.ok) return res.json();
    const body = await res.json().catch(() => ({}));
    lastErr = { status: res.status, msg: body.error?.message || res.statusText };
    if ([400, 403, 429].includes(res.status)) { keyIdx = (keyIdx + 1) % KEYS.length; continue; }
    break;
  }
  const e = new Error(lastErr.msg); e.status = lastErr.status; throw e;
}
async function listChildren(folderId, keyStart) {
  const out = []; let pageToken = "";
  do {
    const data = await api({
      q: `'${folderId}' in parents and trashed = false and (mimeType contains 'video/' or mimeType = '${FOLDER}' or mimeType = '${SHORTCUT}')`,
      fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,thumbnailLink,videoMediaMetadata(durationMillis,width,height),shortcutDetails(targetId,targetMimeType))",
      pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {})
    }, keyStart);
    out.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}
const toVideo = (f, category) => {
  const sc = f.mimeType === SHORTCUT, m = f.videoMediaMetadata || {};
  return {
    id: sc ? f.shortcutDetails.targetId : f.id,
    name: f.name.replace(/\.[a-z0-9]{2,4}$/i, ""),
    cat: category,
    created: f.createdTime || "",
    modified: f.modifiedTime || f.createdTime || "",
    dur: m.durationMillis ? +m.durationMillis : 0,
    w: m.width ? +m.width : 0, h: m.height ? +m.height : 0,   // ukuran video: untuk tahu vertikal / horizontal
    mime: (sc ? f.shortcutDetails.targetMimeType : f.mimeType) || "",
    thumb: f.thumbnailLink || ""                               // thumbnail asli dari Drive (lebih cepat & akurat)
  };
};
const isVideoItem = f => f.mimeType.startsWith("video/") ||
  (f.mimeType === SHORTCUT && (f.shortcutDetails?.targetMimeType || "").startsWith("video/"));
const isFavFolder = name => (CFG.FAVORITE_FOLDER_NAMES || []).includes(name.trim().toLowerCase());

async function loadDrive() {
  const vids = new Map(), favIds = new Set(), catSet = new Set(), src = new Map();
  const walk = async (folderId, category, inFav, depth, k) => {
    const items = await listChildren(folderId, k);
    const jobs = [];
    for (const f of items) {
      if (f.mimeType === FOLDER) {
        if (depth >= 3) continue;
        if (depth === 0 && isFavFolder(f.name)) jobs.push(walk(f.id, null, true, depth + 1, k));
        else jobs.push(walk(f.id, depth === 0 ? f.name : category, inFav, depth + 1, k));
      } else if (isVideoItem(f)) {
        const v = toVideo(f, category);
        if (inFav) favIds.add(v.id);
        if (!src.has(v.id)) src.set(v.id, k);
        const old = vids.get(v.id);
        if (!old) vids.set(v.id, v);
        else { if (!old.cat && v.cat) old.cat = v.cat; if (!old.dur) old.dur = v.dur; if (!old.thumb) old.thumb = v.thumb; if (!old.w) { old.w = v.w; old.h = v.h; } }
        if (v.cat) catSet.add(v.cat);
      }
    }
    await Promise.all(jobs);
  };
  const results = await Promise.allSettled(FOLDERS.map((id, i) => walk(id, null, false, 0, i)));
  const failed = results.map((r, i) => r.status === "rejected" ? { n: i + 1, err: r.reason } : null).filter(Boolean);
  if (failed.length === FOLDERS.length) throw failed[0].err;
  const videos = [...vids.values()].map(v => ({ ...v, cat: v.cat || "Others" }));
  const list = [...catSet].sort((a, b) => a.localeCompare(b, "id"));
  if (videos.some(v => v.cat === "Others") && list.length) list.push("Others");
  const newest = [...videos].sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
  // nama playlist: nama dari Profile, kalau kosong pakai nama folder di Drive
  const names = await Promise.all(FOLDERS.map((id, i) => FOLDER_NAMES[id] ? FOLDER_NAMES[id]
    : api({ fields: "name", supportsAllDrives: true }, i, "/" + encodeURIComponent(id)).then(r => r.name).catch(() => `Folder ${i + 1}`)));
  const playlists = FOLDERS.map((_, i) => ({ name: names[i], ids: newest.filter(v => src.get(v.id) === i).map(v => v.id) }));
  return { videos, fav: [...favIds], cats: list, playlists, failed: failed.map(f => f.n) };
}

/* ---------- cache (khusus mode API) ---------- */
const ckey = () => "vg-cache3-" + FOLDERS.map(id => id + ":" + (FOLDER_NAMES[id] || "")).join(",");
const readCache = () => { const c = load(ckey(), null); return c && Date.now() - c.t < (CFG.CACHE_MINUTES || 10) * 60000 ? c.d : null; };
const writeCache = d => { for (const k of Object.keys(localStorage)) if (k.startsWith("vg-cache")) localStorage.removeItem(k); store(ckey(), { t: Date.now(), d }); };

/* ---------- helpers ---------- */
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fmtDur = ms => { if (!ms) return ""; const s = Math.round(ms / 1000), h = s / 3600 | 0, m = (s % 3600) / 60 | 0, ss = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`; };
const fmtDate = d => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const thumbUrl = (v, w) => v.thumb ? v.thumb.replace(/=s\d+$/, "=s" + w) : `https://drive.google.com/thumbnail?id=${encodeURIComponent(v.id)}&sz=w${w}`;
const driveThumb = (v, w) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(v.id)}&sz=w${w}`;
// thumbnail gagal -> coba link cadangan -> kalau gagal juga, sembunyikan
window.vgThumbErr = img => { if (img.dataset.fb) { img.src = img.dataset.fb; img.dataset.fb = ""; } else img.remove(); };
const isTall = v => v.h > v.w && v.w > 0;
const img = (v, w, eager) => `<img src="${esc(thumbUrl(v, w))}" data-fb="${v.thumb ? esc(driveThumb(v, w)) : ""}" alt="" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" referrerpolicy="no-referrer" onerror="vgThumbErr(this)">`;

const playIco = c => `<svg width="14" height="14" viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="${c}"/></svg>`;
const heart = `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>`;
const addIco = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h11M4 12h11M4 18h7M18 14v8M14 18h8"/></svg>`;
const fallbackArt = `<svg class="ph-art" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;

/* ---------- render ---------- */
function renderChips() {
  $("chips").hidden = mode === "playlists";
  $("chips").innerHTML = cats.map(c => `<button class="chip ${c === cat ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}<span class="x">${
    c === "All" ? "" : c === cat
      ? `<svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`}</span></button>`).join("");
}

const card = (v, i) => {
  const f = isFav(v.id);
  return `<article class="card" style="--a:${COLORS[i % COLORS.length]}">
  <button class="add" data-add="${esc(v.id)}" aria-label="Save to playlist">${addIco}</button>
  <button class="fav ${f ? "on" : ""}" data-fav="${esc(v.id)}" aria-label="Favorite" aria-pressed="${f}">${heart}</button>
  <button class="thumb" data-play="${esc(v.id)}" aria-label="Play ${esc(v.name)}">${fallbackArt}${img(v, 480, i < 4)}${v.dur ? `<span class="dur">${fmtDur(v.dur)}</span>` : ""}<span class="play">${playIco("#16161a")}</span><span class="watched"><i style="width:${watchedPct(v)}%"></i></span></button>
  <h3 title="${esc(v.name)}">${esc(v.name)}</h3><div class="cat"><i></i>${esc(v.cat)}</div>
  <div class="row"><span class="views">${fmtDate(v.modified || v.created)}</span>${driveFav.has(v.id) && !hiddenFav.has(v.id) ? '<span class="tag">Starred</span>' : ""}</div>
</article>`;
};

function computeView() {
  let base = order;
  if (mode === "playlist") { const p = findPl(curPl); base = p ? p.ids.map(id => byId.get(id)).filter(Boolean) : []; }
  let v = base.filter(x => (cat === "All" || x.cat === cat) && (mode !== "fav" || isFav(x.id)) && x.name.toLowerCase().includes(q));
  if (sort === "acak" && mode === "playlist") v = shuffle([...v]);
  if (sort === "baru") v = [...v].sort((a, b) => (b.modified || b.created || "").localeCompare(a.modified || a.created || ""));
  if (sort === "nama") v = [...v].sort((a, b) => a.name.localeCompare(b.name, "en"));
  return v;
}

function setTitle() {
  const p = mode === "playlist" ? findPl(curPl) : null;
  const [lead, main] = mode === "fav" ? ["Your", "Favorites"] : mode === "playlists" ? ["Your", "Playlists"]
    : p ? [p.user ? "Playlist" : "From Drive", p.name] : ["Welcome to", "Video Gallery"];
  $("title").innerHTML = `<span>${esc(lead)}</span><b>${esc(main)}</b>`;
  const bar = $("plbar");
  bar.hidden = mode !== "playlist";
  if (p) bar.innerHTML = `<button class="pill" data-act="pl-back">← All playlists</button>${p.user
    ? `<button class="pill" data-act="pl-rename">Rename</button><button class="pill" data-act="pl-delete">Delete playlist</button>`
    : `<span class="pill ghost">Synced from Google Drive</span>`}`;
}

function renderSetup() {
  const step = (done, title, text) => `<li class="${done ? "done" : ""}"><span class="ck">${done ? "✓" : ""}</span><div><b>${title}</b><small>${text}</small></div></li>`;
  view = []; shown = 0;
  $("feat").style.display = "none"; $("chips").hidden = true; $("sort").hidden = true; $("plbar").hidden = true;
  $("count").textContent = ""; $("status").textContent = "";
  $("grid").innerHTML = `<div class="setup">
    <small>Get started</small><h2>Play videos from your own Google Drive</h2>
    <ol>
      ${step(KEYS.length, "Add a Google Drive API key", "Google Cloud Console → enable Google Drive API → Credentials → Create API key.")}
      ${step(FOLDERS.length, "Add a Drive folder", "Share the folder as “Anyone with the link”, then paste its link.")}
    </ol>
    <div class="acts"><button class="btn dark" data-act="open-profile">Open Profile</button></div>
    <p>Your keys and folders are saved only in this browser.</p>
  </div>`;
  updateBadges();
}
function renderAll() {
  setTitle();
  if (!KEYS.length || !FOLDERS.length) { renderSetup(); return; }
  renderChips(); $("sort").hidden = false;
  $("grid").innerHTML = ""; shown = 0;
  $("grid").classList.toggle("pls", mode === "playlists");
  $("sort").hidden = mode === "playlists";
  if (mode === "playlists") { $("feat").style.display = "none"; renderPlaylists(); updateBadges(); return; }
  view = computeView();
  $("count").textContent = `${view.length.toLocaleString("en-US")} ${mode === "fav" ? "favorite" : "video"}${view.length === 1 ? "" : "s"}`;
  const f = view[0];
  if (f && !q && mode === "home") {
    $("feat").style.display = ""; $("feat").dataset.play = f.id;
    $("feat").innerHTML = `<div class="thumb">${fallbackArt}${img(f, 1280, true)}${f.dur ? `<span class="dur">${fmtDur(f.dur)}</span>` : ""}</div>
      <div><small>Featured · ${esc(f.cat)}</small><h2>${esc(f.name)}</h2><p>Updated ${fmtDate(f.modified || f.created)}</p><span class="go">${playIco("#16161a")} Play now</span></div>`;
  } else $("feat").style.display = "none";
  if (!view.length) {
    $("grid").innerHTML = `<div class="empty"><b>${mode === "fav" ? "No favorites yet" : mode === "playlist" ? "This playlist is empty" : "No videos found"}</b>${
      mode === "fav" ? "Tap the heart on any video, or star it in Google Drive."
      : mode === "playlist" ? "Tap the list icon (top left of a video card) to add videos to this playlist."
      : "Try another keyword or category."}</div>`;
  }
  more(); updateBadges();
}

function renderPlaylists() {
  const list = allPl();
  $("count").textContent = `${list.length} playlist${list.length === 1 ? "" : "s"}`;
  $("status").textContent = "";
  $("grid").innerHTML = `<button class="plcard new" data-act="pl-create"><span class="plus"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg></span><small>Add</small><b>New playlist</b></button>` +
    list.map((p, i) => {
      const first = p.ids.map(id => byId.get(id)).find(Boolean);
      return `<button class="plcard" data-pl="${esc(p.id)}" style="--a:${COLORS[i % COLORS.length]}">
        <span class="cover">${fallbackArt}${first ? img(first, 480, i < 4) : ""}<span class="dur">${p.ids.length.toLocaleString("en-US")} video${p.ids.length === 1 ? "" : "s"}</span></span>
        <b>${esc(p.name)}</b><small>${p.user ? "Your playlist" : "From Google Drive"}</small></button>`;
    }).join("");
}

function more() {
  if (mode === "playlists" || !KEYS.length || !FOLDERS.length) return;
  if (shown >= view.length) { $("status").textContent = view.length > CFG.PAGE_SIZE ? "You've reached the end" : ""; return; }
  const next = view.slice(shown, shown + CFG.PAGE_SIZE);
  $("grid").insertAdjacentHTML("beforeend", next.map((v, i) => card(v, shown + i)).join(""));
  shown += next.length;
  $("status").textContent = shown < view.length ? "Loading videos…" : (view.length > CFG.PAGE_SIZE ? "You've reached the end" : "");
  requestAnimationFrame(() => { io.unobserve($("sentinel")); io.observe($("sentinel")); });
}

function updateBadges() {
  const n = library.filter(v => isFav(v.id)).length;
  $("favCount").textContent = $("favCountSide").textContent = n;
  $("favCount").hidden = $("favCountSide").hidden = !n;
}
function syncFavButtons(id) {
  const on = isFav(id);
  document.querySelectorAll(`[data-fav="${CSS.escape(id)}"]`).forEach(b => { b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
}
function skeleton() {
  $("feat").style.display = "none";
  $("count").textContent = "Loading videos…";
  $("grid").innerHTML = Array.from({ length: 8 }, (_, i) => `<div class="card sk"><div class="thumb"></div><i></i><i></i></div>`).join("");
}
function showError(msg) {
  $("count").textContent = ""; $("feat").style.display = "none";
  $("grid").innerHTML = `<div class="empty"><b>Videos couldn't be loaded</b>${msg}</div>`;
}

/* ---------- favorit ---------- */
function toggleFav(id) {
  if (isFav(id)) {
    localFav.delete(id);
    if (driveFav.has(id)) hiddenFav.add(id);   // bintang di Drive tetap, hanya disembunyikan di website
  } else {
    if (driveFav.has(id)) hiddenFav.delete(id); else localFav.add(id);
  }
  saveFav(); syncFavButtons(id); updateBadges();
  if (mode === "fav") renderAll();
}

/* ---------- player (layar penuh di HP, dengan "Up next") ---------- */
let queue = [], qi = -1;
function openPlayer(id, list) {
  queue = list || view.map(v => v.id);
  qi = queue.indexOf(id); if (qi < 0) { queue = [id]; qi = 0; }
  showPlayer();
  $("modal").classList.add("open"); document.body.classList.add("in-player");
  $("close").focus({ preventScroll: true });
}
let keyTurn = Math.random() * 97 | 0;
function iframePlayer(v) {
  $("screen").innerHTML = `<iframe src="https://drive.google.com/file/d/${encodeURIComponent(v.id)}/preview" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
}
// Pilihan player (Profile): "smooth" = player buatan sendiri (memakai sedikit kuota API),
// "drive" = player Google Drive (tanpa kuota, tapi tampilannya tidak bisa diatur)
const playerPref = () => load("vg-player", CFG.DIRECT_PLAY === false ? "drive" : "smooth");
const useSmooth = () => KEYS.length > 0 && playerPref() === "smooth";
const vpIco = {
  play: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>`,
  vol: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>`,
  mute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/></svg>`,
  loop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>`,
  fs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
  fsOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>`
};
const fmtSec = t => { t = Math.max(0, t | 0); const h = t / 3600 | 0, m = (t % 3600) / 60 | 0, s2 = String(t % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${s2}` : `${m}:${s2}`; };
let vpLoop = load("vg-loop", true), vpRate = load("vg-rate", 1), vpHideT;

/* Lanjutkan dari posisi terakhir (seperti YouTube) */
let posMap = load("vg-pos", {});
let posSaveT = 0;
function savePos(id, t, dur) {
  if (!dur || dur < 30) return;                         // video pendek tidak perlu dilanjutkan
  if (t < 5 || t > dur - 8) delete posMap[id]; else { delete posMap[id]; posMap[id] = Math.floor(t); }
  const keys = Object.keys(posMap); if (keys.length > 300) delete posMap[keys[0]];
  if (Date.now() - posSaveT > 2500) { posSaveT = Date.now(); store("vg-pos", posMap); }
}
const watchedPct = v => posMap[v.id] && v.dur ? Math.min(100, posMap[v.id] * 1000 / v.dur * 100) : 0;

/* Video berikutnya di antrean dimuat duluan, jadi tombol Next / geser langsung jalan */
let pre = null;
function dropPre() { if (pre) { pre.el.removeAttribute("src"); pre.el.load(); pre = null; } }
function preloadNext() {
  if (!useSmooth() || queue.length < 2) return;
  const nid = queue[(qi + 1) % queue.length], v = byId.get(nid);
  if (!v || !smoothOK(v) || pre?.id === nid) return;
  dropPre();
  const el = document.createElement("video");
  el.preload = "auto"; el.muted = true; el.playsInline = true;
  const k = KEYS[keyTurn++ % KEYS.length]; trackPlay(k);
  el.src = `${API}/${encodeURIComponent(nid)}?alt=media&key=${encodeURIComponent(k)}`;
  el.addEventListener("error", () => { if (pre?.el === el) pre = null; });
  pre = { id: nid, el };
}

/* Video yang tidak bisa diputar player Smooth langsung dialihkan ke player Drive, lalu DIINGAT
   supaya lain kali tidak menunggu lagi. Format lama (AVI, WMV, FLV, MPEG-2) langsung dilewati. */
const NO_SMOOTH_MIME = /avi|msvideo|wmv|ms-asf|x-flv|mpeg$|mp2t/i;
let noSmooth = new Set(load("vg-nosmooth", []));
const smoothOK = v => !!v && !noSmooth.has(v.id) && !(v.mime && NO_SMOOTH_MIME.test(v.mime));
function markNoSmooth(id) { noSmooth.add(id); store("vg-nosmooth", [...noSmooth].slice(-3000)); }
// cek cepat (2 byte) kenapa video gagal: "codec" = file bisa diunduh tapi formatnya tidak didukung browser,
// "key" = API key ditolak / kena limit -> coba key lain
async function smoothFail(v, key) {
  try {
    const r = await fetch(`${API}/${encodeURIComponent(v.id)}?alt=media&key=${encodeURIComponent(key)}`, { headers: { Range: "bytes=0-1" } });
    return r.ok ? "codec" : "key";
  } catch (e) { return "key"; }
}

function videoPlayer(v, dir) {
  if (!useSmooth() || !smoothOK(v)) { iframePlayer(v); return; }
  let tries = 0;
  const start = keyTurn++;
  $("screen").innerHTML = `<div class="vp ui-on loading ${dir ? "in-" + dir : ""}" id="vp">
    <video id="pv" playsinline webkit-playsinline preload="auto" poster="${esc(thumbUrl(v, 1280))}"></video>
    <div class="vp-spin" aria-hidden="true"></div>
    <div class="vp-flash l" aria-hidden="true">« 10s</div><div class="vp-flash r" aria-hidden="true">10s »</div>
    <div class="vp-ui">
      <button class="vp-big" data-vp="toggle" aria-label="Play or pause">${vpIco.pause}</button>
      <div class="vp-bottom">
        <div class="vp-track"><div class="vp-buf"></div><input class="vp-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek"></div>
        <div class="vp-row">
          <span class="vp-time"><b>0:00</b> / 0:00</span><span class="vp-grow"></span>
          <button data-vp="mute" aria-label="Mute">${vpIco.vol}</button>
          <button data-vp="speed" class="vp-speed" aria-label="Playback speed">${vpRate}x</button>
          <button data-vp="loop" class="${vpLoop ? "on" : ""}" aria-label="Loop" aria-pressed="${vpLoop}">${vpIco.loop}</button>
          <button data-vp="fs" aria-label="Fullscreen">${vpIco.fs}</button>
        </div>
      </div>
    </div>
  </div>`;
  let el = $("pv"); const vp = $("vp"), seek = vp.querySelector(".vp-seek"), buf = vp.querySelector(".vp-buf"), time = vp.querySelector(".vp-time");
  let reused = false;
  if (pre && pre.id === v.id) {           // pakai video yang sudah dimuat duluan -> langsung jalan
    const e2 = pre.el; pre = null;
    e2.id = "pv"; e2.setAttribute("playsinline", ""); e2.setAttribute("webkit-playsinline", ""); e2.poster = thumbUrl(v, 1280); e2.muted = false;
    el.replaceWith(e2); el = e2; reused = true;
    if (el.readyState >= 3) vp.classList.remove("loading");
  }
  el.loop = vpLoop; el.playbackRate = vpRate;
  el.addEventListener("loadedmetadata", () => {
    const p = posMap[v.id];
    if (p && el.duration && p < el.duration - 8) { el.currentTime = p; toast(`Resumed at ${fmtSec(p)}`); }
  }, { once: true });
  if (reused && el.readyState >= 1) { const p = posMap[v.id]; if (p && el.duration && p < el.duration - 8) el.currentTime = p; }
  el.addEventListener("canplay", () => setTimeout(() => { if (queue[qi] === v.id) preloadNext(); }, 800), { once: true });
  const setSrc = () => { const k = KEYS[(start + tries) % KEYS.length]; trackPlay(k); el.src = `${API}/${encodeURIComponent(v.id)}?alt=media&key=${encodeURIComponent(k)}`; };
  el.addEventListener("error", async () => {
    if (queue[qi] !== v.id || !el.isConnected) return;
    const why = await smoothFail(v, KEYS[(start + tries) % KEYS.length]);
    if (queue[qi] !== v.id || !el.isConnected) return;
    if (why === "key" && ++tries < KEYS.length) { setSrc(); el.play().catch(() => {}); return; }
    if (why === "codec") markNoSmooth(v.id);
    iframePlayer(v);
    toast(why === "codec" ? "This video's format isn't supported here, so it plays with the Google Drive player (remembered)" : "API key limit reached, playing with the Google Drive player");
  });
  const sync = () => {
    vp.classList.toggle("paused", el.paused);
    vp.querySelector(".vp-big").innerHTML = el.paused ? vpIco.play : vpIco.pause;
  };
  el.addEventListener("play", () => { sync(); vpAutoHide(); });
  el.addEventListener("pause", () => { sync(); vpShowUI(true); });
  el.addEventListener("waiting", () => vp.classList.add("loading"));
  el.addEventListener("playing", () => vp.classList.remove("loading"));
  el.addEventListener("canplay", () => vp.classList.remove("loading"));
  el.addEventListener("timeupdate", () => {
    if (!el.duration) return;
    if (!seek.matches(":active")) seek.value = Math.round(el.currentTime / el.duration * 1000);
    seek.style.setProperty("--p", (seek.value / 10) + "%");
    time.innerHTML = `<b>${fmtSec(el.currentTime)}</b> / ${fmtSec(el.duration)}`;
    savePos(v.id, el.currentTime, el.duration);
  });
  el.addEventListener("progress", () => { try { if (el.duration && el.buffered.length) buf.style.width = (el.buffered.end(el.buffered.length - 1) / el.duration * 100) + "%"; } catch (e) {} });
  el.addEventListener("ended", () => { delete posMap[v.id]; store("vg-pos", posMap); if (!el.loop) step(1); });   // loop mati -> lanjut ke video berikutnya
  seek.addEventListener("input", () => {
    seek.style.setProperty("--p", (seek.value / 10) + "%");
    if (el.duration) { el.currentTime = seek.value / 1000 * el.duration; time.innerHTML = `<b>${fmtSec(el.currentTime)}</b> / ${fmtSec(el.duration)}`; }
    vpShowUI(true);
  });
  seek.addEventListener("change", () => vpAutoHide());
  if (!reused) setSrc();
  el.play().catch(() => { el.muted = true; vp.querySelector('[data-vp="mute"]').innerHTML = vpIco.mute; el.play().catch(() => {}); sync(); });
  sync();
}
// tampilkan / sembunyikan tombol player (hilang sendiri setelah 3 detik saat video berjalan)
function vpShowUI(stay) { const vp = $("vp"); if (!vp) return; vp.classList.add("ui-on"); clearTimeout(vpHideT); if (!stay) vpAutoHide(); }
function vpAutoHide() { clearTimeout(vpHideT); vpHideT = setTimeout(() => { const vp = $("vp"), el = $("pv"); if (vp && el && !el.paused && !vp.querySelector(".vp-seek:active")) vp.classList.remove("ui-on"); }, 3000); }
function vpFlash(side) { const f = $("vp")?.querySelector(".vp-flash." + side); if (!f) return; f.classList.remove("go"); void f.offsetWidth; f.classList.add("go"); }
function vpFullscreen() {
  const sc = $("screen"), on = document.fullscreenElement || sc.classList.contains("pseudo-fs");
  const btn = sc.querySelector('[data-vp="fs"]');
  if (on) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    sc.classList.remove("pseudo-fs"); try { screen.orientation?.unlock?.(); } catch (e) {}
    if (btn) btn.innerHTML = vpIco.fs;
    return;
  }
  const v = byId.get(queue[qi]);
  const done = () => { if (btn) btn.innerHTML = vpIco.fsOff; if (v && !isTall(v)) screen.orientation?.lock?.("landscape").catch(() => {}); };
  if (sc.requestFullscreen) sc.requestFullscreen().then(done).catch(() => { sc.classList.add("pseudo-fs"); done(); });
  else { sc.classList.add("pseudo-fs"); done(); }
}
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) { const b = $("screen")?.querySelector('[data-vp="fs"]'); if (b) b.innerHTML = vpIco.fs; } });
// ketuk sekali = munculkan/sembunyikan tombol (TIDAK menjeda); ketuk dua kali di kiri/kanan = mundur/maju 10 detik
{
  let lastTap = 0, tapTimer;
  $("screen").addEventListener("click", e => {
    const vp = $("vp"), el = $("pv"); if (!vp || !el) return;
    const b = e.target.closest("[data-vp]");
    if (b) {
      const a = b.dataset.vp;
      if (a === "toggle") el.paused ? el.play().catch(() => {}) : el.pause();
      if (a === "mute") { el.muted = !el.muted; b.innerHTML = el.muted ? vpIco.mute : vpIco.vol; }
      if (a === "speed") { const r = [1, 1.25, 1.5, 2, 0.75]; vpRate = r[(r.indexOf(vpRate) + 1) % r.length]; el.playbackRate = vpRate; store("vg-rate", vpRate); b.textContent = vpRate + "x"; }
      if (a === "loop") { vpLoop = !vpLoop; el.loop = vpLoop; store("vg-loop", vpLoop); b.classList.toggle("on", vpLoop); b.setAttribute("aria-pressed", vpLoop); toast(vpLoop ? "Loop on" : "Loop off · plays the next video when this one ends"); }
      if (a === "fs") vpFullscreen();
      vpShowUI(); return;
    }
    if (e.target.closest(".vp-bottom")) { vpShowUI(); return; }
    const r = vp.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, now = Date.now();
    if (now - lastTap < 280) {
      clearTimeout(tapTimer); lastTap = 0;
      if (x < .38) { el.currentTime = Math.max(0, el.currentTime - 10); vpFlash("l"); }
      else if (x > .62) { el.currentTime = Math.min(el.duration || 1e9, el.currentTime + 10); vpFlash("r"); }
      else el.paused ? el.play().catch(() => {}) : el.pause();
      return;
    }
    lastTap = now;
    tapTimer = setTimeout(() => { vp.classList.contains("ui-on") && !el.paused ? (clearTimeout(vpHideT), vp.classList.remove("ui-on")) : vpShowUI(); }, 240);
  });
}
function step(d) {
  if (queue.length < 2) return;
  qi = (qi + d + queue.length) % queue.length;   // berputar: setelah video terakhir kembali ke awal
  showPlayer(d > 0 ? "next" : "prev");
}
function showPlayer(dir) {
  const v = byId.get(queue[qi]); if (!v) return;
  const p = mode === "playlist" ? findPl(curPl) : null;
  $("mTitle").textContent = v.name; $("mTitle").title = v.name;
  $("mSub").innerHTML = [p ? esc(p.name) : esc(v.cat), fmtDur(v.dur), fmtDate(v.modified || v.created)].filter(Boolean).map(x => `<span>${x}</span>`).join("");
  $("pCount").textContent = queue.length > 1 ? `${qi + 1} / ${queue.length.toLocaleString("en-US")}` : "";
  // ukuran layar video mengikuti bentuk videonya (vertikal tidak jadi kecil)
  $("screen").style.aspectRatio = v.w && v.h ? `${v.w} / ${v.h}` : "16 / 9";
  $("screen").classList.toggle("tall", isTall(v));
  $("pAdd").dataset.id = v.id;
  $("pFav").dataset.fav = v.id; const on = isFav(v.id); $("pFav").classList.toggle("on", on); $("pFav").setAttribute("aria-pressed", on);
  $("pPrev").disabled = $("pNext").disabled = queue.length < 2;
  videoPlayer(v, dir);
  renderUpNext();
}
function renderUpNext() {
  const items = [];
  for (let k = 1; k <= Math.min(12, queue.length - 1); k++) { const n = (qi + k) % queue.length; const v = byId.get(queue[n]); if (v) items.push([n, v]); }
  $("upnext").hidden = !items.length;
  $("upList").innerHTML = items.map(([n, v], k) => `<button class="up-row" data-qi="${n}">
    <span class="up-thumb">${fallbackArt}${img(v, 320, k < 3)}${v.dur ? `<span class="dur">${fmtDur(v.dur)}</span>` : ""}</span>
    <span class="up-txt"><b>${esc(v.name)}</b><small>${esc(v.cat)} · ${fmtDate(v.modified || v.created)}</small></span></button>`).join("");
  $("upList").scrollTop = 0;
}
const closePlayer = () => {
  const pv = $("pv"); if (pv && pv.duration) { savePos(queue[qi], pv.currentTime, pv.duration); store("vg-pos", posMap); }
  dropPre();
  if (!loading && mode !== "playlists") document.querySelectorAll(".card").forEach(c => { const id = c.querySelector("[data-play]")?.dataset.play, v = byId.get(id), w = c.querySelector(".watched i"); if (v && w) w.style.width = watchedPct(v) + "%"; });
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $("screen").classList.remove("pseudo-fs");
  $("modal").classList.remove("open"); document.body.classList.remove("in-player"); $("screen").innerHTML = "";
};

/* ---------- playlist buatan sendiri ---------- */
let plVid = "";
function openPlSheet(id) {
  plVid = id; const v = byId.get(id); if (!v) return;
  $("plVideo").textContent = v.name;
  renderPlList();
  $("plNewName").value = "";
  $("plModal").classList.add("open");
}
function renderPlList() {
  $("plList").innerHTML = userPl.length
    ? userPl.map(p => { const on = p.ids.includes(plVid);
        return `<label class="pl-row"><input type="checkbox" data-pltoggle="${esc(p.id)}" ${on ? "checked" : ""}><span>${esc(p.name)}</span><small>${p.ids.length}</small></label>`; }).join("")
    : `<p class="muted">You don't have any playlists yet. Create your first one below.</p>`;
}
function createPl(name, firstId) {
  const p = { id: "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.slice(0, 60), ids: firstId ? [firstId] : [], user: true };
  userPl.push(p); savePl(); return p;
}
$("plList").addEventListener("change", e => {
  const id = e.target.dataset.pltoggle; if (!id) return;
  const p = userPl.find(x => x.id === id); if (!p) return;
  if (e.target.checked) { if (!p.ids.includes(plVid)) p.ids.unshift(plVid); toast(`Saved to “${p.name}”`); }
  else { p.ids = p.ids.filter(x => x !== plVid); toast(`Removed from “${p.name}”`); }
  savePl(); renderPlList();
  if (mode === "playlist" && curPl === id) renderAll();
});
$("plNew").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("plNewName").value.trim(); if (!name) { $("plNewName").focus(); return; }
  const p = createPl(name, plVid); $("plNewName").value = "";
  renderPlList(); toast(`Playlist “${p.name}” created`);
});

/* dialog teks / konfirmasi (pengganti prompt & confirm) */
let dlgResolve = null;
function ask({ title, text = "", value = null, ok = "OK" }) {
  $("dlgTitle").textContent = title; $("dlgText").textContent = text;
  $("dlgInput").hidden = value === null; $("dlgInput").value = value ?? "";
  $("dlgOk").textContent = ok;
  $("dlgModal").classList.add("open");
  setTimeout(() => (value === null ? $("dlgOk") : $("dlgInput")).focus(), 30);
  return new Promise(r => { dlgResolve = r; });
}
function endDlg(val) { $("dlgModal").classList.remove("open"); const r = dlgResolve; dlgResolve = null; r?.(val); }
$("dlgForm").addEventListener("submit", e => { e.preventDefault(); endDlg($("dlgInput").hidden ? true : $("dlgInput").value.trim()); });

async function plCreateFlow() {
  const name = await ask({ title: "New playlist", text: "Name your playlist. Add videos later with the list icon on each card.", value: "", ok: "Create" });
  if (!name) return;
  const p = createPl(name); toast(`Playlist “${p.name}” created`);
  curPl = p.id; mode = "playlist"; renderAll();
}
async function plRenameFlow() {
  const p = userPl.find(x => x.id === curPl); if (!p) return;
  const name = await ask({ title: "Rename playlist", value: p.name, ok: "Save" });
  if (!name || name === p.name) return;
  p.name = name.slice(0, 60); savePl(); setTitle(); toast("Playlist renamed");
}
async function plDeleteFlow() {
  const p = userPl.find(x => x.id === curPl); if (!p) return;
  const yes = await ask({ title: `Delete “${p.name}”?`, text: "Only the playlist is deleted. Your videos stay in Google Drive.", ok: "Delete" });
  if (!yes) return;
  userPl = userPl.filter(x => x.id !== p.id); savePl();
  toast("Playlist deleted"); setNav("playlist");
}

/* ---------- profil: ringkasan + cadangan data ---------- */
const maskKey = k => k.length > 12 ? k.slice(0, 4) + "••••••••" + k.slice(-4) : "••••";
function renderSources() {
  $("keyList").innerHTML = KEYS.length ? KEYS.map((k, i) => `<div class="src-row"><span class="mono">${esc(maskKey(k))}</span><small>Key ${i + 1}</small><button class="x-btn sm" data-delkey="${i}" aria-label="Remove key ${i + 1}">${xIco}</button></div>`).join("")
    : `<p class="muted small">No API key yet.</p>`;
  $("folderList").innerHTML = FOLDERS.length ? FOLDERS.map(id => `<div class="src-row"><span>${esc(FOLDER_NAMES[id] || "Named from Drive")}</span><small class="mono">${esc(id.slice(0, 10))}…</small><button class="x-btn sm" data-delfolder="${esc(id)}" aria-label="Remove folder">${xIco}</button></div>`).join("")
    : `<p class="muted small">No folder yet.</p>`;
}
const xIco = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
$("keyForm").addEventListener("submit", e => {
  e.preventDefault();
  const k = $("keyInput").value.trim();
  if (!k) return;
  if (!/^AIza[0-9A-Za-z_\-]{30,}$/.test(k)) { $("srcMsg").textContent = "That doesn't look like a Google API key (it usually starts with “AIza”)."; return; }
  if (KEYS.includes(k)) { $("srcMsg").textContent = "This key is already added."; return; }
  KEYS.push(k); saveSources(); $("keyInput").value = ""; $("srcMsg").textContent = "";
  renderSources(); toast("API key added"); reloadLibrary();
});
$("folderForm").addEventListener("submit", e => {
  e.preventDefault();
  const id = toId($("folderInput").value);
  if (!id) return;
  if (!/^[\w-]{10,}$/.test(id)) { $("srcMsg").textContent = "Paste a Google Drive folder link or its ID."; return; }
  if (FOLDERS.includes(id)) { $("srcMsg").textContent = "This folder is already added."; return; }
  FOLDERS.push(id); FOLDER_NAMES[id] = $("folderName").value.trim().slice(0, 60); saveSources();
  $("folderInput").value = ""; $("folderName").value = ""; $("srcMsg").textContent = "";
  renderSources(); toast("Folder added"); reloadLibrary();
});
function renderStats() {
  $("profStats").innerHTML = [
    [library.length, "Videos"], [library.filter(v => isFav(v.id)).length, "Favorites"], [allPl().length, "Playlists"]
  ].map(([n, l]) => `<div><b>${n.toLocaleString("en-US")}</b><span>${l}</span></div>`).join("");
}
function renderShMax() {
  const m = String(load("vg-shmax", 0));
  document.querySelectorAll("[data-shmax]").forEach(b => { b.classList.toggle("on", b.dataset.shmax === m); b.setAttribute("aria-pressed", b.dataset.shmax === m); });
}
function renderPlayerSeg() {
  renderShMax();
  const p = playerPref();
  document.querySelectorAll("[data-player]").forEach(b => { b.classList.toggle("on", b.dataset.player === p); b.setAttribute("aria-pressed", b.dataset.player === p); });
}
function openProfile() {
  renderPlayerSeg();
  renderSources(); $("srcMsg").textContent = "";
  renderStats();
  $("profData").value = ""; $("profMsg").textContent = "";
  renderQuota();
  $("profModal").classList.add("open");
  clearInterval(quotaTimer); quotaTimer = setInterval(() => { if ($("profModal").classList.contains("open")) renderQuota(); else clearInterval(quotaTimer); }, 1000);
}
let quotaTimer;
const fmtGB = b => b >= 1024 ** 4 ? (b / 1024 ** 4).toFixed(2) + " TB" : (b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1) + " GB";
const fmtLeft = ms => { const s = Math.max(0, ms / 1000 | 0); return `${s / 3600 | 0}h ${String((s % 3600) / 60 | 0).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`; };
function renderQuota() {
  const u = load("vg-usage", {}); const today = u.day === ptDay() ? u : { plays: 0, keys: {}, minute: [] };
  const perMin = (today.minute || []).filter(t => Date.now() - t < 60000).length;
  const storage = driveAccounts.length ? driveAccounts.map(a => {
    const pct = a.limit ? Math.min(100, a.usage / a.limit * 100) : 0;
    return `<div class="goal">
      <div class="goal-top"><b title="${esc(a.email)}">${esc(a.email)}</b><span>${a.limit ? pct.toFixed(0) + "%" : "Unlimited"}</span></div>
      <div class="bar"><i style="width:${a.limit ? Math.max(pct, 1.5) : 0}%"></i></div>
      <div class="goal-cols"><div><small>Used</small>${fmtGB(a.usage)}</div><div><small>Drive files</small>${fmtGB(a.drive || 0)}</div><div><small>Total</small>${a.limit ? fmtGB(a.limit) : "∞"}</div></div>
    </div>`; }).join("")
    : "";
  const keys = Object.entries(today.keys || {}).map(([k, n]) => `<span class="kchip">Key ${esc(k)} · ${n}</span>`).join("") || `<span class="kchip">No direct plays yet</span>`;
  $("profQuota").innerHTML = `
    ${storage ? `<h3 class="sec">Drive storage</h3>${storage}` : ""}
    <h3 class="sec">API usage <small>this browser</small></h3>
    <div class="stats">
      <div><span>Direct plays today</span><b>${(today.plays || 0).toLocaleString("en-US")}</b></div>
      <div><span>Last 60 seconds</span><b>${perMin}</b></div>
      <div><span>Daily reset in</span><b class="mono">${fmtLeft(msToReset())}</b></div>
      ${syncedAt ? `<div><span>Last sync</span><b>${new Date(syncedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</b></div>` : ""}
    </div>
    <div class="kchips">${keys}</div>
    <p class="muted small">Only Shorts (and direct play, if enabled) use API quota. Home and Shorts (Offline) use none. For exact totals across all visitors, see <a href="https://console.cloud.google.com/apis/api/drive.googleapis.com/quotas" target="_blank" rel="noopener">Drive API quotas in Google Cloud Console</a>.</p>`;
}
async function backup() {
  // API key sengaja TIDAK ikut dicadangkan (lebih aman); masukkan ulang key di perangkat baru
  const data = JSON.stringify({ folders: FOLDERS.map(id => ({ id, name: FOLDER_NAMES[id] || "" })), favs: [...localFav], hidden: [...hiddenFav], playlists: userPl });
  $("profData").value = data;
  try { await navigator.clipboard.writeText(data); $("profMsg").textContent = "Backup copied (API keys are not included, for safety). Paste it in another browser, then tap Restore."; }
  catch (e) { $("profData").select(); $("profMsg").textContent = "Copy the text in the box above manually (Ctrl + C)."; }
}
function restore() {
  try {
    const d = JSON.parse($("profData").value);
    if (!d || !Array.isArray(d.playlists)) throw 0;
    localFav = new Set(d.favs || []); hiddenFav = new Set(d.hidden || []);
    userPl = d.playlists.filter(p => p && p.id && p.name && Array.isArray(p.ids)).map(p => ({ ...p, user: true }));
    saveFav(); savePl();
    if (Array.isArray(d.folders)) {
      const list = d.folders.map(x => ({ id: toId(x.id ?? x), name: String(x.name || "") })).filter(x => x.id);
      FOLDERS = [...new Set(list.map(x => x.id))]; FOLDER_NAMES = Object.fromEntries(list.map(x => [x.id, x.name])); saveSources();
    }
    openProfile(); reloadLibrary(); $("profMsg").textContent = "Data restored. Add your API key again if this is a new browser.";
  } catch (e) { $("profMsg").textContent = "That backup text isn't valid."; }
}

function closeSheets() { for (const id of ["plModal", "profModal"]) $(id).classList.remove("open"); if (dlgResolve) endDlg(null); }

let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2400); }


/* ============ SHORTS: layar penuh ala TikTok ============
   shorts    = player langsung (autoplay + loop, geser di mana saja) -> memakai kuota Drive API
   shortsOff = player Google Drive (tanpa kuota; ketuk untuk putar)
   Kecepatan: video berikutnya sudah dimuat duluan (preload), jadi saat digeser langsung jalan. */
let shMode = "", shList = [], shRendered = 0, shActive = -1, shMuted = false, shPreT;
const SH_BATCH = 6;
const shIco = {
  up: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>`,
  down: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`,
  mute: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l4 6M21 9l-4 6"/></svg>`,
  play: `<svg width="34" height="34" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`,
  heart: `<svg width="30" height="30" viewBox="0 0 24 24"><path d="M12 20.5s-8-4.9-8-11A4.5 4.5 0 0 1 12 6.6a4.5 4.5 0 0 1 8 2.9c0 6.1-8 11-8 11z"/></svg>`,
  save: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h11M4 12h11M4 18h7M18 14v8M14 18h8"/></svg>`,
  vol: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>`,
  ctrl: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg>`,
  muted: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/></svg>`
};

function shSlide(v, i) {
  const f = isFav(v.id), tall = isTall(v);
  return `<article class="sh${tall ? " tall" : ""}" data-i="${i}">
    <div class="sh-frame">
      <div class="sh-media" data-shmedia="${i}">
        <img class="sh-bg" src="${esc(thumbUrl(v, 320))}" alt="" aria-hidden="true" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">
        <img class="sh-poster" src="${esc(thumbUrl(v, 1080))}" data-fb="${v.thumb ? esc(driveThumb(v, 1080)) : ""}" alt="" ${i < 2 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" referrerpolicy="no-referrer" onerror="vgThumbErr(this)">
        <div class="sh-spin" aria-hidden="true"></div>
        <button class="sh-play" data-shplay="${i}" aria-label="Play ${esc(v.name)}">${shIco.play}</button>
        <div class="sh-burst" aria-hidden="true">${shIco.heart}</div>
      </div>
      <div class="sh-shade" aria-hidden="true"></div>
      <div class="sh-meta">
        <span class="sh-cat">${esc(v.cat)}${v.dur ? " · " + fmtDur(v.dur) : ""}</span>
        <b>${esc(v.name)}</b>
        <small>${fmtDate(v.modified || v.created)} · ${i + 1} of ${shList.length.toLocaleString("en-US")}</small>
      </div>
      <div class="sh-bar" data-shbar="${i}" aria-label="Seek"><span><i></i></span></div>
    </div>
    <div class="sh-side">
      <button class="sh-act sh-like ${f ? "on" : ""}" data-fav="${esc(v.id)}" aria-label="Like" aria-pressed="${f}"><span class="ic">${shIco.heart}</span><small>Like</small></button>
      <button class="sh-act" data-add="${esc(v.id)}" aria-label="Save to playlist"><span class="ic">${shIco.save}</span><small>Save</small></button>
      <button class="sh-act sh-ctrl" data-act="sh-ctrl" aria-label="Show Google Drive controls" aria-pressed="false"><span class="ic">${shIco.ctrl}</span><small>Controls</small></button>
      <button class="sh-act sh-mute" data-act="sh-mute" aria-label="Sound on or off"><span class="ic">${shMuted ? shIco.muted : shIco.vol}</span><small>${shMuted ? "Muted" : "Sound"}</small></button>
      <button class="sh-act sh-nav" data-act="sh-up" aria-label="Previous video"><span class="ic">${shIco.up}</span></button>
      <button class="sh-act sh-nav" data-act="sh-down" aria-label="Next video"><span class="ic">${shIco.down}</span></button>
    </div>
  </article>`;
}
function shRenderMore() {
  const next = shList.slice(shRendered, shRendered + SH_BATCH);
  $("shFeed").insertAdjacentHTML("beforeend", next.map((v, k) => shSlide(v, shRendered + k)).join(""));
  $("shFeed").querySelectorAll(".sh:not([data-obs])").forEach(el => { el.dataset.obs = 1; shIO.observe(el); });
  shRendered += next.length;
}
const shIO = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) shActivate(+e.target.dataset.i);
}, { root: $("shFeed"), threshold: 0.6 });

function shMediaEl(i) { return $("shFeed").querySelector(`[data-shmedia="${i}"]`); }
function shStop(i) {
  const m = shMediaEl(i); if (!m) return;
  m.closest(".sh")?.classList.remove("shield");
  m.querySelectorAll("video,iframe,.sh-unmute,.sh-shield").forEach(el => { if (el.tagName === "VIDEO") { el.pause(); el.removeAttribute("src"); el.load(); } el.remove(); });
  m.classList.remove("playing", "paused", "loading", "ready");
  m.closest(".sh")?.classList.remove("ifr");
  const bar = m.closest(".sh")?.querySelector(".sh-bar i"); if (bar) bar.style.width = "0";
}
function shIframe(i) {
  const m = shMediaEl(i), v = shList[i]; if (!m || !v) return;
  shStop(i);
  m.insertAdjacentHTML("beforeend", `<iframe src="https://drive.google.com/file/d/${encodeURIComponent(v.id)}/preview" allow="autoplay; fullscreen" allowfullscreen></iframe><div class="sh-shield" aria-hidden="true"></div>`);
  m.classList.add("playing", "ready");
  m.closest(".sh")?.classList.add("ifr");
  shSetShield(m.closest(".sh"), false);   // belum dilapisi: biar tombol play Google bisa ditekan dulu
}
// buat elemen video di slide i (kalau belum ada); autoplay = putar sekarang, kalau tidak: hanya dimuat duluan
function shEnsureVideo(i, autoplay) {
  const m = shMediaEl(i), v = shList[i]; if (!m || !v) return null;
  if (!smoothOK(v)) { if (autoplay) shIframe(i); return null; }   // sudah diketahui tidak cocok -> langsung player Drive
  let el = m.querySelector("video");
  if (!el) {
    let tries = 0; const start = keyTurn++;
    el = document.createElement("video");
    el.playsInline = true; el.loop = true; el.preload = "auto"; el.muted = shMuted;
    el.setAttribute("playsinline", ""); el.setAttribute("webkit-playsinline", "");
    m.insertBefore(el, m.querySelector(".sh-spin"));
    const bar = m.closest(".sh").querySelector(".sh-bar i");
    el.addEventListener("volumechange", shSyncMute);
    const setSrc = () => { const k = KEYS[(start + tries) % KEYS.length]; trackPlay(k); el.src = `${API}/${encodeURIComponent(v.id)}?alt=media&key=${encodeURIComponent(k)}`; };
    el.addEventListener("error", async () => {
      if (!el.isConnected) return;
      const why = await smoothFail(v, KEYS[(start + tries) % KEYS.length]);
      if (!el.isConnected) return;
      if (why === "key" && ++tries < KEYS.length) { setSrc(); if (shActive === i) el.play().catch(() => {}); return; }
      el.dataset.failed = 1;
      if (why === "codec") markNoSmooth(v.id);
      if (shActive === i) shIframe(i);
    });
    el.addEventListener("waiting", () => { if (shActive === i) m.classList.add("loading"); });
    el.addEventListener("playing", () => m.classList.remove("loading"), { passive: true });
    el.addEventListener("loadeddata", () => m.classList.add("ready"));
    el.addEventListener("timeupdate", () => { if (el.duration) bar.style.width = (el.currentTime / el.duration * 100) + "%"; });
    setSrc();
  }
  if (autoplay) {
    if (el.dataset.failed) { shIframe(i); return null; }
    m.classList.add("playing");
    if (el.readyState < 3) m.classList.add("loading");
    el.muted = shMuted;
    el.play().catch(() => {
      // browser menolak autoplay bersuara -> putar tanpa suara, tampilkan tombol suara
      el.muted = true; shMuted = true; shSyncMute();
      el.play().catch(() => {});
      if (!m.querySelector(".sh-unmute")) m.insertAdjacentHTML("beforeend", `<button class="sh-unmute" data-act="sh-unmute">${shIco.mute} Tap for sound</button>`);
    });
  } else { el.pause(); }
  return el;
}
function shActivate(i) {
  if (i === shActive || !shList[i]) return;
  shActive = i;
  if (i >= shRendered - 3) shRenderMore();
  // simpan hanya video sebelumnya, yang aktif, dan berikutnya (hemat memori & kuota)
  // (player Google tidak bisa dijeda dari luar, jadi di mode Offline slide lain langsung dihentikan)
  $("shFeed").querySelectorAll("[data-shmedia]").forEach(m => { const k = +m.dataset.shmedia; if (k < i - 1 || k > i + 1 || (shMode === "shortsOff" && k !== i)) shStop(k); else if (k !== i) m.querySelector("video")?.pause(); });
  if (shMode === "shortsOff" || !KEYS.length) { shStop(i); return; }
  const el = shEnsureVideo(i, true);
  // video berikutnya baru dimuat setelah video aktif siap diputar, supaya tidak berebut sinyal
  clearTimeout(shPreT);
  const preload = () => { if (shActive === i) shEnsureVideo(i + 1, false); };
  if (!el || el.readyState >= 3) shPreT = setTimeout(preload, 300);
  else { el.addEventListener("canplay", preload, { once: true }); shPreT = setTimeout(preload, 6000); }
}
function shPlay(i) {
  if (shMode === "shortsOff" || !KEYS.length) shIframe(i);
  else shEnsureVideo(i, true);
}
function shStep(d) {
  const feed = $("shFeed"), i = Math.max(0, Math.min(shList.length - 1, shActive + d));
  const el = feed.querySelector(`.sh[data-i="${i}"]`);
  if (el) feed.scrollTo({ top: el.offsetTop, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
/* Shorts (Offline): lapisan transparan di atas player Google.
   Saat aktif, sentuhan tidak sampai ke player Google -> tombolnya hilang sendiri, dan video bisa digeser seperti TikTok.
   Tombol "Controls" mematikan lapisan supaya tombol Google bisa dipakai (jeda, mundur, dll). */
let shShieldT;
function shSetShield(sh, on) {
  if (!sh) return;
  sh.classList.toggle("shield", on);
  const b = sh.querySelector(".sh-ctrl"); if (b) { b.classList.toggle("on", !on); b.setAttribute("aria-pressed", !on); }
}
// mengetuk ke dalam player Google membuat halaman kehilangan fokus -> pasang lapisan lagi beberapa detik kemudian
addEventListener("blur", () => {
  if (!shMode) return;
  setTimeout(() => {
    const f = document.activeElement; if (!f || f.tagName !== "IFRAME") return;
    const sh = f.closest(".sh"); if (!sh || sh.classList.contains("shield")) return;
    clearTimeout(shShieldT);
    shShieldT = setTimeout(() => { if (sh.classList.contains("ifr")) shSetShield(sh, true); }, 3500);
  }, 0);
});
function shToggleCtrl() {
  const sh = $("shFeed").querySelector(`.sh[data-i="${shActive}"]`); if (!sh || !sh.classList.contains("ifr")) return;
  clearTimeout(shShieldT);
  const showCtrl = sh.classList.contains("shield");
  shSetShield(sh, !showCtrl);
  if (showCtrl) toast("Google controls on: tap the video to pause or seek");
}
function shSyncMute() {
  $("shFeed").querySelectorAll(".sh-mute").forEach(b => { b.querySelector(".ic").innerHTML = shMuted ? shIco.muted : shIco.vol; b.querySelector("small").textContent = shMuted ? "Muted" : "Sound"; });
}
function shToggleMute() {
  shMuted = !shMuted;
  $("shFeed").querySelectorAll("video").forEach(v => { v.muted = shMuted; });
  shMediaEl(shActive)?.querySelector(".sh-unmute")?.remove();
  const v = shMediaEl(shActive)?.querySelector("video"); if (v && !shMuted) v.play().catch(() => {});
  shSyncMute();
}
function shTogglePause() {
  const m = shMediaEl(shActive), el = m?.querySelector("video"); if (!el) return;
  if (el.paused) { el.play().catch(() => {}); m.classList.remove("paused"); } else { el.pause(); m.classList.add("paused"); }
}
function shLikeBurst() {
  const m = shMediaEl(shActive), v = shList[shActive]; if (!m || !v) return;
  if (!isFav(v.id)) toggleFav(v.id);
  const b = m.querySelector(".sh-burst"); b.classList.remove("go"); void b.offsetWidth; b.classList.add("go");
}
function openShorts(kind) {
  shMode = kind; nativeBars("DARK");
  $("shTitle").textContent = kind === "shorts" ? "Shorts" : "Shorts (Offline)";
  $("shBadge").textContent = kind === "shorts" ? "Uses API quota" : "No API quota";
  $("shorts").dataset.mode = kind;
  $("shorts").hidden = false; document.body.classList.add("in-shorts");
  // Profile -> "Shorts length": hanya video pendek supaya cepat (durasi tidak diketahui tetap ikut)
  const max = +load("vg-shmax", 0);
  let pool = max ? library.filter(v => !v.dur || v.dur <= max) : library;
  if (max && !pool.length) { pool = library; toast("No short videos found, showing all videos"); }
  shList = shuffle([...pool]); shRendered = 0; shActive = -1;
  $("shFeed").innerHTML = ""; $("shFeed").scrollTop = 0;
  if (!shList.length) { $("shFeed").innerHTML = `<div class="sh-empty">No videos yet. Add an API key and a folder in Profile.</div>`; return; }
  shRenderMore();
  if (kind === "shortsOff" && !load("vg-shoff-tip", false)) { toast("Tap a video to play. Swipe on the text or edges to move."); store("vg-shoff-tip", true); }
  else if (kind === "shorts" && !load("vg-sh-tip", false)) { toast("Swipe up for the next video · double-tap to like"); store("vg-sh-tip", true); }
}
function closeShorts() {
  if ($("shorts").hidden) return;
  $("shFeed").querySelectorAll("[data-shmedia]").forEach(m => shStop(+m.dataset.shmedia));
  shActive = -1; shMode = "";
  $("shorts").hidden = true; document.body.classList.remove("in-shorts"); nativeBars("LIGHT");
  $("shFeed").innerHTML = "";
}
// bar progres bisa digeser (seperti contoh YM Gallery)
{
  let bar = null, vid = null;
  const seekTo = e => {
    if (!vid || !vid.duration) return;
    const r = bar.getBoundingClientRect(), p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    vid.currentTime = p * vid.duration; bar.querySelector("i").style.width = p * 100 + "%";
  };
  $("shFeed").addEventListener("pointerdown", e => {
    const b = e.target.closest(".sh-bar"); if (!b) return;
    e.stopPropagation(); e.preventDefault();
    vid = shMediaEl(+b.dataset.shbar)?.querySelector("video"); if (!vid) return;
    bar = b; bar.classList.add("drag"); bar.setPointerCapture(e.pointerId); seekTo(e);
  });
  $("shFeed").addEventListener("pointermove", e => { if (bar) seekTo(e); });
  const end = () => { bar?.classList.remove("drag"); bar = null; vid = null; };
  $("shFeed").addEventListener("pointerup", end); $("shFeed").addEventListener("pointercancel", end);
}
// PC: tarik feed dengan mouse untuk pindah video (seperti contoh YM Gallery)
{
  const feed = $("shFeed");
  let down = false, dragging = false, y0 = 0, top0 = 0, pid = null;
  feed.addEventListener("dragstart", e => e.preventDefault());   // cegah gambar ikut "terseret"
  feed.addEventListener("pointerdown", e => {
    if (e.pointerType !== "mouse" || e.button !== 0 || e.target.closest("button, .sh-bar")) return;
    down = true; dragging = false; y0 = e.clientY; top0 = feed.scrollTop; pid = e.pointerId;
  });
  feed.addEventListener("pointermove", e => {
    if (!down) return;
    const d = e.clientY - y0;
    if (!dragging && Math.abs(d) > 6) { dragging = true; feed.classList.add("dragging"); feed.setPointerCapture(pid); }
    if (dragging) feed.scrollTop = top0 - d;
  });
  const up = () => {
    if (!down) return; down = false;
    if (dragging) {
      const h = feed.clientHeight || 1, d = feed.scrollTop - top0;   // hitung dulu sebelum snap aktif lagi
      feed.classList.remove("dragging");
      const i = Math.round(top0 / h) + (Math.abs(d) > h * 0.15 ? Math.sign(d) : 0);
      feed.scrollTo({ top: Math.max(0, i) * h, behavior: "smooth" });
      feed.dataset.dragged = "1"; setTimeout(() => { delete feed.dataset.dragged; }, 50);
    }
    dragging = false;
  };
  feed.addEventListener("pointerup", up); feed.addEventListener("pointercancel", up);
}
// ketuk sekali = jeda/putar, ketuk dua kali = like (seperti TikTok)
{
  let tapT = 0, tapTimer;
  $("shFeed").addEventListener("click", e => {
    if (e.target.closest("button, .sh-bar") || $("shFeed").dataset.dragged) return;
    if (e.target.closest(".sh-shield")) { if (!load("vg-shield-tip", false)) { toast("Tap Controls on the right to pause or seek"); store("vg-shield-tip", true); } return; }
    const m = e.target.closest(".sh-frame")?.querySelector(".sh-media"); if (!m || +m.dataset.shmedia !== shActive) return;
    const now = Date.now();
    if (now - tapT < 300) { clearTimeout(tapTimer); tapT = 0; shLikeBurst(); return; }
    tapT = now;
    tapTimer = setTimeout(() => { if (shMode === "shorts") shTogglePause(); }, 300);
  });
}

/* ---------- navigasi ---------- */
function setNav(n) {
  if (n === "profil") { openProfile(); return; }
  if (n === "shorts" || n === "shortsOff") {
    document.querySelectorAll("[data-nav]").forEach(b => b.classList.toggle("on", b.dataset.nav === n));
    if (!loading) openShorts(n);
    return;
  }
  closeShorts();
  document.querySelectorAll("[data-nav]").forEach(b => b.classList.toggle("on", b.dataset.nav === n || (n === "playlist" && b.dataset.nav === "playlist")));
  mode = n === "fav" ? "fav" : n === "playlist" ? "playlists" : "home";
  if (n === "search") { $("search").classList.add("open"); $("q").focus(); }
  if (!loading) { renderAll(); scrollTo({ top: 0 }); }
}

document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  const act = t.dataset.act;
  if (t.dataset.cat) { cat = t.dataset.cat === cat && cat !== "All" ? "All" : t.dataset.cat; renderAll(); }
  else if (t.dataset.fav) toggleFav(t.dataset.fav);
  else if (t.dataset.add) openPlSheet(t.dataset.add);
  else if (t.dataset.qi) { qi = +t.dataset.qi; showPlayer("next"); }
  else if (t.dataset.play) openPlayer(t.dataset.play);
  else if (t.dataset.pl) { curPl = t.dataset.pl; mode = "playlist"; renderAll(); scrollTo({ top: 0 }); }
  else if (t.dataset.nav) setNav(t.dataset.nav);
  else if (act === "pl-create") plCreateFlow();
  else if (act === "pl-back") setNav("playlist");
  else if (act === "pl-rename") plRenameFlow();
  else if (act === "pl-delete") plDeleteFlow();
  else if (act === "backup") backup();
  else if (act === "open-profile") openProfile();
  else if (t.dataset.shmax !== undefined) { store("vg-shmax", +t.dataset.shmax); renderShMax(); toast(+t.dataset.shmax ? `Shorts will show videos up to ${+t.dataset.shmax / 60000} min` : "Shorts will show all videos"); }
  else if (t.dataset.player) { store("vg-player", t.dataset.player); renderPlayerSeg(); toast(t.dataset.player === "smooth" ? "Smooth player on" : "Google Drive player on (no API quota)"); }
  else if (t.dataset.delkey !== undefined) { KEYS.splice(+t.dataset.delkey, 1); saveSources(); renderSources(); toast("API key removed"); reloadLibrary(); }
  else if (t.dataset.delfolder) { FOLDERS = FOLDERS.filter(x => x !== t.dataset.delfolder); delete FOLDER_NAMES[t.dataset.delfolder]; saveSources(); renderSources(); toast("Folder removed"); reloadLibrary(); }
  else if (act === "sh-exit") setNav("home");
  else if (act === "sh-up") shStep(-1);
  else if (act === "sh-down") shStep(1);
  else if (act === "sh-mute") shToggleMute();
  else if (act === "sh-ctrl") shToggleCtrl();
  else if (act === "sh-unmute") { shMuted = false; const v = shMediaEl(shActive)?.querySelector("video"); if (v) { v.muted = false; v.play().catch(() => {}); } t.remove(); }
  else if (t.dataset.shplay) shPlay(+t.dataset.shplay);
  else if (act === "restore") restore();
  else if (act === "close-sheet") closeSheets();
  else if (act === "dlg-cancel") endDlg(null);
  else if (t.id === "pPrev") step(-1);
  else if (t.id === "pNext") step(1);
  else if (t.id === "pAdd") openPlSheet(t.dataset.id);
  else if (t.id === "sbtn") { $("search").classList.toggle("open"); $("q").focus(); }
  else if (t.id === "sort") {
    sort = { acak: "baru", baru: "nama", nama: "acak" }[sort];
    t.textContent = { acak: "Shuffle", baru: "Newest", nama: "A–Z" }[sort];
    if (sort === "acak") order = shuffle([...library]);
    if (!loading) renderAll();
  }
  else if (t.id === "close") closePlayer();
  else if (t.classList.contains("back")) {
    if (mode === "playlist") { setNav("playlist"); return; }
    cat = "All"; q = ""; $("q").value = ""; setNav("home");
  }
});
for (const id of ["modal", "plModal", "profModal", "dlgModal"]) $(id).addEventListener("click", e => {
  if (e.target.id !== id) return;
  if (id === "modal") closePlayer(); else if (id === "dlgModal") endDlg(null); else closeSheets();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closePlayer(); closeSheets(); }
  if (shMode && !e.target.closest("input,textarea") && !document.querySelector(".modal.open")) {
    if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); shStep(1); }
    if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); shStep(-1); }
    if (e.key === " " && shMode === "shorts") { e.preventDefault(); shTogglePause(); }
    if (e.key === "m" && shMode === "shorts") shToggleMute();
    return;
  }
  if ($("modal").classList.contains("open") && !e.target.closest("input,textarea")) {
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
    const pv = $("pv");
    if (pv && (e.key === " " || e.key === "k")) { e.preventDefault(); pv.paused ? pv.play().catch(() => {}) : pv.pause(); }
    if (pv && e.key === "j") { pv.currentTime -= 10; vpFlash("l"); }
    if (pv && e.key === "l") { pv.currentTime += 10; vpFlash("r"); }
    if (pv && e.key === "f") vpFullscreen();
  }
});
/* swipe kiri/kanan di player: kiri = berikutnya, kanan = sebelumnya */
{
  let sx = 0, sy = 0, st = 0, ok = false;
  const box = document.querySelector("#modal .box");
  box.addEventListener("touchstart", e => {
    const t = e.touches[0], r = $("screen").getBoundingClientRect();
    // abaikan kalau mulai dari bar kontrol video (bawah layar video), supaya geser waktu tetap bisa
    ok = e.touches.length === 1 && !e.target.closest(".vp-bottom, input") && !(t.clientY > r.bottom - 56 && t.clientY < r.bottom && !$("vp"));
    sx = t.clientX; sy = t.clientY; st = Date.now();
  }, { passive: true });
  box.addEventListener("touchend", e => {
    if (!ok) return; ok = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 800) step(dx < 0 ? 1 : -1);
    // geser ke bawah (di bagian atas layar) = tutup player
    else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5 && box.scrollTop <= 0 && sy < $("screen").getBoundingClientRect().bottom) closePlayer();
  }, { passive: true });
}
// seluruh kartu bisa diketuk untuk membuka video (bukan cuma gambarnya)
$("grid").addEventListener("click", e => {
  if (e.target.closest("button")) return;
  const c = e.target.closest(".card"); const id = c?.querySelector("[data-play]")?.dataset.play;
  if (id) openPlayer(id);
});
let qTimer;
$("q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => { q = e.target.value.trim().toLowerCase(); if (!loading) { if (mode === "playlists") mode = "home"; renderAll(); } }, 150); });

const io = new IntersectionObserver(es => { if (es[0].isIntersecting && !loading) more(); }, { rootMargin: "900px 0px" });
io.observe($("sentinel"));

/* ---------- mulai ---------- */
function apply(d) {
  library = d.videos; byId = new Map(library.map(v => [v.id, v]));
  driveFav = new Set(d.fav || []);
  cats = ["All", ...(d.cats || []).map(c => c === "Lainnya" ? "Others" : c)];
  for (const v of library) if (v.cat === "Lainnya") v.cat = "Others";
  driveAccounts = d.accounts || []; syncedAt = d.synced || "";
  drivePl = (d.playlists || []).map((p, i) => ({ id: "d" + i, name: p.name, ids: p.ids || [], user: false }));
  userPl = userPl.map(p => ({ ...p, user: true }));
  order = shuffle([...library]);
  loading = false;
  renderAll();
  if ($("profModal").classList.contains("open")) renderStats();
}

async function start() {
  renderChips(); skeleton();
  // 1) cara utama: videos.json hasil script Python (cepat, tanpa memanggil Drive API)
  if (CFG.VIDEOS_JSON) {
    try {
      const r = await fetch(CFG.VIDEOS_JSON, { cache: "no-cache" });
      if (r.ok) { const d = await r.json(); if (d.videos?.length) { apply(d); return; } }
    } catch (e) { /* lanjut ke cadangan */ }
  }
  // 2) muat langsung dari Drive pakai API key & folder milik pengunjung (dari Profile)
  if (!KEYS.length || !FOLDERS.length) { apply({ videos: [], fav: [], cats: [], playlists: [] }); return; }
  const cached = readCache();
  if (cached) { apply(cached); return; }
  try {
    const d = await loadDrive();
    if (!d.failed.length) writeCache(d);
    apply(d);
    if (d.failed.length) $("count").textContent += ` · folder ${d.failed.join(", ")} failed to load (check its sharing settings)`;
  } catch (err) {
    loading = false;
    const tip = err.status === 404 ? "Folder not found. Check the folder link in Profile and make sure it's shared as “Anyone with the link”."
      : err.status === 403 || err.status === 400 ? "Access denied. Check that your API key is correct, the Google Drive API is enabled for it, its website restrictions include this site, and the folder is shared publicly."
      : err.message;
    showError(esc(tip) + `<br><small>${esc(err.status ? "Code " + err.status + ": " + err.message : "")}</small><div class="acts center"><button class="btn dark" data-act="open-profile">Open Profile</button></div>`);
  }
}
/* ============ APLIKASI ANDROID (Capacitor) & PWA ============ */
const isNative = !!window.Capacitor?.isNativePlatform?.();
const nativePlugin = name => window.Capacitor?.Plugins?.[name];
// status bar: ikon gelap di atas gradasi terang; ikon terang di Shorts yang gelap. Gesture bar selalu terang (nav gelap).
function nativeBars(top) {
  const sb = nativePlugin("SystemBars"); if (!sb) return;
  sb.setStyle({ style: top, bar: "StatusBar" }).catch?.(() => {});
  sb.setStyle({ style: "DARK", bar: "NavigationBar" }).catch?.(() => {});
}
if (isNative) {
  document.documentElement.classList.add("native");
  nativeBars("LIGHT");
  // tombol Back Android: tutup jendela/menu dulu, baru keluar aplikasi di Home
  nativePlugin("App")?.addListener?.("backButton", () => {
    if ($("dlgModal").classList.contains("open")) endDlg(null);
    else if ($("modal").classList.contains("open")) closePlayer();
    else if (document.querySelector("#plModal.open, #profModal.open")) closeSheets();
    else if (shMode) setNav("home");
    else if (mode === "playlist") setNav("playlist");
    else if (mode !== "home" || q || cat !== "All") { cat = "All"; q = ""; $("q").value = ""; setNav("home"); }
    else nativePlugin("App").exitApp();
  });
} else if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

let reloadT;
function reloadLibrary() {
  clearTimeout(reloadT);
  reloadT = setTimeout(() => { closeShorts(); loading = true; library = []; byId = new Map(); start(); }, 250);
}
start();
}
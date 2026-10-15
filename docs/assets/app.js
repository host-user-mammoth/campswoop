/* CampSwoop: tabs, the time-aware hero, the watch configurator (sign-up), and the lazily loaded map. */
"use strict";

const API = "https://api.campswoop.com";
const RECGOV_SEARCH = "https://www.recreation.gov/api/search";
const MAX_NIGHTS = 14;
const MAP_MODULE = new URL("map.js", document.currentScript.src).href;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const saveData = navigator.connection?.saveData === true;

// Booking links CampSwoop can watch. Keep in sync with SOURCES in alerts.py and worker/src/index.js.
const CAMIS_SITES = { "reservation.pc.gc.ca": "Parks Canada", "camping.bcparks.ca": "BC Parks",
                      "reservations.ontarioparks.ca": "Ontario Parks", "washington.goingtocamp.com": "Washington State Parks" };
const SOURCES = [
  { title: "Recreation.gov", pattern: /recreation\.gov\/camping\/(campgrounds|campsites)\/(\d+)/i,
    url: m => `https://www.recreation.gov/camping/${m[1].toLowerCase()}/${m[2]}` },
  { title: "Firefly Reservations", pattern: /fireflyreservations\.com\/reserve\/property\/([A-Za-z0-9_-]+)/i,
    url: m => `https://app.fireflyreservations.com/reserve/property/${m[1]}`,
    name: m => m[1].replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[-_]+/g, " ") },
  { title: "Parks Canada, BC, Ontario and Washington parks", noFilter: true,
    pattern: /https?:\/\/((?:[\w-]+\.)*(?:goingtocamp\.com|pc\.gc\.ca|bcparks\.ca|ontarioparks\.ca))\/\S*?[?&]resourceLocationId=-?\d+\S*/i,
    url: m => m[0], name: m => `${CAMIS_SITES[m[1].toLowerCase()] || "GoingToCamp"} campground` },
];

const $ = id => document.getElementById(id);
const state = { place: null }; // { name, detail, url, lookup?, noFilter? }
const monthDay = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dayName = d => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const parseDate = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? new Date(s + "T00:00:00Z") : null);
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const localToday = () => {
  const n = new Date();
  return parseDate(`${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`);
};
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const navHeight = () => $("nav").offsetHeight;

// ---------------------------------------------------------------- Tabs
const panels = { watch: $("panel-watch"), map: $("panel-map") };
const tabButtons = { watch: $("tab-watch"), map: $("tab-map") };

function showTab(name, { scroll = true } = {}) {
  if (!panels[name]) name = "watch";
  for (const key of Object.keys(panels)) {
    const on = key === name;
    panels[key].hidden = !on;
    tabButtons[key].setAttribute("aria-selected", String(on));
    tabButtons[key].tabIndex = on ? 0 : -1;
  }
  document.body.dataset.tab = name;
  history.replaceState(null, "", location.pathname + location.search + (name === "map" ? "#map" : ""));
  placeInk();
  updateNav();
  if (scroll) window.scrollTo({ top: 0, behavior: "auto" });
  if (name === "map") openMap();
}

function placeInk() {
  const tab = Object.values(tabButtons).find(t => t.getAttribute("aria-selected") === "true");
  const ink = document.querySelector(".tab-ink");
  if (!tab || !ink) return;
  const pad = parseFloat(getComputedStyle(tab).paddingLeft) || 0;
  ink.style.width = `${tab.offsetWidth - pad * 2}px`;
  ink.style.transform = `translateX(${tab.offsetLeft + pad}px)`;
}

for (const [name, tab] of Object.entries(tabButtons)) {
  tab.addEventListener("click", () => showTab(name));
  tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = name === "watch" ? "map" : "watch";
    showTab(event.key === "Home" ? "watch" : event.key === "End" ? "map" : next);
    tabButtons[document.body.dataset.tab].focus();
  });
}

document.addEventListener("click", event => {
  const go = event.target.closest("[data-go]");
  if (!go) return;
  event.preventDefault();
  const target = go.dataset.go;
  if (target === "map") showTab("map");
  else if (target === "configure") goToConfigurator();
  else showTab("watch");
});

function scrollToElement(element) {
  const top = element.getBoundingClientRect().top + window.scrollY - navHeight() - 8;
  window.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
}

function goToConfigurator(focusDates = false) {
  if (document.body.dataset.tab !== "watch") showTab("watch", { scroll: false });
  scrollToElement($("configure"));
  const target = focusDates || state.place ? $("in") : $("q");
  setTimeout(() => target.focus({ preventScroll: true }), reduceMotion ? 0 : 650);
}

addEventListener("hashchange", () => showTab(location.hash === "#map" ? "map" : "watch"));
addEventListener("resize", placeInk);
document.fonts?.ready.then(placeInk);

function updateNav() {
  $("nav").classList.toggle("solid", document.body.dataset.tab === "map" || window.scrollY > 40);
}
addEventListener("scroll", updateNav, { passive: true });

// ---------------------------------------------------------------- Reveal on scroll
const revealer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) { entry.target.classList.add("in"); revealer.unobserve(entry.target); }
  }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
document.querySelectorAll(".reveal").forEach(element => revealer.observe(element));

// ---------------------------------------------------------------- Time-aware hero
const hero = $("hero");
const heroVideo = $("hero-video");
const phase = (() => { const h = new Date().getHours(); return h >= 6 && h < 18 ? "day" : "night"; })();
hero.dataset.phase = phase;
heroVideo.poster = `assets/hero-${phase}.webp`;

function partOfDay(hour) {
  return hour < 5 ? "Tonight" : hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : hour < 21 ? "This evening" : "Tonight";
}
function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  $("hero-clock").textContent = `${partOfDay(now.getHours())} · ${time}`;
}
tickClock();
setInterval(tickClock, 15000);

if (!reduceMotion && !saveData) {
  heroVideo.src = `assets/hero-${phase}.mp4`;
  heroVideo.preload = "auto";
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && document.body.dataset.tab === "watch") heroVideo.play().catch(() => {});
    else heroVideo.pause();
  }).observe(hero);
}

// Coverage count from the map data, counted up once.
(window.requestIdleCallback || (fn => setTimeout(fn, 1200)))(async () => {
  try {
    const data = await (await fetch("data/campgrounds.json")).json();
    const total = data.places.length;
    const output = $("coverage-count");
    if (reduceMotion) { output.textContent = total.toLocaleString(); return; }
    const start = performance.now();
    const frame = now => {
      const t = Math.min(1, (now - start) / 1400);
      output.textContent = Math.round(total * (1 - Math.pow(1 - t, 3))).toLocaleString();
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (error) { /* keep the static figure */ }
});

// ---------------------------------------------------------------- Alert preview clip
const alertVideo = $("alert-video");
const replay = $("alert-replay");
if (!reduceMotion) {
  new IntersectionObserver(([entry], observer) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    alertVideo.currentTime = 0;
    alertVideo.play().catch(() => { replay.hidden = false; });
  }, { threshold: 0.5 }).observe(alertVideo);
  alertVideo.addEventListener("ended", () => { replay.hidden = false; });
  replay.addEventListener("click", () => { replay.hidden = true; alertVideo.currentTime = 0; alertVideo.play().catch(() => {}); });
}

// ---------------------------------------------------------------- Step 1: campground
let searchTimer;
let searchSeq = 0;
$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("q").value.trim();
  $("q-notice").hidden = true;
  if (/^https?:\/\/|\.(com|gov|org|ca|net)\//i.test(q)) return useLink(q);
  if (q.length < 3) { $("results").innerHTML = ""; return; }
  searchTimer = setTimeout(() => search(q), 280);
});

let requestTimer;
const requestedHosts = new Set();
function useLink(text) {
  $("results").innerHTML = "";
  for (const source of SOURCES) {
    const m = text.match(source.pattern);
    if (m) {
      return choose({ name: source.name ? source.name(m) : "Recreation.gov campground", detail: source.title,
                      url: source.url(m), lookup: !source.name, noFilter: !!source.noFilter });
    }
  }
  let host = "";
  try { host = new URL(/^https?:/i.test(text) ? text : "https://" + text).hostname.replace(/^www\./, ""); } catch (e) { /* not a URL */ }
  if (/(goingtocamp\.com|pc\.gc\.ca|bcparks\.ca|ontarioparks\.ca)$/i.test(host)) {
    return notice($("q-notice"), "That link doesn't say which park. Open the park on that site, search any dates, and paste the link from the results page.");
  }
  notice($("q-notice"), `We can't watch ${escapeHtml(host || "that booking site")} yet. Supported: ${SOURCES.map(s => s.title).join(", ")}.`);
  // Count which booking sites people want, once each, after they stop typing.
  clearTimeout(requestTimer);
  if (host.includes(".") && !requestedHosts.has(host)) {
    requestTimer = setTimeout(() => {
      requestedHosts.add(host);
      fetch(`${API}/requested`, { method: "POST", headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ host }), keepalive: true }).catch(() => {});
    }, 1500);
  }
}

async function search(q) {
  const seq = ++searchSeq;
  try {
    const params = new URLSearchParams({ q, fq: "entity_type:campground", size: "8" });
    const data = await (await fetch(`${RECGOV_SEARCH}?${params}`)).json();
    if (seq !== searchSeq) return;
    const results = data.results || [];
    $("results").innerHTML = results.map((r, i) => {
      const where = [r.parent_name, r.addresses?.[0]?.state_code || r.state_code].filter(Boolean).join(", ");
      const note = r.reservable === false ? " · first come, first served (can't be booked online)" : "";
      return `<li><button type="button" data-i="${i}" ${r.reservable === false ? "disabled" : ""}>${escapeHtml(r.name)}<small>${escapeHtml(where + note)}</small></button></li>`;
    }).join("");
    $("results").querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
      const r = results[button.dataset.i];
      choose({ name: r.name, detail: [r.parent_name, r.addresses?.[0]?.state_code].filter(Boolean).join(", ") + " · Recreation.gov",
               url: `https://www.recreation.gov/camping/campgrounds/${r.entity_id}` });
    }));
    if (!results.length) {
      const find = `https://www.google.com/search?q=${encodeURIComponent(q + " campground reservations")}`;
      notice($("q-notice"), `Not on Recreation.gov. Try the <button type="button" class="link" data-go="map">map</button>, or <a href="${find}" target="_blank" rel="noopener">find its booking page</a> and paste the link here.`);
    }
  } catch (error) {
    if (seq === searchSeq) notice($("q-notice"), "Search isn't working right now. Paste the campground's booking link instead.");
  }
}

async function lookupRecgov(url) {
  const id = url.match(/campgrounds\/(\d+)/);
  if (!id) return;
  try {
    const params = new URLSearchParams({ fq: `entity_id:${id[1]}`, size: "1" });
    const r = (await (await fetch(`${RECGOV_SEARCH}?${params}`)).json()).results?.[0];
    if (r && state.place?.url === url) {
      state.place.name = r.name;
      state.place.detail = [r.parent_name, r.addresses?.[0]?.state_code].filter(Boolean).join(", ") + " · Recreation.gov";
      showChosen(); update();
    }
  } catch (error) { /* the name is only for display; the API looks it up itself */ }
}

function choose(place) {
  state.place = place;
  showChosen();
  if (place.lookup) lookupRecgov(place.url);
  update();
}

function showChosen() {
  $("pick").hidden = !!state.place;
  $("chosen").hidden = !state.place;
  if (state.place) { $("chosen-name").textContent = state.place.name; $("chosen-detail").textContent = state.place.detail; }
}

$("change").addEventListener("click", () => {
  state.place = null; showChosen(); $("q").value = ""; $("results").innerHTML = ""; $("q").focus(); update();
});

function notice(element, htmlText) { element.innerHTML = htmlText; element.hidden = false; }

// ---------------------------------------------------------------- Step 2: dates
const today = localToday();
$("in").min = iso(today);
$("in").max = iso(addDays(today, 395));
$("in").addEventListener("change", () => {
  const start = parseDate($("in").value);
  const end = parseDate($("out").value);
  if (start) {
    $("out").min = iso(addDays(start, 1));
    if (!end || end <= start || (end - start) / 86400000 > MAX_NIGHTS) $("out").value = iso(addDays(start, 2));
  }
  update();
});
$("out").addEventListener("change", update);

function stay() {
  const start = parseDate($("in").value), end = parseDate($("out").value);
  if (!start || !end) return { error: "" };
  const nights = Math.round((end - start) / 86400000);
  if (start < today) return { error: "Check-in has already passed." };
  if (nights < 1) return { error: "Check-out must be after check-in." };
  if (nights > MAX_NIGHTS) return { error: `Stays can be up to ${MAX_NIGHTS} nights.` };
  if ((start - today) / 86400000 > 395) return { error: "We can watch dates up to about a year ahead." };
  return { start, end, nights };
}

// ---------------------------------------------------------------- Step 3: camping in
const camping = () => document.querySelector('input[name="camping"]:checked').value;
document.querySelectorAll('input[name="camping"]').forEach(radio => radio.addEventListener("change", () => {
  $("length-wrap").hidden = !["trailer", "motorhome"].includes(camping());
  update();
}));
$("length").addEventListener("input", update);

function campingText() {
  if (state.place?.noFilter) return "Any site";
  const kind = camping();
  const length = parseInt($("length").value, 10);
  const name = { any: "Any site", tent: "Tent", trailer: "Trailer", motorhome: "Motorhome or van" }[kind];
  return name + (["trailer", "motorhome"].includes(kind) && length > 0 ? `, ${length} ft` : "");
}

// ---------------------------------------------------------------- Step 4: email, summary, submit
const validEmail = text => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(text.trim());
let sending = false;

function signup() {
  const s = stay();
  if (!state.place || !s.start) return null;
  const kind = state.place.noFilter ? "any" : camping();
  const length = parseInt($("length").value, 10);
  return { s, body: {
    email: $("email").value.trim(), website: $("website").value, link: state.place.url, name: state.place.name,
    check_in: iso(s.start), check_out: iso(s.end), camping: kind,
    length: ["trailer", "motorhome"].includes(kind) && length > 0 ? length : 0,
  } };
}

function setSummary(id, value, empty) {
  const element = $(id);
  const text = value || empty;
  if (element.textContent === text) return;
  element.textContent = text;
  element.classList.toggle("empty", !value);
  if (value && !reduceMotion) { element.classList.remove("flash"); void element.offsetWidth; element.classList.add("flash"); }
}

function update() {
  const s = stay();
  $("date-notice").hidden = !s.error;
  if (s.error) $("date-notice").textContent = s.error;
  $("nights").textContent = s.start
    ? `${s.nights} night${s.nights === 1 ? "" : "s"}: ${dayName(s.start)} → ${dayName(s.end)}. You'll get an alert only when one site is free for every night.`
    : "You'll get an alert only when one site is free for every night.";
  $("camping-note").hidden = !state.place?.noFilter;

  const email = $("email").value.trim();
  setSummary("sum-place", state.place ? state.place.name : "", "Not chosen");
  setSummary("sum-stay", s.start ? `${dayName(s.start)} → ${dayName(s.end)} · ${s.nights} night${s.nights === 1 ? "" : "s"}` : "", "No dates yet");
  setSummary("sum-rig", campingText(), "Any site");
  setSummary("sum-email", validEmail(email) ? email : "", "No email yet");

  $("step-1").classList.toggle("done", !!state.place);
  $("step-2").classList.toggle("done", !!s.start);
  $("step-3").classList.toggle("done", !!state.place && !!s.start);
  $("step-4").classList.toggle("done", validEmail(email));

  const data = signup();
  $("share").disabled = !data;
  $("signup-button").disabled = !data || !validEmail(email) || sending;
}

$("email").addEventListener("input", update);
$("form").addEventListener("submit", async event => {
  event.preventDefault();
  const data = signup();
  if (!data || !validEmail($("email").value) || sending) return;
  sending = true;
  $("signup-button").textContent = "Sending…";
  update();
  let result;
  try {
    const response = await fetch(`${API}/signup`, { method: "POST", headers: { "Content-Type": "application/json" },
                                                    body: JSON.stringify(data.body) });
    result = await response.json();
  } catch (error) {
    result = { error: "We couldn't reach CampSwoop. Check your connection and try again." };
  }
  sending = false;
  $("signup-button").textContent = "Start watching";
  update();
  $("result").className = `result ${result.ok ? "ok" : "error"}`;
  $("result").textContent = result.ok ? `${result.message} Not there? Check your spam or promotions folder.` : result.error;
  $("result").hidden = false;
});

// ---------------------------------------------------------------- Sharing and pre-filled links
// ?link=<booking link>&in=YYYY-MM-DD&out=YYYY-MM-DD&camping=trailer&length=25
$("share").addEventListener("click", async () => {
  const params = new URLSearchParams({ link: state.place.url, in: $("in").value, out: $("out").value });
  if (camping() !== "any" && !state.place.noFilter) params.set("camping", camping());
  if ($("length").value && !$("length-wrap").hidden) params.set("length", $("length").value);
  const url = `${location.origin}${location.pathname}?${params}`;
  try {
    if (navigator.share) await navigator.share({ title: "CampSwoop", text: `Watch ${state.place.name} with me`, url });
    else { await navigator.clipboard.writeText(url); $("share-done").hidden = false; }
  } catch (error) { /* cancelled */ }
});

// ---------------------------------------------------------------- The map (loaded on first visit to the tab)
let mapLoading = null;
function openMap() {
  mapLoading ||= import(MAP_MODULE).catch(error => {
    mapLoading = null;
    const status = $("map-status");
    status.textContent = "The map couldn't load. Try again in a moment.";
    status.hidden = false;
    throw error;
  });
  mapLoading.then(module => module.open({ watchFromMap, reduceMotion })).catch(() => {});
}

function watchFromMap(place) {
  showTab("watch", { scroll: false });
  choose({ name: place.name, detail: place.detail, url: place.url, noFilter: !!place.noFilter });
  requestAnimationFrame(() => goToConfigurator(true));
}
window.CampSwoop = { watchFromMap, showTab };

// ---------------------------------------------------------------- Start
(function start() {
  const params = new URLSearchParams(location.search);
  if (params.get("link")) useLink(params.get("link"));
  if (parseDate(params.get("in"))) { $("in").value = params.get("in"); $("in").dispatchEvent(new Event("change")); }
  if (parseDate(params.get("out"))) $("out").value = params.get("out");
  const kind = document.querySelector(`input[name="camping"][value="${CSS.escape(params.get("camping") || "any")}"]`);
  if (kind) { kind.checked = true; kind.dispatchEvent(new Event("change")); }
  if (/^\d{1,2}$/.test(params.get("length") || "")) $("length").value = params.get("length");
  update();
  showTab(location.hash === "#map" && !params.get("link") ? "map" : "watch", { scroll: false });
  if (params.get("link")) setTimeout(() => goToConfigurator(true), 300);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();

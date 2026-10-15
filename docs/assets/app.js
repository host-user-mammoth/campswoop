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

// animate: a person switched tabs (slide the ink, fade the panel in, and add a history entry so the phone's
// Back gesture returns to the other tab instead of leaving the site).
function showTab(name, { scroll = true, animate = false } = {}) {
  if (!panels[name]) name = "watch";
  const changed = document.body.dataset.tab !== name;
  const url = location.pathname + location.search + (name === "map" ? "#map" : "");
  if (animate && changed) history.pushState({ tab: name }, "", url);
  else history.replaceState({ tab: name }, "", url);
  for (const key of Object.keys(panels)) {
    const on = key === name;
    panels[key].hidden = !on;
    tabButtons[key].setAttribute("aria-selected", String(on));
    tabButtons[key].tabIndex = on ? 0 : -1;
  }
  // Hiding a panel restarts its CSS animations; the hero's entrance plays once per visit, not per tab switch.
  if (name !== "watch") $("hero").classList.add("played");
  document.body.dataset.tab = name;
  placeInk(animate && changed);
  updateNav();
  if (scroll) window.scrollTo({ top: 0, behavior: "auto" });
  if (changed && animate && !reduceMotion) {
    panels[name].animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }
  if (name === "map") openMap();
}

// The tab ink is 1px wide and scaled to the chosen tab. It slides only when someone switches tabs.
function placeInk(animate = false) {
  const tab = Object.values(tabButtons).find(t => t.getAttribute("aria-selected") === "true");
  const ink = document.querySelector(".tab-ink");
  if (!tab || !ink) return;
  if (!animate) ink.style.transition = "none";
  ink.style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth})`;
  if (!animate) { ink.getBoundingClientRect(); ink.style.transition = ""; }
}

for (const [name, tab] of Object.entries(tabButtons)) {
  tab.addEventListener("click", () => showTab(name, { animate: true }));
  tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = name === "watch" ? "map" : "watch";
    showTab(event.key === "Home" ? "watch" : event.key === "End" ? "map" : next, { animate: true });
    tabButtons[document.body.dataset.tab].focus();
  });
}

document.addEventListener("click", event => {
  const go = event.target.closest("[data-go]");
  if (!go) return;
  event.preventDefault();
  const target = go.dataset.go;
  if (target === "map") showTab("map", { animate: true });
  else if (target === "configure") goToConfigurator();
  else showTab("watch", { animate: true });
});
// iOS Safari shows :active press states only when the page listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

function scrollToElement(element, instant = false) {
  const top = element.getBoundingClientRect().top + window.scrollY - navHeight() - 8;
  window.scrollTo({ top, behavior: reduceMotion || instant ? "auto" : "smooth" });
}

function goToConfigurator(focusDates = false, { instant = false } = {}) {
  if (document.body.dataset.tab !== "watch") showTab("watch", { scroll: false });
  scrollToElement($("configure"), instant);
  // Phones won't open the keyboard from a timer, so focusing there would only light the field up.
  if (matchMedia("(pointer: coarse)").matches) return;
  const target = focusDates || state.place ? $("in") : $("q");
  setTimeout(() => target.focus({ preventScroll: true }), reduceMotion || instant ? 0 : 650);
}

// Back and forward between the tabs. Other hashes (#configure from the skip link) are in-page anchors.
const tabFromHash = () => (location.hash === "#map" ? "map" : "watch");
addEventListener("popstate", () => showTab(tabFromHash(), { scroll: false }));
addEventListener("hashchange", () => {
  if ((location.hash === "#map" || location.hash === "") && document.body.dataset.tab !== tabFromHash()) showTab(tabFromHash());
});
addEventListener("resize", () => placeInk());
document.fonts?.ready.then(() => placeInk());

function updateNav() {
  $("nav").classList.toggle("solid", document.body.dataset.tab === "map" || window.scrollY > 40);
}
addEventListener("scroll", updateNav, { passive: true });

// ---------------------------------------------------------------- Reveal on scroll
document.documentElement.classList.add("reveal-on"); // sections hide only once something is here to reveal them
const revealer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) { entry.target.classList.add("in"); revealer.unobserve(entry.target); }
  }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
document.querySelectorAll(".reveal").forEach(element => revealer.observe(element));
// Fail-safe: a fast jump (a link to #configure, restoring scroll) can pass a section without the observer
// firing for it; nothing above the bottom of the screen may stay invisible.
function revealPassed() {
  for (const element of document.querySelectorAll(".reveal:not(.in)")) {
    if (element.getBoundingClientRect().top < innerHeight) { element.classList.add("in"); revealer.unobserve(element); }
  }
}
addEventListener("scrollend", revealPassed);
addEventListener("load", revealPassed);

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

// The loop plays only while the hero is on screen, and anyone can stop it (WCAG 2.2.2).
const heroPause = $("hero-pause");
let heroPausedByVisitor = false;
if (!reduceMotion && !saveData) {
  heroVideo.src = `assets/hero-${phase}.mp4`;
  heroVideo.preload = "auto";
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && document.body.dataset.tab === "watch" && !heroPausedByVisitor) heroVideo.play().catch(() => {});
    else heroVideo.pause();
  }).observe(hero);
  heroVideo.addEventListener("playing", () => { heroPause.hidden = false; }, { once: true });
  heroPause.addEventListener("click", () => {
    heroPausedByVisitor = !heroPausedByVisitor;
    if (heroPausedByVisitor) heroVideo.pause(); else heroVideo.play().catch(() => {});
    heroPause.textContent = heroPausedByVisitor ? "Play" : "Pause";
    heroPause.setAttribute("aria-label", `${heroPausedByVisitor ? "Play" : "Pause"} the background video`);
  });
}
// Someone who turns on reduced motion mid-visit gets stillness right away.
matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", event => {
  if (!event.matches) return;
  heroVideo.pause();
  alertVideo.pause();
  window.CampSwoopMap?.stopSpin?.();
});

// The page ships the current counts; refresh them from the map data so they never go stale.
(window.requestIdleCallback || (fn => setTimeout(fn, 1200)))(async () => {
  try {
    const places = await campgrounds();
    $("coverage-count").textContent = places.length.toLocaleString();
    const counts = {};
    for (const [system] of places) counts[system] = (counts[system] || 0) + 1;
    for (const cell of document.querySelectorAll("#systems [data-system]")) cell.textContent = (counts[cell.dataset.system] || 0).toLocaleString();
  } catch (error) { /* keep the static figures */ }
});

// ---------------------------------------------------------------- Alert preview clip
const alertVideo = $("alert-video");
const replay = $("alert-replay");
if (reduceMotion) {
  // Still by default (the poster is the finished alert), but one tap plays it.
  replay.textContent = "Play";
  replay.hidden = false;
} else {
  // Start from the empty card, so the alert builds itself rather than blanking a finished one.
  alertVideo.poster = "assets/alert-poster-start.webp";
  // Load the clip (90 KB) only when it's about to scroll into view; with reduced motion it loads on Play.
  new IntersectionObserver(([entry], observer) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    alertVideo.preload = "auto";
    alertVideo.load();
  }, { rootMargin: "600px 0px" }).observe(alertVideo);
  // It plays once it's well in view; scrolled away before the end, it rewinds for next time.
  new IntersectionObserver(([entry]) => {
    if (entry.intersectionRatio >= 0.6 && alertVideo.paused && !alertVideo.ended) {
      alertVideo.play().catch(() => { alertVideo.poster = "assets/alert-poster.webp"; replay.textContent = "Play"; replay.hidden = false; });
    } else if (entry.intersectionRatio < 0.25 && !alertVideo.paused) {
      alertVideo.pause();
      alertVideo.currentTime = 0;
    }
  }, { threshold: [0, 0.25, 0.6] }).observe(alertVideo);
}
alertVideo.addEventListener("ended", () => { replay.textContent = "Replay"; replay.hidden = false; });
replay.addEventListener("click", () => { replay.hidden = true; alertVideo.currentTime = 0; alertVideo.play().catch(() => {}); });

// ---------------------------------------------------------------- Step 1: campground
let searchTimer;
let searchSeq = 0;
$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("q").value.trim();
  $("q-notice").textContent = "";
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

// The campgrounds CampSwoop can watch (the map's list): rows of [system, lng, lat, name, area, ref].
const SYSTEM_NAMES = { r: "Recreation.gov", w: "Washington State Parks", b: "BC Parks", o: "Ontario Parks", p: "Parks Canada", f: "Firefly Reservations" };
const CAMIS_HOSTS = { w: "washington.goingtocamp.com", b: "camping.bcparks.ca", o: "reservations.ontarioparks.ca", p: "reservation.pc.gc.ca" };
let campgroundList;
const campgrounds = () => (campgroundList ||= fetch("data/campgrounds.json").then(r => r.json()).then(data => data.places)
  .catch(error => { campgroundList = null; throw error; }));
// Keep in step with bookingLink() in map.js.
function bookingLink([system, , , , , ref]) {
  if (system === "r") return `https://www.recreation.gov/camping/campgrounds/${ref}`;
  if (system === "f") return `https://app.fireflyreservations.com/reserve/property/${ref}`;
  const [location, mapId] = String(ref).split("|");
  return `https://${CAMIS_HOSTS[system]}/create-booking/results?resourceLocationId=${location}&mapId=${mapId}&searchTabGroupId=0&bookingCategoryId=0`;
}

// Search: every campground we can watch by name, from our own list at once; Recreation.gov's search then
// adds its other matches (alternate names, first-come sites it can't book).
async function search(q) {
  const seq = ++searchSeq;
  const needle = q.toLowerCase().replace(/[.\s]+/g, " ").trim();
  const items = [];
  try {
    // Best first: the name starts with what was typed, then a word in it does, then it's anywhere.
    const rank = name => (name.startsWith(needle) ? 0 : (` ${name}`).includes(` ${needle}`) ? 1 : 2);
    const matches = [];
    for (const row of await campgrounds()) {
      const name = row[3].toLowerCase().replace(/[.\s]+/g, " ");
      if (name.includes(needle)) matches.push([rank(name), row[3].length, row]);
    }
    matches.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, , row] of matches.slice(0, 6)) {
      items.push({ name: row[3], where: `${row[4]} · ${SYSTEM_NAMES[row[0]]}`, url: bookingLink(row),
                   noFilter: "wbop".includes(row[0]), id: row[0] === "r" ? String(row[5]) : null });
    }
  } catch (error) { /* our list didn't load; Recreation.gov's search still runs */ }
  if (seq !== searchSeq) return;
  showResults(items);
  try {
    const params = new URLSearchParams({ q, fq: "entity_type:campground", size: "8" });
    const data = await (await fetch(`${RECGOV_SEARCH}?${params}`)).json();
    if (seq !== searchSeq) return;
    const seen = new Set(items.map(item => item.id).filter(Boolean));
    for (const r of data.results || []) {
      if (seen.has(String(r.entity_id)) || items.length >= 8) continue;
      const where = [r.parent_name, r.addresses?.[0]?.state_code || r.state_code].filter(Boolean).join(", ");
      items.push({ name: r.name, where: `${where} · Recreation.gov`, url: `https://www.recreation.gov/camping/campgrounds/${r.entity_id}`,
                   closed: r.reservable === false });
    }
    showResults(items);
  } catch (error) { /* Recreation.gov's search is down; our own matches stand */ }
  if (seq === searchSeq && !items.length) {
    const find = `https://www.google.com/search?q=${encodeURIComponent(q + " campground reservations")}`;
    notice($("q-notice"), `No campground we can watch matches that. Try the <button type="button" class="link" data-go="map">map</button>, or <a href="${find}" target="_blank" rel="noopener">find its booking page</a> and paste the link here.`);
  }
}

function showResults(items) {
  $("results").innerHTML = items.map((item, i) => `<li><button type="button" data-i="${i}" ${item.closed ? "disabled" : ""}>${escapeHtml(item.name)}<small>${escapeHtml(item.where + (item.closed ? " · first come, first served (can't be booked online)" : ""))}</small></button></li>`).join("");
  $("results").querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    const item = items[button.dataset.i];
    choose({ name: item.name, detail: item.where, url: item.url, noFilter: !!item.noFilter });
  }));
}

$("q").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); $("results").querySelector("button:not(:disabled)")?.click(); }
  if (event.key === "Escape") $("results").innerHTML = "";
});

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
  const hadFocus = $("pick").contains(document.activeElement); // the block that held focus is about to hide
  state.place = place;
  showChosen();
  if (place.lookup) lookupRecgov(place.url);
  update();
  if (hadFocus) $("in").focus({ preventScroll: true });
}

function showChosen() {
  $("pick").hidden = !!state.place;
  $("chosen").hidden = !state.place;
  if (state.place) { $("chosen-name").textContent = state.place.name; $("chosen-detail").textContent = state.place.detail; }
}

$("change").addEventListener("click", () => {
  state.place = null; showChosen(); $("q").value = ""; $("results").innerHTML = ""; $("q").focus(); update();
});

// Notices are always-present live regions, shown only while they hold text (.notice:empty is hidden).
function notice(element, htmlText) { element.innerHTML = htmlText; }

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
let sentKey = ""; // the last sign-up that went through

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

const flashTimers = {};
function setSummary(id, value, empty) {
  const element = $(id);
  const text = value || empty;
  if (element.textContent === text) return;
  element.textContent = text;
  element.classList.toggle("empty", !value);
  // One ember flash once typing pauses, not a strobe on every keystroke.
  clearTimeout(flashTimers[id]);
  if (value && !reduceMotion) {
    flashTimers[id] = setTimeout(() => element.animate([{ color: "#ff6a3d" }, { color: "#f4efe6" }], { duration: 600, easing: "ease-out" }), 400);
  }
}

function update() {
  const s = stay();
  if ($("date-notice").textContent !== (s.error || "")) $("date-notice").textContent = s.error || "";
  $("nights").textContent = s.start
    ? `${s.nights} night${s.nights === 1 ? "" : "s"}: ${dayName(s.start)} → ${dayName(s.end)}. One site must be free for every night.`
    : `One site must be free for every night. Stays up to ${MAX_NIGHTS} nights.`;
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
  // After a sign-up the button rests until something changes, so the same watch isn't sent twice.
  const alreadySent = !!data && sentKey === JSON.stringify(data.body);
  $("signup-button").disabled = !data || !validEmail(email) || sending || alreadySent;
  $("signup-button").textContent = sending ? "Sending…" : alreadySent ? "Sent · check your inbox" : "Start watching";
  // Say what's missing rather than leaving a silent, disabled button.
  const emailNeed = !email ? "your email" : !validEmail(email) ? "a complete email address" : "";
  const missing = [!state.place && "a campground", !s.start && "your dates", emailNeed].filter(Boolean);
  $("needs").textContent = missing.length && !sending
    ? `Still needed: ${missing.length < 2 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`}.` : "";
}

$("email").addEventListener("input", update);
$("form").addEventListener("submit", async event => {
  event.preventDefault();
  const data = signup();
  if (!data || !validEmail($("email").value) || sending) return;
  sending = true;
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
  if (result.ok) sentKey = JSON.stringify(data.body);
  update();
  // Shown before the text goes in, so screen readers announce it.
  $("result").className = `result ${result.ok ? "ok" : "error"}`;
  $("result").hidden = false;
  $("result").textContent = result.ok ? `${result.message} Not there? Check your spam or promotions folder.` : result.error;
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
  showTab("watch", { scroll: false, animate: true });
  choose({ name: place.name, detail: place.detail, url: place.url, noFilter: !!place.noFilter });
  // Straight to the form, behind the panel's fade: a smooth scroll would sweep through the whole hero.
  requestAnimationFrame(() => goToConfigurator(true, { instant: true }));
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

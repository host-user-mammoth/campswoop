/* CampSwoop map: every campground CampSwoop can watch, every other OpenStreetMap campsite,
   and where on Earth it's night right now. Loaded the first time someone opens the Map tab. */

const MAPLIBRE_JS = "https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css";
const STYLE = "https://tiles.openfreemap.org/styles/dark";
const PHOTON = "https://photon.komoot.io/api/";
const RECGOV_SEARCH = "https://www.recreation.gov/api/search";
const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> '
  + '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> '
  + 'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const EMBER = "#ff4a1c";
const BONE = "#e8dfd2";
const SYSTEMS = { r: "Recreation.gov", w: "Washington State Parks", b: "BC Parks", o: "Ontario Parks", p: "Parks Canada", f: "Firefly Reservations" };
const CAMIS_HOSTS = { w: "washington.goingtocamp.com", b: "camping.bcparks.ca", o: "reservations.ontarioparks.ca", p: "reservation.pc.gc.ca" };
const LIST_LIMIT = 60;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const wrapLng = lng => ((lng + 540) % 360) - 180;

let hooks;
let map;
let places = [];
let popup;
let started = false;
let spinning = false;
const errors = [];
window.CampSwoopMap = { get map() { return map; }, errors }; // for support and testing

export async function open(api) {
  hooks = api;
  if (started) { map?.resize(); return; }
  started = true;
  status("Loading the map…");
  try {
    loadCss(MAPLIBRE_CSS);
    const [, json] = await Promise.all([loadScript(MAPLIBRE_JS), fetch("data/campgrounds.json").then(r => r.json())]);
    places = json.places.map(([s, lng, lat, name, area, ref], i) => ({ i, s, lng, lat, name, area, ref }));
    $("count-watch").textContent = places.length.toLocaleString();
    build();
  } catch (error) {
    started = false;
    status("The map couldn't load. Try again in a moment.");
    throw error;
  }
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href });
  document.head.append(link);
}

function loadScript(src) {
  if (window.maplibregl) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement("script"), { src, async: true });
    script.onload = resolve;
    script.onerror = () => reject(new Error("map library failed to load"));
    document.head.append(script);
  });
}

function status(text, ms = 0) {
  const element = $("map-status");
  element.textContent = text;
  element.hidden = !text;
  if (text && ms) setTimeout(() => { if (element.textContent === text) element.hidden = true; }, ms);
}

// ---------------------------------------------------------------- Map
function build() {
  // Open on the middle of the campgrounds we can watch.
  const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
  const center = places.length ? [median(places.map(p => p.lng)), median(places.map(p => p.lat))] : [-98, 40];
  map = new maplibregl.Map({
    container: "map", style: STYLE, center, zoom: innerWidth < 760 ? 0.9 : 1.6,
    minZoom: 0.6, maxZoom: 17, attributionControl: false, dragRotate: false, pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  // The tiles carry their own attribution (OpenFreeMap, OpenMapTiles, OpenStreetMap); ATTRIBUTION is the fallback.
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  map.once("load", () => { if (!document.querySelector(".maplibregl-ctrl-attrib a")) map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIBUTION }), "bottom-right"); });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

  map.on("style.load", () => {
    map.setProjection({ type: "globe" });
    map.setSky({
      "sky-color": "#0b0a09", "horizon-color": "#3d2416", "fog-color": "#0b0a09",
      "sky-horizon-blend": 0.5, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.4,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0],
    });
    addLayers();
  });
  map.on("load", () => {
    map.resize();
    status("");
    updateList();
    startSpin();
    setInterval(updateNight, 60000);
  });
  // Re-measure whenever the panel's size changes: tab switches, phone rotation, the keyboard opening.
  new ResizeObserver(() => map.resize()).observe($("map"));
  map.on("moveend", debounce(updateList, 150));
  map.on("idle", debounce(updateList, 100)); // tiles that arrive after the move settle the "in view" counts
  map.on("error", event => { errors.push(String(event.error?.message || event.error || event)); console.warn("map:", errors.at(-1)); });
  for (const type of ["mousedown", "touchstart", "wheel", "dragstart", "keydown"]) map.on(type, () => { spinning = false; });
  wireUi();
}

function restyle() {
  // The dark style is black on black. Lift the land, sink the water into the page, warm the lines and labels.
  const paint = {
    background: { "background-color": "#1a1613" },
    water: { "fill-color": "#0b0a09" },
    waterway: { "line-color": "#0b0a09" },
    landuse_park: { "fill-color": "#211c18" },
    landuse_residential: { "fill-color": "#1e1a17" },
    landcover_ice_shelf: { "fill-color": "#232019" },
    landcover_glacier: { "fill-color": "#232019" },
    building: { "fill-color": "#15120f", "fill-outline-color": "#272220" },
    boundary_state: { "line-color": "#3d352f" },
    "boundary_country_z0-4": { "line-color": "#5d5047" },
    "boundary_country_z5-": { "line-color": "#5d5047" },
    water_name: { "text-color": "#3f3934", "text-halo-color": "rgba(11,10,9,0.6)" },
  };
  for (const layer of map.getStyle().layers) {
    const overrides = paint[layer.id]
      || (layer.id.startsWith("place_") ? { "text-color": "#a89f93", "text-halo-color": "rgba(11,10,9,0.85)" } : null);
    if (!overrides) continue;
    for (const [name, value] of Object.entries(overrides)) {
      try { map.setPaintProperty(layer.id, name, value); } catch (error) { /* the style changed upstream; keep its colors */ }
    }
  }
}

function addLayers() {
  restyle();
  const firstLabel = map.getStyle().layers.find(layer => layer.type === "symbol")?.id;

  // Night: the part of the globe where the sun is down right now, with a warm line where it's rising or setting.
  map.addSource("night", { type: "geojson", data: nightGeoJson(new Date()) });
  map.addLayer({ id: "night-fill", type: "fill", source: "night", filter: ["==", ["geometry-type"], "Polygon"],
                 paint: { "fill-color": "#00050f", "fill-opacity": 0.46 } }, firstLabel);
  map.addLayer({ id: "night-edge", type: "line", source: "night", filter: ["==", ["geometry-type"], "LineString"],
                 paint: { "line-color": "#ff9a5a", "line-opacity": 0.4, "line-width": 1.4, "line-blur": 1.2 } }, firstLabel);

  // Every other campsite, straight from the basemap's OpenStreetMap points of interest (zoom 11+).
  map.addLayer({
    id: "osm-campsites", type: "circle", source: "openmaptiles", "source-layer": "poi", minzoom: 14, // the tiles carry them from zoom 14
    filter: ["==", ["get", "class"], "campsite"],
    paint: {
      "circle-color": BONE, "circle-opacity": 0.9,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 5, 17, 8],
      "circle-stroke-width": 1, "circle-stroke-color": "#0b0a09",
    },
  });

  // Campgrounds CampSwoop can watch, clustered.
  map.addSource("watch", {
    type: "geojson", cluster: true, clusterRadius: 46, clusterMaxZoom: 9,
    data: { type: "FeatureCollection", features: places.map(p => ({
      type: "Feature", id: p.i, geometry: { type: "Point", coordinates: [p.lng, p.lat] }, properties: { i: p.i, name: p.name } })) },
  });
  const clusterRadius = ["step", ["get", "point_count"], 13, 20, 16, 100, 21, 500, 27];
  map.addLayer({ id: "watch-glow", type: "circle", source: "watch",
    paint: { "circle-color": EMBER, "circle-blur": 1, "circle-opacity": 0.35,
             "circle-radius": ["case", ["has", "point_count"], ["*", clusterRadius, 1.9], 11] } });
  map.addLayer({ id: "watch-clusters", type: "circle", source: "watch", filter: ["has", "point_count"],
    paint: { "circle-color": EMBER, "circle-radius": clusterRadius, "circle-stroke-width": 1.5, "circle-stroke-color": "rgba(255, 220, 200, 0.45)" } });
  map.addLayer({ id: "watch-count", type: "symbol", source: "watch", filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
    paint: { "text-color": "#170a05" } });
  map.addLayer({ id: "watch-points", type: "circle", source: "watch", filter: ["!", ["has", "point_count"]],
    paint: { "circle-color": EMBER, "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3.5, 9, 6, 14, 8],
             "circle-stroke-width": 1.5, "circle-stroke-color": "#0b0a09" } });
  map.addLayer({ id: "watch-labels", type: "symbol", source: "watch", filter: ["!", ["has", "point_count"]], minzoom: 8,
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, 1], "text-anchor": "top",
              "text-max-width": 9, "text-optional": true },
    paint: { "text-color": "#e8dfd2", "text-halo-color": "#0b0a09", "text-halo-width": 1.4 } });

  for (const layer of ["watch-clusters", "watch-points", "osm-campsites"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }
  map.on("click", "watch-clusters", async event => {
    const feature = event.features[0];
    const zoom = await map.getSource("watch").getClusterExpansionZoom(feature.properties.cluster_id);
    move({ center: feature.geometry.coordinates, zoom: Math.min(zoom + 0.5, 14) });
  });
  map.on("click", "watch-points", event => showPlace(places[event.features[0].properties.i]));
  map.on("click", "osm-campsites", event => {
    if (map.queryRenderedFeatures(event.point, { layers: ["watch-points"] }).length) return;
    showOsm(event.features[0], event.lngLat);
  });
}

const phone = matchMedia("(max-width: 760px)");

function move(options) {
  // On phones the bottom sheet covers the lower half, so keep the target in the upper half.
  const padding = phone.matches ? { top: 90, bottom: Math.round(innerHeight * 0.45), left: 0, right: 0 } : 0;
  if (hooks.reduceMotion) map.jumpTo({ padding, ...options });
  else map.flyTo({ padding, ...options, speed: 1.4, curve: 1.42, essential: true });
}

function startSpin() {
  spinning = !hooks.reduceMotion;
  const until = Date.now() + 90000; // one slow turn to show the scope, then rest
  const step = () => {
    if (!spinning || Date.now() > until) { spinning = false; return; }
    if (document.body.dataset.tab !== "map" || map.getZoom() > 3) { setTimeout(step, 1500); return; }
    const center = map.getCenter();
    map.easeTo({ center: [center.lng + 4, center.lat], duration: 1000, easing: t => t });
    map.once("moveend", step);
  };
  setTimeout(step, 600);
}

// ---------------------------------------------------------------- Popups
function bookingLink(p) {
  if (p.s === "r") return `https://www.recreation.gov/camping/campgrounds/${p.ref}`;
  if (p.s === "f") return `https://app.fireflyreservations.com/reserve/property/${p.ref}`;
  const [location, mapId] = String(p.ref).split("|");
  return `https://${CAMIS_HOSTS[p.s]}/create-booking/results?resourceLocationId=${location}&mapId=${mapId}&searchTabGroupId=0&bookingCategoryId=0`;
}

function openPopup(lngLat, element) {
  popup?.remove();
  if (phone.matches) { // a card in the bottom sheet, where a thumb can reach it, instead of a popup over the map
    const back = document.createElement("button");
    back.type = "button";
    back.className = "link back";
    back.textContent = "← All campgrounds";
    back.addEventListener("click", closeDetail);
    $("map-detail").replaceChildren(back, element);
    $("map-detail").hidden = false;
    $("map-side").classList.add("open", "detail");
    $("sheet-handle").setAttribute("aria-expanded", "true");
    $("map-detail").scrollTop = 0;
    element.querySelector("h3")?.setAttribute("tabindex", "-1");
    element.querySelector("h3")?.focus({ preventScroll: true });
    return;
  }
  popup = new maplibregl.Popup({ offset: 14, maxWidth: "320px", focusAfterOpen: true })
    .setLngLat(lngLat).setDOMContent(element).addTo(map);
}

function closeDetail() {
  $("map-detail").hidden = true;
  $("map-detail").replaceChildren();
  $("map-side").classList.remove("detail");
}

function showPlace(p, fly = false) {
  const element = document.createElement("div");
  element.innerHTML = `
    ${p.s === "r" ? '<img class="pop-photo" alt="" hidden>' : ""}
    <div class="pop-body">
      <p class="pop-kicker">Can watch · ${esc(SYSTEMS[p.s])}</p>
      <h3>${esc(p.name)}</h3>
      <p class="pop-meta">${esc(p.area)}</p>
      ${sunHtml(p.lat, p.lng)}
      <div class="pop-actions">
        <button class="btn btn-ember" type="button" data-watch>Watch this campground</button>
        <a class="link" href="${esc(bookingLink(p))}" target="_blank" rel="noopener">Booking page ↗</a>
      </div>
    </div>`;
  element.querySelector("[data-watch]").addEventListener("click", () => {
    popup?.remove();
    closeDetail();
    hooks.watchFromMap({ name: p.name, detail: `${p.area} · ${SYSTEMS[p.s]}`, url: bookingLink(p), noFilter: "wbop".includes(p.s) });
  });
  if (p.s === "r") loadPhoto(p.ref, element.querySelector(".pop-photo"));
  if (fly) move({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 10) });
  openPopup([p.lng, p.lat], element);
}

async function loadPhoto(id, img) {
  try {
    const params = new URLSearchParams({ fq: `entity_id:${id}`, size: "1" });
    const result = (await (await fetch(`${RECGOV_SEARCH}?${params}`)).json()).results?.[0];
    if (!result?.preview_image_url) return;
    img.onload = () => { img.hidden = false; };
    img.src = result.preview_image_url;
  } catch (error) { /* no photo */ }
}

function showOsm(feature, lngLat) {
  const props = feature.properties || {};
  const name = props["name:en"] || props.name || "Campsite";
  const [lng, lat] = feature.geometry?.coordinates || [lngLat.lng, lngLat.lat];
  const osm = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=16/${lat.toFixed(5)}/${lng.toFixed(5)}`;
  const find = `https://www.google.com/search?q=${encodeURIComponent(`${name} campground reservations`)}`;
  const element = document.createElement("div");
  element.innerHTML = `
    <div class="pop-body">
      <p class="pop-kicker bone">Campsite · OpenStreetMap</p>
      <h3>${esc(name)}</h3>
      ${sunHtml(lat, lng)}
      <p class="pop-meta">CampSwoop can't watch this one yet. If it books through Recreation.gov, Firefly or GoingToCamp, paste its booking link on the Watch tab.</p>
      <div class="pop-actions">
        <a class="btn btn-ghost" href="${esc(find)}" target="_blank" rel="noopener">Find its booking page ↗</a>
        <a class="link" href="${esc(osm)}" target="_blank" rel="noopener">View on OpenStreetMap ↗</a>
      </div>
    </div>`;
  openPopup([lng, lat], element);
}

// ---------------------------------------------------------------- Sun and night
function sunPosition(date) {
  // Sub-solar point (the spot where the sun is directly overhead), accurate to a fraction of a degree.
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = rad(357.529 + 0.98560028 * d);
  const q = 280.459 + 0.98564736 * d;
  const L = rad(q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * d);
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  return { lat: deg(dec), lng: wrapLng(deg(ra) - gmst * 15) };
}

function nightGeoJson(date) {
  const sun = sunPosition(date);
  const tanDec = Math.tan(rad(Math.abs(sun.lat) < 0.05 ? 0.05 * Math.sign(sun.lat || 1) : sun.lat));
  const line = [];
  for (let lng = -180; lng <= 180; lng += 2) {
    line.push([lng, deg(Math.atan(-Math.cos(rad(lng - sun.lng)) / tanDec))]);
  }
  const pole = sun.lat > 0 ? -89.9 : 89.9;
  const ring = [...line, [180, pole], [-180, pole], line[0]];
  return { type: "FeatureCollection", features: [
    { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } },
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } },
  ] };
}

function updateNight() {
  map.getSource("night")?.setData(nightGeoJson(new Date()));
  updateClock();
}

function sunAltitude(date, lat, lng) {
  const sun = sunPosition(date);
  const h = rad(lng - sun.lng);
  return deg(Math.asin(Math.sin(rad(lat)) * Math.sin(rad(sun.lat)) + Math.cos(rad(lat)) * Math.cos(rad(sun.lat)) * Math.cos(h)));
}

function sunHtml(lat, lng) {
  const now = Date.now();
  const up = sunAltitude(new Date(now), lat, lng) > -0.833;
  let minutes = null;
  for (let m = 5; m <= 26 * 60; m += 5) {
    if ((sunAltitude(new Date(now + m * 60000), lat, lng) > -0.833) !== up) { minutes = m; break; }
  }
  if (minutes === null) return `<p class="pop-sun${up ? "" : " night"}">${up ? "Midnight sun there right now" : "Polar night there right now"}</p>`;
  const at = new Date(now + minutes * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const span = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ""}`.trim();
  return up
    ? `<p class="pop-sun">Daylight there · sun sets in ${span} <span class="fine">(${at} your time)</span></p>`
    : `<p class="pop-sun night">Night there · sun rises in ${span} <span class="fine">(${at} your time)</span></p>`;
}

function updateClock() {
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  $("map-clock").innerHTML = `Your time <b>${esc(time)}</b>`;
  const sun = sunPosition(new Date());
  $("night-hint").textContent = `Sun overhead near ${Math.abs(sun.lat).toFixed(0)}°${sun.lat >= 0 ? "N" : "S"} ${Math.abs(sun.lng).toFixed(0)}°${sun.lng >= 0 ? "E" : "W"}`;
}

// ---------------------------------------------------------------- Side panel
function updateList() {
  if (!map) return;
  updateClock();
  const zoom = map.getZoom();
  const bounds = map.getBounds();
  const center = map.getCenter();
  const visible = zoom < 2.2 ? places : places.filter(p => bounds.contains([p.lng, p.lat]));
  const cosLat = Math.cos(rad(center.lat));
  visible.sort((a, b) => dist(a) - dist(b));
  function dist(p) { const dx = (p.lng - center.lng) * cosLat; const dy = p.lat - center.lat; return dx * dx + dy * dy; }

  $("inview").textContent = `${visible.length.toLocaleString()} watchable ${zoom < 2.2 ? "worldwide" : "in view"}`;
  const list = $("map-list");
  list.innerHTML = visible.slice(0, LIST_LIMIT).map(p => `<li><button type="button" data-i="${p.i}">${esc(p.name)}<small>${esc(p.area)} · ${esc(SYSTEMS[p.s])}</small></button></li>`).join("")
    + (visible.length > LIST_LIMIT ? `<li class="more">Zoom in to see the other ${(visible.length - LIST_LIMIT).toLocaleString()}.</li>` : "");

  if (!$("layer-osm").checked) $("osm-hint").textContent = "OpenStreetMap · hidden";
  else if (zoom < 14) $("osm-hint").textContent = "OpenStreetMap · zoom in close to see them";
  else {
    const seen = new Set(map.queryRenderedFeatures({ layers: ["osm-campsites"] }).map(f => `${f.properties.name}|${f.geometry.coordinates}`));
    $("osm-hint").textContent = `OpenStreetMap · ${seen.size.toLocaleString()} in view`;
  }
}

function wireUi() {
  $("map-list").addEventListener("click", event => {
    const button = event.target.closest("button[data-i]");
    if (button) { spinning = false; showPlace(places[button.dataset.i], true); }
  });
  $("layer-watch").addEventListener("change", event => {
    for (const id of ["watch-glow", "watch-clusters", "watch-count", "watch-points", "watch-labels"]) map.setLayoutProperty(id, "visibility", event.target.checked ? "visible" : "none");
  });
  $("layer-osm").addEventListener("change", event => { map.setLayoutProperty("osm-campsites", "visibility", event.target.checked ? "visible" : "none"); updateList(); });
  $("layer-night").addEventListener("change", event => {
    for (const id of ["night-fill", "night-edge"]) map.setLayoutProperty(id, "visibility", event.target.checked ? "visible" : "none");
  });
  $("sheet-handle").addEventListener("click", () => {
    const open = !$("map-side").classList.contains("open");
    $("map-side").classList.toggle("open", open);
    $("sheet-handle").setAttribute("aria-expanded", String(open));
    if (!open) closeDetail();
  });
  $("locate").addEventListener("click", () => {
    if (!navigator.geolocation) return status("Your browser can't share your location.", 3000);
    status("Finding you…");
    navigator.geolocation.getCurrentPosition(position => {
      status("");
      spinning = false;
      move({ center: [position.coords.longitude, position.coords.latitude], zoom: 8.5 });
    }, () => status("Location is off for this site. Search for a place instead.", 4000), { timeout: 10000, maximumAge: 600000 });
  });

  // Search: places from Photon (OpenStreetMap), plus matching campgrounds CampSwoop can watch.
  let timer;
  let seq = 0;
  const input = $("map-q");
  const results = $("map-results");
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ""; return; }
    timer = setTimeout(() => runSearch(q, ++seq), 300);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); results.querySelector("button")?.click(); }
    if (event.key === "Escape") { results.innerHTML = ""; }
  });
  results.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    spinning = false;
    results.innerHTML = "";
    input.blur();
    if (button.dataset.i) return showPlace(places[button.dataset.i], true);
    const [w, s, e, n] = (button.dataset.extent || "").split(",").map(Number);
    if (button.dataset.extent && [w, s, e, n].every(Number.isFinite)) {
      map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 12, duration: hooks.reduceMotion ? 0 : 1600 });
    } else {
      move({ center: button.dataset.center.split(",").map(Number), zoom: 10 });
    }
  });

  async function runSearch(q, mine) {
    const needle = q.toLowerCase();
    const local = places.filter(p => p.name.toLowerCase().includes(needle)).slice(0, 6);
    let found = [];
    if (q.length >= 3) {
      try {
        const params = new URLSearchParams({ q, limit: "6", lang: "en" });
        found = (await (await fetch(`${PHOTON}?${params}`)).json()).features || [];
      } catch (error) { /* places search unavailable */ }
    }
    if (mine !== seq) return;
    const placeItems = found.map(f => {
      const p = f.properties || {};
      const where = [p.state, p.country].filter(Boolean).join(", ");
      const extent = p.extent ? `${p.extent[0]},${p.extent[3]},${p.extent[2]},${p.extent[1]}` : "";
      return `<li><button type="button" data-center="${f.geometry.coordinates.join(",")}" data-extent="${extent}">${esc(p.name || p.street || q)}<small>${esc(where || p.osm_value || "")}</small></button></li>`;
    }).join("");
    const campItems = local.map(p => `<li><button type="button" data-i="${p.i}">${esc(p.name)}<small>${esc(p.area)} · ${esc(SYSTEMS[p.s])}</small></button></li>`).join("");
    results.innerHTML = (placeItems ? `<li class="group">Places</li>${placeItems}` : "")
      + (campItems ? `<li class="group">Campgrounds CampSwoop can watch</li>${campItems}` : "")
      || `<li class="group">No matches</li>`;
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

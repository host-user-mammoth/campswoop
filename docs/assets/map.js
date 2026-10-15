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
// Phones in either orientation get the bottom sheet (kept in step with the sheet rules in site.css).
const phone = matchMedia("(max-width: 760px), (max-height: 500px) and (orientation: landscape) and (max-width: 1000px)");
window.CampSwoopMap = { get map() { return map; }, errors, stopSpin() { spinning = false; } }; // for support and testing

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
    container: "map", style: STYLE, center, zoom: phone.matches ? 0.9 : 1.6,
    minZoom: 0.6, maxZoom: 17, attributionControl: false, dragRotate: false, pitchWithRotate: false,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2), // a 3x phone draws 44% fewer pixels, with no visible loss
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
    $("map").classList.add("ready"); // fades the globe in instead of popping from black
    status("");
    updateList();
    startSpin();
    setInterval(updateNight, 60000);
  });
  // Re-measure whenever the panel's size changes: tab switches, phone rotation, the keyboard opening.
  new ResizeObserver(() => map.resize()).observe($("map"));
  // While the globe turns by itself the list stays put, so a row can't change under a finger.
  map.on("moveend", debounce(() => { if (!spinning) updateList(); }, 150));
  map.on("idle", debounce(() => { if (!spinning) updateList(); }, 100)); // late tiles settle the "in view" counts
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
                 paint: { "fill-color": "#000000", "fill-opacity": 0.42 } }, firstLabel);
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
    paint: { "circle-color": EMBER, "circle-radius": clusterRadius, "circle-stroke-width": 1.5, "circle-stroke-color": "#0b0a09" } });
  map.addLayer({ id: "watch-count", type: "symbol", source: "watch", filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
    paint: { "text-color": "#170a05" } });
  map.addLayer({ id: "watch-points", type: "circle", source: "watch", filter: ["!", ["has", "point_count"]],
    paint: { "circle-color": EMBER, "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3.5, 9, 6, 14, 8],
             "circle-stroke-width": 1.5, "circle-stroke-color": "#0b0a09" } });
  map.addLayer({ id: "watch-labels", type: "symbol", source: "watch", filter: ["!", ["has", "point_count"]], minzoom: 8,
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, 1.25], "text-anchor": "top",
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
  map.on("click", "watch-points", event => showPlace(places[event.features[0].properties.i], false, true));
  map.on("click", "osm-campsites", event => {
    if (map.queryRenderedFeatures(event.point, { layers: ["watch-points"] }).length) return;
    showOsm(event.features[0], event.lngLat);
  });
}

// On phones the open sheet covers the lower part of the map, so frame the target above it.
function cameraPadding() {
  if (!phone.matches) return 0;
  const sheet = $("map-side");
  const covered = sheet.classList.contains("open") ? sheet.offsetHeight : peekHeight(sheet);
  return { top: 90, bottom: covered + 32, left: 0, right: 0 };
}

// How much of the closed sheet shows: the search box and the handle, above the home indicator.
function peekHeight(sheet) {
  const style = getComputedStyle(sheet);
  return (parseFloat(style.getPropertyValue("--peek")) || 104) + (parseFloat(style.paddingBottom) || 0);
}

function move(options) {
  const padding = cameraPadding();
  if (hooks.reduceMotion) return map.jumpTo({ padding, ...options });
  const zoomChange = Math.abs((options.zoom ?? map.getZoom()) - map.getZoom());
  map.flyTo({ padding, ...options, duration: Math.min(2200, 700 + 160 * zoomChange), essential: true });
}

function startSpin() {
  if (hooks.reduceMotion) return;
  spinning = true;
  // One slow turn to show the scope, then rest: 4° a second, stepped at 30 fps, only while someone can see it.
  const until = performance.now() + 90000;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    if (!spinning || now > until) { clearInterval(timer); spinning = false; updateList(); return; }
    if (!document.hidden && document.body.dataset.tab === "map" && map.getZoom() <= 3 && !$("map-side").classList.contains("open")) {
      const center = map.getCenter();
      map.jumpTo({ center: [center.lng + 4 * (now - last) / 1000, center.lat] });
    }
    last = now;
  }, 1000 / 30);
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
    $("map-side").classList.add("detail");
    setSheet(true);
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

// fly: from a list or search (move there); tapped: a dot on the map (on phones, keep it above the sheet).
function showPlace(p, fly = false, tapped = false) {
  const element = document.createElement("div");
  element.innerHTML = `
    ${p.s === "r" ? '<img class="pop-photo" alt="">' : ""}
    <div class="pop-body">
      <p class="pop-kicker">${esc(SYSTEMS[p.s])}</p>
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
  openPopup([p.lng, p.lat], element);
  // Framed after the sheet opens, so its real height is known.
  if (fly) move({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 10) });
  else if (tapped && phone.matches) map.easeTo({ center: [p.lng, p.lat], padding: cameraPadding(), duration: hooks.reduceMotion ? 0 : 450 });
}

// The photo's space is reserved, so nothing jumps when it arrives; it fades in, or goes if there's none.
async function loadPhoto(id, img) {
  try {
    const params = new URLSearchParams({ fq: `entity_id:${id}`, size: "1" });
    const result = (await (await fetch(`${RECGOV_SEARCH}?${params}`)).json()).results?.[0];
    if (!result?.preview_image_url) return img.remove();
    img.onload = () => img.classList.add("loaded");
    img.onerror = () => img.remove();
    img.src = result.preview_image_url;
  } catch (error) { img.remove(); }
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
      <p class="pop-kicker bone">OpenStreetMap campsite</p>
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
  const list = $("map-list");
  if (zoom < 2.2) {
    // The whole world: list the booking systems (tap one to fly to its campgrounds), not 60 arbitrary rows.
    $("inview").textContent = `${places.length.toLocaleString()} campgrounds we can watch`;
    const counts = {};
    for (const p of places) counts[p.s] = (counts[p.s] || 0) + 1;
    list.innerHTML = Object.keys(SYSTEMS).filter(s => counts[s]).sort((a, b) => counts[b] - counts[a])
      .map(s => `<li><button type="button" class="system" data-system="${s}"><span>${esc(SYSTEMS[s])}</span><b>${counts[s].toLocaleString()}</b></button></li>`).join("")
      + `<li class="note">Zoom in, or pick a system, to list campgrounds by name.</li>`;
  } else {
    // A filtered copy, never places itself: dots, rows and search results find a place by its index in places.
    const visible = places.filter(p => bounds.contains([p.lng, p.lat]));
    const cosLat = Math.cos(rad(center.lat));
    const dist = p => { const dx = (p.lng - center.lng) * cosLat; const dy = p.lat - center.lat; return dx * dx + dy * dy; };
    visible.sort((a, b) => dist(a) - dist(b));
    $("inview").textContent = `${visible.length.toLocaleString()} we can watch in view`;
    list.innerHTML = visible.slice(0, LIST_LIMIT).map(p => `<li><button type="button" data-i="${p.i}">${esc(p.name)}<small>${esc(p.area)} · ${esc(SYSTEMS[p.s])}</small></button></li>`).join("")
      + (visible.length > LIST_LIMIT ? `<li class="more">Zoom in to see the other ${(visible.length - LIST_LIMIT).toLocaleString()}.</li>` : "");
  }

  if (!$("layer-osm").checked) $("osm-hint").textContent = "OpenStreetMap · hidden";
  else if (zoom < 14) $("osm-hint").textContent = "OpenStreetMap · zoom in close to see them";
  else {
    const seen = new Set(map.queryRenderedFeatures({ layers: ["osm-campsites"] }).map(f => `${f.properties.name}|${f.geometry.coordinates}`));
    $("osm-hint").textContent = `OpenStreetMap · ${seen.size.toLocaleString()} in view`;
  }
}

// The phone sheet: tap the handle to open or close it, or drag it; a flick decides by its speed.
function setSheet(open) {
  $("map-side").classList.toggle("open", open);
  $("sheet-handle").setAttribute("aria-expanded", String(open));
  if (open) spinning = false;
  else closeDetail();
}

function wireSheet() {
  const sheet = $("map-side");
  const handle = $("sheet-handle");
  const setPeek = () => sheet.style.setProperty("--peek", `${sheet.querySelector(".map-search").offsetHeight + handle.offsetHeight + 2}px`);
  setPeek();
  new ResizeObserver(setPeek).observe(handle);
  const rubber = (over, size) => (over * size * 0.55) / (size + 0.55 * Math.abs(over));
  let drag = null;
  let swallowClick = false;
  handle.addEventListener("pointerdown", event => {
    if (!phone.matches || drag) return; // ignore a second finger
    const closed = sheet.offsetHeight - peekHeight(sheet);
    drag = { id: event.pointerId, y0: event.clientY, from: sheet.classList.contains("open") ? 0 : closed, closed, moved: false,
             history: [[event.timeStamp, event.clientY]] };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dy = event.clientY - drag.y0;
    if (!drag.moved && Math.abs(dy) < 8) return; // a tap stays a tap
    if (!drag.moved) { drag.moved = true; sheet.classList.add("dragging"); spinning = false; }
    let y = drag.from + dy;
    if (y < 0) y = -rubber(-y, sheet.offsetHeight);
    else if (y > drag.closed) y = drag.closed + rubber(y - drag.closed, sheet.offsetHeight);
    sheet.style.transform = `translateY(${y}px)`;
    drag.history = [...drag.history.slice(-4), [event.timeStamp, event.clientY]];
  });
  const endDrag = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const done = drag;
    drag = null;
    if (!done.moved) return;
    swallowClick = true;
    const [t0, y0] = done.history[0];
    const [t1, y1] = done.history.at(-1);
    const speed = (y1 - y0) / Math.max(16, t1 - t0); // px per ms; negative is upward
    sheet.classList.remove("dragging");
    sheet.style.transform = ""; // the transition carries on from where the finger let go
    setSheet(Math.abs(speed) > 0.11 ? speed < 0 : done.from + event.clientY - done.y0 < done.closed / 2);
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("click", () => {
    if (swallowClick) { swallowClick = false; return; }
    if (phone.matches) setSheet(!sheet.classList.contains("open"));
  });
  sheet.addEventListener("pointerdown", () => { spinning = false; });
  // Searching on a phone opens the sheet, so the results have room above the keyboard.
  $("map-q").addEventListener("focus", () => { if (phone.matches) setSheet(true); });
  // The desktop panel rises in once, not on every visit to the Map tab.
  sheet.addEventListener("animationend", () => { sheet.style.animation = "none"; }, { once: true });
}

function wireUi() {
  wireSheet();
  $("map-list").addEventListener("click", event => {
    const button = event.target.closest("button[data-i], button[data-system]");
    if (!button) return;
    spinning = false;
    if (button.dataset.i) return showPlace(places[button.dataset.i], true);
    if (phone.matches) setSheet(false); // show the region, not the list
    const own = places.filter(p => p.s === button.dataset.system);
    if (own.length === 1) return move({ center: [own[0].lng, own[0].lat], zoom: 11 });
    const lngs = own.map(p => p.lng), lats = own.map(p => p.lat);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
                  { padding: Object.assign({ top: 60, bottom: 60, left: 60, right: 60 }, cameraPadding() || {}),
                    maxZoom: 8, duration: hooks.reduceMotion ? 0 : 1400 });
  });
  $("layer-watch").addEventListener("change", event => {
    for (const id of ["watch-glow", "watch-clusters", "watch-count", "watch-points", "watch-labels"]) map.setLayoutProperty(id, "visibility", event.target.checked ? "visible" : "none");
  });
  $("layer-osm").addEventListener("change", event => { map.setLayoutProperty("osm-campsites", "visibility", event.target.checked ? "visible" : "none"); updateList(); });
  $("layer-night").addEventListener("change", event => {
    for (const id of ["night-fill", "night-edge"]) map.setLayoutProperty(id, "visibility", event.target.checked ? "visible" : "none");
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
    if (phone.matches) setSheet(false); // a place: show the map there
    const [w, s, e, n] = (button.dataset.extent || "").split(",").map(Number);
    if (button.dataset.extent && [w, s, e, n].every(Number.isFinite)) {
      map.fitBounds([[w, s], [e, n]], { padding: Object.assign({ top: 60, bottom: 60, left: 60, right: 60 }, cameraPadding() || {}),
                                        maxZoom: 12, duration: hooks.reduceMotion ? 0 : 1600 });
    } else {
      move({ center: button.dataset.center.split(",").map(Number), zoom: 10 });
    }
  });

  // Campgrounds we can watch show at once; places from Photon join below them when (and if) it answers,
  // so nothing moves under a finger that's about to tap.
  async function runSearch(q, mine) {
    const needle = q.toLowerCase();
    const local = places.filter(p => p.name.toLowerCase().includes(needle)).slice(0, 6);
    const campItems = local.map(p => `<li><button type="button" data-i="${p.i}">${esc(p.name)}<small>${esc(p.area)} · ${esc(SYSTEMS[p.s])}</small></button></li>`).join("");
    const render = (placeItems, searching) => {
      if (mine !== seq) return;
      results.innerHTML = (campItems ? `<li class="group">Campgrounds we can watch</li>${campItems}` : "")
        + (placeItems ? `<li class="group">Places</li>${placeItems}` : searching ? `<li class="group">Searching places…</li>` : "")
        || `<li class="group">No matches</li>`;
    };
    render("", q.length >= 3);
    if (q.length < 3) return;
    let found = [];
    try {
      const params = new URLSearchParams({ q, limit: "6", lang: "en" });
      found = (await (await fetch(`${PHOTON}?${params}`, { signal: AbortSignal.timeout?.(5000) })).json()).features || [];
    } catch (error) { /* places search unavailable or too slow */ }
    render(found.map(f => {
      const p = f.properties || {};
      const where = [p.state, p.country].filter(Boolean).join(", ");
      const extent = p.extent ? `${p.extent[0]},${p.extent[3]},${p.extent[2]},${p.extent[1]}` : "";
      return `<li><button type="button" data-center="${f.geometry.coordinates.join(",")}" data-extent="${extent}">${esc(p.name || p.street || q)}<small>${esc(where || p.osm_value || "")}</small></button></li>`;
    }).join(""), false);
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

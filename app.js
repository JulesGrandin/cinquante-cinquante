const fmt = new Intl.NumberFormat("fr-FR");
const fmt1 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const els = {
  commune: document.querySelector("#stat-commune"),
  dep: document.querySelector("#stat-dep"),
  pop: document.querySelector("#stat-pop"),
  share: document.querySelector("#stat-share"),
  count: document.querySelector("#stat-count"),
  area: document.querySelector("#stat-area"),
  refName: document.querySelector("#ref-name"),
  refPop: document.querySelector("#ref-pop"),
  refShare: document.querySelector("#ref-share"),
  refCount: document.querySelector("#ref-count"),
  refArea: document.querySelector("#ref-area"),
  status: document.querySelector("#status"),
  query: document.querySelector("#query"),
  results: document.querySelector("#results"),
  tip: document.querySelector("#tip"),
  presets: document.querySelector("#presets"),
  cities: document.querySelector("#cities"),
  departments: document.querySelector("#departments"),
  seedHandle: document.querySelector("#seed-handle"),
};

let seedDrag = null;
let dragRecalcRaf = 0;
let dragRecalcLngLat = null;

const PRESET_DEFS = [
  { id: "paris", label: "Paris", code: "75056" },
  { id: "bretagne", label: "Bretagne", deps: ["22", "29", "35", "56"] },
  { id: "corse", label: "Corse", deps: ["2A", "2B"] },
  { id: "lozere", label: "Lozère", deps: ["48"] },
  { id: "idf", label: "Île-de-France", deps: ["75", "77", "78", "91", "92", "93", "94", "95"] },
  { id: "med", label: "Méditerranée", coast: "med" },
  { id: "atl", label: "Atlantique", coast: "atl" },
  { id: "half", label: "Moitié du pays", half: true },
];

const MAJOR_CITY_CODES = new Set(["75056", "13055", "69123"]);

const CITY_CODES = [
  "75056", "13055", "69123", "31555", "06088",
  "44109", "34172", "67482", "33063", "59350",
  "35238", "51454", "42218", "76351",
  "29019", "21231", "87085", "45234", "54395",
];

let presets = [];
let activeId = "idf";
let lastSeed = null;
let cityMarkers = [];

proj4.defs(
  "EPSG:2154",
  "+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
);

const MAP_R = 6378137;
const MAP_M_PER_DEG = MAP_R * Math.PI / 180;

// Lambert-93 metres, encoded so Web Mercator draws them without a second stretch.
function lonLatToMap(lon, lat) {
  const [x, y] = proj4("EPSG:4326", "EPSG:2154", [lon, lat]);
  const lng = (x - 700000) / MAP_M_PER_DEG;
  const merc = (y - 6600000) / MAP_R;
  return [lng, (2 * Math.atan(Math.exp(merc)) - Math.PI / 2) * 180 / Math.PI];
}

const FRANCE_BOUNDS = [[-5.4, -4.97], [4.88, 4.59]];

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {},
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#e6dfd4" } },
    ],
  },
  bounds: FRANCE_BOUNDS,
  fitBoundsOptions: { padding: 28 },
  attributionControl: false,
  maxZoom: 13,
  minZoom: 0,
});

function frameFrance() {
  const box = map.getContainer();
  const size = `${box.clientWidth}x${box.clientHeight}`;
  if (size === frameFrance.size) return false;
  frameFrance.size = size;
  map.resize();
  map.fitBounds(FRANCE_BOUNDS, { padding: 24, duration: 0 });
  paintZones();
  if (!seedDrag) placeSeedHandle();
  return true;
}

new ResizeObserver(() => frameFrance()).observe(map.getContainer());

map.addControl(new maplibregl.AttributionControl({
  customAttribution: "Lambert-93 · IGN Admin Express COG 2026 · Insee, populations municipales 2023",
}), "bottom-right");
map.scrollZoom.disable();
map.boxZoom.disable();
map.doubleClickZoom.disable();
map.touchZoomRotate.disable();
map.dragPan.disable();
map.dragRotate.disable();
map.keyboard.disable();

let index = null;
let coasts = null;
let features = null;
let normNames = null;
let current = [];

function fold(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function placeLabel(i) {
  const dep = index.depNames[index.dep[i]] || index.dep[i];
  return `${index.names[i]} · ${dep}`;
}

function activePreset() {
  return presets.find((preset) => preset.id === activeId);
}

function updateReferenceStats() {
  if (!index) return;
  const preset = activePreset();
  if (!preset) return;
  els.refName.textContent = preset.label;
  els.refPop.textContent = fmt.format(preset.pop);
  els.refShare.textContent = `${fmt1.format((100 * preset.pop) / index.total)} %`;
  if (preset.half) {
    els.refCount.textContent = "—";
    els.refArea.textContent = "—";
  } else {
    els.refCount.textContent = fmt.format(preset.ids.length);
    els.refArea.textContent = `${fmt.format(Math.round(preset.area / 100))} km²`;
  }
}

function renderPresets() {
  els.presets.innerHTML = "";
  for (const item of presets) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.setAttribute("aria-pressed", item.id === activeId ? "true" : "false");
    button.addEventListener("click", () => selectPreset(item.id));
    els.presets.appendChild(button);
  }
  updateReferenceStats();
}

function selectPreset(id) {
  activeId = id;
  renderPresets();
  if (lastSeed !== null) show(lastSeed, { animate: false });
  else paintZones();
}

function preparePresets() {
  presets = PRESET_DEFS.map((def) => {
    if (def.half) return { ...def, pop: index.target, area: null, ids: [] };
    const deps = def.deps ? new Set(def.deps) : null;
    const coastCodes = def.coast ? new Set(coasts[def.coast]) : null;
    let pop = 0;
    let area = 0;
    const ids = [];
    for (let i = 0; i < index.pop.length; i++) {
      const inside = def.code
        ? index.codes[i] === def.code
        : coastCodes
          ? coastCodes.has(index.codes[i])
          : deps.has(index.dep[i]);
      if (!inside) continue;
      pop += index.pop[i];
      area += index.area[i];
      ids.push(i);
    }
    return { ...def, pop, area, ids };
  });
  renderPresets();
}

function grow(seed, target, blocked) {
  const { pop, cx, cy, nb } = index;
  const n = pop.length;
  const selected = new Set();
  const chosen = [];
  let total = 0;
  const seen = new Uint8Array(n);
  const heap = [];

  function push(i) {
    if (seen[i] || blocked.has(i)) return;
    seen[i] = 1;
    const dx = cx[i] - cx[seed];
    const dy = cy[i] - cy[seed];
    heapPush(heap, [dx * dx + dy * dy, i]);
  }

  function nearestOutside() {
    let best = null;
    let bestKey = null;
    for (let i = 0; i < n; i++) {
      if (selected.has(i) || blocked.has(i)) continue;
      const dx = cx[i] - cx[seed];
      const dy = cy[i] - cy[seed];
      const key = dx * dx + dy * dy;
      if (bestKey === null || key < bestKey || (key === bestKey && i < best)) {
        bestKey = key;
        best = i;
      }
    }
    return best;
  }

  if (!blocked.has(seed)) {
    selected.add(seed);
    chosen.push(seed);
    total = pop[seed];
    seen[seed] = 1;
    for (const j of nb[seed]) push(j);
  }

  while (total < target && chosen.length < n) {
    let best = null;
    while (heap.length) {
      const item = heapPop(heap);
      if (!selected.has(item[1]) && !blocked.has(item[1])) {
        best = item[1];
        break;
      }
    }
    if (best === null) {
      best = nearestOutside();
      if (best === null) break;
      seen[best] = 1;
    }
    selected.add(best);
    chosen.push(best);
    total += pop[best];
    for (const j of nb[best]) push(j);
  }
  return chosen;
}

function attachIslandsInDisk(seed, chosen, blocked) {
  const { cx, cy, nb } = index;
  const selected = new Set(chosen);
  const dist2 = (id) => {
    const dx = cx[id] - cx[seed];
    const dy = cy[id] - cy[seed];
    return dx * dx + dy * dy;
  };
  let maxD2 = 0;
  for (const id of chosen) maxD2 = Math.max(maxD2, dist2(id));

  const islands = [];
  for (let i = 0; i < cx.length; i++) {
    if (selected.has(i) || blocked.has(i)) continue;
    if (dist2(i) > maxD2) continue;
    let touches = false;
    for (const j of nb[i]) {
      if (selected.has(j)) {
        touches = true;
        break;
      }
    }
    if (!touches) islands.push(i);
  }
  if (!islands.length) return chosen;

  islands.sort((a, b) => dist2(a) - dist2(b) || a - b);
  const out = chosen.slice();
  for (const id of islands) {
    const d2 = dist2(id);
    let pos = out.length;
    for (let k = 0; k < out.length; k++) {
      if (dist2(out[k]) > d2) {
        pos = k;
        break;
      }
    }
    out.splice(pos, 0, id);
    selected.add(id);
  }
  return out;
}

function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p][0] < item[0] || (heap[p][0] === item[0] && heap[p][1] <= item[1])) break;
    heap[i] = heap[p];
    i = p;
  }
  heap[i] = item;
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    let i = 0;
    while (true) {
      let c = i * 2 + 1;
      if (c >= heap.length) break;
      const r = c + 1;
      if (r < heap.length && (heap[r][0] < heap[c][0] || (heap[r][0] === heap[c][0] && heap[r][1] < heap[c][1]))) {
        c = r;
      }
      if (last[0] < heap[c][0] || (last[0] === heap[c][0] && last[1] <= heap[c][1])) break;
      heap[i] = heap[c];
      i = c;
    }
    heap[i] = last;
  }
  return top;
}

const ZONE_ANIM_MS = 500;

let zoneAnimToken = 0;

function cancelZoneAnim() {
  zoneAnimToken += 1;
}

function updateEquivalentTitle(seed) {
  els.commune.textContent = index.names[seed];
  const dep = index.depNames[index.dep[seed]] || index.dep[seed];
  els.dep.textContent = dep;
}

function updateStats(seed, population, area, count) {
  const share = (100 * population) / index.total;
  updateEquivalentTitle(seed);
  els.pop.textContent = fmt.format(population);
  els.share.textContent = `${fmt1.format(share)} %`;
  els.count.textContent = count ? fmt.format(count) : "—";
  els.area.textContent = count ? `${fmt.format(Math.round(area / 100))} km²` : "—";
}

function communeMapCoord(i) {
  const [wgsLon, wgsLat] = proj4("EPSG:2154", "EPSG:4326", [index.cx[i], index.cy[i]]);
  return lonLatToMap(wgsLon, wgsLat);
}

function mapPointFromClient(clientX, clientY) {
  const rect = map.getCanvas().getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function placeSeedHandleAt(x, y) {
  const handle = els.seedHandle;
  if (!handle) return;
  handle.style.left = `${x}px`;
  handle.style.top = `${y}px`;
}

function placeSeedHandle() {
  const handle = els.seedHandle;
  if (!handle || lastSeed === null || !index) {
    if (handle) handle.hidden = true;
    return;
  }
  handle.hidden = false;
  const point = map.project(communeMapCoord(lastSeed));
  placeSeedHandleAt(point.x, point.y);
}

function queueDragRecalc(lngLat) {
  dragRecalcLngLat = lngLat;
  if (dragRecalcRaf) return;
  dragRecalcRaf = requestAnimationFrame(() => {
    dragRecalcRaf = 0;
    if (!dragRecalcLngLat) return;
    const id = communeAt(dragRecalcLngLat);
    if (id === null || id === lastSeed) return;
    show(id, { animate: false });
  });
}

function bindSeedHandle() {
  const handle = els.seedHandle;
  if (!handle) return;

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    seedDrag = { pointerId: event.pointerId };
    handle.classList.add("is-dragging");
  });

  handle.addEventListener("pointermove", (event) => {
    if (!seedDrag || seedDrag.pointerId !== event.pointerId) return;
    const point = mapPointFromClient(event.clientX, event.clientY);
    const lngLat = map.unproject([point.x, point.y]);
    const id = communeAt(lngLat);
    if (id === null) return;
    placeSeedHandleAt(point.x, point.y);
    queueDragRecalc(lngLat);
  });

  const endDrag = (event) => {
    if (!seedDrag || seedDrag.pointerId !== event.pointerId) return;
    seedDrag = null;
    handle.classList.remove("is-dragging");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    placeSeedHandle();
  };

  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

function show(seed, { animate = true } = {}) {
  cancelZoneAnim();
  lastSeed = seed;
  els.tip.hidden = true;
  if (!seedDrag) placeSeedHandle();

  const blocked = new Set(activePreset().ids || []);
  const ids = attachIslandsInDisk(seed, grow(seed, activePreset().pop, blocked), blocked);
  current = ids;

  const cumPop = new Float64Array(ids.length);
  const cumArea = new Float64Array(ids.length);
  let population = 0;
  let area = 0;
  for (let i = 0; i < ids.length; i++) {
    population += index.pop[ids[i]];
    area += index.area[ids[i]];
    cumPop[i] = population;
    cumArea[i] = area;
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reducedMotion || ids.length <= 1) {
    paintZones();
    updateStats(seed, population, area, ids.length);
    return;
  }

  const token = zoneAnimToken;
  updateStats(seed, 0, 0, 0);
  paintZones(0);

  const start = performance.now();
  const step = (now) => {
    if (token !== zoneAnimToken) return;
    const t = Math.min(1, (now - start) / ZONE_ANIM_MS);
    const eased = 1 - (1 - t) ** 3;
    let count = Math.floor(eased * ids.length);
    if (t >= 1) count = ids.length;
    else if (count < 1 && ids.length) count = 1;

    paintZones(count);
    if (count > 0) {
      updateStats(seed, cumPop[count - 1], cumArea[count - 1], count);
    } else {
      updateStats(seed, 0, 0, 0);
    }

    if (count < ids.length) requestAnimationFrame(step);
    else {
      updateStats(seed, population, area, ids.length);
      if (!seedDrag) placeSeedHandle();
    }
  };
  requestAnimationFrame(step);
}

function placeCities() {
  const byCode = new Map();
  for (let i = 0; i < index.codes.length; i++) byCode.set(index.codes[i], i);
  for (const code of CITY_CODES) {
    const i = byCode.get(code);
    const el = document.createElement("div");
    el.className = MAJOR_CITY_CODES.has(code) ? "city-label major" : "city-label";
    const dot = document.createElement("i");
    const name = document.createElement("span");
    name.textContent = index.names[i];
    el.append(dot, name);
    const marker = new maplibregl.Marker({ element: el, anchor: "left" })
      .setLngLat(lonLatToMap(index.lon[i], index.lat[i]))
      .addTo(map);
    cityMarkers.push(marker);
  }
  setCitiesVisible(els.cities.checked);
}

function setCitiesVisible(on) {
  for (const marker of cityMarkers) marker.getElement().hidden = !on;
}

function setDepartmentsVisible(on) {
  if (!map.getLayer("departements-line")) return;
  map.setLayoutProperty("departements-line", "visibility", on ? "visible" : "none");
}

const HIT_CELL = 0.08;
const hitGrid = new Map();

function eachRing(geometry, fn) {
  const coords = geometry.coordinates;
  if (geometry.type === "Polygon") {
    for (const ring of coords) fn(ring);
  } else if (geometry.type === "MultiPolygon") {
    for (const polygon of coords) for (const ring of polygon) fn(ring);
  }
}

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function geometryContains(geometry, x, y) {
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates;
    if (!ringContains(rings[0], x, y)) return false;
    for (let h = 1; h < rings.length; h++) if (ringContains(rings[h], x, y)) return false;
    return true;
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((rings) => {
      if (!ringContains(rings[0], x, y)) return false;
      for (let h = 1; h < rings.length; h++) if (ringContains(rings[h], x, y)) return false;
      return true;
    });
  }
  return false;
}

function buildHitGrid() {
  hitGrid.clear();
  for (let i = 0; i < features.length; i++) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    eachRing(features[i].geometry, (ring) => {
      for (const point of ring) {
        if (point[0] < minX) minX = point[0];
        if (point[1] < minY) minY = point[1];
        if (point[0] > maxX) maxX = point[0];
        if (point[1] > maxY) maxY = point[1];
      }
    });
    const x0 = Math.floor(minX / HIT_CELL);
    const x1 = Math.floor(maxX / HIT_CELL);
    const y0 = Math.floor(minY / HIT_CELL);
    const y1 = Math.floor(maxY / HIT_CELL);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        const cell = hitGrid.get(key);
        if (cell) cell.push(i);
        else hitGrid.set(key, [i]);
      }
    }
  }
}

function mercUnit(lat) {
  const s = Math.sin(lat * Math.PI / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

// One path per commune, in Web Mercator units. Drawing these into a canvas
// keeps a large zone (half the country) from rebuilding thousands of map tiles.
let zonePaths = null;
const zoneCanvas = document.createElement("canvas");
const zoneCtx = zoneCanvas.getContext("2d", { alpha: true });
let zoneLive = false;

function buildZonePaths() {
  const n = features.length;
  zonePaths = new Array(n);
  for (let i = 0; i < n; i++) {
    const geometry = features[i].geometry;
    const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const path = new Path2D();
    for (const rings of polys) {
      for (const ring of rings) {
        if (ring.length < 3) continue;
        path.moveTo((ring[0][0] + 180) / 360, mercUnit(ring[0][1]));
        for (let k = 1; k < ring.length; k++) path.lineTo((ring[k][0] + 180) / 360, mercUnit(ring[k][1]));
        path.closePath();
      }
    }
    zonePaths[i] = path;
  }
}

function zoneCorners() {
  const w = map.transform.width;
  const h = map.transform.height;
  return [
    map.unproject([0, 0]).toArray(),
    map.unproject([w, 0]).toArray(),
    map.unproject([w, h]).toArray(),
    map.unproject([0, h]).toArray(),
  ];
}

function paintZones(redCount = null) {
  if (!zonePaths || !map.getSource("zone")) return;
  const cssW = map.transform.width;
  const cssH = map.transform.height;
  if (!cssW || !cssH) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  if (zoneCanvas.width !== pxW || zoneCanvas.height !== pxH) {
    zoneCanvas.width = pxW;
    zoneCanvas.height = pxH;
  }
  const world = map.transform.worldSize;
  const center = map.getCenter();
  const sx = (center.lng + 180) / 360 * world;
  const sy = mercUnit(center.lat) * world;
  const ctx = zoneCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pxW, pxH);
  ctx.setTransform(world * dpr, 0, 0, world * dpr, (-sx + cssW / 2) * dpr, (-sy + cssH / 2) * dpr);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 1.25 / world;
  const draw = (ids, color, limit = ids.length) => {
    if (!ids || !ids.length || limit <= 0) return;
    const n = Math.min(limit, ids.length);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    for (let i = 0; i < n; i++) {
      const path = zonePaths[ids[i]];
      ctx.stroke(path);
      ctx.fill(path, "evenodd");
    }
  };
  const redLimit = redCount == null ? current.length : redCount;
  draw(current, "#c23b33", redLimit);
  const preset = activePreset();
  if (preset) draw(preset.ids, "#3a7ab8");
  const source = map.getSource("zone");
  source.setCoordinates(zoneCorners());
  source.play();
  if (!zoneLive) {
    zoneLive = true;
    map.once("render", () => {
      zoneLive = false;
      const live = map.getSource("zone");
      if (live) live.pause();
    });
  }
}

function communeAt(lngLat) {
  if (!lngLat || !hitGrid.size) return null;
  const cell = hitGrid.get(`${Math.floor(lngLat.lng / HIT_CELL)},${Math.floor(lngLat.lat / HIT_CELL)}`);
  if (!cell) return null;
  for (let k = cell.length - 1; k >= 0; k--) {
    const i = cell[k];
    if (geometryContains(features[i].geometry, lngLat.lng, lngLat.lat)) return features[i].id ?? i;
  }
  return null;
}

function paintMap(geojson, departements, france) {
  features = geojson.features;
  map.addSource("france", { type: "geojson", data: france });
  map.addLayer({
    id: "france-fill",
    type: "fill",
    source: "france",
    paint: { "fill-color": "#f7f3ec", "fill-opacity": 1, "fill-antialias": false },
  });
  map.addSource("communes", { type: "geojson", data: geojson });
  buildHitGrid();
  buildZonePaths();
  zoneCanvas.width = Math.max(1, Math.round(map.transform.width || 2));
  zoneCanvas.height = Math.max(1, Math.round(map.transform.height || 2));
  map.addSource("zone", {
    type: "canvas",
    canvas: zoneCanvas,
    coordinates: zoneCorners(),
    animate: false,
  });
  map.addLayer({
    id: "zone",
    type: "raster",
    source: "zone",
    paint: { "raster-opacity": 1, "raster-fade-duration": 0 },
  });
  map.addSource("departements", { type: "geojson", data: departements });
  map.addLayer({
    id: "departements-line",
    type: "line",
    source: "departements",
    layout: {
      visibility: els.departments.checked ? "visible" : "none",
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": "#c4baaf",
      "line-width": 0.7,
    },
  });
  map.addLayer({
    id: "hover-fill",
    type: "fill",
    source: "communes",
    paint: {
      "fill-color": "#000000",
      "fill-opacity": [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        1,
        0,
      ],
      "fill-antialias": false,
    },
  });

  bindSeedHandle();

  map.on("click", (event) => {
    const id = communeAt(event.lngLat);
    if (id === null) return;
    els.tip.hidden = true;
    show(id);
  });

  let hoveredId = null;
  const paintHover = (id) => {
    if (hoveredId === id) return;
    if (hoveredId !== null) map.setFeatureState({ source: "communes", id: hoveredId }, { hover: false });
    hoveredId = id;
    if (hoveredId !== null) map.setFeatureState({ source: "communes", id: hoveredId }, { hover: true });
  };

  map.on("mousemove", (event) => {
    const i = communeAt(event.lngLat);
    if (i === null) {
      paintHover(null);
      map.getCanvas().style.cursor = "";
      els.tip.hidden = true;
      return;
    }
    map.getCanvas().style.cursor = "pointer";
    paintHover(i);
    els.tip.hidden = false;
    const rect = map.getCanvas().getBoundingClientRect();
    els.tip.style.left = `${rect.left + event.point.x}px`;
    els.tip.style.top = `${rect.top + event.point.y}px`;
    els.tip.textContent = `${placeLabel(i)} · ${fmt.format(index.pop[i])} hab.`;
  });

  map.on("mouseout", () => {
    paintHover(null);
    els.tip.hidden = true;
  });
}

els.cities.addEventListener("change", () => setCitiesVisible(els.cities.checked));
els.departments.addEventListener("change", () => setDepartmentsVisible(els.departments.checked));

els.query.addEventListener("input", () => {
  const q = fold(els.query.value.trim());
  els.results.innerHTML = "";
  if (q.length < 2 || !normNames) {
    els.results.hidden = true;
    return;
  }
  const exact = [];
  const starts = [];
  const contains = [];
  for (let i = 0; i < normNames.length; i++) {
    const name = normNames[i];
    if (name === q) exact.push(i);
    else if (name.startsWith(q)) starts.push(i);
    else if (name.includes(q)) contains.push(i);
  }
  const hits = exact.concat(starts, contains).slice(0, 8);
  if (!hits.length) {
    els.results.hidden = true;
    return;
  }
  for (const i of hits) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = placeLabel(i);
    button.addEventListener("click", () => {
      els.query.value = index.names[i];
      els.results.hidden = true;
      show(i);
    });
    li.appendChild(button);
    els.results.appendChild(li);
  }
  els.results.hidden = false;
});

map.on("load", async () => {
  try {
    const [indexRes, geoRes, coastRes, depRes, franceRes] = await Promise.all([
      fetch("data/index.json"),
      fetch("data/communes.geojson?v=l93"),
      fetch("data/coasts.json"),
      fetch("data/departements.geojson?v=ne10m"),
      fetch("data/france.geojson?v=silhouette"),
    ]);
    if (!indexRes.ok || !geoRes.ok || !coastRes.ok || !depRes.ok || !franceRes.ok) throw new Error("fichiers de données introuvables");
    index = await indexRes.json();
    coasts = await coastRes.json();
    const geojson = await geoRes.json();
    const departements = await depRes.json();
    const france = await franceRes.json();
    normNames = index.names.map(fold);
    preparePresets();
    paintMap(geojson, departements, france);
    placeCities();
    if (!frameFrance()) paintZones();
    els.status.textContent = "";
  } catch (error) {
    els.status.textContent = `Impossible de charger les données (${error.message}).`;
  }
});

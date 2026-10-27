import {
  OVERPASS_MIRRORS, waterwayQuery, obstacleQuery, paddedBBox, bboxContains,
  buildGraph, snap, routeVia, parseObstacles, findObstaclesOnRoute, toGPX, typeLabel,
} from "./route.js";

const MAX_SPAN_DEG = 0.5; // ~50 km; keeps Overpass responses small
const SNAP_MAX_M = 300;

const $ = (id) => document.getElementById(id);
const map = L.map("map", { zoomControl: true }).setView([30.25, 120.15], 11);

const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: "© OpenStreetMap contributors",
});
const sat = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Esri World Imagery" }
);
let satOn = false;
osm.addTo(map);
$("bLayer").onclick = () => {
  satOn = !satOn;
  (satOn ? sat : osm).addTo(map);
  map.removeLayer(satOn ? osm : sat);
  $("bLayer").textContent = satOn ? "地图" : "卫星图";
};

// ---- state ------------------------------------------------------------
const state = {
  start: null, end: null, vias: [], mode: null,
  graph: null, graphBBox: null,
  route: null, obstacles: [], token: 0,
};
const markerLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const obsLayer = L.layerGroup().addTo(map);

function setStatus(text, isErr = false) {
  $("status").textContent = text;
  $("status").className = isErr ? "err" : "";
}

function setMode(mode) {
  state.mode = mode;
  for (const [id, m] of [["bStart", "start"], ["bEnd", "end"], ["bVia", "via"]]) {
    $(id).classList.toggle("active", mode === m);
  }
  if (mode) setStatus({ start: "在河道上点一下设置起点", end: "在河道上点一下设置终点", via: "在河道上点一下添加途经点" }[mode]);
}
$("bStart").onclick = () => setMode(state.mode === "start" ? null : "start");
$("bEnd").onclick = () => setMode(state.mode === "end" ? null : "end");
$("bVia").onclick = () => setMode(state.mode === "via" ? null : "via");

$("bClear").onclick = () => {
  state.token++;
  Object.assign(state, { start: null, end: null, vias: [], route: null, obstacles: [] });
  markerLayer.clearLayers(); routeLayer.clearLayers(); obsLayer.clearLayers();
  $("summary").hidden = true; $("obs").replaceChildren(); $("bGpx").disabled = true;
  setMode(null);
  setStatus("已清除。点“起点”重新开始。");
};

// ---- map interaction ----------------------------------------------------
function pin(latlng, cls, text) {
  return L.marker(latlng, { icon: L.divIcon({ className: "", html: `<div class="pin ${cls}">${text}</div>`, iconSize: [0, 0] }) });
}

function redrawMarkers() {
  markerLayer.clearLayers();
  if (state.start) pin(state.start, "start", "起").addTo(markerLayer);
  state.vias.forEach((v, i) => pin(v, "via", i + 1).addTo(markerLayer));
  if (state.end) pin(state.end, "end", "终").addTo(markerLayer);
}

map.on("click", (e) => {
  if (!state.mode) return;
  const ll = [e.latlng.lat, e.latlng.lng];
  if (state.mode === "start") { state.start = ll; setMode(state.end ? null : "end"); }
  else if (state.mode === "end") { state.end = ll; setMode(null); }
  else state.vias.push(ll);
  redrawMarkers();
  plan();
});

// ---- Overpass -----------------------------------------------------------
async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS_MIRRORS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).elements;
    } catch (err) {
      lastErr = err.name === "AbortError" ? new Error("请求超时") : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Overpass 服务不可用:" + (lastErr?.message || "未知错误"));
}

// ---- planning -----------------------------------------------------------
async function plan() {
  if (!state.start || !state.end) {
    setStatus(state.start ? "再设置终点。" : "先设置起点。");
    return;
  }
  const token = ++state.token;
  const pts = [state.start, ...state.vias, state.end];
  try {
    if (!state.graph || !bboxContains(state.graphBBox, pts)) {
      const bbox = paddedBBox(pts);
      if (bbox[2] - bbox[0] > MAX_SPAN_DEG || bbox[3] - bbox[1] > MAX_SPAN_DEG) {
        setStatus("起终点相距太远(超过约 50 km),请分段规划。", true);
        return;
      }
      setStatus("正在下载河道数据…");
      const elements = await overpass(waterwayQuery(bbox));
      if (token !== state.token) return;
      state.graph = buildGraph(elements.filter((e) => e.type === "way"));
      state.graphBBox = bbox;
    }

    const ids = [];
    for (const p of pts) {
      const s = snap(state.graph, p, SNAP_MAX_M);
      if (!s) {
        setStatus(`有标记点 ${SNAP_MAX_M} m 内没有 OSM 河道,请把点放在河道上,或换卫星图核对。`, true);
        return;
      }
      ids.push(s.id);
    }

    const r = routeVia(state.graph, ids);
    if (r.error) {
      setStatus(`第 ${r.leg + 1} 段未找到连通水道(OSM 数据可能断开),可添加途经点绕过断点。`, true);
      routeLayer.clearLayers(); obsLayer.clearLayers();
      $("summary").hidden = true; $("obs").replaceChildren(); $("bGpx").disabled = true;
      return;
    }
    state.route = r;
    routeLayer.clearLayers();
    const line = L.polyline(r.coords, { color: "#0b6fa4", weight: 5, opacity: 0.9 }).addTo(routeLayer);
    map.fitBounds(line.getBounds(), { padding: [30, 30] });
    renderSummary();
    $("bGpx").disabled = false;

    setStatus("正在查找坝/闸/桥…");
    const rb = paddedBBox(r.coords, 0.02, 0.002);
    let obstacles = [];
    try {
      obstacles = parseObstacles(await overpass(obstacleQuery(rb)));
    } catch (err) {
      setStatus("航线已生成,但障碍物数据获取失败:" + err.message, true);
    }
    if (token !== state.token) return;
    state.obstacles = findObstaclesOnRoute(r.coords, obstacles, 50);
    renderObstacles();
    if (!$("status").classList.contains("err")) setStatus("完成。点击地图上的标记或下方列表项可定位。");
  } catch (err) {
    if (token === state.token) setStatus(err.message, true);
  }
}

function renderSummary() {
  if (!state.route) return;
  const km = state.route.distance / 1000;
  const speed = Math.max(0.5, parseFloat($("speed").value) || 3.5);
  const hours = km / speed;
  const h = Math.floor(hours), m = Math.round((hours - h) * 60);
  $("dist").textContent = `${km.toFixed(1)} km`;
  $("time").textContent = `约 ${h ? h + " 小时 " : ""}${m} 分钟`;
  $("summary").hidden = false;
}
$("speed").oninput = renderSummary;

function renderObstacles() {
  obsLayer.clearLayers();
  const ul = $("obs");
  ul.replaceChildren();
  if (!state.obstacles.length) {
    const li = document.createElement("li");
    li.textContent = "航线上未发现 OSM 记录的坝/闸/桥(不代表没有,请对照卫星图)。";
    ul.append(li);
    return;
  }
  for (const o of state.obstacles) {
    const icon = o.kind === "portage" ? "⛔" : "🌉";
    L.marker(o.pos, { icon: L.divIcon({ className: "", html: `<div class="ob ${o.kind}">${o.kind === "portage" ? "!" : "桥"}</div>`, iconSize: [0, 0] }) })
      .bindPopup(`${typeLabel(o.type)} ${o.name}`).addTo(obsLayer);
    const li = document.createElement("li");
    li.className = o.kind;
    const b = document.createElement("b");
    b.textContent = `${icon} ${(o.at / 1000).toFixed(2)} km  ${typeLabel(o.type)}${o.name ? " " + o.name : ""}`;
    const note = document.createElement("div");
    note.textContent = o.kind === "portage" ? "需上岸绕行,请提前规划上下岸点" : "确认桥洞净空和水深";
    li.append(b, note);
    li.onclick = () => map.setView(o.pos, Math.max(map.getZoom(), 16));
    ul.append(li);
  }
}

// ---- GPX export ---------------------------------------------------------
$("bGpx").onclick = () => {
  if (!state.route) return;
  const name = `paddle-${new Date().toISOString().slice(0, 10)}`;
  const waypoints = [{ name: "起点", pos: state.start }, ...state.vias.map((v, i) => ({ name: `途经点${i + 1}`, pos: v })), { name: "终点", pos: state.end }];
  const gpx = toGPX({ name, coords: state.route.coords, obstacles: state.obstacles, waypoints });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" }));
  a.download = name + ".gpx";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---- place search (Nominatim) --------------------------------------------
$("search").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim();
  if (!q) return;
  setStatus("搜索中…");
  try {
    const res = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q));
    const [hit] = await res.json();
    if (!hit) { setStatus("没有找到该地点。", true); return; }
    const [s, n, w, ea] = hit.boundingbox.map(Number);
    map.fitBounds([[s, w], [n, ea]], { maxZoom: 14 });
    setStatus(`已定位:${hit.display_name}`);
  } catch (err) {
    setStatus("搜索失败:" + err.message, true);
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

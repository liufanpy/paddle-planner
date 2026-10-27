// Pure routing helpers (no DOM, no network) so they can be unit-tested in Node.
// Coordinates are [lat, lon] pairs in WGS84.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---- Overpass queries -------------------------------------------------

export const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

const bboxStr = ([s, w, n, e]) => `${s},${w},${n},${e}`;

export function waterwayQuery(bbox) {
  return `[out:json][timeout:30];way["waterway"~"^(river|stream|canal|ditch)$"](${bboxStr(bbox)});out geom;`;
}

export function obstacleQuery(bbox) {
  const b = bboxStr(bbox);
  return (
    `[out:json][timeout:30];(` +
    `node["waterway"~"^(weir|dam|lock_gate|waterfall)$"](${b});` +
    `way["waterway"~"^(weir|dam|lock_gate|waterfall)$"](${b});` +
    `way["man_made"="bridge"](${b});` +
    `way["bridge"]["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|track|path|footway|cycleway|pedestrian)$"](${b});` +
    `way["bridge"="yes"]["railway"](${b});` +
    `);out geom;`
  );
}

// Bounding box [s, w, n, e] covering all points, padded by a fraction of its size.
export function paddedBBox(points, padFrac = 0.3, minPadDeg = 0.02) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lon] of points) {
    s = Math.min(s, lat); n = Math.max(n, lat);
    w = Math.min(w, lon); e = Math.max(e, lon);
  }
  const padLat = Math.max((n - s) * padFrac, minPadDeg);
  const padLon = Math.max((e - w) * padFrac, minPadDeg);
  return [s - padLat, w - padLon, n + padLat, e + padLon];
}

export function bboxContains(outer, points) {
  return points.every(([lat, lon]) => lat >= outer[0] && lat <= outer[2] && lon >= outer[1] && lon <= outer[3]);
}

// ---- Graph ------------------------------------------------------------

// ways: Overpass `way` elements with `nodes` (ids) and `geometry` ([{lat, lon}]).
export function buildGraph(ways) {
  const nodes = new Map(); // id -> { lat, lon, edges: [[id, meters]] }
  const addNode = (id, lat, lon) => {
    if (!nodes.has(id)) nodes.set(id, { lat, lon, edges: [] });
  };
  for (const way of ways) {
    const ids = way.nodes;
    const geom = way.geometry;
    if (!ids || !geom || ids.length !== geom.length) continue;
    for (let i = 0; i < ids.length; i++) addNode(ids[i], geom[i].lat, geom[i].lon);
    for (let i = 0; i + 1 < ids.length; i++) {
      if (ids[i] === ids[i + 1]) continue;
      const a = nodes.get(ids[i]);
      const b = nodes.get(ids[i + 1]);
      const d = haversine([a.lat, a.lon], [b.lat, b.lon]);
      a.edges.push([ids[i + 1], d]);
      b.edges.push([ids[i], d]);
    }
  }
  return { nodes };
}

// Nearest graph node to latlng. Returns { id, dist } or null if farther than maxM.
export function snap(graph, latlng, maxM = 300) {
  let best = null;
  for (const [id, n] of graph.nodes) {
    // cheap reject before haversine
    if (Math.abs(n.lat - latlng[0]) > 0.01 || Math.abs(n.lon - latlng[1]) > 0.02) continue;
    const d = haversine(latlng, [n.lat, n.lon]);
    if (!best || d < best.dist) best = { id, dist: d };
  }
  return best && best.dist <= maxM ? best : null;
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// Dijkstra. Returns { ids, coords, distance } or null when not connected.
export function shortestPath(graph, from, to) {
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) return null;
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const heap = new MinHeap();
  heap.push([0, from]);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === to) break;
    for (const [v, w] of graph.nodes.get(u).edges) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        heap.push([nd, v]);
      }
    }
  }
  if (!dist.has(to)) return null;
  const ids = [to];
  while (ids[0] !== from) ids.unshift(prev.get(ids[0]));
  const coords = ids.map((id) => {
    const n = graph.nodes.get(id);
    return [n.lat, n.lon];
  });
  return { ids, coords, distance: dist.get(to) };
}

// Route through ordered node ids (start, vias..., end). Returns null if any leg fails.
export function routeVia(graph, nodeIds) {
  let coords = [];
  let distance = 0;
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    const leg = shortestPath(graph, nodeIds[i], nodeIds[i + 1]);
    if (!leg) return { error: "disconnected", leg: i };
    coords = coords.concat(i === 0 ? leg.coords : leg.coords.slice(1));
    distance += leg.distance;
  }
  return { coords, distance };
}

// ---- Obstacles --------------------------------------------------------

// Local planar projection (meters) around a reference latitude.
function project(p, refLat) {
  return [rad(p[1]) * R * Math.cos(rad(refLat)), rad(p[0]) * R];
}

// Distance from p to polyline `line`. Returns { dist, idx } (idx = nearest segment start).
export function nearestOnPolyline(p, line) {
  if (line.length === 1) return { dist: haversine(p, line[0]), idx: 0 };
  const P = project(p, p[0]);
  let best = { dist: Infinity, idx: 0 };
  for (let i = 0; i + 1 < line.length; i++) {
    const A = project(line[i], p[0]);
    const B = project(line[i + 1], p[0]);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(P[0] - (A[0] + t * dx), P[1] - (A[1] + t * dy));
    if (d < best.dist) best = { dist: d, idx: i };
  }
  return best;
}

const PORTAGE = new Set(["weir", "dam", "lock_gate", "waterfall"]);

// Convert Overpass elements into { kind, type, name, pts } obstacles.
export function parseObstacles(elements) {
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    let pts;
    if (el.type === "node") pts = [[el.lat, el.lon]];
    else if (el.geometry) pts = el.geometry.map((g) => [g.lat, g.lon]);
    else continue;
    if (!pts.length) continue;
    let type = tags.waterway;
    if (!PORTAGE.has(type)) type = "bridge";
    out.push({
      kind: PORTAGE.has(type) ? "portage" : "check",
      type,
      name: tags.name || tags["name:zh"] || "",
      pts,
    });
  }
  return out;
}

export function cumulativeDistances(route) {
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + haversine(route[i - 1], route[i]));
  return cum;
}

// Obstacles within thresholdM of the route, sorted by distance along it.
export function findObstaclesOnRoute(route, obstacles, thresholdM = 50) {
  if (route.length < 2) return [];
  const cum = cumulativeDistances(route);
  const hits = [];
  for (const ob of obstacles) {
    let best = Infinity;
    let at = 0;
    for (const pt of ob.pts) {
      const r = nearestOnPolyline(pt, route);
      if (r.dist < best) { best = r.dist; at = cum[r.idx]; }
    }
    if (ob.pts.length > 1) {
      for (let i = 0; i < route.length; i++) {
        const r = nearestOnPolyline(route[i], ob.pts);
        if (r.dist < best) { best = r.dist; at = cum[i]; }
      }
    }
    if (best <= thresholdM) {
      const mid = ob.pts[Math.floor(ob.pts.length / 2)];
      hits.push({ ...ob, at, offset: best, pos: mid });
    }
  }
  // Collapse duplicates (e.g. several bridge ways of one bridge) within 20 m along the route.
  hits.sort((a, b) => a.at - b.at);
  return hits.filter((h, i) => !(i > 0 && h.type === hits[i - 1].type && h.at - hits[i - 1].at < 20));
}

// ---- GPX --------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

const TYPE_LABEL = {
  weir: "堰", dam: "坝", lock_gate: "船闸/水闸", waterfall: "瀑布", bridge: "桥",
};
export const typeLabel = (t) => TYPE_LABEL[t] || t;

export function toGPX({ name, coords, obstacles = [], waypoints = [] }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="paddle-planner" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${esc(name)}</name></metadata>`,
  ];
  for (const w of waypoints) {
    lines.push(`<wpt lat="${w.pos[0].toFixed(6)}" lon="${w.pos[1].toFixed(6)}"><name>${esc(w.name)}</name></wpt>`);
  }
  for (const o of obstacles) {
    const label = typeLabel(o.type) + (o.name ? ` ${o.name}` : "");
    const desc = o.kind === "portage" ? "需上岸绕行" : "确认桥洞净空和水深";
    lines.push(
      `<wpt lat="${o.pos[0].toFixed(6)}" lon="${o.pos[1].toFixed(6)}"><name>${esc(label)}</name><desc>${esc(
        `${(o.at / 1000).toFixed(2)} km: ${desc}`
      )}</desc></wpt>`
    );
  }
  lines.push(`<trk><name>${esc(name)}</name><trkseg>`);
  for (const [lat, lon] of coords) lines.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`);
  lines.push("</trkseg></trk>", "</gpx>");
  return lines.join("\n");
}

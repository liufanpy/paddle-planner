import assert from "node:assert/strict";
import {
  buildGraph, snap, shortestPath, routeVia, parseObstacles,
  findObstaclesOnRoute, toGPX, paddedBBox, haversine,
} from "../route.js";

// Main river runs west->east along lat 30 (nodes 1..5, ~0.01 deg lon apart).
// A side channel (nodes 3 -> 10 -> 5) is a longer detour. Node 99 is an unconnected pond.
const g = (id, lat, lon) => ({ lat, lon });
const ways = [
  { nodes: [1, 2, 3, 4, 5], geometry: [30, 30.01, 30.02, 30.03, 30.04].map((x, i) => g(0, 30, 120 + i * 0.01)) },
  { nodes: [3, 10, 5], geometry: [g(0, 30, 120.02), g(0, 30.02, 120.03), g(0, 30, 120.04)] },
  { nodes: [98, 99], geometry: [g(0, 31, 121), g(0, 31, 121.01)] },
];
const graph = buildGraph(ways);

assert.equal(graph.nodes.size, 8);

// snap
assert.equal(snap(graph, [30.0001, 120.0101])?.id, 2);
assert.equal(snap(graph, [30.5, 120.0]), null, "far point must not snap");

// shortest path prefers the main river over the detour
const p = shortestPath(graph, 1, 5);
assert.deepEqual(p.ids, [1, 2, 3, 4, 5]);
const expected = haversine([30, 120], [30, 120.04]);
assert.ok(Math.abs(p.distance - expected) < 1, `distance ${p.distance} vs ${expected}`);

// disconnected
assert.equal(shortestPath(graph, 1, 99), null);
assert.equal(routeVia(graph, [1, 99]).error, "disconnected");

// via point forces the detour; legs are joined without duplicating the shared node
const via = routeVia(graph, [1, 10, 5]);
assert.ok(via.distance > p.distance);
assert.equal(via.coords.filter(([la, lo]) => la === 30.02 && lo === 120.03).length, 1);

// obstacles: a weir on the route, a bridge crossing it, and a far-away dam
const obstacles = parseObstacles([
  { type: "node", lat: 30, lon: 120.0201, tags: { waterway: "weir", name: "测试堰" } },
  { type: "way", tags: { bridge: "yes", highway: "primary" }, geometry: [{ lat: 30.001, lon: 120.0301 }, { lat: 29.999, lon: 120.0301 }] },
  { type: "node", lat: 30.5, lon: 120.5, tags: { waterway: "dam" } },
]);
const hits = findObstaclesOnRoute(p.coords, obstacles, 50);
assert.equal(hits.length, 2);
assert.deepEqual(hits.map((h) => h.type), ["weir", "bridge"]);
assert.equal(hits[0].kind, "portage");
assert.equal(hits[1].kind, "check");
assert.ok(hits[0].at < hits[1].at, "sorted along the route");

// GPX
const gpx = toGPX({ name: 'A & B "river"', coords: p.coords, obstacles: hits });
assert.ok(gpx.startsWith("<?xml"));
assert.ok(gpx.includes("A &amp; B &quot;river&quot;"));
assert.equal((gpx.match(/<trkpt /g) || []).length, 5);
assert.equal((gpx.match(/<wpt /g) || []).length, 2);

// bbox padding
const bb = paddedBBox([[30, 120], [30.1, 120.2]]);
assert.ok(bb[0] < 30 && bb[2] > 30.1 && bb[1] < 120 && bb[3] > 120.2);

console.log("all route tests passed");

import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeTerrain,
  sampleTerrain,
  MARS_RADIUS,
  gentleFraction,
  groundDistance,
  terrainProfile,
  findGentlePoint,
} from "../js/terrain-analysis.mjs";
const bounds = { west: 0, east: 0.01, south: -0.005, north: 0.005 };
const flat = analyzeTerrain(Array(25).fill(100), 5, 5, bounds);
test("flat terrain has zero slope and roughness, including boundaries", () => {
  assert.ok(Math.abs(flat.mean - 100) < 1e-10);
  assert.ok([...flat.slopes].every((v) => v === 0));
  assert.ok([...flat.roughness].every((v) => Math.abs(v) < 1e-10));
  assert.equal(gentleFraction(flat, 0), 1);
});
test("eastward plane recovers physical slope independently of rendering", () => {
  const step = (MARS_RADIUS * 0.01 * Math.PI) / 180 / 4;
  const plane = analyzeTerrain(
    Array.from(
      { length: 25 },
      (_, i) => (i % 5) * step * Math.tan((10 * Math.PI) / 180),
    ),
    5,
    5,
    bounds,
  );
  assert.ok(Math.abs(plane.slopes[12] - 10) < 0.0001);
  assert.ok(Math.max(...plane.roughness) < 1e-9);
  assert.equal(gentleFraction(plane, 9), 0);
});
test("roughness removes planar tilt and detects a local bump", () => {
  const heights = Array(25).fill(100);
  heights[12] = 150;
  const bump = analyzeTerrain(heights, 5, 5, bounds);
  assert.ok(bump.roughness[12] > 10);
  const gentle = findGentlePoint(bump);
  assert.ok(Number.isFinite(gentle.elevation));
});
test("north-up bilinear sampling preserves corners and interpolates center", () => {
  const model = analyzeTerrain(
    Array.from({ length: 9 }, (_, i) => i * 10),
    3,
    3,
    bounds,
  );
  assert.equal(sampleTerrain(model, 0, 0).latitude, bounds.north);
  assert.equal(sampleTerrain(model, 1, 1).latitude, bounds.south);
  assert.equal(sampleTerrain(model, 0.5, 0.5).elevation, 40);
  assert.equal(sampleTerrain(model, -1, 2).elevation, 60);
});
test("profile includes endpoints and integrates geographic distances", () => {
  const a = sampleTerrain(flat, 0, 0.5),
    b = sampleTerrain(flat, 1, 0.5);
  const profile = terrainProfile(flat, a, b);
  assert.equal(profile.points.length, 129);
  assert.ok(Math.abs(profile.distance - groundDistance(a, b)) < 0.00001);
  assert.equal(profile.gain, 0);
  assert.ok(profile.points.every((p) => p.elevation === 100));
});
test("invalid grids and bounds fail explicitly", () => {
  assert.throws(() => analyzeTerrain([1], 1, 1, bounds));
  assert.throws(() =>
    analyzeTerrain(Array(9).fill(0), 3, 3, { ...bounds, east: -1 }),
  );
});

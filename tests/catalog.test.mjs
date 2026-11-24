import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const { sites } = JSON.parse(
  await readFile(new URL("data/sites.json", root), "utf8"),
);
test("all seven regions are integrated with unique names and source images", () => {
  assert.equal(sites.length, 7);
  assert.equal(new Set(sites.map((s) => s.name)).size, 7);
  assert.equal(new Set(sites.map((s) => s.heightmap)).size, 7);
});
for (const site of sites)
  test(`${site.name}: raster and spatial metadata agree`, async () => {
    const png = await readFile(new URL(site.heightmap, root));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), site.image.width);
    assert.equal(png.readUInt32BE(20), site.image.height);
    assert.equal(png[24], site.image.bitDepth);
    assert.ok(site.bounds.north > site.bounds.south);
    assert.ok(site.bounds.east > site.bounds.west);
    assert.ok(site.bounds.south > -90 && site.bounds.north < 90);
    assert.ok(site.elevation.max > site.elevation.min);
    assert.ok(site.headline && site.description && site.type && site.source);
  });

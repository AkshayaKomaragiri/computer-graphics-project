/** Analysis uses decoded elevation and map bounds, never display exaggeration. */
export const MARS_RADIUS = 3389500;
const rad = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function analyzeTerrain(values, width, height, bounds) {
  if (width < 3 || height < 3 || values.length !== width * height)
    throw new Error("A heightmap must have at least 3 × 3 samples.");
  if (!(bounds.east > bounds.west && bounds.north > bounds.south))
    throw new Error("Invalid geographic bounds.");
  const elevations = Float64Array.from(values);
  const slopes = new Float32Array(values.length);
  const roughness = new Float32Array(values.length);
  const weights = new Float64Array(values.length);
  const stepZ =
    (MARS_RADIUS * (bounds.north - bounds.south) * rad) / (height - 1);
  let min = Infinity,
    max = -Infinity,
    sum = 0,
    weight = 0,
    slopeSum = 0;
  for (let y = 0; y < height; y++) {
    const lat =
      bounds.north - (y / (height - 1)) * (bounds.north - bounds.south);
    const stepX =
      (MARS_RADIUS * Math.cos(lat * rad) * (bounds.east - bounds.west) * rad) /
      (width - 1);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const xl = Math.max(0, x - 1),
        xr = Math.min(width - 1, x + 1);
      const yt = Math.max(0, y - 1),
        yb = Math.min(height - 1, y + 1);
      const gx =
        (elevations[y * width + xr] - elevations[y * width + xl]) /
        ((xr - xl) * stepX);
      const gz =
        (elevations[yb * width + x] - elevations[yt * width + x]) /
        ((yb - yt) * stepZ);
      slopes[i] = Math.atan(Math.hypot(gx, gz)) / rad;
      // RMS residual of a least-squares plane over the available 3 × 3 window.
      const mx = (xl + xr) / 2,
        my = (yt + yb) / 2;
      let total = 0,
        sxh = 0,
        syh = 0,
        sxx = 0,
        syy = 0,
        count = 0;
      for (let yy = yt; yy <= yb; yy++)
        for (let xx = xl; xx <= xr; xx++) {
          const dx = (xx - mx) * stepX,
            dz = (yy - my) * stepZ,
            z = elevations[yy * width + xx];
          total += z;
          sxh += dx * z;
          syh += dz * z;
          sxx += dx * dx;
          syy += dz * dz;
          count++;
        }
      const mean = total / count,
        a = sxh / sxx,
        b = syh / syy;
      let error = 0;
      for (let yy = yt; yy <= yb; yy++)
        for (let xx = xl; xx <= xr; xx++) {
          error +=
            (elevations[yy * width + xx] -
              mean -
              a * (xx - mx) * stepX -
              b * (yy - my) * stepZ) **
            2;
        }
      roughness[i] = Math.sqrt(error / count);
      const w =
        Math.cos(lat * rad) *
        (x === 0 || x === width - 1 ? 0.5 : 1) *
        (y === 0 || y === height - 1 ? 0.5 : 1);
      weights[i] = w;
      weight += w;
      sum += elevations[i] * w;
      slopeSum += slopes[i] * w;
      min = Math.min(min, elevations[i]);
      max = Math.max(max, elevations[i]);
    }
  }
  const sorted = [...roughness].sort((a, b) => a - b);
  const middleLat = (bounds.north + bounds.south) / 2;
  return {
    elevations,
    slopes,
    roughness,
    weights,
    width,
    height,
    bounds,
    min,
    max,
    mean: sum / weight,
    meanSlope: slopeSum / weight,
    roughness95: sorted[Math.floor(sorted.length * 0.95)],
    extentX:
      MARS_RADIUS *
      Math.cos(middleLat * rad) *
      (bounds.east - bounds.west) *
      rad,
    extentZ: MARS_RADIUS * (bounds.north - bounds.south) * rad,
    areaKm2:
      (MARS_RADIUS ** 2 *
        (bounds.east - bounds.west) *
        rad *
        (Math.sin(bounds.north * rad) - Math.sin(bounds.south * rad))) /
      1e6,
  };
}

export function sampleField(field, width, height, u, v) {
  const x = clamp(u, 0, 1) * (width - 1),
    y = clamp(v, 0, 1) * (height - 1);
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    x1 = Math.min(width - 1, x0 + 1),
    y1 = Math.min(height - 1, y0 + 1);
  const a = x - x0,
    b = y - y0;
  return (
    (field[y0 * width + x0] * (1 - a) + field[y0 * width + x1] * a) * (1 - b) +
    (field[y1 * width + x0] * (1 - a) + field[y1 * width + x1] * a) * b
  );
}

export function sampleTerrain(model, u, v) {
  u = clamp(u, 0, 1);
  v = clamp(v, 0, 1);
  const field = (data) => sampleField(data, model.width, model.height, u, v);
  return {
    u,
    v,
    elevation: field(model.elevations),
    slope: field(model.slopes),
    roughness: field(model.roughness),
    latitude:
      model.bounds.north - v * (model.bounds.north - model.bounds.south),
    longitude: model.bounds.west + u * (model.bounds.east - model.bounds.west),
  };
}

export function gentleFraction(model, limit) {
  let below = 0,
    total = 0;
  for (let i = 0; i < model.slopes.length; i++) {
    total += model.weights[i];
    if (model.slopes[i] <= limit) below += model.weights[i];
  }
  return below / total;
}

export function findGentlePoint(model) {
  let best = Infinity,
    point;
  for (let y = 2; y < model.height - 2; y++)
    for (let x = 2; x < model.width - 2; x++) {
      let score = 0;
      for (let yy = y - 1; yy <= y + 1; yy++)
        for (let xx = x - 1; xx <= x + 1; xx++) {
          const i = yy * model.width + xx;
          score +=
            model.slopes[i] +
            (5 * model.roughness[i]) / Math.max(model.roughness95, 0.01);
        }
      if (score < best) {
        best = score;
        point = { u: x / (model.width - 1), v: y / (model.height - 1) };
      }
    }
  return point
    ? sampleTerrain(model, point.u, point.v)
    : sampleTerrain(model, 0.5, 0.5);
}

export function groundDistance(a, b) {
  const dlat = (b.latitude - a.latitude) * rad,
    dlon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dlon / 2) ** 2;
  return 2 * MARS_RADIUS * Math.asin(Math.sqrt(clamp(h, 0, 1)));
}

export function terrainProfile(model, a, b, count = 129) {
  if (count < 2) throw new Error("A profile needs at least two samples.");
  const points = Array.from({ length: count }, (_, i) =>
    sampleTerrain(
      model,
      a.u + ((b.u - a.u) * i) / (count - 1),
      a.v + ((b.v - a.v) * i) / (count - 1),
    ),
  );
  let distance = 0;
  points.forEach((p, i) => {
    if (i) distance += groundDistance(points[i - 1], p);
    p.distance = distance;
  });
  return {
    points,
    distance,
    gain: points.at(-1).elevation - points[0].elevation,
  };
}

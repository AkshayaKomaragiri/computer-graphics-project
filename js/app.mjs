import * as THREE from "../vendor/three/three.module.js";
import { OrbitControls } from "../vendor/three/OrbitControls.js?v=local-imports-1";
import {
  analyzeTerrain,
  sampleField,
  sampleTerrain,
  gentleFraction,
  findGentlePoint,
  terrainProfile,
} from "./terrain-analysis.mjs";

const $ = (id) => document.getElementById(id);
const fmt = (v, digits = 0) =>
  Number(v).toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
const coord = (v, positive, negative) =>
  `${Math.abs(v).toFixed(2)}°${v < 0 ? negative : positive}`;
const clamp = THREE.MathUtils.clamp;
const state = {
  sites: [],
  site: null,
  model: null,
  mode: "surface",
  relief: 4,
  contours: true,
  tool: "inspect",
  sample: null,
  profile: null,
  profileStart: null,
  top: false,
  request: 0,
};
const palettes = {
  surface: ["#644335", "#a56b4d", "#d69b72", "#f0c99a"],
  elevation: ["#314d66", "#548b92", "#b4be9b", "#e7bc82", "#d77550", "#f5deae"],
  slope: ["#83b4a4", "#d9d6aa", "#efac65", "#db694a", "#7c4359"],
  roughness: ["#467782", "#8cbaa8", "#ded0a4", "#d6856b", "#a45568"],
};
const colorStops = Object.fromEntries(
  Object.entries(palettes).map(([key, colors]) => [
    key,
    colors.map((c) => new THREE.Color(c)),
  ]),
);
const tempColor = new THREE.Color();
function colorAt(mode, value, out = tempColor) {
  const colors = colorStops[mode],
    index = clamp(value, 0, 1) * (colors.length - 1);
  return out
    .copy(colors[Math.floor(index)])
    .lerp(
      colors[Math.min(colors.length - 1, Math.floor(index) + 1)],
      index % 1,
    );
}
let scene,
  camera,
  renderer,
  controls,
  sun,
  terrainGroup,
  surface,
  base,
  walls,
  grid,
  referenceRing;
let worldWidth = 5.2,
  worldDepth = 4.8,
  metersToWorld = 0.0001,
  contourUniform = { value: 1 };
let markerGroup, sampleMarker, profileMarkers, profileLine, raycaster;
let cameraTween,
  animationFrame,
  lastTime = 0,
  dirty = true,
  toastTimer;
const pixelCache = new Map();
const viewport = $("viewport");

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3200);
}
function disposeObject(object) {
  if (!object) return;
  object.parent?.remove(object);
  const geometries = new Set(),
    materials = new Set();
  object.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.material)
      (Array.isArray(node.material) ? node.material : [node.material]).forEach(
        (m) => materials.add(m),
      );
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => {
    m.map?.dispose();
    m.dispose();
  });
}
function setupScene() {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  viewport.appendChild(renderer.domElement);
  renderer.domElement.setAttribute(
    "aria-label",
    "Interactive Mars terrain. Drag to rotate; click to inspect.",
  );
  renderer.domElement.tabIndex = 0;
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe0e9df, 0x39352e, 2.2));
  sun = new THREE.DirectionalLight(0xffddba, 3.1);
  scene.add(sun);
  updateSun();
  const rim = new THREE.DirectionalLight(0x9ab6c9, 1.8);
  rim.position.set(3, 2, -5);
  scene.add(rim);
  camera = new THREE.PerspectiveCamera(37, 1, 0.05, 100);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3;
  controls.maxDistance = 35;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.autoRotateSpeed = 0.5;
  controls.addEventListener("change", () => {
    dirty = true;
  });
  controls.addEventListener("start", () => {
    cameraTween = null;
    setFlyover(false);
  });
  controls.addEventListener("end", () => {
    state.top = controls.getPolarAngle() < 0.08;
    updateTopButton();
  });
  markerGroup = new THREE.Group();
  scene.add(markerGroup);
  profileMarkers = new THREE.Group();
  markerGroup.add(profileMarkers);
  grid = new THREE.GridHelper(14, 40, 0x8a8e7e, 0x737e75);
  grid.material.transparent = true;
  grid.material.opacity = 0.13;
  scene.add(grid);
  referenceRing = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 180 }, (_, i) => {
        const angle = (i / 180) * Math.PI * 2;
        return new THREE.Vector3(
          Math.cos(angle) * 4.25,
          0,
          Math.sin(angle) * 4.25,
        );
      }),
    ),
    new THREE.LineBasicMaterial({
      color: 0x899283,
      transparent: true,
      opacity: 0.15,
    }),
  );
  scene.add(referenceRing);
  raycaster = new THREE.Raycaster();
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  let down;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    down = {
      x: e.clientX,
      y: e.clientY,
      time: performance.now(),
      button: e.button,
    };
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (
      down &&
      down.button === 0 &&
      Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 &&
      performance.now() - down.time < 700
    ) {
      const hit = hitTerrain(e);
      if (hit) selectPoint(hit);
    }
    down = null;
  });
  let lastPointer = 0;
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (e.buttons || performance.now() - lastPointer < 65) {
      $("probe-tooltip").hidden = true;
      return;
    }
    lastPointer = performance.now();
    const hit = hitTerrain(e);
    const tip = $("probe-tooltip");
    tip.hidden = !hit;
    renderer.domElement.style.cursor = hit ? "crosshair" : "grab";
    if (hit) {
      const rect = viewport.getBoundingClientRect();
      tip.innerHTML = `${fmt(hit.elevation)} m <small>${fmt(hit.slope, 1)}° slope</small>`;
      tip.style.left = `${clamp(e.clientX - rect.left + 15, 8, rect.width - 175)}px`;
      tip.style.top = `${clamp(e.clientY - rect.top - 40, 8, rect.height - 40)}px`;
    }
  });
  renderer.domElement.addEventListener("pointerleave", () => {
    $("probe-tooltip").hidden = true;
    down = null;
  });
  renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    showError(
      "The 3D view was interrupted. Reload to restore your expedition.",
    );
  });
  resetCamera(true);
  animate(0);
}
function resize() {
  const width = viewport.clientWidth,
    height = viewport.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  dirty = true;
}
function initialCamera() {
  // Keep the entire region visible on narrow screens and below the heading.
  const aspect = Math.max(
    viewport.clientWidth / Math.max(viewport.clientHeight, 1),
    0.4,
  );
  const distance = Math.max(13.5, 12.4 / aspect);
  return new THREE.Vector3(distance * 0.54, distance * 0.55, distance * 0.67);
}
function transitionCamera(
  position,
  target = new THREE.Vector3(0, 0.65, 0),
  instant = false,
) {
  if (instant || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    camera.position.copy(position);
    controls.target.copy(target);
    controls.update();
    dirty = true;
    return;
  }
  cameraTween = {
    start: performance.now(),
    from: camera.position.clone(),
    to: position,
    targetFrom: controls.target.clone(),
    targetTo: target,
  };
}
function resetCamera(instant = false) {
  state.top = false;
  setFlyover(false);
  updateTopButton();
  transitionCamera(initialCamera(), new THREE.Vector3(0, 0.65, 0), instant);
}
function updateTopButton() {
  $("top-view").classList.toggle("active", state.top);
  $("top-view").setAttribute("aria-pressed", String(state.top));
  $("view-label").textContent = state.top ? "OVERHEAD" : "PERSPECTIVE";
}
function setFlyover(active) {
  if (!controls) return;
  controls.autoRotate = active;
  $("orbit-toggle").classList.toggle("active", active);
  $("orbit-toggle").setAttribute("aria-pressed", String(active));
  $("orbit-toggle").setAttribute(
    "aria-label",
    active ? "Pause flyover" : "Start flyover",
  );
  $("orbit-toggle").title = active ? "Pause flyover" : "Start flyover";
  dirty = true;
}
function animate(time) {
  animationFrame = requestAnimationFrame(animate);
  if (document.hidden) {
    lastTime = time;
    return;
  }
  const delta = Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;
  if (cameraTween) {
    const t = clamp((performance.now() - cameraTween.start) / 900, 0, 1),
      eased = 1 - (1 - t) ** 3;
    camera.position.lerpVectors(cameraTween.from, cameraTween.to, eased);
    controls.target.lerpVectors(
      cameraTween.targetFrom,
      cameraTween.targetTo,
      eased,
    );
    dirty = true;
    if (t >= 1) cameraTween = null;
  }
  controls.update(delta);
  if (dirty || controls.autoRotate || cameraTween) {
    $("compass-needle").style.transform =
      `rotate(${(-controls.getAzimuthalAngle() * 180) / Math.PI}deg)`;
    renderer.render(scene, camera);
    dirty = false;
  }
}
function updateSun() {
  if (!sun) return;
  const angle = (+$("sun").value * Math.PI) / 180;
  sun.position.set(Math.cos(angle) * 6, 5, Math.sin(angle) * 6);
  dirty = true;
}
async function readMap(site) {
  if (pixelCache.has(site.heightmap)) return pixelCache.get(site.heightmap);
  const image = new Image();
  image.src = site.heightmap;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const values = Float64Array.from(
    { length: canvas.width * canvas.height },
    (_, i) =>
      site.elevation.min +
      (rgba[i * 4] / 255) * (site.elevation.max - site.elevation.min),
  );
  const data = { values, width: canvas.width, height: canvas.height };
  pixelCache.set(site.heightmap, data);
  return data;
}
function terrainY(elevation) {
  return (
    (elevation - (state.model.min + state.model.max) / 2) *
    metersToWorld *
    state.relief
  );
}
function worldPoint(sample, lift = 0) {
  return new THREE.Vector3(
    (sample.u - 0.5) * worldWidth,
    terrainY(sample.elevation) + lift,
    (sample.v - 0.5) * worldDepth,
  );
}
function buildTerrain() {
  disposeObject(terrainGroup);
  const m = state.model;
  metersToWorld = 5.2 / Math.max(m.extentX, m.extentZ);
  worldWidth = m.extentX * metersToWorld;
  worldDepth = m.extentZ * metersToWorld;
  terrainGroup = new THREE.Group();
  scene.add(terrainGroup);
  const segX = (m.width - 1) * 2,
    segY = (m.height - 1) * 2;
  const geometry = new THREE.PlaneGeometry(worldWidth, worldDepth, segX, segY);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  const raw = new Float32Array(position.count),
    normalized = new Float32Array(position.count),
    colors = new Float32Array(position.count * 3);
  for (let y = 0; y <= segY; y++)
    for (let x = 0; x <= segX; x++) {
      const i = y * (segX + 1) + x,
        u = x / segX,
        v = y / segY;
      const elevation = sampleField(m.elevations, m.width, m.height, u, v);
      raw[i] = elevation;
      normalized[i] = (elevation - m.min) / Math.max(m.max - m.min, 1);
      position.setY(i, terrainY(elevation));
    }
  geometry.setAttribute("aHeight", new THREE.BufferAttribute(normalized, 1));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uContours = contourUniform;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      "#include <common>\nattribute float aHeight; varying float vTerrainHeight; varying vec2 vGround;",
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvTerrainHeight = aHeight; vGround = position.xz;",
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      "#include <common>\nuniform float uContours; varying float vTerrainHeight; varying vec2 vGround;",
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      float level = vTerrainHeight * 20.0;
      float d = abs(fract(level - 0.5) - 0.5);
      float line = 1.0 - smoothstep(0.0, max(fwidth(level) * 1.15, 0.025), d);
      float grain = fract(sin(dot(floor(vGround * 900.0), vec2(12.9898,78.233))) * 43758.5453);
      diffuseColor.rgb *= (0.97 + grain * 0.06) * (1.0 - line * 0.28 * uContours);
    `,
    );
  };
  surface = new THREE.Mesh(geometry, material);
  surface.userData.raw = raw;
  terrainGroup.add(surface);
  // A restrained cutaway base closes the heightmap edges; it is a display plinth.
  const boundary = [];
  for (let x = 0; x <= segX; x++) boundary.push(x);
  for (let y = 1; y <= segY; y++) boundary.push(y * (segX + 1) + segX);
  for (let x = segX - 1; x >= 0; x--) boundary.push(segY * (segX + 1) + x);
  for (let y = segY - 1; y > 0; y--) boundary.push(y * (segX + 1));
  const wallGeometry = new THREE.BufferGeometry();
  wallGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(boundary.length * 18), 3),
  );
  walls = new THREE.Mesh(
    wallGeometry,
    new THREE.MeshStandardMaterial({
      color: 0x664735,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
  );
  walls.userData.boundary = boundary;
  terrainGroup.add(walls);
  base = new THREE.Mesh(
    new THREE.BoxGeometry(worldWidth, 0.055, worldDepth),
    new THREE.MeshStandardMaterial({ color: 0x303d38, roughness: 0.8 }),
  );
  terrainGroup.add(base);
  updateRelief();
  recolor();
}
function updateRelief() {
  state.relief = +$("relief").value;
  $("relief-output").textContent = `${state.relief.toFixed(1)}×`;
  if (!surface) return;
  const positions = surface.geometry.attributes.position,
    raw = surface.userData.raw;
  for (let i = 0; i < positions.count; i++) positions.setY(i, terrainY(raw[i]));
  positions.needsUpdate = true;
  surface.geometry.computeVertexNormals();
  surface.geometry.computeBoundingSphere();
  const bottom = terrainY(state.model.min) - 0.18;
  const boundary = walls.userData.boundary,
    wp = walls.geometry.attributes.position;
  let offset = 0;
  for (let k = 0; k < boundary.length; k++) {
    const a = boundary[k],
      b = boundary[(k + 1) % boundary.length];
    const ax = positions.getX(a),
      az = positions.getZ(a),
      ay = positions.getY(a),
      bx = positions.getX(b),
      bz = positions.getZ(b),
      by = positions.getY(b);
    for (const vertex of [
      [ax, ay, az],
      [bx, by, bz],
      [ax, bottom, az],
      [bx, by, bz],
      [bx, bottom, bz],
      [ax, bottom, az],
    ])
      wp.setXYZ(offset++, ...vertex);
  }
  wp.needsUpdate = true;
  walls.geometry.computeVertexNormals();
  walls.geometry.computeBoundingSphere();
  base.position.y = bottom - 0.025;
  grid.position.y = bottom - 0.075;
  referenceRing.position.y = bottom - 0.07;
  updateMarkers();
  dirty = true;
}
function recolor() {
  if (!surface) return;
  const m = state.model,
    geometry = surface.geometry,
    position = geometry.attributes.position,
    colors = geometry.attributes.color;
  const raw = surface.userData.raw;
  for (let i = 0; i < position.count; i++) {
    let t = (raw[i] - m.min) / Math.max(m.max - m.min, 1);
    if (state.mode === "slope" || state.mode === "roughness") {
      const u = position.getX(i) / worldWidth + 0.5,
        v = position.getZ(i) / worldDepth + 0.5;
      t =
        sampleField(
          state.mode === "slope" ? m.slopes : m.roughness,
          m.width,
          m.height,
          u,
          v,
        ) / (state.mode === "slope" ? 15 : Math.max(m.roughness95, 1));
    }
    const color = colorAt(state.mode, t);
    colors.setXYZ(i, color.r, color.g, color.b);
  }
  colors.needsUpdate = true;
  const labels = {
    surface: [
      "SURFACE ELEVATION",
      "METERS",
      `${fmt(m.min)} m`,
      `${fmt(m.max)} m`,
    ],
    elevation: ["ELEVATION", "METERS", `${fmt(m.min)} m`, `${fmt(m.max)} m`],
    slope: ["GROUND SLOPE", "DEGREES", "0° · gentle", "15°+ · steep"],
    roughness: [
      "LOCAL ROUGHNESS",
      "METERS · 95TH PCTL",
      "0 m · smooth",
      `${fmt(Math.max(m.roughness95, 1), 1)}+ m`,
    ],
  }[state.mode];
  ["legend-title", "legend-unit", "legend-min", "legend-max"].forEach(
    (id, i) => ($(id).textContent = labels[i]),
  );
  $("legend-gradient").style.background =
    `linear-gradient(90deg,${palettes[state.mode].join(",")})`;
  dirty = true;
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === mode;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
  recolor();
}
function setTool(tool) {
  state.tool = tool;
  for (const name of ["inspect", "profile"]) {
    $(`${name}-tool`).classList.toggle("active", tool === name);
    $(`${name}-tool`).setAttribute("aria-pressed", String(tool === name));
  }
  $("interaction-hint").textContent =
    tool === "profile"
      ? state.profileStart
        ? "Click an end point to complete your cross-section"
        : "Click a start point, then an end point on the terrain"
      : "Drag to explore · Scroll to zoom · Click to inspect";
  if (tool === "inspect" && state.profileStart) {
    state.profileStart = null;
    updateMarkers();
  }
  if (tool === "profile") closeDrawers();
}
function hitTerrain(event) {
  if (!surface || !state.model || !$("loading").hidden) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  );
  const hit = raycaster.intersectObject(surface)[0];
  return hit
    ? sampleTerrain(
        state.model,
        hit.point.x / worldWidth + 0.5,
        hit.point.z / worldDepth + 0.5,
      )
    : null;
}
function selectPoint(point, caption = "A point on another world.") {
  if (state.tool === "profile") {
    if (!state.profileStart) {
      state.profile = null;
      state.profileStart = point;
      updateMarkers();
      updateProfileChart();
      setTool("profile");
      toast("Start marked. Choose an end point on the terrain.");
    } else {
      state.profile = terrainProfile(state.model, state.profileStart, point);
      state.profileStart = null;
      updateMarkers();
      updateProfileChart();
      setTool("inspect");
      openAnalysis();
      toast("Cross-section traced. Explore its elevation in Analysis.");
    }
    return;
  }
  state.sample = point;
  $("sample-caption").textContent = caption;
  $("sample-location").textContent =
    `${coord(point.latitude, "N", "S")} · ${coord(point.longitude, "E", "W")}`;
  $("sample-elevation").innerHTML = `${fmt(point.elevation)} <small>m</small>`;
  $("sample-slope").innerHTML = `${fmt(point.slope, 1)}<small>°</small>`;
  $("sample-roughness").innerHTML =
    `${fmt(point.roughness, 1)} <small>m</small>`;
  const relative =
    (point.elevation - state.model.min) /
    Math.max(state.model.max - state.model.min, 1);
  $("sample-context").textContent =
    `${point.slope < 5 ? "Gentle ground" : point.slope < 15 ? "Moderately inclined ground" : "Steeper ground"}, in the ${relative < 0.33 ? "lower" : relative < 0.67 ? "middle" : "upper"} third of this region's elevation range. Roughness measures local height variation after removing the ground's overall tilt.`;
  setTab("sample");
  updateMarkers();
  openAnalysis();
}
function pin(color = 0xf9aa76, size = 1, label = "") {
  const group = new THREE.Group();
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.038 * size, 16, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
  head.position.y = 0.29 * size;
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.005 * size, 0.005 * size, 0.27 * size, 6),
    new THREE.MeshBasicMaterial({ color }),
  );
  stem.position.y = 0.14 * size;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.045 * size, 0.065 * size, 40),
    new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.007;
  group.add(head, stem, ring);
  if (label) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#172120";
    ctx.beginPath();
    ctx.roundRect(4, 4, 88, 88, 22);
    ctx.fill();
    ctx.strokeStyle = new THREE.Color(color).getStyle();
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = "#f5e8cd";
    ctx.font = "500 53px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 48, 51);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      }),
    );
    sprite.scale.set(0.22, 0.22, 1);
    sprite.position.y = 0.47 * size;
    group.add(sprite);
  }
  group.traverse((node) => {
    node.renderOrder = 10;
    if (node.material) {
      node.material.depthTest = false;
      node.material.depthWrite = false;
    }
  });
  return group;
}
function updateMarkers() {
  if (!markerGroup || !state.model) return;
  disposeObject(sampleMarker);
  sampleMarker = null;
  while (profileMarkers.children.length)
    disposeObject(profileMarkers.children[0]);
  disposeObject(profileLine);
  profileLine = null;
  if (state.sample) {
    sampleMarker = pin(0xf9aa76, 1, "+");
    sampleMarker.position.copy(worldPoint(state.sample, 0.015));
    markerGroup.add(sampleMarker);
  }
  const endpoints = state.profile
    ? [state.profile.points[0], state.profile.points.at(-1)]
    : state.profileStart
      ? [state.profileStart]
      : [];
  endpoints.forEach((point, i) => {
    const marker = pin(i ? 0xafd1c2 : 0xf9aa76, 0.8, i ? "B" : "A");
    marker.position.copy(worldPoint(point, 0.015));
    profileMarkers.add(marker);
  });
  if (state.profile) {
    profileLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        state.profile.points.map((p) => worldPoint(p, 0.022)),
      ),
      new THREE.LineBasicMaterial({
        color: 0xffd19b,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      }),
    );
    profileLine.renderOrder = 5;
    markerGroup.add(profileLine);
  }
  dirty = true;
}
function setTab(tab) {
  $("overview-section").hidden = tab !== "overview";
  $("sample-section").hidden = tab !== "sample";
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
    b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
  });
}
function updateGentle() {
  if (!state.model) return;
  const limit = +$("slope-limit").value,
    fraction = gentleFraction(state.model, limit);
  $("slope-limit-output").textContent = `${limit}°`;
  $("gentle-percentage").textContent = `${fmt(fraction * 100, 1)}%`;
  $("gentle-fill").style.width = `${fraction * 100}%`;
}
function drawHistogram() {
  const canvas = $("histogram"),
    ctx = canvas.getContext("2d"),
    w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const bins = new Float64Array(32),
    m = state.model;
  for (let i = 0; i < m.elevations.length; i++)
    bins[
      Math.min(
        31,
        Math.floor(
          ((m.elevations[i] - m.min) / Math.max(m.max - m.min, 1)) * 32,
        ),
      )
    ] += m.weights[i];
  const max = Math.max(...bins);
  for (let i = 0; i < bins.length; i++) {
    const height = Math.max(2, (bins[i] / max) * (h - 10));
    ctx.fillStyle = colorAt("surface", i / 31).getStyle();
    ctx.beginPath();
    ctx.roundRect(
      (i * w) / 32 + 2,
      h - height,
      w / 32 - 4,
      height,
      [3, 3, 0, 0],
    );
    ctx.fill();
  }
}
function updateProfileChart() {
  const profile = state.profile;
  $("profile-empty").hidden = !!profile;
  $("profile-result").hidden = !profile;
  $("clear-profile").hidden = !profile && !state.profileStart;
  if (!profile) return;
  const canvas = $("profile-chart"),
    ctx = canvas.getContext("2d"),
    w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const min = Math.min(...profile.points.map((p) => p.elevation)),
    max = Math.max(...profile.points.map((p) => p.elevation));
  const range = Math.max(max - min, 1),
    pad = 12;
  const xy = (p, i) => [
    pad + (i / (profile.points.length - 1)) * (w - pad * 2),
    h - 25 - ((p.elevation - min) / range) * (h - 55),
  ];
  ctx.strokeStyle = "#ffffff12";
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const y = 30 + (i * (h - 55)) / 2;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }
  ctx.beginPath();
  profile.points.forEach((p, i) => {
    const [x, y] = xy(p, i);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.lineTo(w - pad, h - 25);
  ctx.lineTo(pad, h - 25);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 20, 0, h);
  gradient.addColorStop(0, "#f0ad7455");
  gradient.addColorStop(1, "#f0ad7400");
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  profile.points.forEach((p, i) => {
    const [x, y] = xy(p, i);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.strokeStyle = "#f4ba88";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.font = "16px monospace";
  ctx.fillStyle = "#acb4a7";
  ctx.textAlign = "left";
  ctx.fillText("A", pad, h - 3);
  ctx.textAlign = "right";
  ctx.fillText("B", w - pad, h - 3);
  $("profile-distance").textContent = `${fmt(profile.distance / 1000, 1)} km`;
  $("profile-gain").textContent =
    `${profile.gain >= 0 ? "+" : ""}${fmt(profile.gain)} m`;
  canvas.setAttribute(
    "aria-label",
    `Elevation cross-section: ${fmt(min)} to ${fmt(max)} meters over ${fmt(profile.distance / 1000, 1)} kilometers.`,
  );
}
function updateOverview() {
  const m = state.model,
    site = state.site;
  $("region-type").textContent = site.type;
  $("region-title").textContent = site.name;
  const dot = document.createElement("span");
  dot.textContent = ".";
  $("region-title").append(dot);
  $("region-headline").textContent = site.headline;
  $("region-description").textContent = site.description;
  $("coordinates").textContent =
    `${coord(site.location.latitude, "N", "S")} / ${coord(site.location.longitude, "E", "W")}`;
  $("elevation-span").innerHTML = `${fmt(m.max - m.min)} <small>m</small>`;
  $("min-elevation").textContent = `${fmt(m.min)} m`;
  $("max-elevation").textContent = `${fmt(m.max)} m`;
  $("mean-slope").innerHTML = `${fmt(m.meanSlope, 1)}<small>°</small>`;
  $("mapped-area").innerHTML =
    `${m.areaKm2 >= 10000 ? fmt(m.areaKm2 / 1000, 1) + "k" : fmt(m.areaKm2)} <small>km²</small>`;
  document.title = `${site.name} · Mars Atlas`;
  drawHistogram();
  updateGentle();
  updateProfileChart();
  setTab("overview");
  // Clear the previous region's sample instead of showing stale readings.
  $("sample-caption").textContent = "A point on another world.";
  $("sample-location").textContent = "Select a point to begin.";
  ["sample-elevation", "sample-slope", "sample-roughness"].forEach(
    (id) => ($(id).textContent = "—"),
  );
  $("sample-context").textContent =
    "Click the terrain to sample elevation, physical slope, and local surface roughness.";
}
async function selectSite(site) {
  const request = ++state.request;
  $("loading").hidden = false;
  $("loading").classList.remove("startup-error");
  $("loading").setAttribute("role", "status");
  const spinner = $("loading").querySelector(".loading-orbit");
  if (spinner) spinner.hidden = false;
  $("loading").querySelector("h2").textContent = "Preparing your expedition";
  for (const id of ["startup-help", "startup-details"]) {
    if ($(id)) $(id).hidden = true;
  }
  $("retry").hidden = true;
  $("loading-message").textContent = `Reading ${site.name} elevation data…`;
  closeDrawers();
  setFlyover(false);
  $("probe-tooltip").hidden = true;
  try {
    const data = await readMap(site);
    if (request !== state.request) return;
    const model = analyzeTerrain(
      data.values,
      data.width,
      data.height,
      site.bounds,
    );
    state.site = site;
    state.model = model;
    state.sample = null;
    state.profile = null;
    state.profileStart = null;
    buildTerrain();
    updateOverview();
    setTool("inspect");
    resetCamera(true);
    document.querySelectorAll(".region-card").forEach((b) => {
      const selected = b.dataset.site === site.name;
      b.classList.toggle("active", selected);
      b.setAttribute("aria-pressed", String(selected));
    });
    $("loading").hidden = true;
    history.replaceState(null, "", `#${encodeURIComponent(site.name)}`);
    dirty = true;
  } catch (error) {
    if (request === state.request)
      showError(`Could not load ${site.name}. ${error.message}`);
  }
}
function showError(message) {
  console.error(message);
  $("loading").hidden = false;
  $("loading").classList.add("startup-error");
  $("loading").setAttribute("role", "alert");
  $("loading").querySelector("h2").textContent = "Unable to load the explorer";
  const spinner = $("loading").querySelector(".loading-orbit");
  if (spinner) spinner.hidden = true;
  $("loading-message").textContent = message;
  if ($("startup-help")) $("startup-help").hidden = false;
  $("retry").hidden = false;
}
function buildRegionList() {
  $("region-list").replaceChildren();
  state.sites.forEach((site) => {
    const b = document.createElement("button");
    b.className = "region-card";
    b.dataset.site = site.name;
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", `Explore ${site.name}`);
    const img = document.createElement("img");
    img.className = "region-thumb";
    img.src = site.heightmap;
    img.alt = "";
    img.width = 61;
    img.height = 60;
    const label = document.createElement("span"),
      name = document.createElement("span"),
      kind = document.createElement("span");
    name.className = "region-name";
    name.textContent = site.name;
    kind.className = "region-kind";
    kind.textContent = site.type
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase());
    label.append(name, kind);
    b.append(img, label);
    b.addEventListener("click", () => selectSite(site));
    $("region-list").append(b);
  });
}
let drawerOpener;
function openDrawer(name) {
  closeDrawers(false);
  drawerOpener = document.activeElement;
  $(`${name}-panel`).classList.add("open");
  $("drawer-backdrop").hidden = false;
  $(`${name}-toggle`).setAttribute("aria-expanded", "true");
  // Only overlays are dialogs; desktop sidebars remain normal page regions.
  $(`${name}-panel`).setAttribute("role", "dialog");
  $(`${name}-panel`).setAttribute("aria-modal", "true");
  $(`${name}-panel`).querySelector(".drawer-close").focus();
}
function closeDrawers(restore = true) {
  for (const name of ["regions", "analysis"]) {
    $(`${name}-panel`).classList.remove("open");
    $(`${name}-panel`).removeAttribute("role");
    $(`${name}-panel`).removeAttribute("aria-modal");
    $(`${name}-toggle`).setAttribute("aria-expanded", "false");
  }
  $("drawer-backdrop").hidden = true;
  if (restore && drawerOpener) {
    drawerOpener.focus();
    drawerOpener = null;
  }
}
function openAnalysis() {
  if (matchMedia("(max-width:899px)").matches) openDrawer("analysis");
}
function openGuide(method = false) {
  $("guide-dialog").showModal();
  if (method) $("method-details").open = true;
}
function exportNotes() {
  if (!state.model) return;
  const m = state.model;
  const notes = {
    title: "Mars Atlas · Field notes",
    createdAt: new Date().toISOString(),
    region: state.site.name,
    source: state.site.source,
    heightmap: state.site.heightmap,
    bounds: state.site.bounds,
    encoding: {
      bitDepth: 8,
      elevationMin: state.site.elevation.min,
      elevationMax: state.site.elevation.max,
      metersPerLevel:
        (state.site.elevation.max - state.site.elevation.min) / 255,
    },
    summary: {
      minElevationM: m.min,
      maxElevationM: m.max,
      meanElevationM: m.mean,
      meanSlopeDegrees: m.meanSlope,
      areaKm2: m.areaKm2,
      slopeLimitDegrees: +$("slope-limit").value,
      gentleAreaPercent: gentleFraction(m, +$("slope-limit").value) * 100,
    },
    sample: state.sample,
    profile: state.profile,
    display: {
      mode: state.mode,
      verticalExaggeration: state.relief,
      contours: state.contours,
    },
    methods: {
      slope:
        "Gradient angle using latitude-adjusted spacing; spherical Mars radius 3389500 m.",
      roughness:
        "RMS residual from a fitted plane in a 3x3 pixel neighborhood, meters.",
      profile:
        "Bilinear heights along a straight line in map coordinates; geographic segment distances.",
      gentlePoint:
        "Minimum 3x3 mean of slope degrees + 5 * roughness / regional roughness95.",
    },
    limitations:
      "Quantized 8-bit regional maps. Metrics describe sampled terrain, not landing or rover safety. Display relief does not alter analysis.",
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(notes, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `mars-atlas-${state.site.name.toLowerCase().replaceAll(" ", "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Your field notes have been exported.");
}
function setupUI() {
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.addEventListener("click", () => setMode(b.dataset.view)));
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("relief").addEventListener("input", updateRelief);
  $("sun").addEventListener("input", updateSun);
  $("slope-limit").addEventListener("input", updateGentle);
  $("camera-reset").addEventListener("click", () => resetCamera());
  $("top-view").addEventListener("click", () => {
    state.top = !state.top;
    setFlyover(false);
    updateTopButton();
    const overheadDistance = Math.max(14.5, 12.4 / camera.aspect);
    transitionCamera(
      state.top
        ? new THREE.Vector3(0, overheadDistance, -0.649)
        : initialCamera(),
      state.top
        ? new THREE.Vector3(0, 0, -0.65)
        : new THREE.Vector3(0, 0.65, 0),
    );
  });
  $("orbit-toggle").addEventListener("click", () => {
    if (state.top) {
      state.top = false;
      updateTopButton();
      transitionCamera(initialCamera());
    }
    setFlyover(!controls.autoRotate);
  });
  $("contours-toggle").addEventListener("click", () => {
    state.contours = !state.contours;
    contourUniform.value = +state.contours;
    $("contours-toggle").classList.toggle("active", state.contours);
    $("contours-toggle").setAttribute("aria-pressed", String(state.contours));
    dirty = true;
  });
  $("inspect-tool").addEventListener("click", () => setTool("inspect"));
  $("profile-tool").addEventListener("click", () => setTool("profile"));
  $("find-gentle").addEventListener("click", () => {
    if (!state.model) return;
    setTool("inspect");
    selectPoint(
      findGentlePoint(state.model),
      "A gentler place to investigate.",
    );
    toast("Low slope and low roughness across a local neighborhood.");
  });
  $("sample-center").addEventListener("click", () => {
    if (!state.model) return;
    setTool("inspect");
    selectPoint(sampleTerrain(state.model, 0.5, 0.5));
  });
  $("demo-profile").addEventListener("click", () => {
    if (!state.model) return;
    state.profileStart = null;
    state.profile = terrainProfile(
      state.model,
      { u: 0.14, v: 0.5 },
      { u: 0.86, v: 0.5 },
    );
    updateMarkers();
    updateProfileChart();
    setTool("inspect");
    toast("Cross-section traced west to east through the region.");
  });
  $("clear-profile").addEventListener("click", () => {
    state.profile = null;
    state.profileStart = null;
    updateMarkers();
    updateProfileChart();
    setTool("inspect");
  });
  $("export").addEventListener("click", exportNotes);
  $("guide-open").addEventListener("click", () => openGuide());
  $("method-open").addEventListener("click", () => openGuide(true));
  ["guide-close", "guide-start"].forEach((id) =>
    $(id).addEventListener("click", () => $("guide-dialog").close()),
  );
  $("guide-dialog").addEventListener("click", (e) => {
    if (e.target === $("guide-dialog")) {
      const r = $("guide-dialog").getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        $("guide-dialog").close();
    }
  });
  ["regions", "analysis"].forEach((name) => {
    $(`${name}-toggle`).setAttribute("aria-expanded", "false");
    $(`${name}-toggle`).setAttribute("aria-controls", `${name}-panel`);
    $(`${name}-toggle`).addEventListener("click", () => openDrawer(name));
  });
  document
    .querySelectorAll("[data-close]")
    .forEach((b) => b.addEventListener("click", () => closeDrawers()));
  $("drawer-backdrop").addEventListener("click", () => closeDrawers());
  document.addEventListener("keydown", (e) => {
    const drawer = document.querySelector(".panel.open");
    if (e.key === "Escape") {
      closeDrawers();
      if (state.profileStart) {
        state.profileStart = null;
        setTool("inspect");
        updateMarkers();
        updateProfileChart();
      }
      return;
    }
    if (e.key === "Tab" && drawer) {
      const focus = [
        ...drawer.querySelectorAll("button,input,a,summary"),
      ].filter((el) => el.getClientRects().length);
      if (e.shiftKey && document.activeElement === focus[0]) {
        e.preventDefault();
        focus.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === focus.at(-1)) {
        e.preventDefault();
        focus[0].focus();
      }
      return;
    }
    if (
      e.target.matches("input,textarea,select") ||
      $("guide-dialog").open ||
      drawer
    )
      return;
    if (e.key.toLowerCase() === "r") resetCamera();
    if (e.key === "?") openGuide();
  });
  window.addEventListener("resize", () => {
    if (!$("drawer-backdrop").hidden) closeDrawers();
  });
  if (typeof window.startMarsAtlas !== "function") {
    $("retry").addEventListener("click", () => location.reload());
  }
}
let initialization;
export function init() {
  if (!initialization) initialization = initialize();
  return initialization;
}

async function initialize() {
  try {
    setupUI();
    setupScene();
    const response = await fetch("data/sites.json");
    if (!response.ok)
      throw new Error("The region catalog could not be loaded.");
    const data = await response.json();
    state.sites = data.sites;
    if (!state.sites.length) throw new Error("No regions are available.");
    buildRegionList();
    let hash = "";
    try {
      hash = decodeURIComponent(location.hash.slice(1));
    } catch {}
    await selectSite(
      state.sites.find((s) => s.name === hash) || state.sites[0],
    );
  } catch (error) {
    showError(error.message);
  }
}

// Keep cached copies of the previous HTML entry point working, while letting
// the startup guard await the same initialization without starting it twice.
init();

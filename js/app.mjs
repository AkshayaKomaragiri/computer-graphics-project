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
  surface: ["#654239", "#c18b69", "#e1b18c"],
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
    if (node.userData.surfaceMaterial) materials.add(node.userData.surfaceMaterial);
    if (node.userData.analysisMaterial) materials.add(node.userData.analysisMaterial);
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
    terrainY(sample.elevation) + lift + (state.mode === "surface" && surface ? sampleField(surface.userData.detail, (state.model.width-1)*2+1, (state.model.height-1)*2+1, sample.u, sample.v) : 0),
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
  const w=m.width, h=m.height, vertCount=position.count;
  const surfaceColors = new Float32Array(vertCount*3);
  const low=new THREE.Color(0x654239), mid=new THREE.Color(0xc18b69), high=new THREE.Color(0xe1b18c);
      const rock = new THREE.Color(0x855747);
      const soilColor = new THREE.Color();
      const orangeDust = new THREE.Color(0xb66d4e);
      const ochreDust = new THREE.Color(0xd49a70);

      for (let i = 0; i < vertCount; i++) {
        const x = (i % (segX + 1)) / 2;
        const z = Math.floor(i / (segX + 1)) / 2;

        const field = (x,z) => (sampleField(m.elevations,w,h,x/(w-1),z/(h-1))-m.min)/Math.max(m.max-m.min,1);
        const slope = Math.hypot((field(x+1,z)-field(x-1,z))*w/2,(field(x,z+1)-field(x,z-1))*h/2);
        const cliff = THREE.MathUtils.smoothstep(slope, 0.22, 1.25) * 0.84;
        const e = normalized[i];

        soilColor.copy(e < 0.52 ? low : mid);

        if (e < 0.52) {
          soilColor.lerp(mid, e / 0.52);
        } else {
          soilColor.lerp(high, (e - 0.52) / 0.48);
        }

        soilColor.lerp(rock, cliff);

        // Bright orange iron-oxide dust patches
        const warmField =
          0.5
          + 0.25 * Math.sin(x * 0.105 + Math.sin(z * 0.073) * 2.3)
          + 0.25 * Math.sin(z * 0.087 - x * 0.051);

        const patch = THREE.MathUtils.smoothstep(warmField, 0.43, 0.72);
        const flatness = 1 - THREE.MathUtils.smoothstep(slope, 0.25, 1.15);

        const orangeAmount =
          patch * flatness * (0.48 + 0.12 * Math.sin(e * 7.0));

        soilColor.lerp(orangeDust, Math.max(0, orangeAmount));

        const ochreField =
          0.5 + 0.5 * Math.sin(
            x * 0.061 - z * 0.083 + Math.sin(x * 0.037)
          );

        soilColor.lerp(ochreDust, 0.22 * ochreField * flatness);

        const variation =
          0.88 + 0.12
          * Math.sin(x * 1.71 + z * 0.37)
          * Math.sin(z * 2.13 - x * 0.19);

        surfaceColors[i * 3] = soilColor.r * variation;
        surfaceColors[i * 3 + 1] = soilColor.g * variation;
        surfaceColors[i * 3 + 2] = soilColor.b * variation;
      }

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
        function hash(ix, iz) {
          const v = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
          return v - Math.floor(v);
        }
        function reliefNoise(x, z, frequency) {
          const fx = x * frequency, fz = z * frequency;
          const ix = Math.floor(fx), iz = Math.floor(fz);
          let tx = fx - ix, tz = fz - iz;
          tx = tx * tx * (3 - 2 * tx);
          tz = tz * tz * (3 - 2 * tz);
          const a = hash(ix, iz), b = hash(ix + 1, iz);
          const c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
          return THREE.MathUtils.lerp(
            THREE.MathUtils.lerp(a, b, tx),
            THREE.MathUtils.lerp(c, d, tx), tz
          ) * 2 - 1;
        }

  const detail = new Float32Array(position.count);
  for(let i=0;i<position.count;i++) {
    const x=position.getX(i)/2.6,z=position.getZ(i)/2.6;
    const edge=THREE.MathUtils.smoothstep(Math.min(worldWidth/5.2-Math.abs(x),worldDepth/5.2-Math.abs(z)),0,0.07);
    const u=position.getX(i)/worldWidth+0.5,v=position.getZ(i)/worldDepth+0.5;
    const slope=sampleField(m.slopes,m.width,m.height,u,v);
    const mask=THREE.MathUtils.smoothstep(slope,2,8);
    const ridge1=1-Math.abs(reliefNoise(x+12.7,z-4.3,21));
    const ridge2=1-Math.abs(reliefNoise(x-6.2,z+9.1,53));
    detail[i]=2.6*edge*(0.0045*(0.65*reliefNoise(x,z,32)+0.25*reliefNoise(x,z,90)+0.10*reliefNoise(x,z,175))+0.014*mask*(0.75*ridge1**3+0.25*ridge2**4-0.24));
  }
  surface.userData.detail=detail;
  surface.userData.raw = raw;
  surface.userData.surfaceColors = surfaceColors;
  terrainGroup.add(surface);
      // Procedural rocky dust texture
      const textureCanvas = document.createElement('canvas');
      textureCanvas.width = textureCanvas.height = 512;
      const texCtx = textureCanvas.getContext('2d');
      const tex = texCtx.createImageData(512, 512);

      let seed = 1234567;
      const rand = () =>
        ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);

      // Periodic value noise: opposing edges wrap to the same values.
      function tileableNoise(cells) {
        const grid = Float32Array.from({ length: cells * cells }, rand);

        return (u, v) => {
          const fx = u * cells;
          const fy = v * cells;
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const x0 = ((ix % cells) + cells) % cells;
          const y0 = ((iy % cells) + cells) % cells;
          const x1 = (x0 + 1) % cells;
          const y1 = (y0 + 1) % cells;

          let tx = fx - ix;
          let ty = fy - iy;
          tx = tx * tx * (3 - 2 * tx);
          ty = ty * ty * (3 - 2 * ty);

          const a = grid[y0 * cells + x0];
          const b = grid[y0 * cells + x1];
          const c = grid[y1 * cells + x0];
          const d = grid[y1 * cells + x1];

          return (a * (1 - tx) + b * tx) * (1 - ty)
            + (c * (1 - tx) + d * tx) * ty;
        };
      }

      const broad = tileableNoise(8);
      const medium = tileableNoise(32);
      const fine = tileableNoise(96);
      const micro = tileableNoise(192);

      for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) {
          const i = (y * 512 + x) * 4;
          const u = x / 512;
          const v = y / 512;

          const detail =
            75 * (broad(u, v) - 0.5) +
            55 * (medium(u, v) - 0.5) +
            35 * (fine(u, v) - 0.5) +
            18 * (micro(u, v) - 0.5);

          // Fine grain also wraps: a deterministic periodic pixel pattern.
          const grain = 18 * (rand() - 0.5);
          const brightness = Math.max(
            110, Math.min(255, Math.round(210 + detail + grain))
          );

          tex.data[i] = brightness;
          tex.data[i + 1] = Math.round(brightness * 0.96);
          tex.data[i + 2] = Math.round(brightness * 0.90);
          tex.data[i + 3] = 255;
        }
      }

      texCtx.putImageData(tex, 0, 0);

      const dustMap = new THREE.CanvasTexture(textureCanvas);

      dustMap.wrapS = THREE.RepeatWrapping;
      dustMap.wrapT = THREE.RepeatWrapping;
      dustMap.repeat.set(6, 6);
      dustMap.colorSpace = THREE.SRGBColorSpace;

      const solidMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: dustMap,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide
      });

      // Fractured bedrock: connected polygonal plates separated by narrow cracks.
      // Detail is procedural (no additional micro-rock meshes).
      const ROCK_PATCH_COVERAGE = 0.55;
      const ROCK_PATCH_STRENGTH = 0.78;
      const FRACTURE_DENSITY = 270.0; // higher = smaller connected stone plates

      const MICRO_STONE_DENSITY = 340.0; // small simulated stone chips, no extra meshes
      const MICRO_STONE_STRENGTH = 0.88; // subtle contrast on the rocky patches

      solidMat.onBeforeCompile = (shader) => {
        material.onBeforeCompile(shader);
        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `#include <common>
           varying vec2 vGravelXZ;
           varying float vGravelFlatness;`
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vGravelXZ = position.xz / 2.6;
           vGravelFlatness = abs(normal.y);`
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
           varying vec2 vGravelXZ;
           varying float vGravelFlatness;

           float gravelHash(vec2 p) {
             return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
           }
           vec2 gravelHash2(vec2 p) {
             return vec2(gravelHash(p + 1.7), gravelHash(p + 49.3));
           }
           float gravelNoise(vec2 p) {
             vec2 i = floor(p), f = fract(p);
             f = f * f * (3.0 - 2.0 * f);
             return mix(
               mix(gravelHash(i), gravelHash(i + vec2(1.0, 0.0)), f.x),
               mix(gravelHash(i + vec2(0.0, 1.0)), gravelHash(i + vec2(1.0, 1.0)), f.x),
               f.y
             );
           }
           // Voronoi edge distance: adjacent cells share the same boundary,
           // so stone plates fit together rather than forming isolated circles.
           vec3 fracturedStone(vec2 uv) {
             vec2 cell = floor(uv);
             vec2 f = fract(uv);
             float nearestD = 100.0;
             vec2 nearestVector = vec2(0.0);
             vec2 nearestCell = vec2(0.0);
             for (int y = -1; y <= 1; y++) {
               for (int x = -1; x <= 1; x++) {
                 vec2 offset = vec2(float(x), float(y));
                 vec2 id = cell + offset;
                 vec2 feature = offset + 0.20 + 0.60 * gravelHash2(id);
                 vec2 r = feature - f;
                 float d = dot(r, r);
                 if (d < nearestD) {
                   nearestD = d;
                   nearestVector = r;
                   nearestCell = id;
                 }
               }
             }
             float edge = 100.0;
             for (int y = -1; y <= 1; y++) {
               for (int x = -1; x <= 1; x++) {
                 vec2 offset = vec2(float(x), float(y));
                 vec2 id = cell + offset;
                 vec2 feature = offset + 0.20 + 0.60 * gravelHash2(id);
                 vec2 r = feature - f;
                 vec2 difference = r - nearestVector;
                 float dist = length(difference);
                 if (dist > 0.0001) {
                   edge = min(edge, dot(0.5 * (r + nearestVector), difference / dist));
                 }
               }
             }
             float tint = gravelHash(nearestCell + 19.0);
             return vec3(edge, tint, gravelHash(nearestCell + 67.0));
           }
          `
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           float patchNoise = 0.58 * gravelNoise(vGravelXZ * 4.7)
                            + 0.42 * gravelNoise(vGravelXZ * 11.3 + 7.1);
           float patchMask = smoothstep(0.43, 0.64, patchNoise + (${ROCK_PATCH_COVERAGE.toFixed(2)} - 0.5) * 0.26);
           float flatMask = smoothstep(0.70, 0.94, vGravelFlatness);
           float coverage = patchMask * flatMask * ${ROCK_PATCH_STRENGTH.toFixed(2)};

           vec2 rockyUV = vGravelXZ * ${FRACTURE_DENSITY.toFixed(1)};
           // Warp the grid slightly to make fractures less uniform.
           rockyUV += 0.15 * vec2(gravelNoise(rockyUV * 0.23 + 7.2) - 0.5,
                                   gravelNoise(rockyUV * 0.23 + 31.4) - 0.5);
           float pixelWidth = max(length(dFdx(rockyUV)), length(dFdy(rockyUV)));
           float detailFade = 1.0 - smoothstep(0.8, 2.0, pixelWidth);
           vec3 fracture = fracturedStone(rockyUV);
           float crackWidth = 0.015 + 0.007 * fracture.z;
           float aa = max(fwidth(fracture.x) * 1.2, 0.006);
           float stoneInterior = smoothstep(crackWidth - aa, crackWidth + aa, fracture.x);
           float edgeHighlight = smoothstep(crackWidth, crackWidth + 0.07, fracture.x)
                               - smoothstep(crackWidth + 0.07, crackWidth + 0.16, fracture.x);
           float stoneVariation = mix(0.82, 1.13, fracture.y);
           vec3 stoneTint = vec3(0.96, 0.92, 0.88) * stoneVariation;
           stoneTint += vec3(0.08, 0.065, 0.05) * edgeHighlight;
           vec3 crackTint = vec3(0.52, 0.47, 0.44);
           vec3 rockyTint = mix(crackTint, stoneTint, stoneInterior);
           float grit = gravelHash(floor(rockyUV * 4.0));
           rockyTint *= 0.96 + 0.08 * grit;
           diffuseColor.rgb *= mix(vec3(1.0), rockyTint, coverage * detailFade);

           // Tiny angular rock chips, rendered as surface shading only.
           // Cell jitter and varying sizes avoid a regular dotted pattern.
           vec2 chipUV = vGravelXZ * ${MICRO_STONE_DENSITY.toFixed(1)};
           vec2 chipCell = floor(chipUV);
           vec2 chipLocal = fract(chipUV);
           vec2 chipCenter = 0.22 + 0.56 * gravelHash2(chipCell + 103.0);
           vec2 chipOffset = chipLocal - chipCenter;
           float chipAngle = gravelHash(chipCell + 71.0) * 6.2831853;
           float ca = cos(chipAngle), sa = sin(chipAngle);
           vec2 rotated = vec2(ca * chipOffset.x - sa * chipOffset.y,
                               sa * chipOffset.x + ca * chipOffset.y);
           float chipSize = mix(0.20, 0.35, gravelHash(chipCell + 32.0));
           float chipShape = max(abs(rotated.x) * 0.92, abs(rotated.y) * 1.27);
           float chipAA = max(fwidth(chipShape), 0.008);
           float chip = 1.0 - smoothstep(chipSize - chipAA, chipSize + chipAA, chipShape);
           float chipPresence = step(0.16, gravelHash(chipCell + 9.0));
           float chipLight = gravelHash(chipCell + 17.0);
           float chipShade = mix(0.72, 1.28, chipLight);
           float chipRim = 1.0 - smoothstep(chipSize * 0.60, chipSize, chipShape);
           vec3 chipTint = mix(vec3(0.70, 0.72, 0.74), vec3(1.26, 1.16, 1.05), chipLight);
           chipTint *= chipShade + 0.11 * chipRim;
           float chipPixelWidth = max(length(dFdx(chipUV)), length(dFdy(chipUV)));
           float chipFade = 1.0 - smoothstep(0.95, 2.3, chipPixelWidth);
           float chipMask = chip * chipPresence * chipFade * coverage
                          * ${MICRO_STONE_STRENGTH.toFixed(2)};
           diffuseColor.rgb *= mix(vec3(1.0), chipTint, chipMask);
          `
        );
      };


      solidMat.toneMapped = false;
      solidMat.customProgramCacheKey = () => "mars-original-surface-v1";
      surface.userData.surfaceMaterial = solidMat;
      surface.userData.analysisMaterial = material;

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
function rebuildRocks() {
  disposeObject(surface.userData.rockGroup);
  surface.userData.rockGroup = null;
  if(state.mode !== "surface") return;
  const rockGroup = new THREE.Group();
  const geometry=surface.geometry, pos=geometry.attributes.position;
      let rockState = 24681357;
      const rockRandom = () =>
        ((rockState = (1664525 * rockState + 1013904223) >>> 0) / 4294967296);

      const rockGeometry = new THREE.IcosahedronGeometry(1, 0);
      const rockMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 1,
        metalness: 0,
        flatShading: true
      });
      const rockDummy = new THREE.Object3D();
      const rockTint = new THREE.Color();
      const grayStone = new THREE.Color(0x918780);
      const lightStone = new THREE.Color(0xc5a58b);
      const triangleIndices = geometry.index.array;
      const triangleCount = triangleIndices.length / 3;
      const vertexColor = new THREE.BufferAttribute(surface.userData.surfaceColors,3);

      // Favor flatter triangles: near-horizontal ground gets many stones,
      // while steep crater walls get very few. Use the actual mesh triangles.
      const edgeA = new THREE.Vector3();
      const edgeB = new THREE.Vector3();
      const faceNormal = new THREE.Vector3();
      function randomTerrainPoint(preferVeryFlat = false) {
        let triangle = 0;
        for (let attempt = 0; attempt < 120; attempt++) {
          triangle = Math.floor(rockRandom() * triangleCount) * 3;
          const a = triangleIndices[triangle];
          const b = triangleIndices[triangle + 1];
          const c = triangleIndices[triangle + 2];
          edgeA.set(pos.getX(b) - pos.getX(a), pos.getY(b) - pos.getY(a), pos.getZ(b) - pos.getZ(a));
          edgeB.set(pos.getX(c) - pos.getX(a), pos.getY(c) - pos.getY(a), pos.getZ(c) - pos.getZ(a));
          faceNormal.crossVectors(edgeA, edgeB).normalize();
          const flatness = Math.abs(faceNormal.y); // 1 = flat, 0 = vertical
          const flatPreference = THREE.MathUtils.smoothstep(flatness, 0.70, 0.98);
          const probability = preferVeryFlat
            ? 0.002 + 0.998 * Math.pow(flatPreference, 4)
            : 0.025 + 0.975 * flatPreference * flatPreference;
          if (rockRandom() < probability) break;
        }
        const ia = triangleIndices[triangle];
        const ib = triangleIndices[triangle + 1];
        const ic = triangleIndices[triangle + 2];
        let u = rockRandom();
        let v = rockRandom();
        if (u + v > 1) {
          u = 1 - u;
          v = 1 - v;
        }
        const wa = 1 - u - v;
        const wb = u;
        const wc = v;
        const x = wa * pos.getX(ia) + wb * pos.getX(ib) + wc * pos.getX(ic);
        const y = wa * pos.getY(ia) + wb * pos.getY(ib) + wc * pos.getY(ic);
        const z = wa * pos.getZ(ia) + wb * pos.getZ(ib) + wc * pos.getZ(ic);
        rockTint.setRGB(
          wa * vertexColor.getX(ia) + wb * vertexColor.getX(ib) + wc * vertexColor.getX(ic),
          wa * vertexColor.getY(ia) + wb * vertexColor.getY(ib) + wc * vertexColor.getY(ic),
          wa * vertexColor.getZ(ia) + wb * vertexColor.getZ(ib) + wc * vertexColor.getZ(ic)
        );
        return { x, y, z };
      }

      // Dense micro-gravel on flat ground. One InstancedMesh keeps draw calls low.
      // Toggle this to compare the appearance with the previous version.
      const ENABLE_MICRO_GRAVEL = true;
      const MICRO_GRAVEL_COUNT = 28000;

      // [number of rocks, minimum radius, maximum radius, maximum height multiplier]
      const rockGroups = [
        ...(ENABLE_MICRO_GRAVEL ? [[MICRO_GRAVEL_COUNT, 0.00022, 0.00065, 0.34]] : []),
        [5000, 0.0008, 0.0021, 0.52],
        [420, 0.0022, 0.0046, 0.65],
        [24, 0.0055, 0.0090, 0.78]
      ];

      for (const [count, minRadius, maxRadius, maxHeight] of rockGroups) {
        const isMicroGravel = count === MICRO_GRAVEL_COUNT && ENABLE_MICRO_GRAVEL;
        const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, count);
        for (let i = 0; i < count; i++) {
          const point = randomTerrainPoint(isMicroGravel);
          const radius = 2.6 * THREE.MathUtils.lerp(minRadius, maxRadius, rockRandom());
          const heightRatio = isMicroGravel
            ? 0.15 + rockRandom() * 0.18
            : 0.22 + rockRandom() * (maxHeight - 0.22);
          const rockHeight = radius * heightRatio;

          // The rock's center sits just below the actual triangle surface.
          rockDummy.position.set(
            point.x,
            point.y + rockHeight * 0.2,
            point.z
          );
          rockDummy.rotation.set(
            (rockRandom() - 0.5) * 0.25,
            rockRandom() * Math.PI * 2,
            (rockRandom() - 0.5) * 0.25
          );
          rockDummy.scale.set(radius, rockHeight, radius * (0.75 + rockRandom() * 0.55));
          rockDummy.updateMatrix();
          rocks.setMatrixAt(i, rockDummy.matrix);
          // Most stones match the terrain; a few are muted gray or lighter tan.
          // Keep the contrast restrained so the rocks blend into Mars.
          const stoneType = rockRandom();
          if (stoneType < (isMicroGravel ? 0.08 : 0.13)) {
            rockTint.lerp(grayStone, 0.45 + rockRandom() * 0.20);
          } else if (stoneType < (isMicroGravel ? 0.20 : 0.34)) {
            rockTint.lerp(lightStone, 0.25 + rockRandom() * 0.20);
          }
          rockTint.multiplyScalar(isMicroGravel
            ? 0.89 + rockRandom() * 0.13
            : 0.80 + rockRandom() * 0.18);
          rocks.setColorAt(i, rockTint);
        }
        rocks.instanceMatrix.needsUpdate = true;
        if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
        rocks.frustumCulled = false;
        rockGroup.add(rocks);
      }

  terrainGroup.add(rockGroup);
  surface.userData.rockGroup=rockGroup;
}

function updateRelief() {
  state.relief = +$("relief").value;
  $("relief-output").textContent = `${state.relief.toFixed(1)}×`;
  if (!surface) return;
  const positions = surface.geometry.attributes.position,
    raw = surface.userData.raw;
  for (let i = 0; i < positions.count; i++) positions.setY(i, terrainY(raw[i]) + (state.mode === "surface" ? surface.userData.detail[i] : 0));
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
  rebuildRocks();
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
  surface.material = state.mode === "surface" ? surface.userData.surfaceMaterial : surface.userData.analysisMaterial;
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
    if (state.mode === "surface") {
      const c = surface.userData.surfaceColors;
      colors.setXYZ(i,c[i*3],c[i*3+1],c[i*3+2]);
      continue;
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
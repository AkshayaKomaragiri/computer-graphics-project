import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const script = await readFile(
  new URL("../js/startup.js", import.meta.url),
  "utf8",
);
function harness(protocol = "http:") {
  const elements = new Map();
  for (const id of [
    "loading",
    "retry",
    "loading-spinner",
    "loading-title",
    "loading-message",
    "startup-help",
    "startup-details",
    "startup-error-details",
  ]) {
    const classes = new Set();
    elements.set(id, {
      hidden: false,
      textContent: "",
      classList: { add: (v) => classes.add(v) },
      setAttribute(name, value) {
        this[name] = value;
      },
    });
  }
  const listeners = new Map(),
    timers = new Map();
  let nextTimer = 0,
    reloads = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id) },
    location: {
      protocol,
      reload() {
        reloads++;
      },
    },
    window: {
      addEventListener(name, fn) {
        listeners.set(name, fn);
      },
      removeEventListener(name) {
        listeners.delete(name);
      },
    },
    setTimeout(fn) {
      const id = ++nextTimer;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  vm.runInContext(script, context);
  return {
    start: context.startMarsAtlas,
    elements,
    timers,
    listeners,
    reloads: () => reloads,
  };
}

test("direct file opening explains how to launch without trying blocked imports", async () => {
  const h = harness("file:");
  let requested = false;
  assert.equal(
    await h.start(() => {
      requested = true;
    }),
    false,
  );
  assert.equal(requested, false);
  assert.match(h.elements.get("loading-title").textContent, /launcher/);
  assert.equal(h.elements.get("startup-help").hidden, false);
  assert.equal(h.elements.get("loading-spinner").hidden, true);
  assert.equal(h.elements.get("retry").hidden, true);
  assert.equal(h.timers.size, 0);
});
test("a failed module request replaces the spinner with actionable recovery", async () => {
  const h = harness();
  assert.equal(
    await h.start(() => Promise.reject(new Error("Non-JavaScript MIME type"))),
    false,
  );
  assert.match(h.elements.get("loading-title").textContent, /Unable to load/);
  assert.match(h.elements.get("startup-error-details").textContent, /MIME/);
  assert.equal(h.elements.get("loading").role, "alert");
  assert.equal(h.elements.get("retry").hidden, false);
  assert.equal(h.elements.get("loading-spinner").hidden, true);
  assert.equal(h.timers.size, 0);
  h.elements.get("retry").onclick();
  assert.equal(h.reloads(), 1);
});
test("successful import waits for initialization and removes its watchdog", async () => {
  const h = harness();
  let initialized = false;
  assert.equal(
    await h.start(() =>
      Promise.resolve({
        async init() {
          initialized = true;
        },
      }),
    ),
    true,
  );
  assert.equal(initialized, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
});
test("initialization failure is caught even after imports succeed", async () => {
  const h = harness();
  assert.equal(
    await h.start(() => ({
      init() {
        throw new Error("WebGL unavailable");
      },
    })),
    false,
  );
  assert.match(h.elements.get("startup-error-details").textContent, /WebGL/);
  assert.equal(h.elements.get("loading-spinner").hidden, true);
});
test("an incomplete checkout reports a missing app entry point", async () => {
  const h = harness();
  assert.equal(await h.start(() => ({})), false);
  assert.match(
    h.elements.get("startup-error-details").textContent,
    /entry point is missing/,
  );
});
test("a stalled import displays recovery instead of an indefinite spinner", () => {
  const h = harness();
  h.start(() => new Promise(() => {}));
  for (const timeout of h.timers.values()) timeout();
  assert.match(h.elements.get("loading-title").textContent, /taking too long/);
  assert.equal(h.elements.get("startup-help").hidden, false);
  assert.equal(h.elements.get("retry").hidden, false);
  assert.equal(h.elements.get("loading-spinner").hidden, true);
});

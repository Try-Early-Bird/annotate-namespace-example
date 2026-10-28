/**
 * Start everything this sandbox needs, behind ONE port.
 *
 *   npm run sandbox
 *
 * WHY ONE PORT, AND NOT TWO. The obvious shape is the app on 8081 and the
 * protocol server on 4788, both exposed. It does not work in a devbox, and
 * the way it fails is worth keeping written down:
 *
 *   [annotate] GET …-p4788.devbox.so /health — network error (TypeError)
 *   [annotate] health check failed — overlay disabled
 *
 * Every devbox URL is authenticated — Namespace has `private` and
 * `workspace` access and nothing public. So `…-p4788` is BOTH a different
 * origin from `…-p8081` and behind an auth gate: the browser's request
 * meets a 401 carrying no CORS headers, and `fetch` reports a TypeError
 * that names neither auth nor CORS. The app loads; the overlay never
 * activates.
 *
 * So both live behind one public port:
 *
 *   :8081/__annotate/*  → the Annotate Protocol server
 *   :8081/view          → the panel: what has been sent, read back
 *   :8081/*             → Metro, for the app on the simulator
 *
 * Same origin, so the session cookie is first-party, there is no preflight,
 * and only one port needs exposing. The client accepts an endpoint with a
 * path (capability URLs carry them), so `/__annotate` is a legal base.
 *
 * A DEV CLIENT BUILD, ALWAYS — NEVER `expo start --web`.
 *
 * This used to offer a web target as the zero-setup demo. It is gone, and
 * not because it was merely degraded: on react-native-web you cannot
 * annotate AT ALL. Arming works, and then the tap is swallowed. Annotation
 * asks the React DevTools hook for `getInspectorDataForViewAtPoint`, which
 * is a React NATIVE renderer API; under react-dom the hook's renderer map
 * is empty, resolution returns null, and a null hit becomes a null
 * selection that every downstream gate is keyed on. No composer, no mark.
 *
 * So a web build cannot demonstrate this library, and shipping one as the
 * easy path only teaches people that the product does not work.
 *
 * A Namespace macOS devbox can run the real thing: the images ship Xcode
 * and the Apple simulators, and every macOS devbox has Remote Display
 * (VNC) — `nsc vnc <instance-id>`, or the dashboard. You watch the
 * simulator there and read the queue at <devbox>/view in a browser.
 *
 * The app talks to 127.0.0.1 rather than the devbox URL: it is a process on
 * the same machine, so it meets no auth gate and no CORS at all. The
 * exposed port is for the human's panel, and for Metro.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createVncBridge, probeVnc } from "./vnc-bridge.mjs";
import { createVncHub } from "./vnc-hub.mjs";
import { simulatorScreenRect } from "./sim-window.mjs";
import { listSimulators, appPath, moveApp, bootable } from "./simulators.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const PUBLIC_PORT = Number(process.env.PORT) || 8081;
const API_PORT = Number(process.env.API_PORT) || 4788;   // internal only
const METRO_PORT = Number(process.env.METRO_PORT) || 8082; // internal only
const PREFIX = "/__annotate";
const VNC_PORT = Number(process.env.VNC_PORT) || 5900;
const VNC_HOST = process.env.VNC_HOST || "127.0.0.1";
/** Screen Sharing usually wants one; without it noVNC can only prompt. */
const VNC_PASSWORD = process.env.VNC_PASSWORD || "";
/**
 * With it, VNC_PASSWORD is that macOS account's password (Apple's auth).
 * Without it, VNC_PASSWORD is the legacy VNC password, which has to be
 * switched on in Screen Sharing — the viewer then skips Apple's auth.
 */
const VNC_USER = process.env.VNC_USER || "";
/**
 * Type the password into the lock screen whenever the Mac locks. Only
 * meaningful when VNC_PASSWORD is ALSO the account's login password, which
 * is what `npm run devbox` arranges — so it is the one that switches it on.
 */
const AUTO_UNLOCK = process.env.AUTO_UNLOCK === "1";
/** Which simulator to build for, and whose window the viewer crops to. */
const DEVICE = process.env.SIMULATOR ?? "iPhone 17 Pro";
/**
 * The device the app is on NOW. It starts as DEVICE and changes when the
 * panel moves the app to another simulator. A UDID once known, because a
 * name can exist once per runtime.
 */
let current = { name: DEVICE, udid: null };
const APP_JSON = JSON.parse(readFileSync(resolve(here, "..", "app.json"), "utf8")).expo;
const BUNDLE_ID = APP_JSON.ios.bundleIdentifier;
/** What the panel's header names: the app, and the branch it is built from. */
const APP = {
  name: APP_JSON.slug ?? APP_JSON.name,
  branch: spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: resolve(here, ".."), encoding: "utf8" })
    .stdout?.trim() || null,
};
/**
 * Pin the crop instead of discovering it: `SCREEN_RECT="x,y,w,h"`.
 *
 * Finding the device screen needs Accessibility permission, which a devbox
 * may simply refuse, and there is no way to grant it from a shell. Without
 * an override the only recourse would be an uncropped desktop, so this is
 * the escape hatch: read the rect once by any means and pin it.
 */
const SCREEN_RECT = (() => {
  const raw = process.env.SCREEN_RECT;
  if (!raw) return null;
  const [x, y, width, height] = raw.split(",").map((n) => Number(n.trim()));
  if (![x, y, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) {
    console.error(`  SCREEN_RECT="${raw}" is not "x,y,w,h" — ignoring it`);
    return null;
  }
  return { x, y, width, height };
})();

/** The built panel, served at /view. */
const PANEL_DIR = resolve(here, "..", "panel", "dist");

/** Where noVNC's ES modules live, served read-only under /vnc/. */
const NOVNC_DIR = resolve(here, "..", "node_modules", "@novnc", "novnc");

/** The URL the outside world uses for this devbox's public port. */
function publicUrl(port) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
  const expose = spawnSync("boxctl", ["url", "expose", "--port", String(port), "--access", "workspace"],
    { encoding: "utf8", timeout: 60_000 });
  if (!expose.error) {
    const got = spawnSync("boxctl", ["url", "get", "--port", String(port)], { encoding: "utf8", timeout: 60_000 });
    const url = /https:\/\/\S+/.exec(`${got.stdout ?? ""}${expose.stdout ?? ""}`)?.[0];
    if (url) return url.replace(/\/+$/, "");
  }
  return `http://localhost:${port}`;
}

/**
 * Refuse to start on a port someone else already holds.
 *
 * A leftover `npm run sandbox` is the likeliest thing to go wrong on a
 * second run, and without this the failure is unreadable: `expo run:ios`
 * finds a bundler already on its port, launches the app, exits 0, and the
 * supervisor below tears the whole sandbox down — so the symptom is
 * everything quitting seconds after a SUCCESSFUL build.
 */
async function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "0.0.0.0");
  });
}

for (const [port, what] of [
  [PUBLIC_PORT, "the front door"],
  [API_PORT, "the protocol server"],
  [METRO_PORT, "Metro"],
]) {
  if (!(await portFree(port))) {
    console.error(`\n  Port ${port} is taken, and ${what} needs it.`);
    console.error(`  Most likely a previous run is still going. Find it with:`);
    console.error(`    lsof -nP -iTCP:${port} -sTCP:LISTEN\n`);
    process.exit(1);
  }
}

const origin = publicUrl(PUBLIC_PORT);
/** boxctl exists only on a devbox, which sits behind Namespace's auth gate. */
const onDevbox = !spawnSync("boxctl", ["--help"], { stdio: "ignore", timeout: 10_000 }).error;

// The simulator is ON this machine, so it uses the loopback address: no auth
// gate to pass, and no round trip out to the devbox URL and back.
const endpoint = `http://127.0.0.1:${PUBLIC_PORT}${PREFIX}`;

// Can the browser be shown the screen, or only told where to find it? A
// plain TCP connect: enough to choose, and it does not need the password.
const vncUp = await probeVnc({ host: VNC_HOST, port: VNC_PORT });

console.log(`\n  app       iOS Simulator`);
console.log(`  protocol  ${endpoint}`);
console.log(`  panel     ${origin}/view`);
if (vncUp) {
  console.log(`  screen    embedded in the panel (VNC ${VNC_HOST}:${VNC_PORT})`);
  if (!VNC_PASSWORD) {
    console.log(`            no VNC_PASSWORD set — if the screen stays black, set it`);
  } else if (!VNC_USER) {
    console.log(`            using VNC_PASSWORD as a plain VNC password — Screen`);
    console.log(`            Sharing must have that switched on (see the README)`);
  }
} else {
  console.log(`  screen    NOT embedded — nothing on ${VNC_HOST}:${VNC_PORT}`);
  console.log(`            watch it with \`nsc vnc <instance-id>\` instead, or enable`);
  console.log(`            Screen Sharing and restart to get it in the panel`);
}
console.log("");

const children = [];
/** label -> "running" | "finished" | "failed (N)", for the panel. */
const processState = {};
const run = (label, cmd, args, env) => {
  const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  processState[label] = "running";
  child.on("exit", (code) => {
    processState[label] = code ? `failed (${code})` : "finished";
    // A crash takes everything with it — a half-running sandbox is worse
    // than none, because the failure shows up later and somewhere else.
    if (code) {
      console.error(`\n${label} exited (${code}) — shutting the rest down.`);
      for (const c of children) if (c !== child) c.kill();
      process.exit(code);
    }
    // A CLEAN exit is not a failure and must not kill the panel. `expo
    // run:ios` ends this way when it hands off to a bundler it did not
    // start; the app is installed and running, and the front door still has
    // a job to do.
    console.error(`\n${label} finished. The panel is still up.`);
  });
  children.push(child);
};

run("protocol server", process.execPath,
  ["server/stub-server.mjs", "--port", String(API_PORT)], { PUBLIC_ORIGIN: endpoint, HOST: "127.0.0.1" });

// Expo AFTER the endpoint is known: EXPO_PUBLIC_* is inlined at bundle
// time, so setting it later would change nothing.
const appEnv = {
  EXPO_PUBLIC_ANNOTATE_ENDPOINT: endpoint,
  EXPO_PUBLIC_ANNOTATE_SESSION_ID: process.env.SESSION_ID ?? "sandbox-session",
};

{
  // `run:ios` prebuilds ios/ if it is missing, compiles, installs on a booted
  // simulator and starts Metro itself — so there is no separate `expo start`.
  // The first build is slow (CocoaPods, then a full compile); later ones hit
  // DerivedData. Nothing here is annotate-specific: it is an ordinary dev
  // build, which is the point.
  // THE FRONT DOOR IS THE APP'S BUNDLER, and that is why PORT must stay 8081.
  //
  // `expo run:ios --port N` moves where Metro BINDS but does not bake
  // RCT_METRO_PORT into the binary — it is absent from the generated
  // pbxproj — so the built app always asks localhost:8081 for its bundle.
  // Run the front door anywhere else and the app comes up on a redbox:
  //
  //   No script URL provided.  unsanitizedScriptURLString = (null)
  //
  // It needs no fixing, because the front door already proxies `/` and
  // WebSocket upgrades to Metro: the app asks :8081 for the bundle, the
  // front door hands it to Metro on :8082, and HMR rides the same path.
  // One port serves the bundler, the protocol server and the panel.
  // By UDID, not name: see `bootable`. If nothing boots, the name goes to
  // expo anyway, so its own error is what the terminal shows.
  bootable(DEVICE, (line) => console.log(`  ${line}`))
    .catch(() => null)
    .then((sim) => {
      if (sim) current = { name: sim.name, udid: sim.udid };
      else console.log(`  no simulator would boot — \`xcrun simctl list devices\` shows what there is`);
      const target = sim ? `${sim.name} (${sim.runtime})` : DEVICE;
      console.log(`  building the dev build for "${target}" — the first one takes a while\n`);
      run("expo run:ios", "npx",
        ["expo", "run:ios", "--device", sim?.udid ?? DEVICE, "--port", String(METRO_PORT)], appEnv);
    });
}

const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};
function contentType(file) {
  const dot = file.lastIndexOf(".");
  return (dot >= 0 && CONTENT_TYPES[file.slice(dot)]) || "application/octet-stream";
}

/**
 * The viewer's URL, carrying the password when there is one.
 *
 * It is a query parameter because noVNC's only other route is a prompt, and
 * a prompt inside a phone-sized iframe is unusable. This is a local
 * development password behind the devbox's own auth gate, on the same origin
 * as everything else here — but it is still a secret in a URL, which is why
 * it is opt-in via VNC_PASSWORD rather than discovered and forwarded.
 */
function screenSrc() {
  const params = new URLSearchParams();
  if (VNC_USER) params.set("username", VNC_USER);
  if (VNC_PASSWORD) params.set("password", VNC_PASSWORD);
  if (VNC_PASSWORD && AUTO_UNLOCK) params.set("unlock", "1");
  const query = params.toString();
  return query ? `/vnc?${query}` : "/vnc";
}

let lastUnlock = 0;

/** Tell macOS a user is active: the display wakes and idle timers restart. */
function wake() {
  spawn("caffeinate", ["-u", "-t", "2"], { stdio: "ignore" }).on("error", () => {});
}

// Every minute, so the Mac is never idle long enough to sleep the display
// or lock. Settings and `caffeinate -d` should already see to that; on a
// devbox they have not always, and a locked screen with a frozen picture
// is the result. Only with a screen to show — it is for the viewer's sake.
if (vncUp) setInterval(wake, 60_000).unref();

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

/** GET a JSON path on the protocol server, with how long it took. */
function apiGet(path, timeout = 2000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port: API_PORT, path, timeout }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try { resolve({ ok: res.statusCode === 200, ms: Date.now() - started, body: JSON.parse(raw) }); }
        catch { resolve({ ok: false, ms: Date.now() - started, body: null }); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ ok: false, ms: Date.now() - started, body: null }));
    req.end();
  });
}

/**
 * Which simulator the app is on: the known UDID if there is one, else a
 * booted device with DEVICE's name — which is where `expo run:ios` put it.
 */
async function currentSimulator(devices) {
  const found = (current.udid && devices.find((d) => d.udid === current.udid))
    || devices.find((d) => d.name === current.name && d.state === "Booted")
    || null;
  if (found) current = { name: found.name, udid: found.udid };
  return found;
}

let switching = null;
async function switchDevice(udid) {
  if (switching) throw new Error("already switching devices");
  const devices = await listSimulators();
  const to = devices.find((d) => d.udid === udid);
  if (!to) throw new Error("no such simulator on this Mac");
  const from = await currentSimulator(devices);
  if (!from) throw new Error(`${current.name} is not booted — wait for the build to finish`);
  if (from.udid === to.udid) return;
  switching = moveApp({ from, to, bundleId: BUNDLE_ID });
  try {
    await switching;
    current = { name: to.name, udid: to.udid };
    console.log(`  moved the app to ${to.name} (${to.runtime})`);
  } finally {
    switching = null;
  }
}

async function sandboxStatus() {
  const [devices, health, info] = await Promise.all([
    listSimulators().catch(() => []),
    apiGet("/health"),
    apiGet("/info"),
  ]);
  const sim = await currentSimulator(devices);
  const installed = sim ? Boolean(await appPath(sim.udid, BUNDLE_ID)) : false;
  const expo = processState["expo run:ios"];
  return {
    app: APP,
    build: {
      // run:ios stays up as Metro once the app is installed, so "running"
      // alone does not say whether the build is done; the install does.
      state: switching ? "switching" : installed ? "installed" : expo === "running" ? "building" : expo ?? "starting",
      bundleId: BUNDLE_ID,
    },
    simulator: sim,
    screen: { embedded: vncUp, src: vncUp ? screenSrc() : null, pinned: Boolean(SCREEN_RECT), autoUnlock: AUTO_UNLOCK },
    protocol: {
      endpoint,
      path: PREFIX,
      session: appEnv.EXPO_PUBLIC_ANNOTATE_SESSION_ID,
      ok: health.ok && health.body?.status === "ok",
      version: health.body?.protocolVersion ?? null,
      ms: health.ms,
      state: processState["protocol server"] ?? "starting",
    },
    storage: info.body?.storage ?? null,
    agent: info.body?.agent ?? null,
  };
}

/** Hand a request to one of the two servers, unchanged apart from the prefix. */
/**
 * WHO MAY USE THE FRONT DOOR FROM A BROWSER.
 *
 * Everything goes through this door: the panel, the screen, the agent's
 * routes. A page you happen to visit can send requests to localhost too,
 * so two checks come before anything is served:
 *
 * - Off a devbox, the Host must be localhost or an IP address. A page that
 *   points its own domain at 127.0.0.1 (DNS rebinding) would otherwise be
 *   "same-site" with this door. On a devbox, Namespace's proxy and its
 *   sign-in are in front, and the Host is the devbox's own name.
 * - A request that CHANGES something (anything but GET, HEAD and OPTIONS),
 *   and every WebSocket (the screen, Metro), must come from this door's own
 *   origin or from no browser at all: the app sends no Origin, or its own.
 *   Reads are covered by the stub sending no CORS headers, so another
 *   site's page cannot read what it gets back.
 */
function refused(req, { writes }) {
  const host = req.headers.host ?? "";
  if (!onDevbox) {
    const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    if (name && name !== "localhost" && isIP(name) === 0) return "unexpected Host";
  }
  const from = req.headers.origin;
  if (!from || !writes) return null;
  if (from === "null") return "opaque origin";
  try {
    return new URL(from).host === host ? null : "cross-site request";
  } catch {
    return "bad Origin";
  }
}

const proxy = (req, res) => {
  const no = refused(req, { writes: !["GET", "HEAD", "OPTIONS"].includes(req.method) });
  if (no) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`refused: ${no}\n`);
    return;
  }
  // The shell is served BY the devbox, so its <iframe src="/"> is resolved
  // against the devbox's own origin — same origin, so the session cookie
  // goes with it and nothing is blocked. A shell served from a laptop
  // cannot do this: the browser resolves the frame against the laptop.
  //
  // Expo stays at "/" rather than under a prefix, because its web build
  // assumes it owns the root and rewriting every asset path to please a
  // wrapper is a worse trade than giving the wrapper its own address.
  // Where to crop the desktop down to. Polled rather than resolved once:
  // the window does not exist while the app is still building, and it can
  // be moved afterwards. Null means "show the desktop as it is" — a wrong
  // crop would hide the app, an uncropped desktop is merely ugly.
  // The lock screen is the viewer's call, from the pixels it is shown.
  if (req.url === "/screen-rect") {
    return Promise.resolve(SCREEN_RECT ?? simulatorScreenRect(current.name))
      .then((rect) => {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(rect));
      })
      .catch(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("null");
      });
  }

  // What the panel shows about the sandbox itself: the simulator, the
  // build, the screen, and the protocol server and its agent.
  if (req.url === "/sandbox/status" && req.method === "GET") {
    return sandboxStatus().then((body) => sendJson(res, 200, body));
  }
  if (req.url === "/sandbox/devices" && req.method === "GET") {
    return listSimulators()
      .then((devices) => sendJson(res, 200, devices))
      .catch((err) => sendJson(res, 500, { error: err.message }));
  }
  // Wake the display. Asleep, it stops sending frames, so the viewer shows
  // the last one — a lock screen with a clock minutes behind — and clicks
  // and keys look like they do nothing. `caffeinate -u` declares a user
  // active, which turns it back on. The viewer calls this before it signs
  // in, and while the screen looks locked.
  // Who signs in at the lock screen. Every open tab sees it, and two typing
  // the password at once would interleave the keys into a wrong one — so
  // the first to ask in any 20 seconds gets to, and the rest stand by.
  // Who is signed in at the Mac's screen, and what the login window said
  // lately, as plain text for a browser tab: the terminal is usually busy
  // running this sandbox, and this is what you need when the screen sits
  // at a login window that will not let you in.
  if (req.url === "/sandbox/diagnostics" && req.method === "GET") {
    const sh = (cmd, args) => String(spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 }).stdout ?? "").trim();
    const console_ = sh("stat", ["-f", "%Su", "/dev/console"]);
    const log = sh("log", ["show", "--last", "5m", "--style", "compact", "--predicate", 'process == "loginwindow"'])
      .split("\n")
      // Every app launch and exit is logged too; that is noise here.
      // Match on the message, not the "com.apple.loginwindow" prefix every
      // line carries.
      .filter((l) => {
        const [where, ...rest] = l.split(" | ");
        return /log ?in|log ?out|session|fail|error|auth|password/i.test(rest.join(" | "))
          && !/ApplicationManager|\[Application |PersistentAppsSupport/.test(where);
      })
      .slice(-40).join("\n");
    const body = [
      `signed in at the screen: ${console_ === "root" ? "nobody (root — the login window)" : console_}`,
      `auto-login user: ${sh("defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"]) || "none"}`,
      `FileVault: ${sh("fdesetup", ["status"])}`,
      `screen sharing connection: ${vnc ? "up" : "none"}`,
      "",
      "loginwindow, last 5 minutes:",
      log || "(nothing matching)",
    ].join("\n");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(body + "\n");
  }

  if (req.url === "/sandbox/unlock" && req.method === "POST") {
    const ok = Date.now() - lastUnlock > 20_000;
    if (ok) lastUnlock = Date.now();
    return sendJson(res, 200, { ok });
  }

  if (req.url === "/sandbox/wake" && req.method === "POST") {
    wake();
    return sendJson(res, 200, { ok: true });
  }

  if (req.url === "/sandbox/device" && req.method === "POST") {
    return readJson(req).then((body) => switchDevice(body?.udid))
      .then(() => sendJson(res, 200, { name: current.name, udid: current.udid }))
      .catch((err) => sendJson(res, 409, { error: err.message }));
  }

  // The viewer page and noVNC's modules. Served from node_modules rather
  // than copied in, so the version in package.json is the version running.
  if (req.url === "/vnc" || req.url === "/vnc/" || req.url.startsWith("/vnc?")) {
    return readFile(join(here, "..", "public", "vnc.html"), "utf8")
      .then((html) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      })
      .catch(() => { res.writeHead(500); res.end("vnc.html missing"); });
  }
  if (req.url.startsWith("/vnc/")) {
    // Resolve, then prove the result is still inside noVNC's directory: the
    // path comes from a URL, and `../` in it must not reach the filesystem.
    const rel = normalize(decodeURIComponent(req.url.slice("/vnc/".length).split("?")[0]));
    const file = resolve(NOVNC_DIR, rel);
    if (file !== NOVNC_DIR && !file.startsWith(NOVNC_DIR + sep)) {
      res.writeHead(403); res.end("outside the viewer");
      return;
    }
    return readFile(file)
      .then((body) => {
        res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-cache" });
        res.end(body);
      })
      .catch(() => { res.writeHead(404); res.end("not found"); });
  }

  // The panel: a React app in panel/, built to panel/dist by `npm install`.
  // It learns where the screen is from /sandbox/status, so it is served as
  // built. Assets are content-hashed and cached; index.html never is, so a
  // rebuild shows up on the next reload.
  if (req.url === "/view" || req.url.startsWith("/view?") || req.url.startsWith("/view/")) {
    const rel = normalize(decodeURIComponent(req.url.slice("/view".length).split("?")[0])).replace(/^[/\\]+/, "");
    const file = resolve(PANEL_DIR, rel || "index.html");
    if (file !== PANEL_DIR && !file.startsWith(PANEL_DIR + sep)) {
      res.writeHead(403); res.end("outside the panel");
      return;
    }
    const asset = rel.startsWith("assets/");
    return readFile(asset ? file : join(PANEL_DIR, "index.html"))
      .then((body) => {
        res.writeHead(200, {
          "Content-Type": asset ? contentType(file) : "text/html; charset=utf-8",
          "Cache-Control": asset ? "public, max-age=31536000, immutable" : "no-cache",
        });
        res.end(body);
      })
      .catch(() => {
        if (asset) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("The panel is not built. Run `npm install` (it builds panel/), or `npm run panel:build`.\n");
      });
  }
  const toApi = req.url === PREFIX || req.url.startsWith(`${PREFIX}/`);
  const target = {
    host: "127.0.0.1",
    port: toApi ? API_PORT : METRO_PORT,
    path: toApi ? req.url.slice(PREFIX.length) || "/" : req.url,
    method: req.method,
    headers: req.headers,
  };
  const upstream = httpRequest(target, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    // A dev server that is still booting is the common case, and a bare
    // socket hangup tells the reader nothing.
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`upstream ${toApi ? "protocol server" : "Metro"} not reachable: ${err.message}\n`);
  });
  req.pipe(upstream);
};

const front = createServer(proxy);

// TWO kinds of WebSocket now come through this door, and they must not be
// confused: Metro's HMR, and the browser's VNC stream. Route by path before
// anything else — handing an RFB stream to Metro would hang the screen with
// no error on either side.
// One shared connection to the Mac for every viewer (vnc-hub.mjs), so a
// second tab sees the same session rather than a login window. Not with
// VNC_USER: Apple's own auth is the relay's, through noVNC. VNC_SHARED=0
// goes back to one connection per tab.
const shared = !VNC_USER && process.env.VNC_SHARED !== "0";
const vnc = !vncUp ? null : shared
  ? createVncHub({ host: VNC_HOST, port: VNC_PORT, password: VNC_PASSWORD, onLog: (m) => console.error(m) })
  : createVncBridge({ host: VNC_HOST, port: VNC_PORT, onLog: (m) => console.error(m) });

front.on("upgrade", (req, socket, head) => {
  if (refused(req, { writes: true })) { socket.destroy(); return; }
  if (req.url === "/websockify" || req.url.startsWith("/websockify?")) {
    if (!vnc) { socket.destroy(); return; }
    vnc.handleUpgrade(req, socket, head);
    return;
  }
  const upstream = httpRequest({
    host: "127.0.0.1", port: METRO_PORT, path: req.url, method: req.method,
    headers: req.headers,
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
      `\r\n\r\n`);
    if (upHead?.length) socket.unshift(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  upstream.on("error", () => socket.destroy());
  if (head?.length) upstream.write(head);
  upstream.end();
});

/**
 * Off a devbox, the front door listens on this machine only. It serves the
 * screen and, with VNC_PASSWORD set, hands the panel the password to drive
 * it, so on a laptop every device on the same Wi-Fi could otherwise take
 * over the Mac. On a devbox it has to be reachable by Namespace's proxy,
 * which is where the authentication happens. HOST overrides either.
 */
const BIND = process.env.HOST || (onDevbox ? "0.0.0.0" : "127.0.0.1");
front.listen(PUBLIC_PORT, BIND, () => console.log(`  open      ${origin}/view\n`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { for (const c of children) c.kill(signal); process.exit(0); });
}

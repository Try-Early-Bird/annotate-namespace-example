/**
 * Which simulators this Mac can run, and moving the app from one to another.
 *
 * The panel offers a device picker, and the list it offers has to be what
 * THIS machine has: a devbox image ships some runtimes and device types and
 * not others, and a name like "iPhone 17 Pro" can exist once per runtime.
 * So everything is keyed by UDID, and the list comes from simctl each time.
 *
 * Switching does NOT rebuild. A simulator build runs on any iOS simulator
 * new enough for its deployment target, so the .app already installed on
 * the current device is copied to the next one and launched there. A debug
 * build asks localhost:8081 for its bundle, which is the front door, so the
 * new device comes up on the same Metro with nothing else to do.
 */
import { execFile } from "node:child_process";

const BUNDLE_TIMEOUT_MS = 120_000;

function simctl(args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile("xcrun", ["simctl", ...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(String(stdout));
    });
  });
}

/**
 * Devices that have failed to boot, for as long as the sandbox runs. They
 * stay out of the picker and out of `bootable`, so one bad device costs one
 * failed boot, not one per switch.
 */
const broken = new Set();

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-5" → "iOS 26.5" */
function runtimeName(id) {
  const m = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(id);
  return m ? `${m[1]} ${m[2].replace(/-/g, ".")}` : id;
}

/**
 * Every available iOS simulator, iPhones first, newest runtime first.
 * Other platforms (watchOS, tvOS, visionOS) are left out: the app is an
 * iOS build and would not install there.
 */
export async function listSimulators() {
  const [{ devices }, { runtimes }] = await Promise.all([
    simctl(["list", "devices", "available", "-j"]).then(JSON.parse),
    simctl(["list", "runtimes", "available", "-j"]).then(JSON.parse),
  ]);
  // "available" on a device is not enough: simctl lists devices whose
  // runtime build is no longer installed, and they fail to boot with
  // "cannot determine the runtime bundle". Keep only devices on a runtime
  // simctl lists as installed, and none that have already failed to boot.
  const installed = new Set(runtimes.map((r) => r.identifier));
  const out = [];
  for (const [runtime, list] of Object.entries(devices)) {
    if (!/SimRuntime\.iOS-/.test(runtime) || !installed.has(runtime)) continue;
    for (const d of list) {
      if (broken.has(d.udid)) continue;
      out.push({
        udid: d.udid,
        name: d.name,
        runtime: runtimeName(runtime),
        state: d.state,
        kind: /iPad/.test(d.name) ? "iPad" : "iPhone",
      });
    }
  }
  const version = (r) => r.split(" ")[1].split(".").map(Number);
  return out.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === "iPhone" ? -1 : 1)
    || version(b.runtime)[0] - version(a.runtime)[0]
    || version(b.runtime)[1] - version(a.runtime)[1]
    || a.name.localeCompare(b.name));
}

/**
 * A simulator called `name` that actually boots, booted, or null.
 *
 * A name is not enough to hand to `expo run:ios`. A devbox image can list
 * a device whose runtime is gone ("Unable to boot device because we cannot
 * determine the runtime bundle") next to a healthy one of the same name,
 * and expo picks the first. So try them, newest runtime first, then any
 * other iPhone, and give expo the UDID of the one that booted.
 */
export async function bootable(name, log = () => {}) {
  const devices = await listSimulators();
  const named = devices.filter((d) => d.name === name);
  const candidates = [
    ...named.filter((d) => d.state === "Booted"),
    ...named.filter((d) => d.state !== "Booted"),
    ...devices.filter((d) => d.name !== name && d.kind === "iPhone"),
  ];
  for (const d of candidates) {
    if (d.state === "Booted") return d;
    try {
      await simctl(["boot", d.udid], BUNDLE_TIMEOUT_MS);
      return d;
    } catch (err) {
      if (/current state: Booted/i.test(err.message)) return d;
      broken.add(d.udid);
      log(`${d.name} (${d.runtime}, ${d.udid}) will not boot: ${err.message.split("\n").pop()}`);
    }
  }
  return fresh(name, log);
}

/**
 * When no existing device boots, make one: `name` on each iOS runtime that
 * can run it, newest first, until one boots. A device that will not boot
 * is deleted again, so a failed attempt leaves nothing behind for expo to
 * pick by name next time.
 */
async function fresh(name, log) {
  const { runtimes } = JSON.parse(await simctl(["list", "runtimes", "available", "-j"]));
  const ios = runtimes
    .filter((r) => r.platform === "iOS" || /SimRuntime\.iOS-/.test(r.identifier))
    .filter((r) => !r.supportedDeviceTypes || r.supportedDeviceTypes.some((t) => t.name === name))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  for (const r of ios) {
    let udid;
    try {
      udid = (await simctl(["create", name, name, r.identifier])).trim();
      await simctl(["boot", udid], BUNDLE_TIMEOUT_MS);
      log(`created ${name} on iOS ${r.version} (${udid})`);
      return { udid, name, runtime: `iOS ${r.version}`, state: "Booted", kind: /iPad/.test(name) ? "iPad" : "iPhone" };
    } catch (err) {
      log(`${name} on iOS ${r.version} will not boot: ${err.message.split("\n").pop()}`);
      if (udid) await simctl(["delete", udid]).catch(() => {});
    }
  }
  return null;
}

/** Where the app is installed on a device, or null if it is not. */
export async function appPath(udid, bundleId) {
  try {
    return (await simctl(["get_app_container", udid, bundleId, "app"])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Put the app on `to` and shut `from` down.
 *
 * Shutting the old device down is not tidiness: the viewer crops to the
 * Simulator window whose title names the device, and two device windows on
 * one desktop would leave it showing whichever it found first.
 */
export async function moveApp({ from, to, bundleId }) {
  const app = await appPath(from.udid, bundleId);
  if (!app) throw new Error(`the app is not installed on ${from.name} yet — wait for the build to finish`);
  await simctl(["boot", to.udid]).catch((err) => {
    // Booting a booted device is the one failure that is not a failure.
    if (/current state: Booted/i.test(err.message)) return;
    broken.add(to.udid);
    throw new Error(`${to.name} (${to.runtime}) will not boot: ${err.message.split("\n").pop()}`);
  });
  // Bring its window up in Simulator.app, which is what the screen shows.
  await new Promise((resolve) =>
    execFile("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", to.udid], () => resolve()));
  await simctl(["bootstatus", to.udid], BUNDLE_TIMEOUT_MS).catch(() => {});
  await simctl(["install", to.udid, app], BUNDLE_TIMEOUT_MS);
  await simctl(["launch", to.udid, bundleId]);
  if (from.udid !== to.udid) await simctl(["shutdown", from.udid]).catch(() => {});
}

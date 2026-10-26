/**
 * Where the simulator's SCREEN is on the Mac's desktop.
 *
 * VNC streams a whole desktop. Dropping that into a phone frame shows a
 * desktop with a phone somewhere in it, which is not what anyone wants to
 * look at, so the viewer crops — and this is how it learns what to crop to.
 *
 * The Simulator window is not the answer: it carries a title bar and a
 * margin around the device. Inside it, the accessibility tree has an
 * AXGroup that IS the device screen, and its aspect ratio gives it away —
 * 383x833 against an iPhone 17 Pro's 402x874 logical points is the same
 * shape to three decimals. That group's rect, in global screen
 * coordinates, is exactly the region to show.
 *
 * Everything here is best-effort. Reading it needs Accessibility
 * permission, the window may not exist yet while the app is still
 * building, and a devbox may refuse the whole thing — so every failure
 * returns null and the viewer falls back to showing the desktop uncropped.
 * A wrong crop would hide the app completely; an uncropped desktop is at
 * least honest.
 */
import { execFile } from "node:child_process";

/**
 * AppleScript that prints "x y w h" for the device screen inside the
 * Simulator window whose title names this device.
 *
 * The title is `iPhone 17 Pro – iOS 26.3` — note the EN DASH — so it is
 * matched with `contains` on the device name rather than equality.
 */
function script(deviceName) {
  const name = String(deviceName).replace(/["\\]/g, "");
  // Parallel lists, joined with "|", rather than `whose role is "AXGroup"`.
  // That filter is what AppleScript rejects with `AppleEvent handler failed
  // (-10000)` against Simulator's UI elements — asking for the three
  // attributes as plain lists always works, and picking from them is
  // JavaScript's job anyway.
  return `
    tell application "System Events"
      if not (exists process "Simulator") then return "no-process"
      tell process "Simulator"
        set candidates to (every window whose name contains "${name}")
        if (count of candidates) is 0 then return "no-window"
        set w to item 1 of candidates
        set AppleScript's text item delimiters to ","
        set r to (role of UI elements of w) as string
        set p to (position of UI elements of w) as string
        set z to (size of UI elements of w) as string
        return r & "|" & p & "|" & z
      end tell
    end tell`;
}

/**
 * Pick the device screen out of a window's UI elements.
 *
 * The screen is an AXGroup, and on a window that has several the right one
 * is the largest — the others are toolbars and buttons, which are small.
 */
function largestGroup(roles, positions, sizes) {
  let best = null;
  for (let i = 0; i < roles.length; i++) {
    if (roles[i] !== "AXGroup") continue;
    const rect = {
      x: positions[i * 2],
      y: positions[i * 2 + 1],
      width: sizes[i * 2],
      height: sizes[i * 2 + 1],
    };
    if (!(rect.width > 0) || !(rect.height > 0)) continue;
    if (!best || rect.width * rect.height > best.width * best.height) best = rect;
  }
  return best;
}

/**
 * The device screen's rect in desktop coordinates, or null.
 *
 * These are POINTS. The VNC framebuffer is not necessarily: with the
 * legacy VNC password a Retina devbox serves its backing PIXELS (2560x1600
 * for a 1280x800-point desktop), and a points rect laid on that lands at
 * half the right place — on wallpaper. So the desktop's own size in points
 * rides along as `desktop`, and the viewer scales by framebuffer width over
 * desktop width, which is right whichever unit the server chose. A second
 * display would break this; a devbox has one.
 */
export function simulatorScreenRect(deviceName, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script(deviceName)], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout).trim();
      if (!out.includes("|")) return resolve(null); // "no-process" / "no-window"
      const [roleStr, posStr, sizeStr] = out.split("|");
      const roles = roleStr.split(",").map((t) => t.trim());
      const positions = posStr.split(",").map(Number);
      const sizes = sizeStr.split(",").map(Number);
      if (positions.length !== roles.length * 2 || sizes.length !== roles.length * 2) {
        return resolve(null);
      }
      if (positions.some((n) => !Number.isFinite(n)) || sizes.some((n) => !Number.isFinite(n))) {
        return resolve(null);
      }
      const rect = largestGroup(roles, positions, sizes);
      if (!rect) return resolve(null);
      desktopSize().then((desktop) => resolve(desktop ? { ...rect, desktop } : rect));
    });
  });
}

let desktop = null;

/**
 * The main display's size in points, or null. Cached once known: it does
 * not change under a running sandbox, and this is polled every two seconds.
 *
 * NSScreen through JXA rather than Finder's desktop bounds, because asking
 * Finder needs an Automation grant that a devbox has no way to click
 * through.
 */
function desktopSize(timeoutMs = 4000) {
  if (desktop) return Promise.resolve(desktop);
  const js = "ObjC.import('AppKit'); const f = $.NSScreen.mainScreen.frame;" +
    " JSON.stringify({ width: f.size.width, height: f.size.height })";
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", js], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const size = JSON.parse(String(stdout));
        if (size.width > 0 && size.height > 0) desktop = size;
      } catch {
        /* no display to ask — leave it unknown */
      }
      resolve(desktop);
    });
  });
}


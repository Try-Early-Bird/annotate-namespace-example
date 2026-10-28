/**
 * THE APP'S ASSETS, from a folder in its repo — a local AssetStore
 * (docs/assets.md).
 *
 * The stub lists what is in the folder for the app's + Attach → Assets,
 * serves image previews, and — when the store is writable — saves uploads
 * and deletes. Every asset is a file in the agent's checkout, so a picked
 * one reaches the agent as a path it can open and `require()`.
 *
 * THE RULES LIVE HERE, not in the routes: a path may not leave the folder
 * (no "..", no absolute path, no symlink out of it), an upload's type is
 * read from its bytes and never taken from what it claims, and only raster
 * images get previews — an SVG is a document that can run script.
 */
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

/** What the list offers: images, fonts, data and media an app bundles. */
const LISTED = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".ttf", ".otf", ".woff", ".woff2",
  ".json", ".mp4", ".mov", ".mp3", ".wav", ".m4a", ".lottie",
]);
/** Types the stub previews, by extension; the bytes are checked when served. */
const PREVIEWED = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const LIST_MAX = 500;
const DEPTH_MAX = 6;

/** The image type of some bytes, from their first bytes, or null. */
export function sniffImage(bytes) {
  const b = (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).subarray(0, 16);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a") return "image/gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/**
 * A file name safe to save under: letters, digits, dot, dash, underscore;
 * no leading dot; a known image extension matching its bytes.
 */
export function safeName(name, contentType) {
  const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[contentType];
  const stem = basename(String(name ?? "")).replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "asset";
  return `${stem}${ext}`;
}

/**
 * A local store over `dir`. `appDir` is the app's root, which paths in code
 * and in the agent's checkout are relative to; `previewBase` the URL the
 * stub serves previews under (`…/assets/raw`).
 */
export function createLocalStore({ dir, appDir, writable = false, uploadsFolder = "uploads" }) {
  const root = resolve(dir);
  const app = resolve(appDir);

  /** `rel` inside the folder, as an absolute path, or null if it would leave it. */
  async function inside(rel) {
    if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
    const parts = rel.split(/[\\/]+/);
    if (parts.some((p) => p === ".." || p === "") || rel.startsWith("/")) return null;
    const full = resolve(root, ...parts);
    if (full !== root && !full.startsWith(root + sep)) return null;
    try {
      // A symlink inside the folder may still point out of it.
      const real = await realpath(full);
      const realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    } catch { /* not there yet: fine for a put, a miss for a read */ }
    return full;
  }

  function describe(full, info, previewBase) {
    const path = relative(root, full).split(sep).join("/");
    const inApp = relative(app, full).split(sep).join("/");
    const ext = extname(full).toLowerCase();
    return {
      path,
      name: basename(full),
      // In the app's repo, both are the same path: what code require()s, and
      // what the agent opens, relative to the folder it works in.
      publicPath: inApp,
      agentPath: inApp,
      ...(PREVIEWED[ext] && previewBase ? { previewUrl: `${previewBase}/${path.split("/").map(encodeURIComponent).join("/")}` } : {}),
      contentType: PREVIEWED[ext] ?? null,
      size: info.size,
      uploaded: info.mtime.toISOString(),
    };
  }

  async function walk(dirPath, depth, out, previewBase) {
    if (depth > DEPTH_MAX || out.length >= LIST_MAX) return;
    let entries;
    try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= LIST_MAX) return;
      // Hidden files and anything symlinked are not offered: neither is
      // something the app ships on purpose, and a link may lead outside.
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const full = join(dirPath, e.name);
      if (e.isDirectory()) await walk(full, depth + 1, out, previewBase);
      else if (e.isFile() && LISTED.has(extname(e.name).toLowerCase())) {
        out.push(describe(full, await stat(full), previewBase));
      }
    }
  }

  return {
    kind: "local",
    writable,
    dir: root,

    /** Every asset in the folder, newest first. */
    async list(previewBase) {
      const out = [];
      await walk(root, 0, out, previewBase);
      return out.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
    },

    /** A raster image's bytes and type, checked from the bytes, or null. */
    async read(rel) {
      const full = await inside(rel);
      if (!full || !PREVIEWED[extname(full).toLowerCase()]) return null;
      try {
        if ((await lstat(full)).isSymbolicLink()) return null;
        const bytes = await readFile(full);
        const contentType = sniffImage(bytes);
        return contentType ? { bytes, contentType } : null;
      } catch { return null; }
    },

    /** Save an image under uploads/, never over an existing file. */
    async put(name, bytes, previewBase) {
      if (!writable) throw Object.assign(new Error("this store is read-only"), { status: 405 });
      const contentType = sniffImage(bytes);
      if (!contentType) throw Object.assign(new Error("not a PNG, JPEG, GIF or WebP image"), { status: 415 });
      const folder = await inside(uploadsFolder);
      if (!folder) throw Object.assign(new Error("bad uploads folder"), { status: 500 });
      await mkdir(folder, { recursive: true });
      const wanted = safeName(name, contentType);
      const ext = extname(wanted), stem = wanted.slice(0, -ext.length);
      for (let n = 1; n < 1000; n++) {
        const full = join(folder, n === 1 ? wanted : `${stem}-${n}${ext}`);
        try {
          // "wx": fails if the file exists, so two uploads of one name never
          // overwrite each other, or anything already in the repo.
          await writeFile(full, bytes, { flag: "wx" });
          return describe(full, await stat(full), previewBase);
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
      }
      throw Object.assign(new Error("too many files with that name"), { status: 409 });
    },

    /** Delete one asset. Only from the uploads folder: the rest is the app's. */
    async remove(rel) {
      if (!writable) throw Object.assign(new Error("this store is read-only"), { status: 405 });
      if (!String(rel).startsWith(`${uploadsFolder}/`)) {
        throw Object.assign(new Error(`only assets under ${uploadsFolder}/ can be deleted here`), { status: 403 });
      }
      const full = await inside(rel);
      if (!full) return false;
      try {
        if (!(await lstat(full)).isFile()) return false;
        await rm(full);
        return true;
      } catch { return false; }
    },
  };
}

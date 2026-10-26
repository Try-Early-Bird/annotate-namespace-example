/**
 * ONE connection to the Mac's screen, shared by every viewer.
 *
 * Relaying each browser tab to its own VNC connection looked fine with one
 * viewer and fell apart with two: on a devbox, a second connection to
 * Screen Sharing can land in a different session — the login window —
 * while the first shows the signed-in desktop with the app. A teammate
 * opening the panel saw a lock screen; so did "Open in a new tab", and so
 * could a reconnect.
 *
 * So the server holds the only connection to the Mac and keeps it, and
 * speaks VNC itself to each browser:
 *
 *   tab ──ws──┐
 *   tab ──ws──┼─> hub: one framebuffer ──tcp──> 127.0.0.1:5900
 *   tab ──ws──┘
 *
 * Upstream it asks for Raw and CopyRect only — it is localhost, so size is
 * free — in noVNC's own pixel format, and keeps the pixels. Downstream each
 * tab gets the rectangles that changed since it last asked, zlib-compressed
 * on a stream of its own, because a tab is across the internet. Keys and
 * pointer events from any tab go up the one connection, so everyone sees
 * and drives the same screen.
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { WebSocketServer } from "ws";
// Node's OpenSSL has DES switched off; VNC's password check needs it.
import { DESECBCipher } from "../node_modules/@novnc/novnc/core/crypto/des.js";

const RAW = 0, COPYRECT = 1, ZLIB = 6, DESKTOP_SIZE = -223;
const NONE = 1, VNC_AUTH = 2;

/** noVNC's pixel format: 32 bpp, depth 24, little-endian, R G B X in memory. */
const PIXEL_FORMAT = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);

/** VNC authentication: the challenge, DES-encrypted with the password as key. */
function vncResponse(password, challenge) {
  const key = [...password.slice(0, 8)].map((c) => c.charCodeAt(0));
  while (key.length < 8) key.push(0);
  return Buffer.from(DESECBCipher.importKey(key).encrypt(null, challenge));
}

/**
 * Reads exact byte counts off whatever is pushed in — a TCP socket's data
 * or a WebSocket's messages — for a protocol of fixed-size fields.
 */
class Reader {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.waiting = null;
    this.ended = false;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
    this.wake();
  }
  end() {
    this.ended = true;
    this.wake();
  }
  wake() {
    if (!this.waiting) return;
    const { n, resolve, reject } = this.waiting;
    if (this.length >= n) { this.waiting = null; resolve(this.take(n)); }
    else if (this.ended) { this.waiting = null; reject(new Error("closed")); }
  }
  take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = n < all.length ? [all.subarray(n)] : [];
    this.length -= n;
    return all.subarray(0, n);
  }
  read(n) {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    if (this.length >= n) return Promise.resolve(this.take(n));
    if (this.ended) return Promise.reject(new Error("closed"));
    return new Promise((resolve, reject) => { this.waiting = { n, resolve, reject }; });
  }
}

/** The smallest rect holding both. */
const union = (a, b) => {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/**
 * Changed regions, kept as a few rects. Past a handful they merge into one
 * box: sending some unchanged pixels is cheaper than a long list.
 */
class Dirty {
  constructor() { this.rects = []; }
  add(r) {
    if (r.width <= 0 || r.height <= 0) return;
    this.rects.push(r);
    if (this.rects.length > 8) this.rects = [this.rects.reduce(union, null)];
  }
  takeAll() { const r = this.rects; this.rects = []; return r; }
  get empty() { return this.rects.length === 0; }
}

/**
 * The one connection to the Mac. Connects when the first viewer arrives,
 * then stays — so the session it landed in stays too — and reconnects if
 * the Mac drops it.
 */
class Upstream {
  constructor({ host, port, password, onLog }) {
    Object.assign(this, { host, port, password, onLog });
    this.width = 0;
    this.height = 0;
    this.name = "";
    this.fb = null;
    this.viewers = new Set();
    this.socket = null;
    this.ready = null;
    // No viewer is sent pixels until the Mac's first full picture is in:
    // before that the framebuffer is all zeros, and a static screen would
    // never send the changes that replace them — a black screen for good.
    this.framed = false;
  }

  /** Resolves once the framebuffer exists; rejects if the Mac would not have us. */
  start() {
    if (!this.ready) {
      this.ready = this.connect().catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  async connect() {
    const socket = net.connect(this.port, this.host);
    socket.setNoDelay(true);
    const reader = new Reader();
    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("close", () => reader.end());
    socket.on("error", () => {});
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });

    await reader.read(12); // "RFB 003.xxx\n"
    socket.write("RFB 003.008\n");
    const types = [...await reader.read((await reader.read(1))[0])];
    if (!types.length) {
      const why = await reader.read((await reader.read(4)).readUInt32BE(0));
      throw new Error(`the screen refused: ${why}`);
    }
    // Apple's own auth (30) wants a macOS account; the VNC password (2) is
    // what devbox.sh switches on. Never 30 — see public/vnc.html.
    if (this.password && types.includes(VNC_AUTH)) {
      socket.write(Buffer.from([VNC_AUTH]));
      socket.write(vncResponse(this.password, await reader.read(16)));
    } else if (types.includes(NONE)) {
      socket.write(Buffer.from([NONE]));
    } else {
      throw new Error(`no security type we can use (offered ${types.join(", ")}); set VNC_PASSWORD`);
    }
    if ((await reader.read(4)).readUInt32BE(0) !== 0) {
      const n = (await reader.read(4).catch(() => Buffer.alloc(4))).readUInt32BE(0);
      const why = n ? await reader.read(n).catch(() => "") : "";
      throw new Error(`the screen refused the password${why ? `: ${why}` : ""}`);
    }

    socket.write(Buffer.from([1])); // shared: never kick another client off
    const init = await reader.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    this.name = String(await reader.read(init.readUInt32BE(20)));
    this.fb = Buffer.alloc(this.width * this.height * 4);
    this.framed = false;
    const theirs = [...init.subarray(4, 20)].join(",");

    const pf = Buffer.alloc(20);
    pf[0] = 0;
    PIXEL_FORMAT.copy(pf, 4);
    const encs = [RAW, COPYRECT, DESKTOP_SIZE];
    const se = Buffer.alloc(4 + encs.length * 4);
    se[0] = 2;
    se.writeUInt16BE(encs.length, 2);
    encs.forEach((e, i) => se.writeInt32BE(e, 4 + i * 4));
    socket.write(Buffer.concat([pf, se]));
    this.socket = socket;
    this.request(false);
    this.onLog?.(`vnc: shared connection to ${this.width}x${this.height} "${this.name}" (its pixel format ${theirs})`);
    this.asked = Date.now();
    // Ask again if the first picture is slow; say so if it never comes.
    const watch = setInterval(() => {
      if (this.framed || this.socket !== socket) return clearInterval(watch);
      this.onLog?.(`vnc: no picture from the Mac after ${Math.round((Date.now() - this.asked) / 1000)}s — asking again`);
      this.request(false);
    }, 10_000);
    watch.unref();

    this.loop(reader).catch((err) => this.lost(err));
    return this;
  }

  request(incremental) {
    const m = Buffer.alloc(10);
    m[0] = 3;
    m[1] = incremental ? 1 : 0;
    m.writeUInt16BE(this.width, 6);
    m.writeUInt16BE(this.height, 8);
    this.socket?.write(m);
  }

  async loop(reader) {
    for (;;) {
      const type = (await reader.read(1))[0];
      if (type === 0) {
        const n = (await reader.read(3)).readUInt16BE(1);
        const changed = [];
        for (let i = 0; i < n; i++) {
          const h = await reader.read(12);
          const r = { x: h.readUInt16BE(0), y: h.readUInt16BE(2), width: h.readUInt16BE(4), height: h.readUInt16BE(6) };
          const enc = h.readInt32BE(8);
          if (enc === RAW) {
            const data = await reader.read(r.width * r.height * 4);
            this.blit(r, data);
            changed.push(r);
          } else if (enc === COPYRECT) {
            const src = await reader.read(4);
            this.copy(src.readUInt16BE(0), src.readUInt16BE(2), r);
            changed.push(r);
          } else if (enc === DESKTOP_SIZE) {
            // The desktop changed size: every viewer's framebuffer is now
            // wrong. Start over; they reconnect from the panel.
            throw new Error("the desktop changed size");
          } else {
            throw new Error(`unexpected encoding ${enc}`);
          }
        }
        // The first update answers the full request: the whole screen, in
        // however many tiles the Mac chose.
        if (!this.framed) {
          this.framed = true;
          this.onLog?.(`vnc: first picture from the Mac in ${Date.now() - this.asked} ms`);
          for (const v of this.viewers) v.dirty.add({ x: 0, y: 0, width: this.width, height: this.height });
        }
        for (const v of this.viewers) for (const r of changed) v.dirty.add(r);
        for (const v of this.viewers) v.pump();
        this.request(true);
      } else if (type === 1) {
        const h = await reader.read(5);
        await reader.read(h.readUInt16BE(3) * 6); // colour map: not in true colour
      } else if (type === 2) {
        // bell
      } else if (type === 3) {
        const h = await reader.read(7);
        const text = await reader.read(h.readUInt32BE(3));
        for (const v of this.viewers) v.cutText(text);
      } else {
        throw new Error(`unexpected message ${type}`);
      }
    }
  }

  blit(r, data) {
    const row = r.width * 4;
    for (let y = 0; y < r.height; y++) {
      data.copy(this.fb, ((r.y + y) * this.width + r.x) * 4, y * row, (y + 1) * row);
    }
  }

  copy(sx, sy, r) {
    const row = r.width * 4;
    const tmp = Buffer.alloc(row * r.height);
    for (let y = 0; y < r.height; y++) this.fb.copy(tmp, y * row, ((sy + y) * this.width + sx) * 4, ((sy + y) * this.width + sx) * 4 + row);
    this.blit(r, tmp);
  }

  /** Input from any viewer goes up the one connection. */
  send(buf) { this.socket?.write(buf); }

  lost(err) {
    if (err?.message !== "closed") this.onLog?.(`vnc: ${err.message}`);
    this.socket?.destroy();
    this.socket = null;
    this.ready = null;
    for (const v of this.viewers) v.close();
  }
}

/** One browser tab: a VNC server of our own, fed from the shared framebuffer. */
class Viewer {
  constructor(ws, up, password) {
    Object.assign(this, { ws, up, password });
    this.dirty = new Dirty();
    this.wants = false; // has an update request outstanding
    this.sending = false;
    this.deflate = zlib.createDeflate({ level: 6 });
    this.chunks = [];
    this.deflate.on("data", (c) => this.chunks.push(c));
  }

  /**
   * In pieces of at most 64 KB, as the plain relay's TCP reads were: a
   * whole picture is megabytes, and a proxy between here and the browser
   * may stall or drop one message that size. RFB is a stream, so noVNC
   * does not care where the cuts are.
   */
  write(buf) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    for (let i = 0; i < buf.length; i += 65536) this.ws.send(buf.subarray(i, i + 65536), { binary: true });
  }
  close() { if (this.ws.readyState <= 1) this.ws.close(); }

  async run(reader) {
    this.write(Buffer.from("RFB 003.008\n"));
    await reader.read(12);
    if (this.password) {
      this.write(Buffer.from([1, VNC_AUTH]));
      if ((await reader.read(1))[0] !== VNC_AUTH) throw new Error("viewer picked no auth");
      const challenge = randomBytes(16);
      this.write(challenge);
      const ok = (await reader.read(16)).equals(vncResponse(this.password, challenge));
      const fail = Buffer.from("Authentication failed");
      this.write(ok ? Buffer.alloc(4) : Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 0, fail.length]), fail]));
      if (!ok) throw new Error("viewer gave the wrong password");
    } else {
      this.write(Buffer.from([1, NONE]));
      await reader.read(1);
      this.write(Buffer.alloc(4));
    }
    await reader.read(1); // ClientInit: everyone shares, whatever it asks

    const up = await this.up.start();
    const name = Buffer.from(up.name || "Simulator");
    const init = Buffer.alloc(24);
    init.writeUInt16BE(up.width, 0);
    init.writeUInt16BE(up.height, 2);
    PIXEL_FORMAT.copy(init, 4);
    init.writeUInt32BE(name.length, 20);
    this.write(Buffer.concat([init, name]));
    up.viewers.add(this);
    up.onLog?.(`vnc: a viewer joined (${up.viewers.size} watching)`);

    for (;;) {
      const type = (await reader.read(1))[0];
      if (type === 0) {
        // SetPixelFormat. noVNC asks for exactly ours; anything else would
        // need converting, which nothing here does.
        const m = await reader.read(19);
        if (!m.subarray(3, 19).equals(PIXEL_FORMAT)) throw new Error("viewer wants a pixel format the hub does not convert to");
      } else if (type === 2) {
        const n = (await reader.read(3)).readUInt16BE(1);
        await reader.read(n * 4); // whatever it supports, it gets zlib: noVNC decodes it
      } else if (type === 3) {
        const m = await reader.read(9);
        if (!m[0]) this.dirty.add({ x: 0, y: 0, width: up.width, height: up.height });
        this.wants = true;
        this.pump();
      } else if (type === 4) {
        up.send(Buffer.concat([Buffer.from([4]), await reader.read(7)]));
      } else if (type === 5) {
        up.send(Buffer.concat([Buffer.from([5]), await reader.read(5)]));
      } else if (type === 6) {
        const h = await reader.read(7);
        const len = h.readUInt32BE(3);
        // Extended clipboard sets the length's top bit; not passed on.
        if (len & 0x80000000) await reader.read(len & 0x7fffffff);
        else up.send(Buffer.concat([Buffer.from([6]), h, await reader.read(len)]));
      } else {
        throw new Error(`viewer sent message ${type}`);
      }
    }
  }

  cutText(text) {
    const h = Buffer.alloc(8);
    h[0] = 3;
    h.writeUInt32BE(text.length, 4);
    this.write(Buffer.concat([h, text]));
  }

  /** Send what changed, if this viewer has asked and is not mid-send. */
  async pump() {
    if (!this.up.framed || !this.wants || this.sending || this.dirty.empty) return;
    this.sending = true;
    this.wants = false;
    const rects = this.dirty.takeAll();
    const { fb, width } = this.up;
    const parts = [Buffer.from([0, 0, rects.length >> 8, rects.length & 255])];
    for (const r of rects) {
      const row = r.width * 4;
      const raw = Buffer.alloc(row * r.height);
      for (let y = 0; y < r.height; y++) fb.copy(raw, y * row, ((r.y + y) * width + r.x) * 4, ((r.y + y) * width + r.x) * 4 + row);
      const packed = await this.pack(raw);
      const h = Buffer.alloc(16);
      h.writeUInt16BE(r.x, 0);
      h.writeUInt16BE(r.y, 2);
      h.writeUInt16BE(r.width, 4);
      h.writeUInt16BE(r.height, 6);
      h.writeInt32BE(ZLIB, 8);
      h.writeUInt32BE(packed.length, 12);
      parts.push(h, packed);
    }
    this.write(Buffer.concat(parts));
    this.sending = false;
    this.pump(); // more may have changed while compressing
  }

  /** Deflate on this viewer's stream, flushed so the rect is complete. */
  pack(raw) {
    return new Promise((resolve) => {
      this.deflate.write(raw);
      this.deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        const out = Buffer.concat(this.chunks);
        this.chunks = [];
        resolve(out);
      });
    });
  }
}

/**
 * The WebSocket side, on the front door's HTTP server (`noServer`: the front
 * door owns the upgrade event and routes `/websockify` here).
 *
 * `password` is the VNC password: used to reach the Mac, and asked of each
 * viewer in turn, so the screen is no more open than it was.
 */
export function createVncHub({ host, port, password, onLog }) {
  const up = new Upstream({ host, port, password, onLog });
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });
  wss.on("connection", (ws) => {
    const reader = new Reader();
    ws.on("message", (data) => reader.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    const viewer = new Viewer(ws, up, password);
    const end = (err) => {
      up.viewers.delete(viewer);
      viewer.deflate.destroy();
      if (err && err.message !== "closed") onLog?.(`vnc: ${err.message}`);
      viewer.close();
    };
    ws.on("close", () => { reader.end(); end(); });
    ws.on("error", () => end());
    viewer.run(reader).catch(end);
  });
  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
  };
}

/**
 * The simulator, in the browser.
 *
 * A dev client build is the only thing that can demonstrate this library —
 * component identity comes from a React Native renderer API that react-dom
 * does not have — but a native build on a simulator is exactly the thing a
 * browser cannot render. So the browser gets PIXELS instead: macOS Screen
 * Sharing speaks VNC, noVNC speaks VNC over WebSocket, and this module is
 * the adapter between them.
 *
 *   browser ──ws──> /websockify ──tcp──> 127.0.0.1:5900 ──> the Simulator
 *
 * It lives behind the SAME front door as everything else, which is the whole
 * point. A separate VNC port would be a different origin behind its own auth
 * gate, and we already know how that ends (see run-sandbox.mjs). Behind
 * :8081 the frame is same-origin, the session cookie rides along, and one
 * authorisation covers the app, the panel, the protocol server and the
 * screen.
 *
 * This is best-effort by design. If Screen Sharing is not running, the probe
 * fails and the panel falls back to telling you to open Remote Display — a
 * blank black rectangle would be worse than an honest card.
 */
import net from "node:net";
import { WebSocketServer } from "ws";

export const DEFAULT_VNC_HOST = "127.0.0.1";
export const DEFAULT_VNC_PORT = 5900;

/**
 * Is anything listening on the VNC port?
 *
 * A TCP connect, not a handshake: we only need to know whether to embed the
 * screen or show the fallback card, and a real RFB handshake would need the
 * password we may not have.
 */
export function probeVnc({ host = DEFAULT_VNC_HOST, port = DEFAULT_VNC_PORT, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Relay one WebSocket to one TCP socket, in both directions, until either
 * end goes away.
 *
 * noVNC sends binary frames, so anything arriving as text would be a
 * protocol error rather than something to coerce — RFB is not text and a
 * string here means something upstream is confused.
 */
function relay(ws, { host, port, onLog }) {
  const tcp = net.connect(port, host);
  // RFB is latency-sensitive and its messages are small; Nagle would batch
  // them into visible input lag.
  tcp.setNoDelay(true);

  let open = false;
  const pending = [];

  tcp.on("connect", () => {
    open = true;
    for (const chunk of pending) tcp.write(chunk);
    pending.length = 0;
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary && typeof data === "string") return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (open) tcp.write(chunk);
    else pending.push(chunk); // the client may greet before TCP is up
  });

  tcp.on("data", (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  });

  const shutdown = (why) => {
    if (why) onLog?.(why);
    tcp.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  };

  tcp.on("error", (err) => shutdown(`vnc: upstream error — ${err.message}`));
  tcp.on("close", () => shutdown());
  ws.on("close", () => shutdown());
  ws.on("error", () => shutdown());
}

/**
 * Serve the WebSocket half of the bridge on an existing HTTP server.
 *
 * `noServer` because the front door already owns the upgrade event and has
 * to route: `/websockify` here, everything else to Metro's HMR socket.
 */
export function createVncBridge({
  host = DEFAULT_VNC_HOST,
  port = DEFAULT_VNC_PORT,
  onLog,
} = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    // noVNC offers "binary" for compatibility with websockify. Accepting it
    // is harmless; refusing to pick any offered protocol makes some clients
    // abort the handshake.
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });

  wss.on("connection", (ws) => relay(ws, { host, port, onLog }));

  return {
    /** Take over an upgrade the front door has decided belongs to us. */
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    close() {
      wss.close();
    },
  };
}

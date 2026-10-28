/**
 * What the sandbox's front door tells the panel. Everything is same-origin:
 * the panel is served at /view by the server it is asking.
 */

export const API = "/__annotate";

export type Simulator = {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  kind: "iPhone" | "iPad";
};

export type Agent = {
  enabled: boolean;
  id: string | null;
  name: string | null;
  /** Its edits are auto-approved with shell access, not file tools only. */
  shell: boolean | null;
  error: string | null;
  mode: "in-tree" | "worktree";
  dir: string | null;
  jobs: number;
  pullRequests: boolean;
  model: string | null;
  tools: string[] | null;
  sandbox: string | null;
  queued: number;
  working: number;
};

export type Storage = {
  kind: string;
  detail: string;
  sessions: number;
  tasks: number;
  notes: number;
  screenshots: number;
};

export type Status = {
  app?: { name: string; branch: string | null };
  build: { state: string; bundleId: string };
  simulator: Simulator | null;
  screen: { embedded: boolean; src: string | null; pinned: boolean; autoUnlock: boolean };
  protocol: {
    endpoint: string;
    path: string;
    session: string;
    ok: boolean;
    version: number | null;
    ms: number;
    state: string;
  };
  storage: Storage | null;
  agent: Agent | null;
};

export type Reference = { type: string; url?: string; value?: string; label?: string; name?: string };

/** Resolved by the SERVER; the client never names anyone (README, "Comments"). */
export type Author = { id: string; name?: string; avatarUrl?: string };

/**
 * A message in an agent task's thread (`role`, `timestamp`) or a team
 * note's (`author`, `createdAt`). `text` is what older stubs wrote.
 */
export type Message = {
  id: string;
  content?: string;
  text?: string;
  role?: "user" | "agent" | string;
  author?: Author | null;
  timestamp?: string;
  createdAt?: string;
};

export const messageText = (m: Message) => m.content ?? m.text ?? "";
export const messageTime = (m: Message) => m.timestamp ?? m.createdAt;

/**
 * Where an agent's run on a task stands. The sandbox server's own field —
 * not protocol, the app never reads it — so it can say what the protocol's
 * status cannot: what the agent is doing right now, and what it changed.
 */
export type Run = {
  state: "running" | "review" | "done" | "failed" | "stopped" | "accepted" | "reverted";
  agent?: string;
  startedAt?: string;
  finishedAt?: string;
  log?: string[];
  files?: { path: string; added: number; removed: number }[];
  before?: string;
  after?: string;
  error?: string;
  branch?: string;
};

export const shotUrl = (id: string) => `${API}/screenshots/${encodeURIComponent(id)}`;

/** An agent task or a team note: the protocol shapes, as far as the panel reads them. */
export type Mark = {
  id: string;
  comment?: string;
  content?: string;
  element?: string;
  source?: { file?: string; line?: number };
  routeName?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  author?: Author;
  references?: Reference[];
  thread?: Message[];
  messages?: Message[];
  /** The captured identity, carried over when a note becomes a task. */
  componentStack?: string[];
  testID?: string;
  x?: number;
  y?: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
  scroll?: { scrollViewTag?: number; offsetY: number; offsetX?: number };
  /** On a task made from a note: which note, and which of its messages. */
  sourceCommentId?: string;
  sourceMessageIds?: string[];
  run?: Run;
};

export async function getJson<T>(url: string, fallback: T): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  return r.ok ? ((await r.json()) as T) : fallback;
}

/** The server's /agent (docs/protocol.md in the package, "Agent"). */
export type AgentChoice = { id: string; label: string; installed: boolean; version?: string; shell?: boolean };
export type AgentConfig = {
  enabled: boolean;
  current: { id: string; label: string; model: string | null; shell?: boolean } | null;
  error: string | null;
  working: number;
  agents: AgentChoice[];
};
export type AgentModel = { id: string; label: string; description?: string; default?: boolean };
export type AgentModels = { ok: true; models: AgentModel[] } | { ok: false; message: string };

export async function getAgent(refresh = false): Promise<AgentConfig> {
  const r = await fetch(`${API}/agent${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Slow: the server starts the agent's CLI to ask it. */
export async function getAgentModels(agent: string): Promise<AgentModels> {
  const r = await fetch(`${API}/agent/models?agent=${encodeURIComponent(agent)}`, { cache: "no-store" });
  return r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
}

export async function setAgent(change: { agent?: string; model?: string | null }): Promise<AgentConfig> {
  const r = await fetch(`${API}/agent`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

/** The app's assets/ folder, as the stub lists it (docs/assets.md in the package). */
export type Asset = {
  path: string;
  name: string;
  publicPath: string;
  agentPath?: string;
  contentType: string | null;
  size: number;
  uploaded: string;
};

export async function listAssets(): Promise<{ assets: Asset[]; writable: boolean }> {
  const r = await fetch(`${API}/assets`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Through the front door: the stub's own previewUrl is for the app, not a browser. */
export function assetPreview(asset: Asset): string | null {
  return asset.contentType ? `${API}/assets/raw/${asset.path.split("/").map(encodeURIComponent).join("/")}` : null;
}

export async function uploadAsset(file: File): Promise<Asset> {
  const form = new FormData();
  form.append("file", file, file.name);
  const r = await fetch(`${API}/assets`, { method: "POST", body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

export async function deleteAsset(path: string): Promise<void> {
  const r = await fetch(`${API}/assets/${path.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
}

export async function switchDevice(udid: string) {
  const r = await fetch("/sandbox/device", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ udid }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
}

/**
 * Screenshot and diff URLs are built by the server from the host the APP
 * used (127.0.0.1, without the /__annotate prefix), which a browser cannot
 * reach. Keep the path and ask through the front door instead.
 */
export function screenshotUrl(url: string) {
  return `${API}/screenshots/${encodeURIComponent(url.split("/").pop() ?? "")}`;
}

export function referenceHref(ref: Reference, markId: string): string | null {
  if (ref.type !== "url" || !ref.value) return null;
  if (/\/annotations\/[^/]+\/diff$/.test(ref.value)) {
    return `${API}/annotations/${encodeURIComponent(markId)}/diff`;
  }
  // A reference is data the app sent, so only plain web links become links.
  return /^https?:/.test(ref.value) ? ref.value : null;
}

export function ago(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

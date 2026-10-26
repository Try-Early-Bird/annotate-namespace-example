/**
 * What the panel can DO, through the same protocol routes the overlay uses
 * (README, "Annotations", "Threads", "Comments"). Nothing here is
 * panel-only: a task made from a note on the web is the same body the app
 * would post, so the agent cannot tell which one made it.
 */
import { API, messageText, type Mark, type Message } from "@/lib/api";

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.json().then((j) => j?.error).catch(() => null);
    throw new Error(detail || `HTTP ${r.status}`);
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}

const seg = encodeURIComponent;

// ── Agent tasks ─────────────────────────────────────────────────────────

/** Hand tasks to the agent. An empty list means "every pending one". */
export const sendToAgent = (ids: string[]) => call("POST", "/annotations/send", { annotationIds: ids });

/** A follow-up. The server records it as "user" and reopens a finished task. */
export const replyToTask = (id: string, content: string) =>
  call("POST", `/annotations/${seg(id)}/thread`, { content });

export const deleteTask = (id: string) => call("DELETE", `/annotations/${seg(id)}`);

// The sandbox server's controls over a run (not protocol).
export const stopRun = (id: string) => call("POST", `/annotations/${seg(id)}/stop`);
export const acceptRun = (id: string) => call("POST", `/annotations/${seg(id)}/accept`);
export const revertRun = (id: string) => call("POST", `/annotations/${seg(id)}/revert`);

// ── Team notes ──────────────────────────────────────────────────────────

/** `authorName` is the advisory hint; a server with auth ignores it. */
export const replyToNote = (id: string, content: string, authorName: string) =>
  call("POST", `/comments/${seg(id)}/messages`, { content, authorName });

export const setNoteStatus = (id: string, status: "open" | "resolved") =>
  call("PATCH", `/comments/${seg(id)}`, { status });

export const deleteNote = (id: string) => call("DELETE", `/comments/${seg(id)}`);

/**
 * A note's messages as the agent reads them: "Author: what they said",
 * thread order. The typed instruction is the REQUEST and goes first; the
 * quotes are context under a lead-in, so a discussion is never mistaken for
 * the instruction. Same composition as the app (src/message-task.ts).
 */
/** Where a task's request ends and the quoted discussion begins. */
export const DISCUSSION = "\n\nFrom the discussion:\n\n";

export function taskText(instruction: string, quoted: Message[]) {
  const request = instruction.trim();
  const context = quoted
    .filter((m) => messageText(m).trim())
    .map((m) => `${m.author?.name?.trim() || "Someone"}: ${messageText(m).trim()}`)
    .join("\n\n");
  if (request && context) return `${request}${DISCUSSION}${context}`;
  return request || context || null;
}

/**
 * Make an agent task out of a note: the note's captured identity (element,
 * source, screen, coordinates), the composed text, and a back-link to the
 * note and the messages it quoted. The note itself is not touched — it stays
 * an open conversation that can spawn another task later.
 */
export async function taskFromNote(
  note: Mark,
  quoted: Message[],
  instruction: string,
  session: string,
  send: boolean,
) {
  const comment = taskText(instruction, quoted);
  if (!comment) throw new Error("pick a message or write what to do");
  const x = note.x ?? note.boundingBox?.x ?? 0;
  const y = note.y ?? note.boundingBox?.y ?? 0;
  const id = crypto.randomUUID();
  await call("POST", `/sessions/${seg(session)}/annotations`, {
    id,
    comment,
    kind: "feedback",
    platform: "native",
    element: note.element ?? "Screen",
    componentStack: note.componentStack ?? [],
    source: note.source,
    testID: note.testID,
    routeName: note.routeName,
    x, y,
    boundingBox: note.boundingBox ?? { x, y, width: 0, height: 0 },
    scroll: note.scroll ?? { offsetY: 0 },
    sourceCommentId: note.id,
    ...(quoted.length ? { sourceMessageIds: quoted.map((m) => m.id) } : {}),
  });
  if (send) await sendToAgent([id]);
  return id;
}

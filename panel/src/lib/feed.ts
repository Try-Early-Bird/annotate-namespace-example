/**
 * Agent tasks and team notes as ONE feed, the way the app's queue shows
 * them (filter chips All · Agent · Team), each in the state its card draws.
 */
import type { Mark } from "@/lib/api";

export type TaskState = "queued" | "running" | "review" | "failed" | "resolved";

/** What a task's card shows, from the protocol status and the server's run. */
export function taskState(t: Mark): TaskState {
  const run = t.run?.state;
  if (t.status === "working" || run === "running") return "running";
  if (t.status === "pending") return run === "failed" ? "failed" : "queued";
  if (run === "review") return "review";
  return "resolved"; // done, accepted, reverted, or sent with no agent
}

export const noteResolved = (n: Mark) => n.status === "resolved" || n.status === "converted";

export type FeedItem =
  | { type: "task"; mark: Mark; state: TaskState; number: number | null }
  | { type: "note"; mark: Mark; tasks: Mark[] };

/**
 * The app's marker numbers, so a card and the pin on the phone agree.
 *
 * The overlay numbers agent tasks per SCREEN, 1..N in server order, over
 * the open ones (pending and working) that have a position — and skips a
 * task made from a note, which shows on the note's marker instead
 * (src/marker-hit.ts, `visibleMarkers`). Same rule here.
 */
function markerNumbers(tasks: Mark[]) {
  const byRoute = new Map<string, number>();
  const numbers = new Map<string, number>();
  const oldestFirst = [...tasks].sort((a, b) => Date.parse(a.createdAt ?? "0") - Date.parse(b.createdAt ?? "0"));
  for (const t of oldestFirst) {
    if (t.status !== "pending" && t.status !== "working") continue;
    if (t.sourceCommentId || typeof t.x !== "number" || typeof t.y !== "number") continue;
    const route = t.routeName ?? "";
    const n = (byRoute.get(route) ?? 0) + 1;
    byRoute.set(route, n);
    numbers.set(t.id, n);
  }
  return numbers;
}

/** Live work first — it is what needs a decision — then newest first. */
const ORDER: Record<string, number> = { running: 0, review: 1, failed: 2, queued: 3, note: 3 };

export function buildFeed(tasks: Mark[], notes: Mark[]) {
  const numbers = markerNumbers(tasks);
  const noteIds = new Set(notes.map((n) => n.id));
  const open: FeedItem[] = [];
  const resolved: FeedItem[] = [];

  for (const t of tasks) {
    // A task made from a note reports back INSIDE the note's card.
    if (t.sourceCommentId && noteIds.has(t.sourceCommentId)) continue;
    const item: FeedItem = { type: "task", mark: t, state: taskState(t), number: numbers.get(t.id) ?? null };
    (item.state === "resolved" ? resolved : open).push(item);
  }
  for (const n of notes) {
    const item: FeedItem = { type: "note", mark: n, tasks: tasks.filter((t) => t.sourceCommentId === n.id) };
    (noteResolved(n) ? resolved : open).push(item);
  }

  const time = (i: FeedItem) => Date.parse(i.mark.updatedAt ?? i.mark.createdAt ?? "0");
  const rank = (i: FeedItem) => {
    if (i.type === "task") return ORDER[i.state];
    // A note whose task is live sorts with that task.
    const live = i.tasks.map(taskState).filter((s) => s !== "resolved" && s !== "queued");
    return live.length ? Math.min(...live.map((s) => ORDER[s])) : ORDER.note;
  };
  open.sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
  resolved.sort((a, b) => time(b) - time(a));
  return { open, resolved };
}

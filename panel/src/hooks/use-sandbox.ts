import { useCallback, useEffect, useRef, useState } from "react";
import { API, getJson, type Mark, type Simulator, type Status } from "@/lib/api";

/** The sandbox's status, polled. Null until the first answer. */
export function useStatus(intervalMs = 5000) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getJson<Status | null>("/sandbox/status", null));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  return { status, error, refresh };
}

/** Every iOS simulator on the Mac. Changes rarely, so fetched on demand. */
export function useDevices() {
  const [devices, setDevices] = useState<Simulator[] | null>(null);
  const refresh = useCallback(async () => {
    setDevices(await getJson<Simulator[]>("/sandbox/devices", []).catch(() => []));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { devices, refresh };
}

const EVENTS = [
  "annotation.created", "annotation.updated", "annotation.deleted",
  "comment.created", "comment.updated", "comment.deleted",
];

const newest = (a: Mark, b: Mark) => Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0");

/**
 * Tasks and notes, kept current by the protocol's own event stream — a
 * nudge to re-read whenever anything changes. Polling stays on underneath
 * in case the stream drops.
 */
export function useFeed(session: string) {
  const [tasks, setTasks] = useState<Mark[]>([]);
  const [notes, setNotes] = useState<Mark[]>([]);
  const [live, setLive] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async () => {
    try {
      // Every task in the session, not only pending ones: a finished task
      // carries the agent's reply, its branch and its diff.
      const [t, n] = await Promise.all([
        getJson<Mark[]>(`${API}/sessions/${encodeURIComponent(session)}/annotations`, []),
        getJson<Mark[] | { comments?: Mark[] }>(`${API}/comments`, []),
      ]);
      setTasks((Array.isArray(t) ? t : []).sort(newest));
      // `{comments: […]}` per the protocol, or a bare array (README, "Comments").
      setNotes((Array.isArray(n) ? n : n?.comments ?? []).sort(newest));
      setUpdated(new Date());
      setError(false);
    } catch {
      setError(true);
    }
  }, [session]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 10000);
    const events = new EventSource(`${API}/sessions/${encodeURIComponent(session)}/events`);
    events.onopen = () => setLive(true);
    events.onerror = () => setLive(false);
    const nudge = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 150);
    };
    for (const type of EVENTS) events.addEventListener(type, nudge);
    return () => {
      clearInterval(poll);
      clearTimeout(timer.current);
      events.close();
    };
  }, [session, refresh]);

  return { tasks, notes, live, updated, error, refresh };
}

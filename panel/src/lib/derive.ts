import type { Tone } from "@/components/status-dot";
import type { ScreenState } from "@/components/phone";
import type { Status } from "@/lib/api";

/** One judgement per part of the sandbox, shared by the header and Connections. */

export function buildState(s: Status | null): { tone: Tone; label: string } {
  const state = s?.build.state ?? "starting";
  if (state === "installed") return { tone: "ok", label: "Running" };
  if (state.startsWith("failed")) return { tone: "bad", label: `Build ${state}` };
  const label = { building: "Building", switching: "Switching device", starting: "Starting", finished: "Stopped" }[state];
  return { tone: state === "finished" ? "warn" : "busy", label: label ?? state };
}

export function screenState(s: Status | null, live: ScreenState): { tone: Tone; label: string } {
  if (s && !s.screen.embedded) return { tone: "bad", label: "Not embedded" };
  if (live === "connected") return { tone: "ok", label: "Live" };
  if (live === "disconnected") return { tone: "bad", label: "Disconnected" };
  return { tone: "busy", label: "Connecting" };
}

export function backendState(s: Status | null): { tone: Tone; label: string } {
  if (!s) return { tone: "off", label: "Checking" };
  return s.protocol.ok ? { tone: "ok", label: "Connected" } : { tone: "bad", label: "Down" };
}

export function agentState(s: Status | null): { tone: Tone; label: string } {
  const a = s?.agent;
  if (!a) return { tone: "off", label: "Unknown" };
  if (!a.enabled) return { tone: "warn", label: "Off" };
  if (a.error) return { tone: "bad", label: "Not found" };
  if (a.working > 0) return { tone: "busy", label: `${a.name} · working` };
  return { tone: "ok", label: `${a.name ?? "On"} · idle` };
}

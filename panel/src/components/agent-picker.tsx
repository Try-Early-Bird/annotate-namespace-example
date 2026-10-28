import { useCallback, useEffect, useRef, useState } from "react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { getAgent, getAgentModels, setAgent, type AgentConfig, type AgentModel, type AgentModels } from "@/lib/api";

/** Select needs a string for "no model" / "no effort": the default. */
const DEFAULT = "__default";

/** "xhigh" → "Extra high"; the rest capitalised. */
const effortLabel = (e: string) => (e === "xhigh" ? "Extra high" : e.charAt(0).toUpperCase() + e.slice(1));

/**
 * One row per model, the default one tagged — the same list the app's
 * pill and Settings → Agent show. The default row stands for "the agent's
 * own default" (no model sent); a lone Default row only when the default
 * is not among the listed models.
 */
function modelRows(models: AgentModels | null) {
  const list = models?.ok ? models.models : [];
  const def = list.find((m) => m.default) ?? (models?.ok && models.defaultLabel ? list.find((m) => m.label === models.defaultLabel) : undefined);
  const head = { value: DEFAULT, key: def?.id ?? DEFAULT, label: def?.label ?? (models?.ok && models.defaultLabel) ?? "Default", isDefault: true };
  return [head, ...list.filter((m) => m !== def).map((m) => ({ value: m.id, key: m.id, label: m.label, isDefault: false }))];
}

/** A model's effort levels and default; the agent's for its Default. */
function modelEfforts(models: AgentModels | null, modelId: string | null) {
  if (!models?.ok) return { efforts: [] as string[], defaultEffort: null as string | null };
  const m: AgentModel | undefined = modelId ? models.models.find((x) => x.id === modelId) : undefined;
  if (m?.efforts) return { efforts: m.efforts, defaultEffort: m.defaultEffort ?? null };
  return { efforts: models.efforts ?? [], defaultEffort: models.defaultEffort ?? null };
}

/**
 * The SERVER'S DEFAULT agent, model and effort — what a task without its
 * own runs on. Tasks made in the app carry their own choice (its agent
 * pill); tasks made here, from a note, run on this. Agents that are not
 * installed or not signed in are listed, disabled. Models come from the
 * agent's own CLI, asked by the server, so loading them takes a moment.
 */
export function AgentPicker({
  onChanged,
  refreshKey = 0,
}: {
  onChanged?: () => void;
  /** Bumped by the menu's refresh: look for agents again, and ask the CLI for its models again. */
  refreshKey?: number;
}) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [models, setModels] = useState<AgentModels | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((refresh = false) => {
    getAgent(refresh).then(setConfig).catch(() => setError("Could not read the agent."));
  }, []);
  useEffect(() => load(refreshKey > 0), [load, refreshKey]);

  const currentId = config?.current?.id ?? null;
  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (!currentId) return;
    const fresh = lastRefresh.current !== refreshKey;
    lastRefresh.current = refreshKey;
    let live = true;
    setModels(null);
    getAgentModels(currentId, fresh).then((m) => live && setModels(m));
    return () => { live = false; };
  }, [currentId, refreshKey]);

  async function change(body: { agent?: string; model?: string | null; effort?: string | null }) {
    setBusy(true);
    setError(null);
    try {
      setConfig(await setAgent(body));
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!config) return error ? <span className="text-xs text-destructive">{error}</span> : <Spinner className="size-3" />;
  // Nothing to choose between: the status line above says so.
  const usable = (a: AgentConfig["agents"][number]) => a.installed && a.connected !== false;
  if (!config.enabled || !config.agents.some(usable)) return null;

  const current = config.current;
  const rows = modelRows(models);
  const modelValue = !current?.model || rows[0]?.key === current.model ? DEFAULT : current.model;
  const { efforts, defaultEffort } = modelEfforts(models, current?.model ?? null);
  const effortValue = current?.effort ?? defaultEffort ?? "";

  return (
    <div className="space-y-2 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={currentId ?? ""} onValueChange={(agent) => change({ agent })} disabled={busy}>
          <SelectTrigger size="sm" className="w-40" aria-label="Agent">
            <SelectValue placeholder="No agent" />
          </SelectTrigger>
          <SelectContent position="popper">
            {config.agents.map((a) => (
              <SelectItem key={a.id} value={a.id} disabled={!usable(a)}>
                {a.label}
                {!a.installed
                  ? <span className="text-muted-foreground">not installed</span>
                  : a.connected === false && <span className="text-destructive">not signed in</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {current && (
          <Select
            // Empty while loading, so the trigger says so instead of guessing.
            value={models === null ? "" : modelValue}
            onValueChange={(v) => change({ model: v === DEFAULT ? null : v })}
            disabled={busy || models === null}
          >
            <SelectTrigger size="sm" className="w-48" aria-label="Model">
              <SelectValue placeholder="Loading models…" />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-80">
              {/* A model set elsewhere that this list does not have still shows. */}
              {current.model && models?.ok && modelValue !== DEFAULT && !rows.some((r) => r.value === current.model) && (
                <SelectItem value={current.model}>{current.model}</SelectItem>
              )}
              {rows.map((m) => (
                <SelectItem key={m.key} value={m.value}>
                  {m.label}
                  {m.isDefault && m.label !== "Default" && <span className="text-muted-foreground">default</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {current && efforts.length > 0 && (
          <Select
            value={effortValue}
            // The model's default level is chosen as itself: that is what runs.
            onValueChange={(v) => change({ effort: v })}
            disabled={busy}
          >
            <SelectTrigger size="sm" className="w-36" aria-label="Effort">
              <SelectValue placeholder="Effort" />
            </SelectTrigger>
            <SelectContent position="popper">
              {efforts.map((e) => (
                <SelectItem key={e} value={e}>
                  {effortLabel(e)}
                  {e === defaultEffort && <span className="text-muted-foreground">default</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {busy && <Spinner className="size-3" />}
      </div>
      {models && !models.ok && <div className="text-xs text-muted-foreground">{models.message}</div>}
      {models?.ok && models.note && <div className="text-xs text-destructive">{models.note}</div>}
      {error && <div className="text-xs text-destructive">{error}</div>}
      {config.perTask && (
        <div className="text-xs text-muted-foreground">
          The default for tasks made here. Tasks made in the app carry the agent, model and effort chosen there.
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { getAgent, getAgentModels, setAgent, type AgentConfig, type AgentModels } from "@/lib/api";

/** Select needs a string for "no model": the agent's own default. */
const DEFAULT = "__default";

/**
 * Which agent runs tasks, and on which model — the same /agent routes the
 * app's Settings → Agent uses, so a switch made here shows there too.
 * Agents that are not installed are listed, disabled. Models come from the
 * agent's own CLI, asked by the server, so loading them takes a moment.
 */
export function AgentPicker({ onChanged }: { onChanged?: () => void }) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [models, setModels] = useState<AgentModels | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((refresh = false) => {
    getAgent(refresh).then(setConfig).catch(() => setError("Could not read the agent."));
  }, []);
  useEffect(() => load(), [load]);

  const currentId = config?.current?.id ?? null;
  useEffect(() => {
    if (!currentId) return;
    let live = true;
    setModels(null);
    getAgentModels(currentId).then((m) => live && setModels(m));
    return () => { live = false; };
  }, [currentId]);

  async function change(body: { agent?: string; model?: string | null }) {
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
  if (!config.enabled) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Select value={currentId ?? ""} onValueChange={(agent) => change({ agent })} disabled={busy}>
        <SelectTrigger size="sm" className="w-40" aria-label="Agent">
          <SelectValue placeholder="No agent" />
        </SelectTrigger>
        <SelectContent position="popper">
          {config.agents.map((a) => (
            <SelectItem key={a.id} value={a.id} disabled={!a.installed}>
              {a.label}
              {!a.installed && <span className="text-muted-foreground">not installed</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {config.current && (
        <Select
          value={config.current.model ?? DEFAULT}
          onValueChange={(v) => change({ model: v === DEFAULT ? null : v })}
          disabled={busy || models === null}
        >
          <SelectTrigger size="sm" className="w-56" aria-label="Model">
            <SelectValue placeholder="Loading models…" />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-80">
            <SelectItem value={DEFAULT}>
              {models?.ok && models.defaultLabel ? `Default (${models.defaultLabel})` : "Default"}
            </SelectItem>
            {/* A model set elsewhere that this list does not have still shows. */}
            {config.current.model && models?.ok && !models.models.some((m) => m.id === config.current?.model) && (
              <SelectItem value={config.current.model}>{config.current.model}</SelectItem>
            )}
            {models?.ok && models.models.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
                {m.default && <span className="text-muted-foreground">default</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={busy} aria-label="Check for agents again">
        <RotateCw /> Check again
      </Button>
      {busy && <Spinner className="size-3" />}
      {models && !models.ok && <span className="text-xs text-muted-foreground">{models.message}</span>}
      {models?.ok && models.note && <span className="text-xs text-destructive">{models.note}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

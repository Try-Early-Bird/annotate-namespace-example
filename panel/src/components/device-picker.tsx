import { useState } from "react";
import { Smartphone, Tablet } from "lucide-react";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { switchDevice, type Simulator } from "@/lib/api";

/**
 * Every iOS simulator on the Mac. Picking one moves the installed app there
 * without rebuilding (see server/simulators.mjs), so it needs the first
 * build to have finished — until then there is nothing to move.
 */
export function DevicePicker({
  devices,
  current,
  busy,
  onSwitched,
}: {
  devices: Simulator[] | null;
  current: Simulator | null;
  busy: boolean;
  onSwitched: () => void;
}) {
  const [moving, setMoving] = useState<Simulator | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = new Map<string, Simulator[]>();
  for (const d of devices ?? []) {
    const key = `${d.kind} · ${d.runtime}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }

  async function choose(udid: string) {
    const to = devices?.find((d) => d.udid === udid);
    if (!to || to.udid === current?.udid) return;
    setMoving(to);
    setError(null);
    try {
      await switchDevice(udid);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMoving(null);
      onSwitched();
    }
  }

  const disabled = !current || !devices?.length || Boolean(moving) || busy;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Select value={current?.udid ?? ""} onValueChange={choose} disabled={disabled}>
        <SelectTrigger className="w-64 max-w-full border-0 bg-muted/60 shadow-none dark:bg-muted/60" aria-label="Simulator">
          <SelectValue placeholder={devices === null ? "Loading simulators…" : "Waiting for the simulator…"} />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-80">
          {[...groups.entries()].map(([label, list], i) => (
            <SelectGroup key={label}>
              {i > 0 && <SelectSeparator />}
              <SelectLabel>{label}</SelectLabel>
              {list.map((d) => (
                <SelectItem key={d.udid} value={d.udid}>
                  {d.kind === "iPad" ? <Tablet /> : <Smartphone />}
                  {d.name}
                  <span className="text-muted-foreground">{d.runtime}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {moving && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" /> Moving the app to {moving.name}…
        </span>
      )}
      {error && <span className="text-xs text-destructive">Could not switch: {error}</span>}
    </div>
  );
}

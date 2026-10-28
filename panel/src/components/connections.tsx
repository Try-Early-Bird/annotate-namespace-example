import { useState, type ReactNode } from "react";
import { Bot, ChevronDown, Database, MonitorSmartphone, Server, Smartphone } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, type Tone } from "@/components/status-dot";
import type { ScreenState } from "@/components/phone";
import type { Status } from "@/lib/api";
import { agentState, backendState, buildState, screenState } from "@/lib/derive";
import { AgentPicker } from "@/components/agent-picker";

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{children}</code>;
}

function Row({
  icon, tone, label, value, children,
}: {
  icon: ReactNode; tone: Tone; label: string; value: ReactNode; children?: ReactNode;
}) {
  return (
    <Item size="sm" className="items-start rounded-none px-4">
      <ItemMedia variant="icon" className="relative">
        {icon}
        <StatusDot tone={tone} className="absolute -right-0.5 -bottom-0.5" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemDescription className="text-xs">{label}</ItemDescription>
        <ItemTitle>{value}</ItemTitle>
        {children && <div className="mt-1 space-y-1 text-xs text-muted-foreground">{children}</div>}
      </ItemContent>
    </Item>
  );
}

/** Open or closed, per viewer. Storage can be missing or throw; then it is just closed. */
const KEY = "panel.connections.open";
function remembered() {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
function remember(open: boolean) {
  try { localStorage.setItem(KEY, open ? "1" : "0"); } catch { /* not kept */ }
}

/**
 * What the sandbox is connected to. Collapsed by default, so Feedback gets
 * the height; collapsed, the header still shows one dot per connection.
 */
export function Connections({ status, screen }: { status: Status | null; screen: ScreenState }) {
  const [open, setOpen] = useState(remembered);
  const toggle = (next: boolean) => { setOpen(next); remember(next); };

  const build = buildState(status), shown = screenState(status, screen);
  const backend = backendState(status), agent = agentState(status);
  const summary: [string, Tone][] = [
    ["Backend", backend.tone], ["Agent", agent.tone], ["Storage", status?.storage ? "warn" : "off"],
    ["Simulator", status?.simulator ? build.tone : "warn"], ["Screen", shown.tone],
  ];

  return (
    <Collapsible open={open} onOpenChange={toggle} asChild>
      <section className="shrink-0 rounded-xl bg-muted/60">
        <CollapsibleTrigger asChild>
          <div
            role="button"
            aria-label={open ? "Collapse connections" : "Expand connections"}
            className="flex cursor-pointer items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium select-none hover:bg-muted"
          >
            Connections
            {!open && (
              <span className="flex items-center gap-1.5" aria-hidden>
                {summary.map(([label, tone]) => <StatusDot key={label} tone={tone} />)}
              </span>
            )}
            <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform in-data-[state=open]:rotate-180" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="max-h-[40dvh] overflow-y-auto">
          {status ? <Details status={status} screen={screen} /> : (
            <div className="space-y-4 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
          )}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function Details({ status, screen }: { status: Status; screen: ScreenState }) {
  const { protocol: p, agent: a, storage: st, simulator: sim } = status;
  const build = buildState(status), shown = screenState(status, screen);
  const backend = backendState(status), agent = agentState(status);

  return (
      <ItemGroup className="gap-0! py-1">
        <Row icon={<Server />} tone={backend.tone} label="Backend"
          value={p.ok
            ? <>Annotate Protocol v{p.version} <span className="font-normal text-muted-foreground">· {p.ms} ms</span></>
            : "Not answering"}>
          <div>App posts to <Code>{p.endpoint}</Code></div>
          <div>Session <Code>{p.session}</Code></div>
        </Row>

        <Row icon={<Bot />} tone={agent.tone} label="Agent"
          value={!a?.enabled ? "Off" : a.error ? "Not found" : `${a.name}${a.model ? ` · ${a.model}` : ""}`}>
          {!a?.enabled && (
            <div>
              Turned off with <Code>AGENT=0</Code>: tasks are stored and nothing acts on them. Restart
              without it to hand them to an agent.
            </div>
          )}
          {a?.enabled && a.error && <pre className="font-mono text-[11px] whitespace-pre-wrap">{a.error}</pre>}
          {a?.enabled && <AgentPicker />}
          {a?.enabled && a.shell && (
            <div>Its edits are auto-approved, and that includes shell commands.</div>
          )}
          {a?.enabled && !a.error && (
            <>
              <div>
                {a.mode === "worktree"
                  ? `A branch per task, ${a.jobs} at a time${a.pullRequests ? ", opens pull requests" : ""}`
                  : <>Edits <Code>{a.dir}</Code> directly, so the app hot reloads</>}
              </div>
              {a.tools && <div className="flex flex-wrap gap-1">Tools: {a.tools.map((t) => <Code key={t}>{t}</Code>)}</div>}
              {a.sandbox && <div>Sandbox <Code>{a.sandbox}</Code></div>}
              <div>{a.working} working · {a.queued} queued{a.model ? ` · ${a.model}` : ""}</div>
            </>
          )}
        </Row>

        <Row icon={<Database />} tone={st ? "warn" : "bad"} label="Storage"
          value={st ? (st.kind === "memory" ? "In memory" : st.kind) : "Unknown"}>
          {st && (
            <>
              <div>{st.tasks} tasks · {st.notes} notes · {st.screenshots} screenshots</div>
              <div>Restarting the sandbox clears it</div>
            </>
          )}
        </Row>

        <Row icon={<Smartphone />} tone={sim ? build.tone : "warn"} label="Simulator"
          value={sim
            ? <>{sim.name} <span className="font-normal text-muted-foreground">· {sim.runtime}</span></>
            : "Not booted yet"}>
          <div>{build.label} · <Code>{status.build.bundleId}</Code></div>
          {sim && <div className="truncate">UDID <Code>{sim.udid}</Code></div>}
        </Row>

        <Row icon={<MonitorSmartphone />} tone={shown.tone} label="Screen"
          value={status.screen.embedded ? "macOS Screen Sharing over VNC" : "Not embedded"}>
          {status.screen.embedded && (
            <>
              <div>{status.screen.pinned ? "Crop pinned by SCREEN_RECT" : "Cropped to the Simulator window"}</div>
              {status.screen.autoUnlock && <div>Signs back in if the Mac locks</div>}
            </>
          )}
        </Row>
      </ItemGroup>
  );
}

import { useState, type ReactNode } from "react";
import { ChevronDown, Database, MonitorSmartphone, RotateCw, Server, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

/** A header menu's button: a label, what it says now, and a chevron. */
function MenuButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs hover:bg-muted data-[state=open]:bg-muted"
        aria-label={label}
      >
        {children}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>
    </PopoverTrigger>
  );
}

/**
 * CONNECTIONS, a header menu: one dot per thing the sandbox depends on —
 * the app, the backend, storage, the simulator and the screen — and, open,
 * the detail of each. It was a section at the foot of the sidebar, where
 * it pushed Feedback up and was out of sight; in the header the dots are
 * always visible and the detail is one click away.
 */
export function ConnectionsMenu({
  status, screen, unreachable = false,
}: {
  status: Status | null; screen: ScreenState;
  /** The panel cannot reach the sandbox at all: everything else is stale. */
  unreachable?: boolean;
}) {
  const build = buildState(status), shown = screenState(status, screen);
  const backend = unreachable ? { tone: "bad" as const, label: "Unreachable" } : backendState(status);
  const dots: [string, Tone][] = [
    ["App", build.tone], ["Backend", backend.tone], ["Storage", status?.storage ? "warn" : "off"],
    ["Simulator", status?.simulator ? build.tone : "warn"], ["Screen", shown.tone],
  ];
  return (
    <Popover>
      <MenuButton label="Connections">
        <span className="font-medium">{unreachable ? "Unreachable" : "Connections"}</span>
        <span className="flex items-center gap-1" aria-hidden>
          {dots.map(([label, tone]) => <StatusDot key={label} tone={tone} />)}
        </span>
      </MenuButton>
      <PopoverContent>
        {status ? <Details status={status} screen={screen} /> : (
          <div className="space-y-4 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * AGENT, a header menu: which agent and whether it is working, and, open,
 * the picker and how it runs. Its own menu rather than a row under
 * Connections, because it is the one thing here people change.
 */
export function AgentMenu({ status }: { status: Status | null }) {
  const agent = agentState(status);
  const a = status?.agent;
  const [refreshKey, setRefreshKey] = useState(0);
  // The server's reason, as one sentence: the rest of its message is
  // install instructions for a terminal, which the menu does not need.
  const reason = a?.error?.split("\n")[0].trim().replace(/[\s:]+$/, "");
  const line = !a?.enabled
    ? "Turned off on the server"
    : reason || (a.working > 0 ? `${a.name} is working` : `Connected to ${a.name}`);
  return (
    <Popover>
      <MenuButton label="Agent">
        <StatusDot tone={agent.tone} />
        <span className="text-muted-foreground">Agent</span>
        <span className="font-medium">{agent.label}</span>
      </MenuButton>
      <PopoverContent>
        {/* The app's Agent page, in the panel: a header with refresh, the
            status in one line, then the picker when there is a choice. */}
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <span className="text-sm font-medium">Agent</span>
          <Button variant="ghost" size="icon-sm" aria-label="Look for agents again"
            onClick={() => setRefreshKey((n) => n + 1)}>
            <RotateCw />
          </Button>
        </div>
        <div className="space-y-3 px-4 pb-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <StatusDot tone={agent.tone} />
            {line}
          </div>
          {!a?.enabled && (
            <div>Started with <Code>AGENT=0</Code>, so tasks are stored and nothing acts on them.</div>
          )}
          {a?.enabled && <AgentPicker refreshKey={refreshKey} />}
          {a?.enabled && a.shell && <div>Its edits are auto-approved, and that includes shell commands.</div>}
          {a?.enabled && !a.error && (
            <div className="space-y-1">
              <div>
                {a.mode === "worktree"
                  ? `A branch per task, ${a.jobs} at a time${a.pullRequests ? ", opens pull requests" : ""}`
                  : <>Edits <Code>{a.dir}</Code> directly, so the app hot reloads</>}
              </div>
              {a.tools && <div className="flex flex-wrap gap-1">Tools: {a.tools.map((t) => <Code key={t}>{t}</Code>)}</div>}
              {a.sandbox && <div>Sandbox <Code>{a.sandbox}</Code></div>}
              <div>{a.working} working · {a.queued} queued</div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Details({ status, screen }: { status: Status; screen: ScreenState }) {
  const { protocol: p, storage: st, simulator: sim } = status;
  const build = buildState(status), shown = screenState(status, screen);
  const backend = backendState(status);

  return (
      <ItemGroup className="gap-0! py-1">
        <Row icon={<Server />} tone={backend.tone} label="Backend"
          value={p.ok
            ? <>Annotate Protocol v{p.version} <span className="font-normal text-muted-foreground">· {p.ms} ms</span></>
            : "Not answering"}>
          <div>App posts to <Code>{p.endpoint}</Code></div>
          <div>Session <Code>{p.session}</Code></div>
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

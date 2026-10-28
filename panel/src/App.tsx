import { useState } from "react";
import { Maximize, PenLine, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentMenu, ConnectionsMenu } from "@/components/connections";
import { DevicePicker } from "@/components/device-picker";
import { Feedback } from "@/components/feedback";
import { Phone, wake, type ScreenState } from "@/components/phone";
import { StatusDot } from "@/components/status-dot";
import { useDevices, useFeed, useStatus } from "@/hooks/use-sandbox";
import { Person } from "@/components/feedback-parts";
import type { Author } from "@/lib/api";
import { buildFeed } from "@/lib/feed";
import { Assets } from "@/components/assets";


export default function App() {
  const { status, error, refresh } = useStatus();
  const { devices, refresh: refreshDevices } = useDevices();
  const feed = useFeed(status?.protocol.session ?? "sandbox-session");
  const [screen, setScreen] = useState<ScreenState>("connecting");
  const [generation, setGeneration] = useState(0);

  const src = status?.screen.src ?? null;
  const sim = status?.simulator ?? null;

  // The header's summary line and the people in the conversation.
  const { open } = buildFeed(feed.tasks, feed.notes);
  const queued = feed.tasks.filter((t) => t.status === "pending").length;
  const people = new Map<string, Author>();
  for (const n of feed.notes) for (const m of n.messages ?? []) if (m.author?.id) people.set(m.author.id, m.author);
  const summary = [
    status?.app?.name,
    status?.app?.branch,
    `${open.length} open`,
  ].filter(Boolean).join(" · ");

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <PenLine className="size-4" />
            </div>
            <div>
              <h1 className="text-[15px] leading-tight font-semibold">Annotate sandbox</h1>
              <p className="text-xs text-muted-foreground">{summary}</p>
            </div>
          </div>
          <nav className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Status">
            <ConnectionsMenu status={status} screen={screen} unreachable={error} />
            <AgentMenu status={status} />
            {people.size > 0 && (
              <div className="flex -space-x-1.5" aria-label={`${people.size} people in team notes`}>
                {[...people.values()].slice(0, 4).map((p) => (
                  <Tooltip key={p.id}>
                    <TooltipTrigger asChild>
                      <span className="rounded-full ring-2 ring-background"><Person author={p} /></span>
                    </TooltipTrigger>
                    <TooltipContent>{p.name ?? "Someone"}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1440px] items-start gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <DevicePicker
              devices={devices}
              current={sim}
              busy={status?.build.state === "switching"}
              onSwitched={() => { refresh(); refreshDevices(); }}
            />
            <div className="ml-auto flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <StatusDot tone={feed.error ? "bad" : feed.live ? "ok" : "warn"} />
                {feed.error ? "Backend unreachable" : `${feed.live ? "Live" : "Polling"}${feed.updated ? ` · ${feed.updated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`}
              </span>
              <Button variant="ghost" size="sm" disabled={!src} onClick={() => { wake(); setGeneration((g) => g + 1); }}>
                <RotateCw /> Reconnect
              </Button>
              {/* Full screen, not a new tab: a second VNC connection can
                  land in another session — the login window — rather than
                  the one the app is running in. This is the same one. */}
              <Button variant="ghost" size="sm" disabled={!src}
                onClick={() => document.querySelector<HTMLIFrameElement>("#screen-frame")?.requestFullscreen()}>
                <Maximize /> Full screen
              </Button>
            </div>
          </div>

          {/* The stage has its own surface, so the device never sits on the
              page colour, and the bezel contrasts with THAT. */}
          <div className="flex justify-center rounded-3xl bg-muted/60 bg-[radial-gradient(circle_at_center,var(--border)_1px,transparent_1px)] bg-size-[16px_16px] px-4 py-8">
            {status ? (
              <Phone src={src} generation={generation} onState={setScreen} state={screen}
                build={status.build.state} autoUnlock={status.screen.autoUnlock} />
            ) : (
              <div className="aspect-[402/874] w-[min(100%,calc((100dvh-260px)*0.46),460px)] animate-pulse rounded-[66px] bg-neutral-300 dark:bg-neutral-800" />
            )}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
            <span>Click into the simulator to take control. Tap the pencil in the app to arm the overlay, then tap any element.</span>
            <span className="ml-auto tabular-nums">{open.length} open · {queued} queued for agent</span>
          </div>
        </section>

        {/* On a wide screen the column is exactly the window's height below
            the header, and Feedback takes whatever Connections leaves. */}
        <aside className="flex flex-col gap-4 rounded-2xl border p-3 lg:sticky lg:top-20 lg:h-[calc(100dvh-112px)]">
          <Feedback tasks={feed.tasks} notes={feed.notes} refresh={feed.refresh} agent={status?.agent ?? null} session={status?.protocol.session ?? "sandbox-session"} className="lg:min-h-[45%] lg:flex-1" />
          <Assets />
        </aside>
      </main>
    </div>
  );
}

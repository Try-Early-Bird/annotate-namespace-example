import { useState } from "react";
import { Check, ChevronDown, Inbox, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentReady, NoteCard, ResolvedRow, TaskCard } from "@/components/cards";
import { attempt } from "@/components/feedback-parts";
import { sendToAgent } from "@/lib/actions";
import type { Agent, Mark } from "@/lib/api";
import { buildFeed, type FeedItem } from "@/lib/feed";
import { cn } from "@/lib/utils";

type Filter = "all" | "agent" | "team";

const FILTERS: { value: Filter; label: string; dot?: string }[] = [
  { value: "all", label: "All" },
  { value: "agent", label: "Agent", dot: "bg-agent" },
  { value: "team", label: "Team", dot: "bg-team" },
];

const matches = (filter: Filter, item: FeedItem) =>
  filter === "all" || (filter === "agent" ? item.type === "task" : item.type === "note");

/**
 * Agent tasks and team notes in ONE list, filtered like the app's queue.
 * What needs a decision comes first — a running task, one waiting for
 * review, one that failed — and settled things fold away at the bottom.
 */
export function Feedback({
  tasks, notes, agent, session, refresh, className,
}: {
  tasks: Mark[]; notes: Mark[]; agent: Agent | null; session: string; refresh: () => void; className?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const { open, resolved } = buildFeed(tasks, notes);
  const shown = open.filter((i) => matches(filter, i));
  const settled = resolved.filter((i) => matches(filter, i));
  const pending = tasks.filter((t) => t.status === "pending");

  const run = (
    <Button size="xs" className="bg-agent text-agent-foreground hover:bg-agent/85"
      disabled={!pending.length || !agentReady(agent)}
      onClick={() => attempt("send to the agent", () => sendToAgent(pending.map((t) => t.id)),
        `Sent ${pending.length} to ${agent?.name ?? "the agent"}`).then(refresh)}>
      <Play className="fill-current" /> Run {pending.length || ""} task{pending.length === 1 ? "" : "s"}
    </Button>
  );

  return (
    <section className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-1 pb-2">
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" role="radio" aria-checked={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                filter === f.value && "bg-secondary text-foreground",
              )}>
              {f.dot && <span className={cn("size-1.5 rounded-full", f.dot)} />}{f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto">
          {agentReady(agent) ? run : (
            <Tooltip>
              <TooltipTrigger asChild><span tabIndex={0}>{run}</span></TooltipTrigger>
              <TooltipContent>No agent is connected. Start the sandbox with AGENT=1.</TooltipContent>
            </Tooltip>
          )}
        </span>
      </div>

      {/* Scrolls inside the card: on a wide screen the card fills the
          column's height, on a narrow one it stops at most of the screen. */}
      <div className="-mx-1 min-h-[320px] max-h-[75dvh] flex-1 space-y-2 overflow-y-auto px-1 lg:max-h-none lg:min-h-0">
        {shown.map((item) => item.type === "task" ? (
          <TaskCard key={item.mark.id} mark={item.mark} state={item.state} number={item.number} agent={agent} onChange={refresh} />
        ) : (
          <NoteCard key={item.mark.id} mark={item.mark} tasks={item.tasks} agent={agent} session={session} onChange={refresh} />
        ))}

        {!shown.length && (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
              <EmptyTitle>{settled.length ? "All caught up" : "Nothing yet"}</EmptyTitle>
              <EmptyDescription>
                Tap the pencil in the app, tap an element, and send it to the agent or the team. It appears here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {settled.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              <Check className="size-3.5" /> {settled.length} resolved
              <ChevronDown className="ml-auto size-3.5 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="space-y-0.5">
                {settled.map((item) => (
                  <ResolvedRow key={item.mark.id} mark={item.mark} kind={item.type} onChange={refresh} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </section>
  );
}

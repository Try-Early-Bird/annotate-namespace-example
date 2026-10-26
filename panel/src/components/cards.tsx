import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  ArrowRight, Bot, Check, CircleAlert, CircleDot, Eye, FileDiff, ListPlus, Play, Quote, RotateCcw,
  Send, Square, Undo2, User, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { attempt, Composer, nameOf, Person, RowMenu } from "@/components/feedback-parts";
import { useName } from "@/hooks/use-name";
import {
  acceptRun, DISCUSSION, deleteNote, deleteTask, replyToNote, replyToTask, revertRun, sendToAgent,
  setNoteStatus, stopRun, taskFromNote, taskText,
} from "@/lib/actions";
import {
  ago, messageText, referenceHref, screenshotUrl, shotUrl, type Agent, type Mark, type Message,
} from "@/lib/api";
import { taskState, type TaskState } from "@/lib/feed";
import { cn } from "@/lib/utils";

export const agentReady = (agent: Agent | null) => Boolean(agent?.enabled && !agent.error);

// ── Pieces ──────────────────────────────────────────────────────────────

/**
 * The card's mark, drawn like the app's marker on the phone: an agent task
 * is a teal circle with its number, a team note an orange rounded square
 * with a quote. A task with no marker on screen (finished, or not placed)
 * shows its state instead of a number.
 */
export function Marker({ kind, number }: { kind: "agent" | "team"; number?: number | null }) {
  if (kind === "team") {
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-md bg-team text-team-foreground" aria-label="Team note">
        <Quote className="size-3 fill-current" strokeWidth={0} />
      </span>
    );
  }
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-agent text-[11px] font-semibold text-agent-foreground tabular-nums"
      aria-label={number ? `Agent task ${number}` : "Agent task"}>
      {number ?? <Bot className="size-3" />}
    </span>
  );
}

const PILL: Record<string, string> = {
  agent: "text-agent",
  team: "text-team",
  failed: "text-destructive",
  muted: "text-muted-foreground",
};

function Pill({ tone, icon, children }: { tone: keyof typeof PILL; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium [&_svg]:size-3", PILL[tone])}>
      {icon}{children}
    </span>
  );
}

/** A running clock from when the run started: "0:42". */
function Elapsed({ since }: { since?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!since) return null;
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return <span className="tabular-nums">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

/** component · file:line · screen, in one quiet monospace line. */
function Where({ mark }: { mark: Mark }) {
  const parts = [
    mark.element,
    mark.source?.file && `${mark.source.file.split("/").pop()}:${mark.source.line ?? "?"}`,
    mark.routeName,
  ].filter(Boolean);
  return parts.length ? <p className="truncate font-mono text-[11px] text-muted-foreground">{parts.join(" · ")}</p> : null;
}

/** The card frame: a soft surface, tinted when it failed, then header, body, actions. */
function Frame({
  edge, head, children, className,
}: {
  edge?: "agent" | "team" | "failed"; head: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <article className={cn(
      "space-y-2 rounded-xl bg-muted/60 p-3 text-card-foreground",
      edge === "failed" && "bg-destructive/[0.06]",
      className,
    )}>
      <div className="flex items-center gap-2">{head}</div>
      {children}
    </article>
  );
}

/** A send that cannot happen says why, rather than silently doing nothing. */
function NeedsAgent({ agent, children }: { agent: Agent | null; children: ReactNode }) {
  if (agentReady(agent)) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0}>{children}</span></TooltipTrigger>
      <TooltipContent>No agent is connected. Start the sandbox with AGENT=1.</TooltipContent>
    </Tooltip>
  );
}

function Busy({ onClick, children, ...props }: Omit<ComponentProps<typeof Button>, "onClick"> & { onClick: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button {...props} disabled={props.disabled || busy}
      onClick={async () => { setBusy(true); await onClick(); setBusy(false); }}>
      {busy && <Spinner />}{children}
    </Button>
  );
}

const agentButton = "bg-agent text-agent-foreground hover:bg-agent/85";

// ── Agent tasks ─────────────────────────────────────────────────────────

/** The request, with a quoted discussion (from a note) as quiet context. */
function Title({ text }: { text: string }) {
  const at = text.indexOf(DISCUSSION);
  const request = (at >= 0 ? text.slice(0, at) : text).trim();
  const quoted = at >= 0 ? text.slice(at + DISCUSSION.length).trim() : "";
  return (
    <>
      {request && <p className="text-sm leading-snug font-semibold whitespace-pre-wrap">{request}</p>}
      {quoted && (
        <blockquote className="text-xs whitespace-pre-wrap text-muted-foreground">{quoted}</blockquote>
      )}
    </>
  );
}

/** The thread, compact: the agent's replies and the person's follow-ups. */
function Thread({ mark }: { mark: Mark }) {
  const diff = (mark.references ?? []).find((r) => r.type === "url" && /\/diff$/.test(r.value ?? ""));
  const messages = (mark.thread ?? []).filter((m) => messageText(m).trim());
  if (!messages.length) return null;
  return (
    <ul className="space-y-1.5">
      {messages.map((m, i) => {
        const agent = m.role === "agent" || m.role === "assistant";
        const last = i === messages.length - 1;
        return (
          <li key={m.id} className="flex gap-2 text-xs">
            <span className={cn("mt-px grid size-4 shrink-0 place-items-center rounded-full",
              agent ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground")}>
              {agent ? <Bot className="size-2.5" /> : <User className="size-2.5" />}
            </span>
            <p className="min-w-0 break-words whitespace-pre-wrap">
              {messageText(m)}
              {agent && last && diff && (
                <> <a className="font-medium text-agent hover:underline" target="_blank" rel="noopener"
                  href={referenceHref(diff, mark.id) ?? undefined}>Diff</a></>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function Screenshot({ mark }: { mark: Mark }) {
  const shot = (mark.references ?? []).find((r) => r.type === "screenshot" && r.url);
  if (!shot) return null;
  const src = screenshotUrl(shot.url!);
  return (
    <a href={src} target="_blank" rel="noopener" className="block w-fit">
      <img src={src} alt="What was tapped" loading="lazy" className="h-20 rounded-md object-cover hover:opacity-80" />
    </a>
  );
}

/** The agent's steps as they happen: done ones ticked, the current one last. */
function Log({ lines }: { lines: string[] }) {
  if (!lines.length) return <p className="text-xs text-muted-foreground">Starting…</p>;
  const shown = lines.slice(-6);
  return (
    <div className="space-y-0.5 rounded-lg bg-background px-2.5 py-2 font-mono text-[11px]">
      {shown.map((line, i) => {
        const current = i === shown.length - 1;
        return (
          <p key={i} className={cn("truncate", current ? "font-medium text-foreground" : "text-muted-foreground")}>
            {current ? "▸ " : "✓ "}{line}{current && "…"}
          </p>
        );
      })}
    </div>
  );
}

/** Before and after, side by side, with what changed under them. */
function Review({ mark }: { mark: Mark }) {
  const run = mark.run!;
  const reply = [...(mark.thread ?? [])].reverse().find((m) => m.role === "agent");
  const summary = reply ? messageText(reply).split("\n\n")[0] : "";
  return (
    <div className="space-y-2">
      {(run.before || run.after) && (
        <div className="grid grid-cols-2 gap-2">
          {(["before", "after"] as const).map((side) => (
            <figure key={side} className={cn("overflow-hidden rounded-lg bg-background", side === "after" && "ring-2 ring-agent/60")}>
              <figcaption className={cn("px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase",
                side === "after" ? "text-agent" : "text-muted-foreground")}>{side}</figcaption>
              {run[side]
                ? <a href={shotUrl(run[side]!)} target="_blank" rel="noopener">
                    <img src={shotUrl(run[side]!)} alt={`The screen ${side} the change`} className="h-24 w-full object-cover object-top" />
                  </a>
                : <div className="grid h-24 place-items-center text-[11px] text-muted-foreground"><Spinner /></div>}
            </figure>
          ))}
        </div>
      )}
      {summary && <p className="text-xs leading-snug">{summary}</p>}
      {(run.files ?? []).map((f) => (
        <p key={f.path} className="flex items-center gap-1.5 font-mono text-[11px]">
          <FileDiff className="size-3 text-muted-foreground" />
          <span className="text-agent">+{f.added}</span><span className="text-destructive">−{f.removed}</span>
          <span className="truncate text-muted-foreground">in {f.path.split("/").pop()}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Everything one task can show and do, by state. Used on its own in the
 * feed, and inside a team note's card for the task the note became.
 */
function TaskBody({
  mark, state, agent, onChange, embedded,
}: {
  mark: Mark; state: TaskState; agent: Agent | null; onChange: () => void; embedded?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const send = () => attempt("send to the agent", () => sendToAgent([mark.id]), `Sent to ${agent?.name ?? "the agent"}`).then(onChange);
  const run = mark.run;

  const body = (() => {
    switch (state) {
      case "running":
        return <Log lines={run?.log ?? []} />;
      case "review":
        return <Review mark={mark} />;
      case "failed":
        return (
          <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs leading-snug text-destructive whitespace-pre-wrap">
            {run?.error ?? "The agent could not finish this task."}
          </p>
        );
      default:
        return (
          <>
            <Thread mark={mark} />
            {run?.state === "stopped" && <p className="text-xs text-muted-foreground">Stopped before it finished.</p>}
          </>
        );
    }
  })();

  const actions = (() => {
    switch (state) {
      case "running":
        return (
          <Busy size="xs" variant="ghost" onClick={() => attempt("stop the agent", () => stopRun(mark.id)).then(onChange)}>
            <Square className="fill-current" /> Stop
          </Busy>
        );
      case "review":
        return (
          <>
            <Busy size="xs" variant="ghost" className="mr-auto"
              onClick={() => attempt("revert the change", () => revertRun(mark.id), "Reverted").then(onChange)}>
              <Undo2 /> Revert
            </Busy>
            <Button size="xs" variant="ghost" onClick={() => setReplying((r) => !r)}>Follow up</Button>
            <Busy size="xs" className={agentButton}
              onClick={() => attempt("accept the change", () => acceptRun(mark.id), "Accepted").then(onChange)}>
              <Check /> Accept
            </Busy>
          </>
        );
      case "failed":
        return (
          <>
            <Button size="xs" variant="ghost" onClick={() => setReplying((r) => !r)}>Reply</Button>
            <NeedsAgent agent={agent}>
              <Busy size="xs" variant="ghost" disabled={!agentReady(agent)} onClick={send}><RotateCcw /> Retry</Busy>
            </NeedsAgent>
          </>
        );
      case "queued":
        return (
          <>
            {/* In a note's card, Reply is the note's — to the team. */}
            {!embedded && <Button size="xs" variant="ghost" onClick={() => setReplying((r) => !r)}>Reply</Button>}
            <NeedsAgent agent={agent}>
              <Busy size="xs" variant="ghost" className="text-agent hover:bg-agent/10 hover:text-agent" disabled={!agentReady(agent)} onClick={send}><Play /> Run now</Busy>
            </NeedsAgent>
          </>
        );
      default:
        return null;
    }
  })();

  return (
    <>
      {!embedded && <Title text={mark.comment ?? mark.content ?? "(no text)"} />}
      {!embedded && <Where mark={mark} />}
      {!embedded && state === "queued" && <Screenshot mark={mark} />}
      {body}
      {replying && (
        <Composer autoFocus
          placeholder={state === "review" ? "What should be different?" : "Add detail for the agent…"}
          onSend={(text) => attempt("post the follow-up", () => replyToTask(mark.id, text))
            .then((ok) => { onChange(); if (ok) setReplying(false); return ok; })}
          footer={state === "review" ? "Puts the task back in the queue. Run it again when ready." : undefined}
        />
      )}
      {actions && <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1">{actions}</div>}
    </>
  );
}

function taskHead(mark: Mark, state: TaskState, number: number | null) {
  const pill = {
    queued: <Pill tone="agent">Queued</Pill>,
    running: <Pill tone="agent" icon={<CircleDot className="animate-pulse" />}>Running · <Elapsed since={mark.run?.startedAt} /></Pill>,
    review: <Pill tone="agent" icon={<Eye />}>Needs review</Pill>,
    failed: <Pill tone="failed" icon={<CircleAlert />}>Failed</Pill>,
    resolved: <Pill tone="muted" icon={<Check />}>Done</Pill>,
  }[state];
  return { pill, mark: <Marker kind="agent" number={number} /> };
}

export function TaskCard({
  mark, state, number, agent, onChange,
}: {
  mark: Mark; state: TaskState; number: number | null; agent: Agent | null; onChange: () => void;
}) {
  const { pill, mark: badge } = taskHead(mark, state, number);
  return (
    <Frame
      edge={state === "failed" ? "failed" : state === "running" || state === "review" ? "agent" : undefined}
      head={<>
        {badge}{pill}
        <span className="ml-auto text-[11px] text-muted-foreground">{ago(mark.run?.finishedAt ?? mark.createdAt)}</span>
        <RowMenu what="task" onDelete={() => attempt("delete the task", () => deleteTask(mark.id)).then((ok) => { onChange(); return ok; })} />
      </>}
    >
      <TaskBody mark={mark} state={state} agent={agent} onChange={onChange} />
    </Frame>
  );
}

// ── Team notes ──────────────────────────────────────────────────────────

/**
 * Make an agent task out of the note, the way the app does: tick the
 * message (or messages) that hold the request, optionally say in your own
 * words what to do, then queue it or send it. The note stays open.
 */
function MakeTask({
  note, quoted, agent, session, onDone, onCancel,
}: {
  note: Mark; quoted: Message[]; agent: Agent | null; session: string; onDone: () => void; onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const preview = taskText(instruction, quoted);
  const go = (send: boolean) => attempt("make the task",
    () => taskFromNote(note, quoted, instruction, session, send),
    send ? `Sent to ${agent?.name ?? "the agent"}` : "Added to the queue").then((ok) => { if (ok) onDone(); });

  return (
    <div className="space-y-2 rounded-lg bg-background p-2.5">
      <p className="text-[11px] text-muted-foreground">
        {quoted.length
          ? `${quoted.length} message${quoted.length === 1 ? "" : "s"} quoted as context.`
          : "Tick the messages that hold the request, or just write it."}
      </p>
      <Textarea autoFocus value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2}
        placeholder="What should the agent do?" className="resize-none text-sm" />
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={onCancel}><X /> Cancel</Button>
        <Busy size="xs" variant="ghost" disabled={!preview} onClick={() => go(false)}><ListPlus /> Queue</Busy>
        <NeedsAgent agent={agent}>
          <Busy size="xs" className={agentButton} disabled={!preview || !agentReady(agent)} onClick={() => go(true)}>
            <Send /> Send to agent
          </Busy>
        </NeedsAgent>
      </div>
    </div>
  );
}

function Messages({
  messages, picking, picked, onPick, tasked,
}: {
  messages: Message[]; picking: boolean; picked: string[]; onPick: (id: string) => void; tasked: Set<string>;
}) {
  return (
    <ul className="space-y-2">
      {messages.map((m) => {
        const row = (
          <div className="flex min-w-0 flex-1 gap-2">
            <Person author={m.author} />
            <p className="min-w-0 pt-0.5 text-xs leading-snug break-words whitespace-pre-wrap">
              <span className="font-semibold">{nameOf(m.author)}</span>{" "}
              {messageText(m)}
              {tasked.has(m.id) && <Bot className="ml-1 inline size-3 text-agent" aria-label="made into an agent task" />}
            </p>
          </div>
        );
        return (
          <li key={m.id}>
            {picking ? (
              <label className={cn("-mx-1.5 flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-background",
                picked.includes(m.id) && "bg-muted")}>
                <Checkbox className="mt-1" checked={picked.includes(m.id)} onCheckedChange={() => onPick(m.id)} aria-label="Quote this message" />
                {row}
              </label>
            ) : row}
          </li>
        );
      })}
    </ul>
  );
}

export function NoteCard({
  mark, tasks, agent, session, onChange,
}: {
  mark: Mark; tasks: Mark[]; agent: Agent | null; session: string; onChange: () => void;
}) {
  const { name, ensure, change } = useName();
  const [mode, setMode] = useState<"idle" | "reply" | "task">("idle");
  const [picked, setPicked] = useState<string[]>([]);

  const messages = (mark.messages ?? []).filter((m) => messageText(m).trim());
  const all: Message[] = messages.length
    ? messages
    : [{ id: "legacy", content: mark.comment ?? mark.content ?? "", author: mark.author, createdAt: mark.createdAt }];
  const resolved = mark.status === "resolved" || mark.status === "converted";
  const tasked = new Set(tasks.flatMap((t) => t.sourceMessageIds ?? []));
  // The task this note became that still has something to say, newest first.
  const task = [...tasks].sort((a, b) => Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0"))[0];
  const state = task ? taskState(task) : null;
  const stop = () => { setMode("idle"); setPicked([]); };
  const toggleResolved = () => attempt(resolved ? "reopen the note" : "resolve the note",
    () => setNoteStatus(mark.id, resolved ? "open" : "resolved")).then(onChange);

  return (
    <Frame
      edge="team"
      className={cn(resolved && "opacity-75")}
      head={<>
        <Marker kind="team" />
        {task ? (
          <span className="flex items-center gap-1.5 text-xs">
            <Pill tone="team">Team note</Pill>
            <ArrowRight className="size-3 text-muted-foreground" />
            <span className="rounded-full bg-agent/15 px-1.5 py-px font-medium text-agent">
              Task {state === "resolved" ? "done" : state}
            </span>
          </span>
        ) : <Pill tone="team">Team</Pill>}
        <span className="ml-auto text-[11px] text-muted-foreground">{ago(mark.updatedAt ?? mark.createdAt)}</span>
        <RowMenu what="note" onDelete={() => attempt("delete the note", () => deleteNote(mark.id)).then((ok) => { onChange(); return ok; })} />
      </>}
    >
      <Messages messages={all.filter((m) => m.id !== "legacy" || messageText(m))} picking={mode === "task"}
        picked={picked} onPick={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
        tasked={tasked} />
      <Where mark={mark} />

      {task && (
        <div className="space-y-2 rounded-lg bg-background p-2.5">
          <p className="flex gap-1.5 text-[11px] leading-snug text-muted-foreground">
            <Bot className="mt-px size-3 shrink-0" />
            <span>
              Sent to {agent?.name ?? "the agent"} as “{(task.comment ?? "").split(DISCUSSION)[0].trim()}”.
              Replies here stay with the team; the task reports back in this card.
            </span>
          </p>
          {state !== "resolved" && <TaskBody mark={task} state={state!} agent={agent} onChange={onChange} embedded />}
        </div>
      )}

      {mode === "task" && (
        <MakeTask note={mark} agent={agent} session={session}
          quoted={all.filter((m) => picked.includes(m.id) && m.id !== "legacy")}
          onCancel={stop} onDone={() => { stop(); onChange(); }} />
      )}
      {mode === "reply" && (
        <Composer autoFocus placeholder="Reply to the team…"
          onSend={async (text) => {
            const who = await ensure();
            if (!who) return false;
            const ok = await attempt("post the reply", () => replyToNote(mark.id, text, who));
            onChange();
            if (ok) setMode("idle");
            return ok;
          }}
          footer={name ? <>Posting as {name} · <button type="button" className="hover:underline" onClick={change}>Change</button></> : undefined}
        />
      )}

      {mode === "idle" && (
        <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1">
          <Button size="xs" variant="ghost" onClick={() => setMode("reply")}>Reply</Button>
          {task || resolved ? (
            <Button size="xs" variant="ghost" onClick={toggleResolved}>{resolved ? <><RotateCcw /> Reopen</> : <><Check /> Resolve</>}</Button>
          ) : (
            <>
              <Button size="xs" variant="ghost" onClick={toggleResolved}><Check /> Resolve</Button>
              <Button size="xs" variant="ghost" className="text-agent hover:bg-agent/10 hover:text-agent"
                onClick={() => setMode("task")}>
                <Send /> Send to agent
              </Button>
            </>
          )}
        </div>
      )}
    </Frame>
  );
}

// ── The resolved pile ───────────────────────────────────────────────────

export function ResolvedRow({ mark, kind, onChange }: { mark: Mark; kind: "task" | "note"; onChange: () => void }) {
  const run = mark.run?.state;
  const label = kind === "note" ? "Resolved" : run === "accepted" ? "Accepted" : run === "reverted" ? "Reverted" : "Done";
  const text = kind === "note"
    ? messageText((mark.messages ?? [])[0] ?? { id: "", content: mark.comment ?? "" })
    : (mark.comment ?? "").split(DISCUSSION)[0];
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50">
      <Marker kind={kind === "note" ? "team" : "agent"} />
      <span className="min-w-0 flex-1 truncate">{text || "(no text)"}</span>
      <span className="text-muted-foreground">{label}</span>
      {kind === "note" && (
        <Button size="xs" variant="ghost" onClick={() => attempt("reopen the note", () => setNoteStatus(mark.id, "open")).then(onChange)}>
          Reopen
        </Button>
      )}
    </li>
  );
}

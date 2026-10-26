import { useState, type ReactNode } from "react";
import { Code2, ExternalLink, GitBranch, Monitor, MoreHorizontal, SendHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { referenceHref, screenshotUrl, type Author, type Mark } from "@/lib/api";
import { cn } from "@/lib/utils";

const STATUS: Record<string, [string, string]> = {
  pending: ["Pending", "bg-amber-500/15 text-amber-700 dark:text-amber-300"],
  working: ["Working", "bg-sky-500/15 text-sky-700 dark:text-sky-300"],
  sent: ["Done", "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"],
  open: ["Open", "bg-orange-500/15 text-orange-700 dark:text-orange-300"],
  resolved: ["Resolved", "bg-muted text-muted-foreground"],
  converted: ["Resolved", "bg-muted text-muted-foreground"],
};

export function StatusBadge({ status }: { status?: string }) {
  const [label, cls] = STATUS[status ?? ""] ?? [status ?? "—", STATUS.resolved[1]];
  return <Badge className={cn("border-0", cls)}>{label}</Badge>;
}

/** A small uppercase heading inside a row: which part of it this is. */
export function Label({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase [&_svg]:size-3.5">
      {icon}{children}
    </p>
  );
}

/** What was tapped: the component, the file it is defined in, the screen. */
export function Target({ mark }: { mark: Mark }) {
  if (!mark.element && !mark.source?.file && !mark.routeName) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {mark.element && (
        <Badge variant="secondary" className="font-mono font-normal"><Code2 />{mark.element}</Badge>
      )}
      {mark.source?.file && (
        <Badge variant="secondary" className="font-mono font-normal text-muted-foreground">
          {mark.source.file.split("/").pop()}:{mark.source.line ?? "?"}
        </Badge>
      )}
      {mark.routeName && (
        <Badge variant="secondary" className="font-normal text-muted-foreground"><Monitor />{mark.routeName}</Badge>
      )}
    </div>
  );
}

export function Screenshots({ mark }: { mark: Mark }) {
  const shots = (mark.references ?? []).filter((r) => r.type === "screenshot" && r.url);
  if (!shots.length) return null;
  return (
    <div className="flex gap-2">
      {shots.map((r, i) => {
        const src = screenshotUrl(r.url!);
        return (
          <a key={i} href={src} target="_blank" rel="noopener" className="shrink-0">
            <img src={src} alt="Screenshot of what was tapped" loading="lazy"
              className="h-28 rounded-md border object-cover transition-opacity hover:opacity-80" />
          </a>
        );
      })}
    </div>
  );
}

/** What the agent produced: its branch, the diff, a pull request. */
export function Results({ mark }: { mark: Mark }) {
  const items = (mark.references ?? []).flatMap((r, i) => {
    if (r.type === "branch") {
      return [<Badge key={i} variant="secondary" className="font-mono font-normal"><GitBranch />{r.label ?? r.value}</Badge>];
    }
    const href = referenceHref(r, mark.id);
    if (!href) return [];
    return [
      <Badge key={i} variant="secondary" asChild>
        <a href={href} target="_blank" rel="noopener">{r.label ?? "Link"}<ExternalLink /></a>
      </Badge>,
    ];
  });
  return items.length ? <div className="flex flex-wrap gap-1.5">{items}</div> : null;
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** A stable colour per person, so the same name reads the same everywhere. */
const HUES = ["bg-rose-500", "bg-orange-500", "bg-amber-500", "bg-emerald-500", "bg-teal-500", "bg-sky-500", "bg-indigo-500", "bg-fuchsia-500"];
function hue(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

export const nameOf = (a?: Author | null) => a?.name?.trim() || "Someone";

export function Person({ author, size = "sm" }: { author?: Author | null; size?: "sm" | "default" }) {
  return (
    <Avatar size={size}>
      {author?.avatarUrl && <AvatarImage src={author.avatarUrl} alt="" />}
      <AvatarFallback className={cn("text-[10px] font-medium text-white", author?.id ? hue(author.id) : "bg-muted-foreground")}>
        {author?.name ? initials(nameOf(author)) : "?"}
      </AvatarFallback>
    </Avatar>
  );
}

/** Run an action with a toast on failure; true if it went through. */
export async function attempt(what: string, run: () => Promise<unknown>, done?: string) {
  try {
    await run();
    if (done) toast.success(done);
    return true;
  } catch (err) {
    toast.error(`Could not ${what}`, { description: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * A text box that posts. Enter sends, Shift+Enter is a new line — the
 * chat convention, and what the app's reply box does.
 */
export function Composer({
  placeholder, onSend, footer, autoFocus,
}: {
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  footer?: ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    if (await onSend(value)) setText("");
    setBusy(false);
  };
  return (
    <div className="space-y-1">
      <div className="relative">
        <Textarea
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }}
          placeholder={placeholder}
          rows={1}
          className="min-h-9 resize-none pr-10 text-sm"
        />
        <Button
          size="icon-xs" variant="ghost" aria-label="Post"
          className="absolute right-1.5 bottom-1.5"
          disabled={!text.trim() || busy}
          onClick={submit}
        >
          {busy ? <Spinner /> : <SendHorizontal />}
        </Button>
      </div>
      {footer && <div className="text-[11px] text-muted-foreground">{footer}</div>}
    </div>
  );
}

/** The ⋯ menu on a row. Only destructive things live here, behind a confirm. */
export function RowMenu({ what, onDelete }: { what: string; onDelete: () => Promise<boolean> }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-xs" variant="ghost" aria-label={`More actions for this ${what}`}><MoreHorizontal /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
            <Trash2 /> Delete {what}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this {what}?</AlertDialogTitle>
            <AlertDialogDescription>
              It goes for everyone, in the app as well as here. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { onDelete(); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

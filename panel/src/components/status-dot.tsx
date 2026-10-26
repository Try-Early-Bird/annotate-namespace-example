import { cn } from "@/lib/utils";

export type Tone = "ok" | "busy" | "warn" | "bad" | "off";

const TONES: Record<Tone, string> = {
  ok: "bg-emerald-500",
  busy: "bg-sky-500 animate-pulse",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  off: "bg-muted-foreground/40",
};

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", TONES[tone], className)} />;
}

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Who is replying from the web. The stub has no sign-in, so — like the app —
 * the panel asks once, at the moment a name is first needed, and sends it as
 * the advisory `authorName`. Kept per browser; storage that is missing or
 * throws just means asking again.
 */
const KEY = "panel.name";
const read = () => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };
const write = (name: string) => { try { localStorage.setItem(KEY, name); } catch { /* not kept */ } };

type NameApi = {
  name: string;
  /** The name, asking for it first if there is none. Null if they cancel. */
  ensure: () => Promise<string | null>;
  change: () => void;
};

const NameContext = createContext<NameApi | null>(null);

export function NameProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState(read);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const waiting = useRef<((name: string | null) => void) | null>(null);

  const ask = useCallback(() => {
    setDraft(read());
    setOpen(true);
    return new Promise<string | null>((resolve) => { waiting.current = resolve; });
  }, []);

  const ensure = useCallback(async () => name || ask(), [name, ask]);

  const finish = (value: string | null) => {
    if (value) { setName(value); write(value); }
    setOpen(false);
    waiting.current?.(value);
    waiting.current = null;
  };

  return (
    <NameContext.Provider value={{ name, ensure, change: () => { ask(); } }}>
      {children}
      <Dialog open={open} onOpenChange={(o) => { if (!o) finish(null); }}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) finish(draft.trim()); }}>
            <DialogHeader>
              <DialogTitle>What should we call you?</DialogTitle>
              <DialogDescription>
                Your name goes on the replies you post from here, so the team can tell who said what.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 grid gap-2">
              <Label htmlFor="panel-name">Name</Label>
              <Input id="panel-name" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={80} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => finish(null)}>Cancel</Button>
              <Button type="submit" disabled={!draft.trim()}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </NameContext.Provider>
  );
}

export function useName() {
  const api = useContext(NameContext);
  if (!api) throw new Error("useName outside NameProvider");
  return api;
}

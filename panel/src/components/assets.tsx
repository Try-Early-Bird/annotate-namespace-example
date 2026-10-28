import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { ChevronDown, Copy, File, ImageUp, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { assetPreview, deleteAsset, listAssets, uploadAsset, type Asset } from "@/lib/api";

const KEY = "annotate-panel:assets-open";
function remembered() {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
function remember(open: boolean) {
  try { localStorage.setItem(KEY, open ? "1" : "0"); } catch { /* not kept */ }
}

/** Only uploads can be deleted here; the rest of assets/ is the app's own. */
const deletable = (a: Asset) => a.path.startsWith("uploads/");

/**
 * The app's assets/ folder. Images uploaded here land in assets/uploads/ in
 * the app's repo, show up in the app's + Attach → Assets, and reach the
 * agent as a path it can open and require() — so a task can say "use this
 * logo" and mean a file. Collapsed by default, like Connections.
 */
export function Assets() {
  const [open, setOpen] = useState(remembered);
  const toggle = (next: boolean) => { setOpen(next); remember(next); };
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [writable, setWritable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    listAssets()
      .then((r) => { setAssets(r.assets); setWritable(r.writable); })
      .catch(() => setAssets([]));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setBusy(true);
    for (const file of list) {
      try {
        const a = await uploadAsset(file);
        toast(`Added ${a.publicPath}`);
      } catch (err) {
        toast.error(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBusy(false);
    load();
  }

  async function remove(a: Asset) {
    try {
      await deleteAsset(a.path);
      toast(`Deleted ${a.publicPath}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    load();
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (writable) void upload(e.dataTransfer.files);
  };

  return (
    <Collapsible open={open} onOpenChange={toggle} asChild>
      <section className="shrink-0 rounded-xl bg-muted/60">
        <CollapsibleTrigger asChild>
          <div
            role="button"
            aria-label={open ? "Collapse assets" : "Expand assets"}
            className="flex cursor-pointer items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium select-none hover:bg-muted"
          >
            Assets
            {assets && <span className="text-xs font-normal text-muted-foreground tabular-nums">{assets.length}</span>}
            <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform in-data-[state=open]:rotate-180" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="max-h-[40dvh] space-y-3 overflow-y-auto px-4 pb-4">
          {writable && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex flex-col items-center gap-2 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground transition-colors ${dragging ? "border-primary bg-primary/5" : ""}`}
            >
              <span>Drop images here, or</span>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
                {busy ? <Spinner className="size-3" /> : <ImageUp />} Upload images
              </Button>
              <span>PNG, JPEG, GIF or WebP, up to 16 MB. Saved to <code>assets/uploads/</code> in the app.</span>
              <input
                ref={input}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }}
              />
            </div>
          )}
          {assets === null && <Spinner className="size-4" />}
          {assets?.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No assets yet. Anything in the app's <code>assets/</code> folder shows up here and in the app's + Attach.
            </p>
          )}
          <ul className="space-y-1">
            {assets?.map((a) => {
              const preview = assetPreview(a);
              return (
                <li key={a.path} className="flex items-center gap-3 rounded-md px-1 py-1 hover:bg-muted">
                  {preview
                    ? <img src={preview} alt="" className="size-10 shrink-0 rounded border bg-background object-contain" loading="lazy" />
                    : <span className="grid size-10 shrink-0 place-items-center rounded border bg-background"><File className="size-4 text-muted-foreground" /></span>}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{a.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{a.publicPath}</div>
                  </div>
                  <Button size="icon-sm" variant="ghost" aria-label={`Copy ${a.publicPath}`}
                    onClick={() => { void navigator.clipboard?.writeText(a.publicPath); toast(`Copied ${a.publicPath}`); }}>
                    <Copy />
                  </Button>
                  {writable && deletable(a) && (
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${a.publicPath}`} onClick={() => void remove(a)}>
                      <Trash2 />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

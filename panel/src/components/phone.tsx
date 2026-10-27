import { useEffect, useRef, useState, type ReactNode } from "react";
import { Lock, MonitorOff, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

export type ScreenState = "connecting" | "connected" | "disconnected";

/** Wake the Mac's display: asleep, it sends no frames and the picture freezes. */
export const wake = () => fetch("/sandbox/wake", { method: "POST" }).catch(() => {});

/** What the viewer is showing: the device, the lock screen, or the bare desktop. */
type View = "device" | "locked" | "desktop";

/** An iPhone 17 Pro, in points: the shape until the viewer reports one. */
const DEFAULT_SHAPE = { width: 402, height: 874 };

/**
 * The simulator's screen in a device frame.
 *
 * The screen is /vnc in an iframe: noVNC, cropped to the Simulator's device
 * screen. It reports the crop's shape, so the frame follows the device that
 * is actually running — an iPad or an iPhone SE is not a 17 Pro, and a
 * fixed frame letterboxes them. Same origin, so one authorisation covers
 * the screen and the panel.
 */
export function Phone({
  src,
  generation,
  onState,
  state,
  build,
  autoUnlock,
}: {
  src: string | null;
  /** Bumped to reconnect: a new iframe is a new VNC session. */
  generation: number;
  onState: (state: ScreenState) => void;
  state: ScreenState;
  /** The server's build state: starting, building, switching, installed, failed… */
  build: string;
  autoUnlock: boolean;
}) {
  const [shape, setShape] = useState(DEFAULT_SHAPE);
  const [view, setView] = useState<View | null>(null);
  const [reveal, setReveal] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  // The viewer does the clicking and typing; it knows where things are.
  const signIn = () => {
    wake();
    frame.current?.contentWindow?.postMessage({ type: "vnc-command", command: "unlock" }, location.origin);
  };
  const [width, setWidth] = useState(0);
  const screen = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== "vnc") return;
      if (e.data.state === "shape" && e.data.width > 0 && e.data.height > 0) {
        setShape({ width: e.data.width, height: e.data.height });
      } else if (e.data.state === "signin") {
        toast(`Sign in: ${e.data.step}`, { id: "signin" });
      } else if (e.data.state === "view") {
        setView(e.data.view);
        setReveal(false);
      } else if (e.data.state === "connected" || e.data.state === "disconnected") {
        onState(e.data.state);
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [onState]);

  useEffect(() => {
    if (src) onState("connecting");
    setView(null);
  }, [src, generation, onState]);

  // Never hold the screen hostage. If signing in has not worked after half
  // a minute — or "locked" was a misreading of the desktop — show what is
  // actually there, so it can be dealt with by hand.
  useEffect(() => {
    if (view !== "locked") return;
    const t = setTimeout(() => setReveal(true), 30_000);
    return () => clearTimeout(t);
  }, [view]);

  // Likewise if connected and the viewer never says what it is showing:
  // whatever it is beats a spinner that never ends.
  useEffect(() => {
    if (state !== "connected" || view !== null) return;
    const t = setTimeout(() => setReveal(true), 15_000);
    return () => clearTimeout(t);
  }, [state, view]);

  useEffect(() => {
    if (!screen.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(screen.current);
    return () => ro.disconnect();
  }, []);

  const ratio = shape.width / shape.height;
  const tablet = ratio > 0.6;
  // Round the corners to the device's: about 13.7% of the screen's width on
  // a current iPhone, much less on an iPad.
  const radius = Math.round(width * (tablet ? 0.045 : 0.137));
  const bezel = 10;

  return (
    <div
      className="relative rounded-[var(--outer)] bg-neutral-900 shadow-[0_0_0_1px_rgb(0_0_0/.3),0_30px_80px_-20px_rgb(0_0_0/.55)] ring-1 ring-white/10 dark:bg-neutral-700"
      style={{
        padding: bezel,
        // The whole device on screen: as tall as the window allows, never
        // wider than the stage.
        width: `min(100%, calc((100dvh - 260px) * ${ratio}), ${tablet ? 900 : 460}px)`,
        ["--outer" as string]: `${radius + bezel}px`,
      }}
    >
      <div
        ref={screen}
        className="relative w-full overflow-hidden bg-black"
        style={{ aspectRatio: `${shape.width} / ${shape.height}`, borderRadius: radius }}
      >
        {src ? (
          <iframe
            key={generation}
            id="screen-frame"
            ref={frame}
            src={src}
            title="The app, running on the iOS Simulator"
            className="absolute inset-0 size-full border-0 bg-black"
          />
        ) : null}
        {src && view === "locked" && reveal && state === "connected" && (
          // Shown the lock screen, which is small in this frame: the same
          // Sign in, floating where it does not cover the password field.
          <Button size="sm" className="absolute top-3 left-1/2 z-10 -translate-x-1/2 shadow-lg" onClick={signIn}>
            Sign in
          </Button>
        )}
        {src ? (
          <Splash state={state} view={view} build={build} autoUnlock={autoUnlock}
            reveal={reveal} onReveal={() => { wake(); setReveal(true); }} onSignIn={signIn} />
        ) : (
          <Empty className="absolute inset-0 overflow-y-auto rounded-none border-0 bg-card text-card-foreground">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MonitorOff /></EmptyMedia>
              <EmptyTitle>The screen is not embedded</EmptyTitle>
              <EmptyDescription>
                Nothing was listening on the VNC port when the sandbox started, so there are no
                pixels to show. Run <Kbd>npm run devbox</Kbd> instead of <Kbd>npm run sandbox</Kbd>:
                it switches Screen Sharing on.
              </EmptyDescription>
              <EmptyDescription>
                Or watch it with <Kbd>nsc vnc &lt;instance-id&gt;</Kbd>. Whatever you send still
                lands in Feedback.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}

/**
 * What covers the screen while there is nothing worth looking at in it.
 *
 * The viewer streams the whole Mac and crops to the Simulator's window. Until
 * the app is built and that window is up — or while the Mac sits at its lock
 * screen — the crop has nothing to hold on to, and the phone would show a
 * zoomed-out desktop. The iframe stays connected underneath, so the screen
 * is there the moment this goes.
 */
function Splash({
  state, view, build, autoUnlock, reveal, onReveal, onSignIn,
}: {
  state: ScreenState; view: View | null; build: string; autoUnlock: boolean; reveal: boolean;
  onReveal: () => void; onSignIn: () => void;
}) {
  let body: { icon: ReactNode; title: string; text: string; action?: ReactNode } | null = null;
  const spin = <Spinner className="size-5" />;

  if (build.startsWith("failed")) {
    body = { icon: <TriangleAlert />, title: "The build failed", text: "The error is in the terminal running the sandbox. Fix it and start the sandbox again." };
  } else if (build === "finished") {
    body = { icon: <TriangleAlert />, title: "The app stopped", text: "Expo exited. Start the sandbox again." };
  } else if (build !== "installed") {
    body = {
      icon: spin,
      title: { switching: "Switching device", building: "Building the app" }[build] ?? "Starting",
      text: build === "switching"
        ? "Moving the app to the other simulator."
        : "The first build takes a few minutes — CocoaPods, then a full compile. Later ones are quicker.",
    };
  } else if (state === "connecting" || (view === null && !reveal)) {
    // Connected is not ready: until the viewer has cropped to the device
    // and said so, the frame holds the whole, zoomed-out desktop.
    body = { icon: spin, title: "Connecting to the screen", text: "Opening a session to the simulator." };
  } else if (state === "disconnected") {
    body = null; // the viewer says what went wrong, in the frame
  } else if (view === "locked" && !reveal) {
    const actions = (
      <div className="flex gap-2">
        <Button size="sm" className="bg-white text-neutral-950 hover:bg-white/90" onClick={onSignIn}>Sign in</Button>
        <Button size="sm" variant="ghost" className="text-neutral-200 hover:bg-white/10 hover:text-white" onClick={onReveal}>Show the screen</Button>
      </div>
    );
    body = autoUnlock ? {
      icon: spin,
      title: "Signing in to the Mac",
      text: "It looks locked, so the sandbox is typing the password. If nothing changes, the screen shows in 30 seconds.",
      action: actions,
    } : {
      icon: <Lock />,
      title: "The Mac is locked",
      text: "Sign in types the screen's password into the lock screen for you.",
      action: actions,
    };
  } else if (view === "desktop") {
    body = { icon: spin, title: "Opening the Simulator", text: "The app is installed; waiting for its window." };
  }

  if (!body) return null;
  return (
    <Empty className="absolute inset-0 overflow-y-auto rounded-none border-0 bg-neutral-950 text-neutral-100">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-white/10 text-neutral-100">{body.icon}</EmptyMedia>
        <EmptyTitle>{body.title}</EmptyTitle>
        <EmptyDescription className="text-neutral-400">{body.text}</EmptyDescription>
      </EmptyHeader>
      {body.action && <EmptyContent>{body.action}</EmptyContent>}
    </Empty>
  );
}

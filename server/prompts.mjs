/**
 * ANSWER THE DEVBOX'S OWN PERMISSION PROMPT, so it never sits over the app.
 *
 * A devbox is a macOS VM, and its guest agent, `vmguest`, reaches for the
 * local network at some point after boot. macOS then asks "Allow "vmguest"
 * to find devices on local networks?" — on the Mac's screen, which is the
 * screen the panel shows, so the dialog lands on top of the simulator for
 * whoever is testing. It is not the app's prompt, nobody testing the app
 * should have to answer it, and macOS gives no way to answer it ahead of
 * time: the Local Network permission cannot be granted from a script.
 *
 * So the sandbox answers it, the way a person would: System Events finds a
 * window whose text names `vmguest` and presses Allow. ONLY that prompt —
 * any other permission dialog is left for a person, because answering
 * those automatically would be granting things nobody chose to grant.
 * Allow, because vmguest is the VM's own agent and refusing it could break
 * something the devbox itself relies on; macOS remembers the answer.
 *
 * It needs the Accessibility permission devbox.sh already relies on to type
 * at the lock screen. Without it the check finds nothing and says nothing.
 */
import { execFile } from "node:child_process";

/** The process names whose prompts are answered, and the button pressed. */
const ANSWERS = [{ names: "vmguest", button: "Allow" }];

/**
 * The process macOS shows these alerts in. The Local Network prompt is set
 * up by NetworkExtension as a system alert (CFUserNotification), which
 * UserNotificationCenter draws. Looking there and nowhere else keeps each
 * check to a fraction of a second; walking every process's windows took
 * twenty.
 */
const ALERT_PROCESSES = ["UserNotificationCenter"];

/** JXA, run by osascript: prints what it pressed, or nothing. */
function script(answers) {
  return `
    const answers = ${JSON.stringify(answers)};
    const se = Application("System Events");
    const pressed = [];
    for (const name of ${JSON.stringify(ALERT_PROCESSES)}) {
      let wins = [];
      try { wins = se.processes.byName(name).windows(); } catch (e) { continue; }
      for (const w of wins) {
        let said = "";
        try { said = w.staticTexts.value().join(" "); } catch (e) { continue; }
        for (const a of answers) {
          // Only a permission question that names this process.
          if (!said.includes(a.names) || !/Allow/.test(said)) continue;
          try { w.buttons.byName(a.button).click(); pressed.push(a.names + " → " + a.button); } catch (e) {}
        }
      }
    }
    pressed.join("\\n");
  `;
}

/** Look once. Resolves to the prompts answered, which is usually none. */
export function answerPrompts(timeoutMs = 8_000) {
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script(ANSWERS)], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split("\n").map((l) => l.trim()).filter(Boolean));
    });
  });
}

/**
 * Keep looking: every few seconds while the devbox is new (vmguest asks
 * soon after boot), then once a minute, for as long as the sandbox runs.
 * One look at a time; a slow one is never stacked under the next.
 */
export function watchPrompts(log = console.log) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const what of await answerPrompts()) log(`  answered the devbox's prompt: ${what}`);
    } finally {
      busy = false;
    }
  };
  const fast = setInterval(tick, 5_000);
  fast.unref();
  const slowDown = setTimeout(() => {
    clearInterval(fast);
    setInterval(tick, 60_000).unref();
  }, 15 * 60_000);
  slowDown.unref();
  void tick();
  return () => { clearInterval(fast); clearTimeout(slowDown); };
}

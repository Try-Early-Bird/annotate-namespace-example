/**
 * Annotate Protocol v1 — a stub server for the examples.
 *
 * The overlay is a strict no-op until an endpoint and a session id resolve
 * AND `GET /health` answers with a matching `protocolVersion`. So an example
 * app with no server shows nothing at all, and "nothing happens" is the
 * worst possible first impression of a tool whose whole point is visible.
 * This gives every example something real to talk to.
 *
 * It is deliberately IN MEMORY and single-process: restart it and the marks
 * are gone. That is the right trade for an example — there is no database to
 * install, no migration to run, and the entire protocol fits in one file you
 * can read in a sitting. It is NOT a reference implementation to deploy; see
 * "Server obligations" in the README for what a real one must enforce
 * (authorization, tenancy, retention), none of which is here.
 *
 *   node stub-server.mjs [--port 4788]
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1]) || Number(process.env.PORT) || 4788;
const PROTOCOL_VERSION = 1;

/**
 * THE AGENT BRIDGE — on unless you turn it off.
 *
 *   node stub-server.mjs                # Claude Code, else Codex, if installed
 *   node stub-server.mjs --no-agent     # or AGENT=0: store tasks only
 *
 * Tapping *Send to agent* hands the task to an agent running headless, and
 * the edit lands in the app — Metro reloads it, and you watch the change you
 * asked for appear on the device that asked for it. That is what this
 * sandbox is for, so it is the default: a devbox someone opened to try the
 * overlay should not need to know a flag before Send does anything.
 *
 * It WRITES TO YOUR FILES. Two limits keep it honest: the agent's working
 * directory is pinned to the app (AGENT_DIR), and it gets file tools only —
 * no shell. With no agent installed, nothing runs and Send says how to
 * install one, in the task's own thread.
 */
const AGENT_FLAG = process.argv.find((a) => a === "--agent" || a.startsWith("--agent="));
const AGENT_OFF =
  process.argv.includes("--no-agent") ||
  ["0", "false", "off", "no"].includes((process.env.AGENT ?? "").trim().toLowerCase());
const AGENT_ENABLED = !AGENT_OFF;

/**
 * THE AGENTS THIS BRIDGE KNOWS.
 *
 * Two CLIs, because an example nobody else can run is a screenshot. Each
 * entry is the whole difference between them: how to ask for one headless
 * edit, and how to read the answer back out.
 *
 * Both default to FILE ACCESS AND NO SHELL: Claude by withholding Bash from
 * `--allowedTools`, Codex by its `workspace-write` sandbox. That is the
 * right default for a DEMO — an agent reachable from a text field on a
 * phone, running unattended on whoever's laptop is hosting this, has no
 * business running arbitrary commands.
 *
 * IT IS A DEFAULT, NOT A POSITION. An adopter running this inside their own
 * platform knows things this example cannot: whose repository it is, what
 * the agent is allowed to touch, whether it may push. `AGENT_TOOLS` and
 * `AGENT_SANDBOX` hand that decision back:
 *
 *   AGENT_TOOLS="Read Edit Write Glob Grep Bash"   # Claude: let it run git
 *   AGENT_SANDBOX=danger-full-access               # Codex: drop the sandbox
 *
 * Widen those and the agent can commit, push and open its own pull request
 * — which is a real thing to want, and a real thing to mean on purpose.
 * The `--pr` path below exists so you do NOT have to widen them just to get
 * a PR: the server does the push with a known, narrow command instead.
 */
const AGENT_TOOLS = (process.env.AGENT_TOOLS ?? "Read Edit Write Glob Grep").split(/\s+/).filter(Boolean);
const AGENT_SANDBOX = process.env.AGENT_SANDBOX ?? "workspace-write";
const AGENTS = {
  claude: {
    bin: "claude",
    label: "Claude Code",
    // STREAMED, so the panel can show what it is doing while it does it:
    // one JSON event per line, tool calls among them, the answer last.
    args: (prompt, dir, model) => [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--allowedTools", ...AGENT_TOOLS,
      "--permission-mode", "acceptEdits",
      ...(model ? ["--model", model] : []),
    ],
    // The `result` event carries the reply. Fall back to raw text if the
    // shape ever changes, rather than reporting an empty answer.
    read: (stdout) => {
      for (const line of stdout.trim().split("\n").reverse()) {
        try { const j = JSON.parse(line); if (j.type === "result") return String(j.result ?? ""); } catch {}
      }
      return stdout;
    },
    progress: (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return null; }
      if (event.type !== "assistant") return null;
      const uses = (event.message?.content ?? []).filter((c) => c.type === "tool_use");
      return uses.map((u) => describeTool(u.name, u.input ?? {})).filter(Boolean);
    },
  },
  codex: {
    bin: "codex",
    label: "Codex",
    args: (prompt, dir, model) => [
      "exec", prompt,
      "--sandbox", AGENT_SANDBOX,
      "-C", dir,
      // Parallel runs share session-restore files without this, and a task
      // per annotation is exactly the parallel case.
      "--ephemeral",
      "--skip-git-repo-check",
      ...(model ? ["-m", model] : []),
    ],
    // codex exec streams progress to stderr and prints the final message to
    // stdout, so stdout already IS the answer.
    read: (stdout) => stdout,
    progressFrom: "stderr",
    progress: (line) => line.trim() && !line.startsWith("[") ? [line.trim().slice(0, 120)] : null,
  },
};

/** "Read app/settings.tsx" → "read settings.tsx": one short line per step. */
function describeTool(name, input) {
  const file = input.file_path ?? input.path ?? input.notebook_path;
  const base = file ? String(file).split("/").pop() : null;
  switch (name) {
    case "Read": return base && `read ${base}`;
    case "Edit": case "MultiEdit": case "Write": return base && `editing ${base}`;
    case "Grep": return `search "${String(input.pattern ?? "").slice(0, 40)}"`;
    case "Glob": return `find ${String(input.pattern ?? "").slice(0, 40)}`;
    case "Bash": return `run ${String(input.command ?? "").slice(0, 60)}`;
    default: return name ? name.toLowerCase() : null;
  }
}

/**
 * What the agent changed, as git sees it.
 *
 * Agent edits land in YOUR working tree, looking exactly like your own
 * work — which is how they get swept into an unrelated commit by a
 * `git add -A`. Naming them after every run is the cheap half of the fix:
 * they appear in this log and in the reply inside the app, so they are
 * never a surprise found later in `git status`. (The other half is the
 * pre-commit hook in .githooks, which refuses the mixed commit outright.)
 *
 * Returns null when git is unavailable or this is not a repository, in
 * which case the bridge simply says nothing about files.
 */
function changedFiles() {
  const probe = spawnSync("git", ["status", "--porcelain", "--", AGENT_DIR],
    { cwd: AGENT_DIR, encoding: "utf8", timeout: 10_000 });
  if (probe.error || probe.status !== 0) return null;
  return probe.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
}

/** Run a git command somewhere, and hand back trimmed stdout (or null). */
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}

/**
 * The repository AGENT_DIR lives in — worktrees are added from there.
 *
 * Resolved on first use rather than at module scope: these helpers are
 * declared above the AGENT_DIR they read, and a `const` evaluated up here
 * crashes the server on startup with a temporal dead zone error.
 */
let repoRootCache;
function repoRoot() {
  if (repoRootCache === undefined) repoRootCache = git(["rev-parse", "--show-toplevel"], AGENT_DIR);
  return repoRootCache;
}

/**
 * A private checkout for one task.
 *
 * OUTSIDE THE REPOSITORY, in the OS temp directory: Metro watches the repo
 * root, and a worktree inside it would be crawled, bundled, and rebuilt on
 * every agent keystroke. The path AGENT_DIR has relative to the repo is
 * preserved inside the worktree, so the agent lands in the same project it
 * would have edited in place.
 */
function makeWorktree(id) {
  const root = repoRoot();
  if (!root) return null;
  const branch = `annotate/${id.slice(0, 12)}`;
  // The branch this task forks FROM. A pull request must target it, not the
  // repository's default branch: the worktree is cut from HEAD, so basing
  // the PR on `main` shows every commit between main and here — the whole
  // feature branch — with the one-line change buried in it. Observed: a
  // task that edited one file opened a PR touching dozens.
  const base = git(["rev-parse", "--abbrev-ref", "HEAD"], root) ?? "main";
  const dir = join(tmpdir(), `annotate-wt-${id.slice(0, 12)}-${Date.now().toString(36)}`);
  // -B so a re-run of the same task reuses its branch instead of failing.
  if (git(["worktree", "add", "--quiet", "-B", branch, dir, "HEAD"], root) === null) return null;
  const rel = relative(root, AGENT_DIR);
  return { branch, base, dir, workDir: rel ? join(dir, rel) : dir };
}

/**
 * Commit whatever the agent did, and say what that was.
 *
 * Returns null when it changed nothing — which is a real outcome worth
 * reporting as itself rather than as an empty commit.
 */
function commitWorktree(wt, annotation) {
  if (git(["add", "-A"], wt.dir) === null) return null;
  const staged = git(["diff", "--cached", "--name-only"], wt.dir);
  if (!staged) return null;
  const subject = (annotation.comment ?? "annotation").split("\n")[0].slice(0, 68);
  git(["-c", "user.name=annotate-agent", "-c", "user.email=agent@example.invalid",
       "commit", "--quiet", "-m", `${subject}\n\nFrom an in-app annotation (${annotation.id}).`], wt.dir);
  return {
    files: staged.split("\n").filter(Boolean),
    sha: git(["rev-parse", "--short", "HEAD"], wt.dir) ?? "",
    // Kept so the phone has something to OPEN. Without a pull request the
    // branch is a name the device cannot reach, and a task that says "I
    // changed three files" without showing which lines is a worse report
    // than the in-place mode it replaced.
    patch: git(["show", "--no-color", "HEAD"], wt.dir) ?? "",
  };
}

/** Push the branch and open a PR. Best effort — never fails the task. */
function openPullRequest(wt, annotation) {
  if (git(["push", "--quiet", "-u", "origin", wt.branch], wt.dir) === null) return null;
  const title = (annotation.comment ?? "Annotation").split("\n")[0].slice(0, 68);
  const r = spawnSync("gh", ["pr", "create", "--base", wt.base, "--head", wt.branch, "--title", title,
      "--body", `From an in-app annotation on \`${annotation.element ?? "an element"}\`.\n\n> ${annotation.comment ?? ""}`],
    { cwd: wt.dir, encoding: "utf8", timeout: 120_000 });
  if (r.error || r.status !== 0) return null;
  return (/https:\/\/\S+/.exec(r.stdout ?? "") ?? [])[0] ?? null;
}

/**
 * ANY OTHER AGENT — `AGENT_CMD`.
 *
 * The two above are conveniences, not the supported set. Anything that can
 * be run once with a prompt and print what it did works here:
 *
 *   AGENT_CMD="aider --yes --message {prompt}"
 *   AGENT_CMD="my-agent.sh {prompt} --dir {dir}"
 *   AGENT_CMD="some-cli --task"        # no {prompt} → appended as the last argument
 *
 * `{prompt}` and `{dir}` are substituted; whatever the command prints on
 * stdout becomes the reply in the app. Arguments split on whitespace, so a
 * wrapper script is the answer for anything needing real quoting — which is
 * also where per-agent flags belong, rather than in this file.
 *
 * Nothing about the sandbox is assumed for a custom command: the server
 * cannot know what flags yours takes, so its permissions are yours to set
 * inside it. AGENT_TOOLS and AGENT_SANDBOX apply to the two named agents
 * only, and the startup banner says a custom command is in use so that is
 * never a silent difference.
 */
function customAgent() {
  const template = (process.env.AGENT_CMD ?? "").trim();
  if (!template) return null;
  const parts = template.split(/\s+/);
  return {
    bin: parts[0],
    label: `custom (${parts[0]})`,
    custom: true,
    args: (prompt, dir) => {
      const rest = parts.slice(1);
      const substituted = rest.map((a) => a.replace(/\{dir\}/g, dir).replace(/\{prompt\}/g, prompt));
      // A template with no {prompt} still has to receive one, or the agent
      // is asked to do nothing at all.
      return rest.some((a) => a.includes("{prompt}")) ? substituted : [...substituted, prompt];
    },
    read: (stdout) => stdout,
    // Your command's stderr, line by line, is the panel's progress log.
    progressFrom: "stderr",
    progress: (line) => (line.trim() ? [line.trim().slice(0, 120)] : null),
  };
}

/** Is this CLI actually installed? Cheaper to ask than to fail mid-task. */
function installed(bin) {
  const probe = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000 });
  return !probe.error && probe.status === 0;
}

/**
 * Which agent to use: whatever was named, else the first one present.
 *
 * Naming one that is not installed is an error rather than a silent
 * fallback — someone who typed `--agent=codex` wants Codex, and quietly
 * running something else would make the result a lie.
 */
function resolveAgent() {
  // An explicit command wins over everything: someone who set it has said
  // exactly what they want run.
  const custom = customAgent();
  if (custom) {
    if (!installed(custom.bin)) return { error: `AGENT_CMD names "${custom.bin}", which is not on PATH` };
    return { agent: custom };
  }
  const asked = (AGENT_FLAG?.split("=")[1] || process.env.AGENT || "").toLowerCase();
  // "Any agent" in every spelling of yes; anything else is a name.
  if (asked && !["1", "true", "on", "yes"].includes(asked)) {
    const chosen = AGENTS[asked];
    if (!chosen) return { error: `unknown agent "${asked}" — expected ${Object.keys(AGENTS).join(" or ")}` };
    if (!installed(chosen.bin)) return { error: `${chosen.label} is not installed (\`${chosen.bin}\` not on PATH)` };
    return { agent: chosen };
  }
  for (const candidate of Object.values(AGENTS)) {
    if (installed(candidate.bin)) return { agent: candidate };
  }
  return {
    error: `no supported agent found. Install one:\n` +
      `    Claude Code  npm i -g @anthropic-ai/claude-code   (then: claude)\n` +
      `    Codex        npm i -g @openai/codex               (then: codex)\n` +
      `  ...or point AGENT_CMD at your own: AGENT_CMD="my-agent {prompt}"`,
  };
}

/**
 * THE APP'S OWN ROOT IS THE DEFAULT ON PURPOSE — do not point it elsewhere to be
 * tidy. It is the directory Metro is watching, and that is the entire
 * effect: the agent writes the file, Fast Refresh rebuilds the one changed
 * module, and the change appears on the device that asked for it without a
 * restart. An agent editing a copy somewhere else would make the same edit
 * and show you nothing.
 *
 * AGENT_DIR exists for the case where you would rather keep agent edits out
 * of your working tree; it costs you the hot reload.
 */
const AGENT_DIR = process.env.AGENT_DIR
  ? resolve(process.env.AGENT_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Unset means "whatever that CLI is already configured to use". */
const AGENT_MODEL = process.env.AGENT_MODEL || null;
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 180_000;

/**
 * WORKTREE MODE — `--worktree`, optionally `--jobs N`.
 *
 * Without it every run edits AGENT_DIR directly, which is what makes the
 * hot-reload demo work and what forces runs to be serial: two agents in one
 * tree overwrite each other. With it, each task gets its own `git worktree`
 * and its own branch, so runs cannot collide and several may go at once.
 *
 * THE TRADE IS THE LIVE RELOAD. A worktree is checked out in the OS temp
 * directory — deliberately outside the repository, since Metro watches the
 * repo root and would otherwise bundle and rebuild every copy. The agent is
 * therefore not editing the tree Metro is serving, so nothing appears on
 * the device; the result arrives as a branch and a thread reply instead.
 * That is the right shape for real work and the wrong one for a demo, which
 * is why this is a mode rather than the default.
 */
const WORKTREE_FLAG = process.argv.find((a) => a === "--worktree" || a.startsWith("--worktree="));
const WORKTREE = Boolean(WORKTREE_FLAG) || process.env.WORKTREE === "1";
const JOBS_FLAG = process.argv.indexOf("--jobs");
const MAX_JOBS = WORKTREE
  ? Math.max(1, Number(JOBS_FLAG > -1 ? process.argv[JOBS_FLAG + 1] : process.env.JOBS) || 2)
  : 1;
/** Open a PR per task. Off by default: it pushes, which is not a demo's business. */
const OPEN_PR = process.argv.includes("--pr") || process.env.PR === "1";
/**
 * What the PHONE should call this server. `localhost` is the device itself
 * on a simulator and wrong on hardware, so a diff link built from it would
 * be unopenable exactly where opening it matters most.
 */
const AGENT_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;

/** Everything the server knows. Restarting is the reset button. */
const db = {
  sessions: new Map(),      // id -> { id, url, title, createdAt }
  annotations: new Map(),   // id -> ServerAnnotation (agent tasks)
  comments: new Map(),      // id -> ServerComment (team notes)
  screenshots: new Map(),   // id -> { contentType, bytes }
  patches: new Map(),       // annotation id -> unified diff, served as text
};

/** Open SSE responses. The overlay reconnects on its own, so losing one is fine. */
const listeners = new Set();

/**
 * Tell every connected overlay that something changed.
 *
 * The protocol's events carry no state — they are a nudge to re-read. That
 * is why this sends an (almost) empty payload: a client that trusted event
 * bodies would drift the moment one was missed.
 */
function emit(type, payload = {}) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of listeners) {
    try { res.write(frame); } catch { listeners.delete(res); }
  }
}

/**
 * Turn an annotation into a prompt.
 *
 * THE TEXT IS THE SEARCH KEY, and this is where that pays off. `source`
 * names where the component is DEFINED — `PrimaryButton.tsx` holds
 * `{label}` — while the words the user actually tapped live at the CALL
 * SITE, in a file the annotation never names. Handing the agent
 * `nearbyText` lets it grep its way to the one line to edit. Before this
 * field rode at the default detail level, the agent had the component and
 * no way to tell which use of it was meant.
 */
function agentPrompt(a) {
  const lines = [
    "A developer annotated a running React Native screen. Make the change they asked for.",
    "",
    `THEY WROTE: ${a.comment ?? "(no text)"}`,
    "",
    "WHAT THEY TOUCHED:",
    `  component: ${a.element ?? "unknown"}`,
  ];
  if (a.source?.file) lines.push(`  defined at: ${a.source.file}:${a.source.line ?? "?"}`);
  if (a.nearbyText) {
    lines.push(`  text on it: ${JSON.stringify(a.nearbyText)}`);
    lines.push(`              (grep for this to find where the component is USED —`);
    lines.push(`               the definition file may only hold a prop)`);
  }
  if (a.testID) lines.push(`  testID: ${a.testID}`);
  if (a.routeName) lines.push(`  screen: ${a.routeName}`);
  lines.push(
    "",
    "Edit the source to satisfy the request. Keep it minimal — change what was",
    "asked and nothing else. Metro is watching, so the app reloads by itself.",
    "Finish with one short sentence saying what you changed.",
  );
  return lines.join("\n");
}

/** Append a message to an annotation's thread and tell the app to re-read. */
function addThreadMessage(id, role, text) {
  const a = db.annotations.get(id);
  if (!a) return;
  // The protocol's message shape: `content` and `timestamp`. The overlay
  // drops a message without a string `content`, so an agent reply stored
  // as `text` never reached the app.
  a.thread = [...(a.thread ?? []), { id: randomUUID(), role, content: text, timestamp: now() }];
  emit("annotation.updated", { id });
}

/**
 * Run the agent for one annotation, then post what it said back into the
 * thread — so the answer arrives in the detail pane the request came from,
 * rather than in a terminal the phone cannot see.
 */
/**
 * ONE AT A TIME.
 *
 * Every agent here edits the same working tree, and two let loose on it do
 * not take turns: both open the file, the second write wins, and one of the
 * two requests disappears with nothing on screen to say it did. Sending
 * three tasks from the queue is exactly that case, so runs are queued and
 * started one after another.
 *
 * The overlay closes its Send button while a task is `working`, but this is
 * not a duplicate of that check: the button is one client's courtesy, and
 * the server is what actually has to hold the line.
 */
const agentQueue = [];
let agentsInFlight = 0;

function enqueueAgent(id) {
  // ALREADY IN FLIGHT OR ALREADY WAITING — do nothing. Pressing send twice,
  // a retry, or two clients acting at once would otherwise run the same
  // task a second time and apply the same edit twice. The overlay disables
  // its button while a task is `working`, but that is one client's
  // courtesy and cannot be the thing standing between an agent and a
  // duplicated change.
  if (agentQueue.includes(id)) return;
  if (db.annotations.get(id)?.status === "working") return;
  agentQueue.push(id);
  startNextAgent();
}

function startNextAgent() {
  // MAX_JOBS is 1 unless --worktree gave each run its own checkout. Without
  // that isolation a second agent is not concurrency, it is two processes
  // overwriting one working tree.
  while (agentsInFlight < MAX_JOBS && agentQueue.length > 0) {
    const id = agentQueue.shift();
    agentsInFlight += 1;
    runAgent(id, () => { agentsInFlight -= 1; startNextAgent(); }, AGENT_ORIGIN);
  }
}

/** Running agents by task, so a run can be stopped from the panel. */
const runs = new Map();

/**
 * The simulator's screen, stored like an upload; its id, or null.
 *
 * The panel shows a task's before and after side by side. "booted" because
 * this server does not know which device the front door is showing; the
 * sandbox runs one at a time. Best effort: off macOS, or with nothing
 * booted, there is simply no picture.
 */
function simulatorShot() {
  const file = join(tmpdir(), `annotate-shot-${randomUUID()}.png`);
  return new Promise((done) => {
    execFile("xcrun", ["simctl", "io", "booted", "screenshot", "--type=png", file], { timeout: 15_000 },
      async (err) => {
        if (err) return done(null);
        try {
          const bytes = await readFile(file);
          const id = randomUUID();
          db.screenshots.set(id, { contentType: "image/png", bytes });
          done(id);
        } catch { done(null); }
        rm(file, { force: true }).catch(() => {});
      });
  });
}

/** Lines added and removed per file, as git counts them. */
function numstat(args, cwd, files) {
  const out = git(["diff", "--numstat", ...args, "--", ...files], cwd) ?? "";
  const counted = new Map(out.split("\n").filter(Boolean).map((l) => {
    const [added, removed, path] = l.split("\t");
    return [path, { path, added: Number(added) || 0, removed: Number(removed) || 0 }];
  }));
  // An untracked new file is not in `git diff`: all of it is added.
  return files.map((f) => counted.get(f) ?? {
    path: f,
    added: (spawnSync("wc", ["-l", join(cwd, f)], { encoding: "utf8" }).stdout ?? "").trim().split(/\s+/)[0] * 1 || 0,
    removed: 0,
  });
}

/**
 * Where a task's run stands, for the panel. NOT protocol — the overlay
 * ignores it and keeps reading `status` — so it can say more than the
 * protocol's three words: running (with what the agent is doing), needs
 * review (with the before and after and what changed), failed (with why),
 * stopped, accepted, reverted.
 */
function setRun(annotation, patch) {
  annotation.run = { ...(annotation.run ?? {}), ...patch };
  emit("annotation.updated", { id: annotation.id });
}

function runAgent(id, done, origin = `http://localhost:${PORT}`) {
  const annotation = db.annotations.get(id);
  if (!annotation || !AGENT) return done?.();

  const wt = WORKTREE ? makeWorktree(id) : null;
  if (WORKTREE && !wt) {
    addThreadMessage(id, "agent", "Could not create a git worktree for this task.");
    annotation.status = "pending";
    setRun(annotation, { state: "failed", error: "Could not create a git worktree for this task.", finishedAt: now() });
    return done?.();
  }
  const workDir = wt ? wt.workDir : AGENT_DIR;
  const args = AGENT.args(agentPrompt(annotation), workDir, AGENT_MODEL);
  // Only meaningful in place: in a worktree the edits are committed to a
  // branch and reported from there, and nothing lands in your working tree.
  const before = wt ? null : new Set(changedFiles() ?? []);
  console.log(`    → ${AGENT.label} working on ${id.slice(0, 8)} in ${wt ? wt.branch : AGENT_DIR}`);
  // The protocol status the overlay's banner reads. Optional and additive:
  // a server that does not run agents never sets it and no banner appears.
  annotation.status = "working";
  annotation.run = { state: "running", agent: AGENT.label, startedAt: now(), log: [], files: [] };
  addThreadMessage(id, "agent", `${AGENT.label} is working on it…`);
  // In place, the screen IS the before picture; in a worktree nothing on
  // the device changes, so there is no before/after to show.
  if (!wt) simulatorShot().then((shot) => shot && setRun(annotation, { before: shot }));

  // spawn rather than execFile: the output is read AS IT ARRIVES, which is
  // what lets the panel show the agent's steps while it is still working.
  // stdin is closed from the start: `codex exec` appends piped stdin to its
  // prompt, and an open-but-silent pipe left it waiting until the timeout.
  const child = spawn(AGENT.bin, args, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  runs.set(id, child);
  let stdout = "", stderr = "", timedOut = false, stopped = false, failedToStart = null;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, AGENT_TIMEOUT_MS);
  child.stopRun = () => { stopped = true; child.kill("SIGTERM"); };

  const lines = (stream, onLine) => {
    let rest = "";
    return (chunk) => {
      const text = rest + chunk;
      const parts = text.split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) onLine(line);
      stream.value += chunk;
    };
  };
  const step = (line) => {
    const said = AGENT.progress?.(line);
    if (!said?.length) return;
    // `progress` is the protocol's one-line "doing this now", which the
    // overlay shows under its banner; the panel reads the whole log.
    const latest = said[said.length - 1];
    annotation.progress = latest.charAt(0).toUpperCase() + latest.slice(1);
    setRun(annotation, { log: [...(annotation.run?.log ?? []), ...said].slice(-40) });
  };
  const out = { value: "" }, errs = { value: "" };
  child.stdout.on("data", lines(out, (AGENT.progressFrom ?? "stdout") === "stdout" ? step : () => {}));
  child.stderr.on("data", lines(errs, AGENT.progressFrom === "stderr" ? step : () => {}));
  child.on("error", (err) => { failedToStart = err; });

  child.on("close", async (code) => {
    clearTimeout(timer);
    runs.delete(id);
    delete annotation.progress;
    stdout = out.value; stderr = errs.value;
    const err = failedToStart || timedOut || stopped || code !== 0;
    let reply;
    let files = [];
    if (err) {
      // Say what went wrong in the app. A silent failure here looks
      // exactly like an agent that decided to do nothing.
      reply = stopped
        ? "Stopped from the panel."
        : timedOut
          ? `Timed out after ${AGENT_TIMEOUT_MS / 1000}s.`
          // The LAST thing it said: agents narrate their steps on stderr
          // and give the reason they stopped at the end.
          : `${AGENT.label} could not run: ${String(failedToStart?.message || stderr || `exit ${code}`).trim().split("\n").pop()}`;
      console.log(`    ✗ ${AGENT.label} ${stopped ? "stopped" : "failed"} on ${id.slice(0, 8)}: ${reply}`);
    } else {
      reply = AGENT.read(stdout).trim() || "Done.";
      console.log(`    ✓ ${AGENT.label} finished ${id.slice(0, 8)}`);
      if (wt) {
        // The work is on a branch, not in front of you — so the reply has
        // to carry everything you would otherwise see by looking.
        const committed = commitWorktree(wt, annotation);
        if (!committed) {
          reply += `\n\nNo files changed.`;
          console.log(`      no changes on ${wt.branch}`);
        } else {
          files = numstat(["HEAD~1", "HEAD"], wt.dir, committed.files);
          // The command to SEE it, not just the branch name. A worktree
          // run shows nothing on the device by design, so the reply is
          // the only place that can close that gap — and checking the
          // branch out in the tree Metro already watches is the whole
          // answer (examples/README, "Seeing a worktree's change").
          reply += `\n\nCommitted ${committed.sha} to \`${wt.branch}\`: ${committed.files.join(", ")}`
            + `\n\nTo see it running: git checkout ${wt.branch}`;
          // The branch as DATA, not only as a sentence. Prose in a thread
          // cannot be queried, chipped in a UI, or followed by anything
          // but a human reading English — and "which branch came out of
          // this task" is a fact about the task. AnnotationReference
          // takes custom types (`string & {}`), so this needs no protocol
          // change; a client that does not know "branch" renders it with
          // the same one-line fallback it gives any other reference.
          annotation.references = [...(annotation.references ?? []),
            { type: "branch", value: wt.branch, label: `${wt.branch} (${committed.sha})` }];
          if (committed.patch) {
            db.patches.set(id, committed.patch);
            annotation.references = [...annotation.references,
              { type: "url", value: `${origin}/annotations/${encodeURIComponent(id)}/diff`,
                label: `Diff — ${committed.files.length} file${committed.files.length === 1 ? "" : "s"}` }];
          }
          console.log(`      committed ${committed.sha} to ${wt.branch}: ${committed.files.join(", ")}`);
          if (OPEN_PR) {
            const url = openPullRequest(wt, annotation);
            if (url) {
              reply += `\n\n${url}`;
              // A `url` reference is where the protocol puts a link, so the
              // task carries the PR rather than only mentioning it.
              annotation.references = [...(annotation.references ?? []),
                { type: "url", value: url, label: "Pull request" }];
              console.log(`      opened ${url}`);
            } else {
              reply += `\n\nCould not open a pull request — the branch is pushed or local.`;
            }
          }
        }
      } else {
        const touched = (changedFiles() ?? []).filter((f) => !before.has(f));
        if (touched.length) {
          files = numstat([], repoRoot() ?? AGENT_DIR, touched);
          console.log(`      edited: ${touched.join(", ")}`);
          console.log(`      undo:   Revert in the panel, or git checkout -- ${touched.join(" ")}`);
          // Say it in the app too: the person watching the phone is the one
          // who will later wonder why their working tree is dirty.
          reply += `\n\nEdited ${touched.join(", ")} — these are in your working tree.`;
        }
      }
    }
    const a = db.annotations.get(id);
    // Out of "working" whichever way it went — a banner that outlives the
    // agent is worse than no banner, because it claims work is happening.
    if (a) a.status = err ? "pending" : "sent";
    // Replace the placeholder rather than stacking a second bubble.
    if (a?.thread?.length) a.thread = a.thread.slice(0, -1);
    addThreadMessage(id, "agent", reply.slice(0, 4000));
    if (a) {
      setRun(a, {
        state: stopped ? "stopped" : err ? "failed" : files.length ? "review" : "done",
        finishedAt: now(),
        error: err && !stopped ? reply : undefined,
        files,
        branch: wt ? wt.branch : undefined,
      });
      // The after picture once Fast Refresh has had time to apply the edit.
      if (!err && !wt && files.length) {
        setTimeout(() => simulatorShot().then((shot) => shot && setRun(a, { after: shot })), 2500);
      }
    }
    // The checkout is disposable; the BRANCH is the artifact and stays.
    if (wt) git(["worktree", "remove", "--force", wt.dir], repoRoot());
    // Whatever happened, the next one may start — a failed run must not
    // wedge the queue behind it.
    done?.();
  });
}

const now = () => new Date().toISOString();

/**
 * Who wrote a note or a reply. A real server takes this from the
 * authenticated user and IGNORES `authorName`; this stub has no auth, which
 * is exactly the case the advisory hint exists for (README, "Who you are").
 * The id is derived from the name so the same name is the same person, and
 * the overlay can put your own messages on your side.
 */
function authorFrom(authorName) {
  const name = typeof authorName === "string" ? authorName.trim().slice(0, 80) : "";
  return name ? { id: `name:${name.toLowerCase()}`, name } : { id: "anonymous" };
}
const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    // The examples run the app and the server on different ports.
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
};
const noContent = (res) => { res.writeHead(204, { "Access-Control-Allow-Origin": "*" }); res.end(); };

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    // A stub with no limit is a stub that can be made to eat the machine.
    if (bytes > 32 * 1024 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const parseJson = (buf) => { try { return JSON.parse(buf.toString("utf8") || "{}"); } catch { return null; } };

/**
 * Pull the first file out of a multipart body.
 *
 * Deliberately crude — enough for one screenshot part, which is all the
 * protocol's upload routes ever send. A real server uses a parser.
 */
function firstFilePart(buf, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const headerEnd = Buffer.from("\r\n\r\n");
  let from = buf.indexOf(marker);
  while (from !== -1) {
    const headStart = from + marker.length;
    const headStop = buf.indexOf(headerEnd, headStart);
    if (headStop === -1) break;
    const headers = buf.subarray(headStart, headStop).toString("utf8");
    const next = buf.indexOf(marker, headStop);
    if (/filename=/i.test(headers)) {
      const body = buf.subarray(headStop + headerEnd.length, next === -1 ? buf.length : next - 2);
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
      return { contentType: (type?.[1] || "image/png").trim(), bytes: body };
    }
    from = next;
  }
  return null;
}

/** Store an upload and hand back the reference the protocol expects. */
function storeScreenshot(buf, contentType, origin) {
  const part = firstFilePart(buf, contentType);
  if (!part) return null;
  const id = randomUUID();
  db.screenshots.set(id, part);
  return { type: "screenshot", url: `${origin}/screenshots/${id}`, name: "screenshot.png" };
}

// Resolved once: probing PATH per annotation would be waste, and an agent
// appearing halfway through a session is not a case worth supporting.
const { agent: AGENT, error: AGENT_ERROR } = AGENT_ENABLED ? resolveAgent() : {};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const origin = `http://${req.headers.host ?? `localhost:${PORT}`}`;
  const seg = path.split("/").filter(Boolean);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    });
    return res.end();
  }

  console.log(`  ${req.method} ${path}`);

  // ── Handshake ─────────────────────────────────────────────────────────
  // The overlay calls this once and disables itself on a version mismatch.
  // queuesTasks: a task sent while another is working waits its turn in
  // agentQueue (MAX_JOBS at a time), so the overlay need not block Send.
  if (path === "/health") {
    return json(res, 200, { status: "ok", protocolVersion: PROTOCOL_VERSION, queuesTasks: true });
  }

  // Identity is optional: 404 leaves the overlay on its local name tiers,
  // which is exactly what an example should demonstrate.
  if (path === "/me") return json(res, 404, { error: "no server identity in the stub" });

  // ── Sessions ──────────────────────────────────────────────────────────
  if (path === "/sessions" && req.method === "POST") {
    const body = parseJson(await readBody(req)) ?? {};
    // Passing an existing id is an idempotent register — the client posts
    // its configured sessionId once at startup.
    const id = typeof body.id === "string" && body.id ? body.id : randomUUID();
    const session = db.sessions.get(id) ?? { id, url: body.url ?? null, title: body.title ?? null, createdAt: now() };
    db.sessions.set(id, session);
    return json(res, 201, session);
  }
  if (path === "/sessions" && req.method === "GET") return json(res, 200, [...db.sessions.values()]);

  if (seg[0] === "sessions" && seg[1]) {
    const sid = decodeURIComponent(seg[1]);
    const mine = () => [...db.annotations.values()].filter((a) => a.sessionId === sid);

    // SSE. Everything else re-reads; this only says "something changed".
    if (seg[2] === "events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(": connected\n\n");
      listeners.add(res);
      const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
      req.on("close", () => { clearInterval(keepAlive); listeners.delete(res); });
      return;
    }

    if (seg[2] === "annotations" && req.method === "POST") {
      const body = parseJson(await readBody(req));
      if (!body) return json(res, 400, { error: "invalid JSON" });
      // Protocol v1 ECHOES the client's id. (agentation-mcp assigns its own
      // instead, which is why the client always re-keys to what it gets back.)
      const id = typeof body.id === "string" && body.id ? body.id : randomUUID();
      const annotation = { ...body, id, sessionId: sid, status: "pending", createdAt: now() };
      db.annotations.set(id, annotation);
      db.sessions.set(sid, db.sessions.get(sid) ?? { id: sid, createdAt: now() });
      emit("annotation.created", { id });
      return json(res, 201, annotation);
    }
    if (seg[2] === "annotations" && req.method === "GET") return json(res, 200, mine());
    if (seg[2] === "pending" && req.method === "GET") {
      // "working" belongs here: a task an agent is mid-way through is not
      // finished, and dropping it from this list would make the queue empty
      // and the banner blind at exactly the moment both have something to
      // say.
      return json(res, 200, mine().filter((a) => a.status === "pending" || a.status === "working"));
    }
    if (!seg[2] && req.method === "GET") {
      return json(res, 200, { ...(db.sessions.get(sid) ?? { id: sid }), annotations: mine() });
    }
  }

  // ── Annotations (agent tasks) ─────────────────────────────────────────
  if (path === "/annotations/send" && req.method === "POST") {
    const body = parseJson(await readBody(req)) ?? {};
    // The protocol field is `annotationIds`, and an EMPTY ARRAY means "send
    // all pending" (README, Annotations). Getting this wrong is silent: the
    // POST still returns 200 and the app still clears its selection, so the
    // only symptom is an agent that never starts.
    const pending = () => [...db.annotations.values()]
      .filter((a) => a.status === "pending").map((a) => a.id);
    const asked = Array.isArray(body.annotationIds) ? body.annotationIds
      : Array.isArray(body.ids) ? body.ids   // tolerated alias
      : null;
    const ids = asked === null ? pending() : asked.length ? asked : pending();
    for (const id of ids) {
      const a = db.annotations.get(id);
      // With the bridge ON, a task is NOT "sent" yet — it is waiting its
      // turn, and runAgent moves it working → sent. Marking it sent here
      // dropped it out of the pending list, so two of three queued tasks
      // vanished from the queue while they had not been touched.
      // With the agent switched OFF, "sent" is the whole story. With it on
      // but none installed, the task stays pending: nothing took it, and it
      // should still be there to send once one is.
      if (a && !AGENT_ENABLED) db.annotations.set(id, { ...a, status: "sent", sentAt: now() });
    }
    if (AGENT) for (const id of ids) enqueueAgent(id);
    else if (AGENT_ENABLED) for (const id of ids) addThreadMessage(id, "agent", AGENT_ERROR);
    else console.log(`    → marked ${ids.length} task(s) sent (the agent is off: AGENT=0 / --no-agent)`);
    emit("annotation.updated", {});
    return json(res, 200, { sent: ids.length });
  }

  if (seg[0] === "annotations" && seg[1]) {
    const id = decodeURIComponent(seg[1]);
    const annotation = db.annotations.get(id);

    if (seg[2] === "screenshot" && req.method === "POST") {
      if (!annotation) return json(res, 404, { error: "no such annotation" });
      const ref = storeScreenshot(await readBody(req), req.headers["content-type"], origin);
      if (!ref) return json(res, 400, { error: "no file part" });
      annotation.references = [...(annotation.references ?? []), ref];
      emit("annotation.updated", { id });
      return json(res, 201, ref);
    }
    // ── Not protocol: the panel's controls over a run ───────────────────
    if (seg[2] === "stop" && req.method === "POST") {
      const child = runs.get(id);
      if (!child) return json(res, 409, { error: "not running" });
      child.stopRun();
      return json(res, 202, { stopping: true });
    }
    if (seg[2] === "accept" && req.method === "POST") {
      if (!annotation?.run) return json(res, 404, { error: "no run to accept" });
      setRun(annotation, { state: "accepted", decidedAt: now() });
      return json(res, 200, annotation);
    }
    if (seg[2] === "revert" && req.method === "POST") {
      if (!annotation?.run) return json(res, 404, { error: "no run to revert" });
      const run = annotation.run;
      if (run.branch) {
        // A worktree run touched nothing here; its branch IS the change.
        git(["branch", "-D", run.branch], repoRoot());
      } else {
        // In place: put back exactly the files this run changed. They were
        // clean when it started (anything already dirty was excluded), so
        // HEAD is what they were — and a file it created is removed.
        const root = repoRoot() ?? AGENT_DIR;
        for (const { path: file } of run.files ?? []) {
          if (git(["ls-files", "--error-unmatch", file], root) !== null) git(["checkout", "--", file], root);
          else await rm(join(root, file), { force: true, recursive: true });
        }
      }
      setRun(annotation, { state: "reverted", decidedAt: now() });
      addThreadMessage(id, "agent", `Reverted: ${(run.files ?? []).map((f) => f.path).join(", ") || run.branch}.`);
      return json(res, 200, annotation);
    }

    if (seg[2] === "thread" && req.method === "POST") {
      if (!annotation) return json(res, 404, { error: "no such annotation" });
      const body = parseJson(await readBody(req)) ?? {};
      // `role` is server-assigned: a client reply is always "user".
      const message = {
        id: randomUUID(),
        role: "user",
        content: body.content ?? body.text ?? "",
        timestamp: now(),
      };
      annotation.thread = [...(annotation.thread ?? []), message];
      // A human reply puts a sent task back in the queue — "reply to refine".
      if (message.role === "user" && annotation.status === "sent") {
        annotation.status = "pending";
        annotation.reopenedAt = now();
        annotation.reopenCount = (annotation.reopenCount ?? 0) + 1;
      }
      emit("annotation.updated", { id });
      return json(res, 201, annotation);
    }
    if (!seg[2] && req.method === "GET") {
      return annotation ? json(res, 200, annotation) : json(res, 404, { error: "no such annotation" });
    }
    if (!seg[2] && req.method === "DELETE") {
      db.annotations.delete(id);
      emit("annotation.deleted", { id });
      return noContent(res);
    }
  }

  // ── Comments (team notes) ─────────────────────────────────────────────
  if (path === "/comments" && req.method === "POST") {
    const body = parseJson(await readBody(req));
    if (!body) return json(res, 400, { error: "invalid JSON" });
    const id = randomUUID();
    const { content, authorName, id: _ignored, messages: _alsoIgnored, ...capture } = body;
    const author = authorFrom(authorName);
    const at = now();
    // The note's text is its FIRST MESSAGE, not a field of its own: a note
    // is a conversation from the start (README, "Comments").
    const comment = {
      ...capture, id, status: "open", author,
      messages: [{ id: randomUUID(), content: String(content ?? ""), author, createdAt: at }],
      createdAt: at, updatedAt: at,
    };
    db.comments.set(id, comment);
    emit("comment.created", { id });
    return json(res, 201, { comment });
  }
  if (path === "/comments" && req.method === "GET") {
    const routeName = url.searchParams.get("routeName");
    const all = [...db.comments.values()];
    return json(res, 200, routeName ? all.filter((c) => c.routeName === routeName) : all);
  }

  if (seg[0] === "comments" && seg[1]) {
    const id = decodeURIComponent(seg[1]);
    const comment = db.comments.get(id);

    if (seg[2] === "screenshot" && req.method === "POST") {
      if (!comment) return json(res, 404, { error: "no such comment" });
      const ref = storeScreenshot(await readBody(req), req.headers["content-type"], origin);
      if (!ref) return json(res, 400, { error: "no file part" });
      comment.references = [...(comment.references ?? []), ref];
      emit("comment.updated", { id });
      return json(res, 201, ref);
    }
    if (seg[2] === "messages" && req.method === "POST") {
      if (!comment) return json(res, 404, { error: "no such comment" });
      const body = parseJson(await readBody(req)) ?? {};
      comment.messages = [...(comment.messages ?? []), {
        id: randomUUID(),
        content: String(body.content ?? ""),
        author: authorFrom(body.authorName),
        createdAt: now(),
      }];
      comment.updatedAt = now();
      emit("comment.updated", { id });
      return json(res, 201, { comment });
    }
    if (!seg[2] && req.method === "GET") {
      return comment ? json(res, 200, { comment }) : json(res, 404, { error: "no such comment" });
    }
    if (!seg[2] && req.method === "PATCH") {
      if (!comment) return json(res, 404, { error: "no such comment" });
      const body = parseJson(await readBody(req)) ?? {};
      if (typeof body.status === "string") comment.status = body.status;
      comment.updatedAt = now();
      emit("comment.updated", { id });
      return json(res, 200, { comment });
    }
    if (!seg[2] && req.method === "DELETE") {
      db.comments.delete(id);
      emit("comment.deleted", { id });
      return noContent(res);
    }
  }

  // ── Not protocol: what the sandbox panel shows about this server ──────
  // The overlay never calls this. It answers "where do marks go, and is
  // anything going to act on them", which the protocol has no route for.
  if (path === "/info" && req.method === "GET") {
    const all = [...db.annotations.values()];
    return json(res, 200, {
      protocolVersion: PROTOCOL_VERSION,
      storage: {
        kind: "memory",
        detail: "in this process — restart the sandbox and it is gone",
        sessions: db.sessions.size,
        tasks: all.length,
        notes: db.comments.size,
        screenshots: db.screenshots.size,
      },
      agent: {
        enabled: AGENT_ENABLED,
        name: AGENT?.label ?? null,
        error: AGENT_ENABLED && !AGENT ? AGENT_ERROR : null,
        mode: WORKTREE ? "worktree" : "in-tree",
        dir: WORKTREE ? null : AGENT_DIR,
        jobs: MAX_JOBS,
        pullRequests: OPEN_PR,
        model: AGENT_MODEL,
        tools: AGENT?.bin === "claude" ? AGENT_TOOLS : null,
        sandbox: AGENT?.bin === "codex" ? AGENT_SANDBOX : null,
        queued: agentQueue.length,
        working: agentsInFlight,
      },
    });
  }

  // ── A task's diff, as plain text a browser can render ─────────────────
  if (seg[0] === "annotations" && seg[1] && seg[2] === "diff" && req.method === "GET") {
    const patch = db.patches.get(decodeURIComponent(seg[1]));
    if (!patch) return json(res, 404, { error: "no diff for this task" });
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(patch);
  }

  // ── Uploaded screenshots, served back ─────────────────────────────────
  if (seg[0] === "screenshots" && seg[1] && req.method === "GET") {
    const shot = db.screenshots.get(seg[1]);
    if (!shot) return json(res, 404, { error: "expired" });
    res.writeHead(200, { "Content-Type": shot.contentType, "Access-Control-Allow-Origin": "*" });
    return res.end(shot.bytes);
  }

  json(res, 404, { error: `no route for ${req.method} ${path}` });
});

// HOST=127.0.0.1 keeps the stub off the network. The sandbox always sets
// it: only its front door, on the same machine, talks to this server.
server.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`\nAnnotate Protocol v1 stub — http://localhost:${PORT}`);
  console.log(`  in memory; restart to clear`);
  if (AGENT && WORKTREE) {
    console.log(`  agent: ${AGENT.label} — worktree per task, ${MAX_JOBS} at a time${OPEN_PR ? ", opens PRs" : ""}`);
    console.log(`         edits land on annotate/* branches, NOT in your tree (so no hot reload)\n`);
  } else if (AGENT) console.log(`  agent: ${AGENT.label} — "Send to agent" edits ${AGENT_DIR}\n`);
  else if (AGENT_ENABLED) console.log(`  agent: NONE — Send will say this in the task too\n    ${AGENT_ERROR}\n`);
  else console.log(`  agent: off (--no-agent / AGENT=0) — tasks are stored, nothing acts on them\n`);
  // Never let a widened sandbox be the quiet part: if someone handed this
  // agent a shell, say so every time it starts. Deliberately AFTER the
  // chain above rather than inside it — putting it in the middle detached
  // the "unavailable" branch and printed both.
  if (AGENT?.custom) {
    console.log(`  ⚠ custom agent command — its permissions are whatever you gave it\n`);
  }
  if (AGENT?.bin === "claude" && AGENT_TOOLS.includes("Bash")) {
    console.log(`  ⚠ agent has Bash — it can run commands, including git push\n`);
  }
  if (AGENT?.bin === "codex" && AGENT_SANDBOX !== "workspace-write") {
    console.log(`  ⚠ agent sandbox is "${AGENT_SANDBOX}" — wider than the default\n`);
  }
  // PUBLIC_ORIGIN when something reachable is known, because in a sandbox
  // `localhost` is the device reading this line, not the machine running
  // it — printing it there hands out an endpoint that cannot resolve, two
  // lines under the public URL that can.
  console.log(`  EXPO_PUBLIC_ANNOTATE_ENDPOINT=${AGENT_ORIGIN}`);
  console.log(`  EXPO_PUBLIC_ANNOTATE_SESSION_ID=example-session\n`);
});

/**
 * THE AGENTS THIS BRIDGE KNOWS — and how to find, run and read each one.
 *
 * Six CLIs, detected on PATH at startup: Claude Code, Codex, Cursor,
 * OpenCode, Gemini CLI and Grok. Each entry is the whole difference between
 * them: which binary it is, how to ask for one headless edit, how to read
 * the answer and the steps back out, and how to list its models.
 *
 * MODELS COME FROM THE CLI, never from this file. A list written here would
 * be wrong the week a provider ships a model, so each CLI is asked: Claude
 * Code over its stream-json control channel, Codex over `app-server`,
 * OpenCode and Grok by their `models` commands. Cursor and Gemini have no
 * way to ask, and offer only their own default.
 *
 * SHELL ACCESS DIFFERS. Claude Code and Codex run with file tools and no
 * shell by default (`AGENT_TOOLS`, `AGENT_SANDBOX`). The other four have no
 * file-only mode in headless use: auto-approving their edits auto-approves
 * their commands too. `shell: true` marks them, and the stub says so at
 * startup and in /agent rather than widening anything quietly.
 *
 * EVENT SHAPES. Claude Code's and Codex's output is what this example has
 * always read. For the other four, the readers take the reply and the steps
 * from the fields their streams are documented or observed to carry, and
 * fall back to the raw output — an unexpected shape costs the progress
 * line, never the reply.
 */
import { spawn, spawnSync } from "node:child_process";

export const AGENT_TOOLS = (process.env.AGENT_TOOLS ?? "Read Edit Write Glob Grep").split(/\s+/).filter(Boolean);
export const AGENT_SANDBOX = process.env.AGENT_SANDBOX ?? "workspace-write";

/** Every JSON object on a line of `text`, skipping anything that is not one. */
function events(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* a partial or a log line */ }
  }
  return out;
}
const parse = (line) => events(line)[0] ?? null;

/**
 * One tool call as a short line, whatever the CLI calls the tool.
 * "read settings.tsx", "editing Button.tsx", "run npm test".
 */
export function describeTool(name, input = {}) {
  const file = input.file_path ?? input.filePath ?? input.path ?? input.absolute_path ?? input.notebook_path;
  const base = file ? String(file).split("/").pop() : null;
  const tool = String(name ?? "").toLowerCase().replace(/toolcall$/, "");
  if (/^(read|read_file|readfile|view|cat)$/.test(tool)) return base && `read ${base}`;
  if (/^(edit|multiedit|write|write_file|writefile|replace|patch|apply_patch|create)$/.test(tool)) return base && `editing ${base}`;
  if (/^(grep|search|search_file_content|ripgrep)$/.test(tool)) return `search "${String(input.pattern ?? input.query ?? "").slice(0, 40)}"`;
  if (/^(glob|find|list|ls|list_directory)$/.test(tool)) return `find ${String(input.pattern ?? input.path ?? "").slice(0, 40)}`;
  if (/^(bash|shell|run_shell_command|exec|command)$/.test(tool)) return `run ${String(input.command ?? input.cmd ?? "").slice(0, 60)}`;
  return name ? tool : null;
}

/** The last string a stream reports as its result, else every assistant chunk joined. */
function replyFrom(stdout, chunk) {
  const all = events(stdout);
  for (const e of [...all].reverse()) {
    const result = e.result ?? e.response;
    if (e.type === "result" && typeof result === "string" && result.trim()) return result;
  }
  const text = all.map(chunk).filter((t) => typeof t === "string").join("");
  return text.trim() ? text : stdout;
}

/** An ACP session update, wherever a line carries it (Grok's streaming-json). */
const acpUpdate = (e) => e?.update ?? e?.params?.update ?? (e?.sessionUpdate ? e : null);

export const PROVIDERS = {
  claude: {
    label: "Claude Code",
    bins: ["claude"],
    // STREAMED, so the steps show while it works: one JSON event per line,
    // tool calls among them, the answer last.
    args: (prompt, dir, model) => [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--allowedTools", ...AGENT_TOOLS,
      "--permission-mode", "acceptEdits",
      ...(model ? ["--model", model] : []),
    ],
    read: (stdout) => replyFrom(stdout, () => null),
    progress: (line) => {
      const event = parse(line);
      if (event?.type !== "assistant") return null;
      const uses = (event.message?.content ?? []).filter((c) => c.type === "tool_use");
      return uses.map((u) => describeTool(u.name, u.input ?? {})).filter(Boolean);
    },
    models: (bin) => claudeModels(bin),
  },
  codex: {
    label: "Codex",
    bins: ["codex"],
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
    models: (bin) => codexModels(bin),
  },
  cursor: {
    label: "Cursor",
    // `cursor-agent` first: `agent` is Cursor's newer name, but Grok installs
    // an `agent` too, so that one only counts if it does not say "grok".
    bins: ["cursor-agent", "agent"],
    identify: (version) => !/grok/i.test(version),
    shell: true,
    args: (prompt, dir, model) => [
      "-p", "--force",
      "--output-format", "stream-json",
      ...(model ? ["--model", model] : []),
      prompt,
    ],
    read: (stdout) => replyFrom(stdout, (e) =>
      e.type === "assistant" ? (e.message?.content ?? []).map((c) => c.text ?? "").join("") : null),
    progress: (line) => {
      const e = parse(line);
      if (e?.type !== "tool_call" || e.subtype !== "started" || !e.tool_call) return null;
      const [key, call] = Object.entries(e.tool_call)[0] ?? [];
      return key ? [describeTool(key, call?.args ?? {})].filter(Boolean) : null;
    },
    models: async () => [],
  },
  opencode: {
    label: "OpenCode",
    bins: ["opencode"],
    shell: true,
    // The auto-approve flag was renamed: --dangerously-skip-permissions in
    // 1.x, --auto in the current docs. Asked once, at detection.
    probe: (bin) => {
      const help = spawnSync(bin, ["run", "--help"], { encoding: "utf8", timeout: 15_000 }).stdout ?? "";
      return { approve: /--auto\b/.test(help) ? "--auto" : "--dangerously-skip-permissions" };
    },
    args: (prompt, dir, model, extra = {}) => [
      "run", "--format", "json",
      extra.approve ?? "--dangerously-skip-permissions",
      "--dir", dir,
      ...(model ? ["-m", model] : []),
      prompt,
    ],
    read: (stdout) => replyFrom(stdout, (e) => (e.type === "text" ? e.part?.text ?? e.text : null)),
    progress: (line) => {
      const e = parse(line);
      if (e?.type !== "tool_use" && e?.type !== "tool") return null;
      return [describeTool(e.part?.tool ?? e.tool, e.part?.state?.input ?? e.input ?? {})].filter(Boolean);
    },
    // "provider/model" per line, across every provider the user configured.
    models: (bin) => lineModels(bin, ["models"], (line) => (/^[\w.-]+\/\S+$/.test(line) ? { id: line, label: line } : null)),
  },
  gemini: {
    label: "Gemini CLI",
    bins: ["gemini"],
    shell: true,
    args: (prompt, dir, model) => [
      "-p", prompt,
      "--yolo",
      "--output-format", "stream-json",
      ...(model ? ["-m", model] : []),
    ],
    read: (stdout) => replyFrom(stdout, (e) =>
      e.type === "message" && e.role === "assistant" ? (typeof e.content === "string" ? e.content : "") : null),
    progress: (line) => {
      const e = parse(line);
      if (e?.type !== "tool_use") return null;
      return [describeTool(e.tool_name ?? e.name, e.parameters ?? e.args ?? {})].filter(Boolean);
    },
    models: async () => [],
  },
  grok: {
    label: "Grok",
    bins: ["grok"],
    shell: true,
    args: (prompt, dir, model) => [
      "-p", prompt,
      "--always-approve",
      "--output-format", "streaming-json",
      "--cwd", dir,
      ...(model ? ["-m", model] : []),
    ],
    read: (stdout) => replyFrom(stdout, (e) => {
      const u = acpUpdate(e);
      return u?.sessionUpdate === "agent_message_chunk" ? u.content?.text ?? "" : null;
    }),
    progress: (line) => {
      const u = acpUpdate(parse(line));
      if (u?.sessionUpdate !== "tool_call") return null;
      const path = u.locations?.[0]?.path;
      return [describeTool(u.kind ?? u.title, path ? { path } : {}) ?? u.title].filter(Boolean);
    },
    // "  * grok-4.6 (default)" / "  - grok-4.5", under "You are not
    // authenticated." when it is not signed in — which lists the models
    // all the same, and then fails every task. Said, not hidden.
    models: (bin) => lineModels(bin, ["models"], (line) => {
      const m = /^\s*[*-]\s+(\S+)(\s+\(default\))?/.exec(line);
      return m ? { id: m[1], label: m[1], ...(m[2] ? { default: true } : {}) } : null;
    }, (out) => (/not authenticated/i.test(out)
      ? { note: "Grok isn't signed in, so its tasks will fail. Run grok once in a terminal to sign in." }
      : {})),
  },
};

/** The order "whichever is installed" tries them in. */
export const PROVIDER_ORDER = ["claude", "codex", "cursor", "opencode", "gemini", "grok"];

/**
 * `AGENT_CMD` — any other agent, as a command template. `{prompt}` and
 * `{dir}` are substituted; stdout is the reply, stderr lines are the steps.
 */
export function customProvider() {
  const template = (process.env.AGENT_CMD ?? "").trim();
  if (!template) return null;
  const parts = template.split(/\s+/);
  return {
    label: `custom (${parts[0]})`,
    bins: [parts[0]],
    custom: true,
    shell: true,
    args: (prompt, dir) => {
      const rest = parts.slice(1);
      const substituted = rest.map((a) => a.replace(/\{dir\}/g, dir).replace(/\{prompt\}/g, prompt));
      return rest.some((a) => a.includes("{prompt}")) ? substituted : [...substituted, prompt];
    },
    read: (stdout) => stdout,
    progressFrom: "stderr",
    progress: (line) => (line.trim() ? [line.trim().slice(0, 120)] : null),
    models: async () => [],
  };
}

/** `bin --version`, or null when it is not there or does not answer. */
function version(bin) {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (probe.error || probe.status !== 0) return null;
  return `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim().split("\n")[0] || "unknown";
}

/**
 * Which providers are installed, by asking each candidate binary for its
 * version. Blocking, and a few hundred ms per binary: run at startup and
 * when someone asks to check again, never per request.
 */
export function detectProviders(providers = PROVIDERS) {
  const found = {};
  for (const [id, p] of Object.entries(providers)) {
    let hit = null;
    for (const bin of p.bins) {
      const v = version(bin);
      if (v && (!p.identify || p.identify(v))) { hit = { bin, version: v }; break; }
    }
    found[id] = hit ? { installed: true, ...hit, extra: p.probe?.(hit.bin) ?? {} } : { installed: false };
  }
  return found;
}

// ── Model discovery ─────────────────────────────────────────────────────────

const DISCOVERY_TIMEOUT_MS = 20_000;

/** Run `bin args`, keep the lines `pick` turns into models; `inspect` may add a note. */
function lineModels(bin, args, pick, inspect = () => ({})) {
  return new Promise((resolveModels, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), DISCOVERY_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (d) => { if (out.length < 1_000_000) out += d; });
    child.on("error", () => { clearTimeout(timer); reject(new Error("could not run it")); });
    child.on("close", () => {
      clearTimeout(timer);
      const models = out.split("\n").map((l) => pick(l.trimEnd())).filter(Boolean);
      models.length ? resolveModels({ models, ...inspect(out) }) : reject(new Error("it listed no models"));
    });
  });
}

/** Line-delimited JSON with a CLI on stdin/stdout; `onEvent` returns models to finish. */
function jsonSession(bin, args, start, onEvent) {
  return new Promise((resolveModels, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", done = false;
    const finish = (models, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      const list = Array.isArray(models) ? models : models?.models;
      list?.length ? resolveModels(models) : reject(error ?? new Error("it listed no models"));
    };
    const timer = setTimeout(() => finish(null, new Error("it did not answer in time")), DISCOVERY_TIMEOUT_MS);
    const send = (v) => child.stdin.write(JSON.stringify(v) + "\n");
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.stdout.setEncoding("utf8").on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const event = parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (!event) continue;
        const models = onEvent(event, send);
        if (models) finish(models);
      }
    });
    child.on("error", () => finish(null, new Error("could not run it")));
    child.on("close", () => finish(null));
    start(send);
  });
}

/**
 * Claude Code's own list, over the stream-json control channel — the same
 * list its /model picker shows. Its "default" entry is the CLI's default,
 * which is what no --model means, so it is not offered as a model of its
 * own; its description names the model it stands for ("Opus 5.5 · …"),
 * which becomes the Default row's label.
 */
function claudeModels(bin) {
  return jsonSession(
    bin,
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--setting-sources", ""],
    (send) => send({ type: "control_request", request_id: "models", request: { subtype: "initialize" } }),
    (e) => {
      if (e.type !== "control_response") return null;
      const all = e.response?.response?.models ?? [];
      const def = all.find((m) => m?.value === "default");
      const models = all
        .filter((m) => typeof m?.value === "string" && m.value !== "default")
        .map((m) => ({ id: m.value, label: m.displayName ?? m.value, ...(m.description ? { description: m.description } : {}) }));
      const named = typeof def?.description === "string" ? def.description.split("·")[0].trim() : "";
      return models.length ? { models, ...(named ? { defaultLabel: named } : {}) } : null;
    },
  );
}

/** Codex's own list, over `codex app-server`'s JSON-RPC `model/list`. */
function codexModels(bin) {
  return jsonSession(
    bin,
    ["app-server"],
    (send) => send({ id: 1, method: "initialize", params: { clientInfo: { name: "annotate-sandbox", version: "1" } } }),
    (e, send) => {
      if (e.id === 1) {
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "model/list", params: { limit: 100 } });
        return null;
      }
      if (e.id !== 2) return null;
      return (e.result?.data ?? [])
        .filter((m) => m && !m.hidden && typeof (m.id ?? m.model) === "string")
        .map((m) => ({ id: m.id ?? m.model, label: m.displayName ?? m.id ?? m.model, ...(m.isDefault ? { default: true } : {}) }));
    },
  );
}

/** Each provider's models, cached for a minute: discovery starts a CLI. */
const modelCache = new Map();
export async function providerModels(id, provider, bin) {
  const hit = modelCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let value;
  try {
    // A list, or { models, defaultLabel?, note? } when the CLI said more.
    const got = await provider.models(bin);
    const models = Array.isArray(got) ? got : got.models;
    const defaultLabel = (Array.isArray(got) ? null : got.defaultLabel) ?? models.find((m) => m.default)?.label;
    value = {
      ok: true,
      models,
      ...(defaultLabel ? { defaultLabel } : {}),
      ...(!Array.isArray(got) && got.note ? { note: got.note } : {}),
    };
  } catch (err) {
    value = { ok: false, message: `Could not load ${provider.label}'s models: ${err.message}.` };
  }
  modelCache.set(id, { at: Date.now(), value });
  return value;
}

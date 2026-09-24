/**
 * iflow (SuperClaude V8) extension for oh-my-pi (omp), shipped inside the
 * `iflow-zh` plugin package.
 *
 * Registers every behavioral command in `framework/commands/sc/*.md` as a
 * native omp slash command (`/sc:implement`, `/sc:task`, ...), narrows the
 * main session to a dispatcher, and routes `task` calls that omit an agent.
 *
 * The dispatcher activates at `session_start` for any non-subagent session —
 * interactive, print (`omp -p`), and `--mode json` alike — so headless runs
 * also enter dispatcher mode. Subagent sessions are detected via the hidden
 * `yield` tool and skipped to avoid locking them out of their own mutators.
 * Pass `--sc-dispatch off` on the CLI to suppress activation in any mode.
 *
 * Package layout (paths resolved from `import.meta.url`, never from cwd — the
 * plugin lives in omp's plugin root and knows nothing about the user's project):
 *   extension/iflow.ts        <- this file (package.json#omp.extensions)
 *   extension/setup.mjs       <- writer shared with bin/install.mjs
 *   framework/commands/sc/    <- command definitions
 *   agents/*.md               <- 15 specialists, found by omp's task discovery
 *   rules/*.md                <- iflow-sticky (all agents), iflow-dispatch (main)
 *
 * A command handler expands the markdown body (frontmatter stripped,
 * `$ARGUMENTS` / `$@` / `$1..$9` substituted) and submits it as the next user
 * prompt, which is exactly how Claude Code file-commands behave.
 *
 * `/reload-plugins` refreshes commands; changes to this file or its hooks need
 * a session restart.
 */
import type {
  AsyncJobSnapshot,
  AsyncJobSnapshotItem,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { stderr } from "node:process";
import { fileURLToPath } from "node:url";
import { checkApplied, formatReport, resolveAgentDir, runSetup } from "./setup.mjs";

interface Frontmatter {
  name?: string;
  description?: string;
}

interface CommandDef {
  name: string;
  description: string;
  body: string;
}

const NAMESPACE = "sc";
const HELP_COMMAND = "sc";
const MODEL_ROLES = ["default", "smol", "task", "slow"] as const;
const DISPATCH_FLAG = "sc-dispatch";

/**
 * Tools the dispatcher keeps. Names must match omp's canonical registry
 * (`tools/builtin-names.ts`): `setActiveToolsByName` silently DROPS names it
 * does not know, so a typo here shows up as a mysteriously smaller tool set
 * rather than an error.
 */
const DISPATCHER_TOOLS = ["read", "grep", "glob", "task", "todo", "ask", "hub"];

/** Landing tools the gate refuses in the main session. */
const MUTATORS: Record<string, true> = {
  edit: true,
  write: true,
  bash: true,
  eval: true,
  ast_edit: true,
};

/**
 * Commands implemented directly in code below instead of prompt expansion.
 * `loadCommands()` still parses their Markdown (so `/sc` help lists them and
 * the shipped file documents the contract), but the generic registration loop
 * skips them — registering `sc:<name>` twice would make one handler dead, and
 * which one wins is an omp implementation detail, never relied on.
 */
const OPERATIONAL_COMMANDS: Record<string, true> = { cleanup: true };

const TASK_ROUTES: Array<{ agent: string; patterns: RegExp[] }> = [
  {
    agent: "security-reviewer",
    patterns: [
      /security review/, /security audit/, /security assessment/, /security analysis/,
      /vulnerability/, /threat model/, /credential leak/, /cve\b/,
      /安全审查/, /安全审核/, /安全审计/, /安全分析/, /漏洞/,
      /威胁建模/, /凭据泄露/, /密钥泄露/,
    ],
  },
  {
    agent: "system-architect",
    patterns: [
      /architecture/, /system design/, /dependency graph/, /module boundary/,
      /架构/, /系统设计/, /依赖图/, /模块边界/,
    ],
  },
  {
    agent: "root-cause-analyst",
    patterns: [
      /root cause/, /debug/, /investigate failure/, /incident analysis/,
      /regression analysis/, /根因/, /调试/, /故障分析/, /回归分析/,
    ],
  },
  {
    agent: "performance-engineer",
    patterns: [
      /performance analysis/, /benchmark/, /latency/, /throughput/,
      /complexity analysis/, /性能分析/, /基准测试/, /延迟/, /吞吐量/, /复杂度分析/,
    ],
  },
  {
    // Research is read-only work, and `scout` is a built-in agent that always
    // exists — the former `librarian` route named an agent nothing defined.
    agent: "scout",
    patterns: [
      /search the repository/, /locate files?/, /inspect files?/, /read-only/, /inventory/,
      /搜索仓库/, /定位文件/, /检查文件/, /只读/, /盘点/,
      /research/, /look up/, /lookup/, /official documentation/, /api reference/,
      /调研/, /查找文档/, /官方文档/, /接口文档/,
    ],
  },
  {
    agent: "reviewer",
    patterns: [/review/, /audit/, /verify/, /quality check/, /评审/, /审计/, /验证/, /质量检查/],
  },
];

function classifyTask(task: string): string {
  const normalized = task.toLowerCase();
  for (const route of TASK_ROUTES) {
    if (route.patterns.some((pattern) => pattern.test(normalized))) return route.agent;
  }
  return "task";
}

function routeTaskInput(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;

  if (Array.isArray(input.tasks)) {
    let changed = false;
    const tasks = input.tasks.map((item: unknown) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
      const taskItem = item as Record<string, unknown>;
      if (typeof taskItem.agent === "string" && taskItem.agent.trim()) return item;
      if (typeof taskItem.task !== "string" || !taskItem.task.trim()) return item;
      changed = true;
      return { ...taskItem, agent: classifyTask(taskItem.task) };
    });
    return changed ? { ...input, tasks } : undefined;
  }

  if (
    typeof input.task === "string" &&
    (!("agent" in input) || typeof input.agent !== "string" || !input.agent.trim())
  ) {
    return { ...input, agent: classifyTask(input.task) };
  }

  return undefined;
}

/** Best-effort agent suggestion for a blocked landing call. */
function suggestAgentFor(event: { toolName: string; input: unknown }): string {
  const input = event.input;
  const hint =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? Object.values(input as Record<string, unknown>)
          .filter((value): value is string => typeof value === "string")
          .join(" ")
      : "";
  return classifyTask(hint);
}

function describeModel(model: unknown): string {
  if (model === null || typeof model !== "object" || Array.isArray(model)) return "unresolved";
  const resolved = model as { provider?: unknown; id?: unknown; name?: unknown };
  if (typeof resolved.provider === "string" && typeof resolved.id === "string") {
    return `${resolved.provider}/${resolved.id}`;
  }
  if (typeof resolved.name === "string") return resolved.name;
  return "resolved";
}

function parseCommandFile(raw: string, fileName: string): CommandDef | undefined {
  const normalized = raw.replace(/\r\n/g, "\n");
  const fm: Frontmatter = {};
  let body = normalized;
  if (normalized.startsWith("---")) {
    const end = normalized.indexOf("\n---", 3);
    if (end !== -1) {
      const header = normalized.slice(4, end);
      body = normalized.slice(end + 4).replace(/^\n+/, "");
      for (const line of header.split("\n")) {
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
        if (!match) continue;
        const [, key, value] = match;
        if (key === "name" || key === "description") {
          fm[key] = value.replace(/^['"]|['"]$/g, "").trim();
        }
      }
    }
  }
  const name = fm.name || path.basename(fileName, ".md");
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return undefined;
  return { name, description: fm.description || "", body };
}

/**
 * Command bodies ship with the package, so resolve them from this module's own
 * URL. The loader imports the realpath'd entry, which makes `import.meta.url`
 * point inside the installed plugin root regardless of the session's cwd.
 */
const COMMAND_DIR = fileURLToPath(new URL("../framework/commands/sc", import.meta.url));

function loadCommands(): CommandDef[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(COMMAND_DIR);
  } catch {
    return [];
  }
  const commands: CommandDef[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const parsed = parseCommandFile(fs.readFileSync(path.join(COMMAND_DIR, entry), "utf8"), entry);
    if (parsed) commands.push(parsed);
  }
  return commands;
}

function splitArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function expandTemplate(body: string, args: string): string {
  const trimmedArgs = args.trim();
  const hasPlaceholder = /\$ARGUMENTS|\$@|\$\d/.test(body);
  let expanded = body
    .replace(/\$ARGUMENTS|\$@/g, trimmedArgs)
    .replace(/\$(\d)/g, (_, digit: string) => splitArgs(trimmedArgs)[Number(digit) - 1] ?? "");
  if (!hasPlaceholder && trimmedArgs) {
    expanded += `\n\n**Task arguments**: ${trimmedArgs}`;
  }
  return expanded;
}

/**
 * Submits a prompt through omp's prompt pipeline via `sendUserMessage`.
 * This is the required message-submission API; a missing one is a hard
 * failure, not something to work around.
 */
async function submitPrompt(pi: ExtensionAPI, prompt: string): Promise<void> {
  const api = pi as unknown as {
    sendUserMessage?: (content: string) => Promise<unknown> | unknown;
  };
  if (typeof api.sendUserMessage === "function") {
    await api.sendUserMessage(prompt);
    return;
  }
  throw new Error("iflow bridge: omp exposes no message submission API");
}

/**
 * Single user-facing output channel for all extension surfaces. In an
 * interactive session `ctx.ui.notify` renders in the TUI; headlessly
 * (`ctx.hasUI === false`) `ctx.ui.notify` is `noOpUIContext.notify` — a no-op
 * (`extensibility/extensions/runner.ts:401-405,701`) — so print/JSON mode would
 * see nothing. Falling back to stderr (never stdout) keeps print mode's
 * contract intact: `--mode json` writes one JSON record per line to stdout
 * (`modes/print-mode.ts:115-120,155-160`) and text print mode writes the final
 * assistant message there (`modes/print-mode.ts:188-237`); an extension
 * polluting stdout would corrupt both.
 *
 * `ExtensionContext` is the narrowest type that compiles for both event
 * handlers (`ExtensionHandler` passes `ExtensionContext`) and command handlers
 * (`RegisteredCommand.handler` passes `ExtensionCommandContext`, which extends
 * `ExtensionContext`); both expose `hasUI` and `ui.notify`.
 */
function report(
  ctx: ExtensionContext,
  text: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
  } else {
    stderr.write(`${text}\n`);
  }
}

/**
 * Detects a `task`-spawned subagent session. `ctx.hasUI` and `ctx.mode` cannot
 * tell a print-mode main session from a subagent — `task/executor.ts:3553`
 * calls `extensionRunner.initialize(actions, contextActions)` with only 2 args,
 * so `uiContext` is undefined ⇒ `hasUI === false` (`runner.ts:701,881-883`) and
 * `mode` falls back to its `"print"` default (`runner.ts:651`); print mode
 * itself also passes no `uiContext` (`modes/runtime-init.ts:152`), producing
 * the identical `hasUI === false`, `mode === "print"`. The reliable
 * discriminator is the hidden `yield` tool: `task/executor.ts:3351` hardcodes
 * `requireYieldTool: true` for every subagent (also `task/persisted-revive.ts:
 * 165` for revived ones), and `tools/index.ts:498,678` registers `yield` into
 * the tool registry ONLY when that flag is set — no main-session path sets it.
 * `yield` is absent from `BUILTIN_TOOL_NAMES` (`tools/builtin-names.ts:1-28,32`),
 * so `--tools yield` cannot smuggle it into a main session (`main.ts:1979`
 * validates against the registry, which lacks it). The
 * `sourceInfo.source === "builtin"` check closes the last hole: an extension
 * could register a tool named `yield`, but it would report `source` as
 * `"extension"` (`types.ts:692-698`; `session/session-tools.ts:533-548` seeds
 * the `"builtin"` source from the session's built-in registry keys, seeded in
 * turn from `sdk.ts:2085` `[...toolRegistry.keys()]`), so the impostor is
 * rejected.
 */
function isSubagentSession(pi: ExtensionAPI): boolean {
  if (!pi.getActiveTools().includes("yield")) return false;
  const yieldTool = pi.getAllTools().find((tool) => tool.name === "yield");
  return yieldTool?.sourceInfo.source === "builtin";
}

// ---------------------------------------------------------------------------
// /sc:cleanup — 会话后台任务快照（只读）。omp 18.1.13 的扩展 API 只有
// ctx.getAsyncJobSnapshot()（AsyncJobSnapshot：running/recent/delivery），
// 没有公开的取消或清理接口；本命令如实报告，绝不伪造"已清理"。
// ---------------------------------------------------------------------------

const CLEANUP_NO_CANCEL_NOTE =
  "omp 18.1.13 只向插件暴露只读快照（ctx.getAsyncJobSnapshot），没有公开的取消/清理接口：" +
  "本命令不会终止或删除任何任务。要停止运行中的任务请用宿主机制（TUI 按 Esc 中断当前回合、" +
  "内建 /jobs 查看）；已完成任务行由 omp 宿主在约 5 分钟后自动淘汰。";

function formatJobDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatJobLine(job: AsyncJobSnapshotItem, now: number): string {
  const age = formatJobDuration(Math.max(0, now - job.startTime));
  const agent = job.agentId !== undefined ? ` @${job.agentId}` : "";
  const label = job.label ? ` — ${job.label}` : "";
  return `  [${job.id}] ${job.type} ${job.status} (${age})${agent}${label}`;
}

function cleanupReportText(snapshot: AsyncJobSnapshot | null, now: number): string {
  if (!snapshot) return `后台异步任务在当前会话不可用。\n说明：${CLEANUP_NO_CANCEL_NOTE}`;
  const lines: string[] = [];
  if (snapshot.running.length === 0 && snapshot.recent.length === 0) {
    lines.push("当前会话没有自己的后台异步任务（后台任务指 task 子代理等异步工具）。");
  } else {
    lines.push(`本会话的后台异步任务：${snapshot.running.length} 运行中 / ${snapshot.recent.length} 最近`);
    if (snapshot.running.length > 0) {
      lines.push("运行中：", ...snapshot.running.map((job) => formatJobLine(job, now)));
    }
    if (snapshot.recent.length > 0) {
      lines.push("最近（含已完成/失败/已取消）：", ...snapshot.recent.map((job) => formatJobLine(job, now)));
    }
    const delivery = snapshot.delivery;
    const retry =
      delivery.nextRetryAt !== undefined ? `，下次重试 ${new Date(delivery.nextRetryAt).toISOString()}` : "";
    lines.push(`投递状态：queued=${delivery.queued}，delivering=${delivery.delivering}${retry}`);
  }
  lines.push(`说明：${CLEANUP_NO_CANCEL_NOTE}`);
  return lines.join("\n");
}

function cleanupReportJson(snapshot: AsyncJobSnapshot | null, sessionId: string, now: number): string {
  return JSON.stringify(
    {
      command: "sc:cleanup",
      mode: "readonly",
      available: snapshot !== null,
      generatedAt: new Date(now).toISOString(),
      sessionId,
      running: snapshot?.running ?? [],
      recent: snapshot?.recent ?? [],
      delivery: snapshot?.delivery ?? null,
      mutation: {
        cancel: false,
        prune: false,
        reason: "omp 18.1.13 exposes no public cancellation/prune API to extensions",
      },
    },
    null,
    2,
  );
}

export default function iflowExtension(pi: ExtensionAPI): void {
  const commands = loadCommands();

  // CLI flag: `--sc-dispatch off` suppresses dispatcher activation in every
  // mode (interactive included). CLI values arrive through `applyExtensionFlags`
  // re-parsing argv into the shared `ExtensionRuntime.flagValues` before the
  // session is created (`main.ts:1895-1904,1975`; `cli/extension-flags.ts:36-43`;
  // `extensibility/extensions/loader.ts:222-230,254-257`), which is why
  // `pi.getFlag` is already readable inside `session_start`. Extension flags
  // shadow same-named built-ins (`cli/args.ts:187-193`); no built-in named
  // `sc-dispatch` exists.
  pi.registerFlag(DISPATCH_FLAG, {
    type: "string",
    description: "iflow 调度者激活：设为 'off' 可在任意模式下关闭它。",
  });

  /**
   * Dispatcher state. `preNarrowTools` holds the tool set captured before the
   * first narrowing: restoring means handing that snapshot back verbatim rather
   * than recomputing a list, because `write` can be transport-only demoted and
   * `setActiveToolsByName` decides that from the active set at call time.
   */
  let dispatchGateOn = false;
  let preNarrowTools: string[] | undefined;

  /**
   * Narrows the session to the dispatcher tool set. `skipped: "subagent"`
   * means the call refused because this is a `task`-spawned subagent — the
   * single choke point that keeps `/sc:dispatch on` from locking a subagent
   * now that the `hasUI` guards are gone from `session_start` and the
   * `tool_call` handler. Subagents keep their complete configured tool set
   * and are never narrowed, regardless of parent mode or `--sc-dispatch`.
   */
  async function enableDispatcher(): Promise<{ removed: string[]; skipped?: "subagent" }> {
    if (isSubagentSession(pi)) return { removed: [], skipped: "subagent" };
    const active = pi.getActiveTools();
    if (preNarrowTools === undefined) preNarrowTools = active;
    const keep = DISPATCHER_TOOLS.filter((name) => active.includes(name));
    await pi.setActiveTools(keep);
    dispatchGateOn = true;
    return { removed: active.filter((name) => !keep.includes(name)) };
  }

  async function disableDispatcher(): Promise<{ restored: string[] | undefined }> {
    dispatchGateOn = false;
    if (preNarrowTools === undefined) return { restored: undefined };
    const snapshot = preNarrowTools;
    await pi.setActiveTools(snapshot);
    preNarrowTools = undefined;
    return { restored: snapshot };
  }

  for (const cmd of commands) {
    // 操作型命令（见 OPERATIONAL_COMMANDS）由下方直接注册处理器，这里跳过，
    // 避免 sc:<name> 被注册两次。
    if (OPERATIONAL_COMMANDS[cmd.name]) continue;
    pi.registerCommand(`${NAMESPACE}:${cmd.name}`, {
      description: cmd.description || `iflow V8 行为命令（${cmd.name}）`,
      handler: async (args: string) => {
        await submitPrompt(pi, expandTemplate(cmd.body, typeof args === "string" ? args : ""));
      },
    });
  }

  pi.registerCommand(HELP_COMMAND, {
    description: "列出 iflow V8（/sc:*）命令、角色与模式",
    handler: async (_args, ctx) => {
      const lines = [
        "iflow (SuperClaude V8) — oh-my-pi 插件",
        "",
        "行为命令（将命令体展开为下一条提示）：",
        ...commands.filter((c) => !OPERATIONAL_COMMANDS[c.name]).map((c) => `- /sc:${c.name}${c.description ? ` — ${c.description}` : ""}`),
        "",
        "状态命令（直接读取 omp 会话状态执行）：",
        ...commands.filter((c) => OPERATIONAL_COMMANDS[c.name]).map((c) => `- /sc:${c.name}${c.description ? ` — ${c.description}` : ""}`),
        "",
        "安装：/sc:setup 写入用户级 AGENTS.md 条目；模型角色与回退链由你在 config.yml 配置。",
        "专家角色（task 工具）：包内 agents/ 目录，共 15 个角色。",
        "任务路由：未显式指定的角色会被分类，显式指定的角色予以保留。",
        "模型角色：每个专家 Agent 在定义中声明复用的内建角色（@slow/@task），无需手动映射；iflow 不改写你的 config.yml，具体模型由该角色在 config.yml 的配置决定。/sc:roles 查看解析结果；子 Agent 自动继承其 Role 的思考深度（如 @slow:high）与 retry.fallbackChains 回退链。",
        "规则：iflow-sticky + iflow-framework（所有 agent）、iflow-dispatch（仅主会话）。",
      ];
      report(ctx, lines.join("\n"));
    },
  });

  pi.registerCommand("sc:roles", {
    description: "展示 omp 模型角色的解析结果（映射由你的 config.yml 决定）",
    handler: async (_args, ctx) => {
      const lines = ["omp 模型角色解析结果（映射由你的 config.yml 决定）", ""];
      for (const role of MODEL_ROLES) {
        lines.push(`@${role} → ${describeModel(ctx.models.resolve(`@${role}`))}`);
      }
      report(ctx, lines.join("\n"));
    },
  });

  pi.registerCommand("sc:setup", {
    description: "写入 iflow 用户级 AGENTS.md 条目（整机范围）",
    handler: async (args: string, ctx) => {
      const dryRun = /(^|\s)(--dry-run|-n)(\s|$)/.test(typeof args === "string" ? args : "");
      try {
        report(ctx, formatReport(runSetup({ dryRun })));
      } catch (error) {
        report(ctx, `iflow /sc:setup 失败：${error instanceof Error ? error.message : error}`, "error");
      }
    },
  });

  pi.registerCommand("sc:dispatch", {
    description: "开启/关闭调度者模式（扣留 edit/write/bash/eval/ast_edit）",
    handler: async (args: string, ctx) => {
      const arg = (typeof args === "string" ? args : "").trim().toLowerCase();
      if (arg === "off") {
        const { restored } = await disableDispatcher();
        report(
          ctx,
          restored
            ? `调度者模式已关闭，工具集还原为进入前的 ${restored.length} 个。`
            : "调度者模式本来就没开启。",
        );
        return;
      }
      if (arg === "on" || arg === "") {
        const { removed, skipped } = await enableDispatcher();
        if (skipped === "subagent") {
          report(
            ctx,
            "调度者模式：当前是子会话（task subagent），不开启调度者；子会话保留完整配置工具集。",
            "warning",
          );
          return;
        }
        report(
          ctx,
          removed.length
            ? `调度者模式已开启，收走 ${removed.length} 个落地工具：${removed.join(", ")}。关闭：/sc:dispatch off`
            : "调度者模式已开启（当前活跃工具里没有落地工具可收）。",
        );
        return;
      }
      report(ctx, "用法：/sc:dispatch [on|off]", "warning");
    },
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (event.toolName === "task") {
      const routedInput = routeTaskInput(event.input);
      return routedInput ? { input: routedInput } : undefined;
    }
    if (!dispatchGateOn) return;
    if (!MUTATORS[event.toolName]) return;
    // Fallback layer only: narrowing already removed the built-ins, so this
    // catches MCP tools, xd:// devices and anything a user re-enabled. Handlers
    // are per-session — the runner iterates its own `this.extensions`
    // (`runner.ts:1470-1511`) and each session rebinds the factory via a fresh
    // `ExtensionRuntime` (`loader.ts:465,417,371`), so `dispatchGateOn` can only
    // be true in a session that narrowed itself. `enableDispatcher` refuses
    // subagents, so no `hasUI` test is needed here.
    return {
      block: true,
      reason:
        `调度者模式：主会话不直接执行 ${event.toolName}。` +
        `请用 task 分派，建议 agent = ${suggestAgentFor(event)}。` +
        `临时关闭：/sc:dispatch off`,
    };
  });

  pi.registerCommand("sc:cleanup", {
    description: "只读报告本会话拥有的后台异步任务快照（无取消/清理能力，见输出说明）",
    handler: async (args: string, ctx) => {
      const flags = splitArgs(typeof args === "string" ? args : "");
      const unknown = flags.filter((flag) => flag.startsWith("-") && !["--json", "--help", "-h"].includes(flag));
      if (unknown.length > 0) {
        report(ctx, `未知参数：${unknown.join(", ")}。用法：/sc:cleanup [--json] [--help]`, "warning");
        return;
      }
      if (flags.includes("--help") || flags.includes("-h")) {
        report(
          ctx,
          [
            "用法：/sc:cleanup [--json] [--help]",
            "",
            "只读列出当前会话拥有的后台异步任务（task 子代理等）与投递状态。",
            "",
            "限制（omp 18.1.13）：扩展 API 只有只读快照 ctx.getAsyncJobSnapshot()，",
            "没有公开的取消/清理接口——本命令不会终止或删除任何任务。停止任务请用宿主机制",
            "（TUI 按 Esc；内建 /jobs 查看）；已完成任务行由 omp 宿主约 5 分钟后自动淘汰。",
          ].join("\n"),
        );
        return;
      }
      const now = Date.now();
      const snapshot = ctx.getAsyncJobSnapshot();
      if (flags.includes("--json")) {
        report(ctx, cleanupReportJson(snapshot, ctx.sessionManager.getSessionId(), now));
        return;
      }
      report(ctx, cleanupReportText(snapshot, now));
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const lines: string[] = [];
    lines.push(
      commands.length
        ? `iflow V8 已激活 — 已注册 ${commands.length} 个 /sc:* 命令。输入 /sc 查看列表。`
        : `iflow V8 未在 ${COMMAND_DIR} 找到命令体，请重新安装插件。`,
    );

    try {
      const status = checkApplied();
      if (!status.hasFrameworkNote) {
        lines.push(`AGENTS.md 缺少框架规则说明（${status.agentDir}）。跑 /sc:setup 补上。`);
      }
    } catch (error) {
      lines.push(`iflow setup 检查失败：${error instanceof Error ? error.message : error}`);
    }

    if (isSubagentSession(pi)) {
      lines.push("调度者模式：当前是子会话（task subagent），不开启调度者；子会话保留完整配置工具集。");
    } else {
      const flagOff = String(pi.getFlag(DISPATCH_FLAG) ?? "").trim().toLowerCase() === "off";
      if (flagOff) {
        lines.push("调度者模式：--sc-dispatch off，不开启。");
      } else {
        const { removed } = await enableDispatcher();
        lines.push(
          removed.length
            ? `调度者模式：已收走 ${removed.join(", ")}，落地动作请用 task 分派。关闭：/sc:dispatch off`
            : "调度者模式：当前活跃工具里没有落地工具。",
        );
      }
    }

    report(ctx, lines.join("\n"));
  });
}

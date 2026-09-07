#!/usr/bin/env node
/**
 * Writes the one thing an omp plugin cannot contribute by discovery: the
 * user-level context file. Shared by two callers, which is why this is `.mjs`
 * rather than `.ts` — the extension runs under Bun (TS is fine),
 * `bin/install.mjs` runs under the user's plain Node (no TS loader).
 *
 *   `<agentDir>/AGENTS.md` — a pure shell. The framework text is never
 *      inlined into a context file: always-apply rule content is deduped
 *      against loaded context files, so a duplicate here would silently drop
 *      one of the two copies — and context files never reach `task` subagents
 *      anyway. The framework travels as the generated always-apply rule
 *      `rules/iflow-framework.md` (see scripts/build-agents.mjs), which omp
 *      injects into the main session and every subagent.
 *
 *   `<agentDir>/config.yml` — NOT written. iflow seeds no model
 *      configuration: providers, `modelRoles` assignments (including
 *      thinking-depth suffixes like `@slow:high`), `task.agentModelOverrides`
 *      and `retry.fallbackChains` stay in the user's own config.yml. omp
 *      natively keys every subagent's retry-fallback chain and thinking depth
 *      off the Role its model resolves to (task/executor.ts
 *      resolveSubagentInheritedRetryFallbackChain / installSubagentRetryFallbackChain),
 *      so a Role with a configured chain needs no help from iflow.
 *      Pre-existing iflow seeds from older versions are left untouched, never
 *      deleted. `templates/config.patch.yml` documents this; `mergeConfig` is
 *      the no-op boundary that keeps the setup report shape stable.
 *
 * Occupying `<agentDir>/AGENTS.md` shadows every other user-level context file
 * (native has the highest provider priority and only one user-level file
 * survives scope dedupe), so we probe the known candidates and `@`-import the
 * one that exists — referenced, not copied, so the user's later edits still
 * apply.
 *
 * Paths are resolved, never hardcoded: profiles move the agent dir to
 * `~/.omp/profiles/<name>/agent`, `PI_CODING_AGENT_DIR` overrides it outright,
 * and `PI_CONFIG_DIR` renames `.omp` itself.
 */
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * User-level context files that `<agentDir>/AGENTS.md` shadows once it exists,
 * in the provider order omp itself uses. Relative to the home directory.
 */
const SHADOWED_CANDIDATES = [
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  ".gemini/GEMINI.md",
  ".config/opencode/AGENTS.md",
  ".copilot/copilot-instructions.md",
  ".agent/AGENTS.md",
  ".agents/AGENTS.md",
];

/** Resolve the agent config directory the same way omp's own resolver does. */
export function resolveAgentDir(env = process.env, home = os.homedir()) {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  const profile = normalizeProfile(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
  // A profile derives its own agent dir and ignores the override, matching
  // DirResolver: `agentDirOverride = profile ? undefined : options.agentDirOverride`.
  if (!profile && override) return path.resolve(override);
  const configRoot = path.join(home, env.PI_CONFIG_DIR || ".omp");
  return profile ? path.join(configRoot, "profiles", profile, "agent") : path.join(configRoot, "agent");
}

function normalizeProfile(value) {
  const normalized = value?.trim();
  if (!normalized || normalized === "default") return undefined;
  return normalized;
}

/** `@` imports accept a `~/` prefix; prefer it so the file survives a home move. */
function toImportToken(target, home = os.homedir()) {
  const relative = path.relative(home, target);
  const portable = !relative.startsWith("..") && !path.isAbsolute(relative);
  const raw = portable ? `~/${relative}` : target;
  return raw.split(path.sep).join("/");
}

function backup(file) {
  if (!existsSync(file)) return null;
  const bak = `${file}.bak`;
  copyFileSync(file, bak);
  return bak;
}

/**
 * iflow owns no settings keys: providers, models, role assignments, and
 * fallback chains stay in the user's own config.yml. `mergeConfig` exists as
 * a no-op boundary so the setup report keeps a stable shape (a plugin cannot
 * contribute settings by discovery, and nothing here may silently rewrite a
 * user's model configuration — including pre-existing iflow seeds, which we
 * deliberately leave untouched rather than delete).
 */
export function mergeConfig(agentDir, { dryRun = false } = {}) {
  const configPath = path.join(agentDir, "config.yml");
  return { path: configPath, added: [], kept: [], alreadySet: [], backupPath: null, text: null, dryRun };
}

/**
 * Write the `AGENTS.md` shell, re-importing whichever user-level context file
 * this one shadows.
 */
export function writeContextShell(agentDir, { pkgRoot = PKG_ROOT, home = os.homedir(), dryRun = false } = {}) {
  const template = readFileSync(path.join(pkgRoot, "templates", "AGENTS.md"), "utf8");

  const shadowed = SHADOWED_CANDIDATES.map(rel => path.join(home, rel)).filter(file => existsSync(file));
  const shadowSection = shadowed.length
    ? [
        "",
        "## 你原有的用户级上下文（被本文件遮蔽，这里按引用接回）",
        "",
        ...shadowed.map(file => `@${toImportToken(file, home)}`),
        "",
      ].join("\n")
    : "";

  const body = template + shadowSection;
  const target = path.join(agentDir, "AGENTS.md");

  let backupPath = null;
  if (!dryRun) {
    mkdirSync(agentDir, { recursive: true });
    backupPath = backup(target);
    writeFileSync(target, body);
  }
  return { path: target, frameworkRule: "rules/iflow-framework.md", shadowed, backupPath, text: body };
}

/** Run both writers. Returns a report the caller renders. */
export function runSetup({ agentDir = resolveAgentDir(), pkgRoot = PKG_ROOT, home = os.homedir(), dryRun = false } = {}) {
  const config = mergeConfig(agentDir, { dryRun });
  const context = writeContextShell(agentDir, { pkgRoot, home, dryRun });
  return { agentDir, config, context, dryRun };
}

/** Render a report as the lines both the CLI and `/sc:setup` print. */
export function formatReport(report) {
  const lines = [
    report.dryRun ? "iflow-zh /sc:setup (dry run)" : "iflow-zh /sc:setup",
    "",
    `agent 目录: ${report.agentDir}`,
    `框架规则:   ${report.context.frameworkRule}（注入主会话与全部 task 子 Agent）`,
    "",
    `设置: ${report.config.path}`,
    "  iflow 不写入任何模型配置（modelRoles / task.agentModelOverrides /",
    "  retry.fallbackChains 全部由你自己的 config.yml 控制，iflow 不创建、",
    "  不覆盖、不删除；旧版 iflow 留下的键原样保留）。",
  ];

  lines.push("", `上下文: ${report.context.path}`);
  if (report.context.backupPath) lines.push(`  备份: ${report.context.backupPath}`);
  lines.push(
    report.context.shadowed.length
      ? `  已按引用接回被遮蔽的 ${report.context.shadowed.length} 份用户级上下文`
      : "  没有检测到被遮蔽的用户级上下文文件",
  );

  lines.push("", "改动要下一个会话才生效：请退出并重新启动 omp。");
  return lines.join("\n");
}

/**
 * Verify whether a live session already has setup applied. iflow seeds no
 * config keys anymore, so the only setup-owned artifact worth checking is the
 * AGENTS.md shell carrying the framework-rule note. Any `modelRoles` /
 * `task.agentModelOverrides` values in the user's config.yml are theirs
 * (possibly left over from an older iflow) and are not validated or touched
 * here.
 */
export function checkApplied({ agentDir = resolveAgentDir(), contextText } = {}) {
  const text = contextText ?? (existsSync(path.join(agentDir, "AGENTS.md"))
    ? readFileSync(path.join(agentDir, "AGENTS.md"), "utf8")
    : "");
  return {
    agentDir,
    hasFrameworkNote: text.includes("iflow-framework.md"),
  };
}

#!/usr/bin/env node
/**
 * Writes the one thing an omp plugin cannot contribute by discovery: the
 * user-level context file. Shared by two callers, which is why this is `.mjs`
 * rather than `.ts` — the extension runs under Bun (TS is fine),
 * `bin/install.mjs` runs under the user's plain Node (no TS loader).
 *
 *   `<agentDir>/AGENTS.md` — AUGMENTED, never replaced. /sc:setup maintains a
 *      marker-delimited iflow block inside the file and leaves every other
 *      (user-authored) byte untouched; a pre-existing AGENTS.md keeps its
 *      content. The framework text is never inlined into a context file:
 *      always-apply rule content is deduped against loaded context files, so a
 *      duplicate here would silently drop one of the two copies — and context
 *      files never reach `task` subagents anyway. The framework travels as the
 *      generated always-apply rule `rules/iflow-framework.md` (see
 *      scripts/build-agents.mjs), which omp injects into every task subagent
 *      (its `agents:` allowlist excludes the main session).
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
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Delimiters for the iflow-managed block inside the user's AGENTS.md. */
const BLOCK_BEGIN = "<!-- iflow-zh:begin (managed by /sc:setup; do not edit inside) -->";
const BLOCK_END = "<!-- iflow-zh:end -->";

/**
 * Sidecar recording what iflow first modified so `npx iflow-zh --uninstall`
 * can restore it: per file, its path, whether it pre-existed, the `.bak` copy,
 * and the sha256 of that copy. Lives beside AGENTS.md; omp never parses it.
 */
const MANIFEST_NAME = ".iflow-setup.json";

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

/**
 * Preserve the user's original AGENTS.md exactly once. The first setup copies
 * it to `${file}.bak`; later runs must not clobber that pristine copy (the
 * managed-block merge already keeps the live file's user content), so an
 * existing backup is returned untouched.
 */
function backup(file) {
  if (!existsSync(file)) return null;
  const bak = `${file}.bak`;
  if (existsSync(bak)) return bak;
  copyFileSync(file, bak);
  return bak;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function manifestPath(agentDir) {
  return path.join(agentDir, MANIFEST_NAME);
}

/** Read the backup manifest, tolerating a missing or corrupt sidecar. */
function readManifest(agentDir) {
  const file = manifestPath(agentDir);
  const empty = { schema: 1, package: "iflow-zh", entries: [] };
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && Array.isArray(parsed.entries)) return { ...empty, ...parsed };
  } catch {
    // A corrupt manifest must never crash setup; treat it as empty.
  }
  return empty;
}

function writeManifest(agentDir, manifest) {
  writeFileSync(manifestPath(agentDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Record — exactly once per target — what setup found before its first write:
 * the file path, whether it pre-existed, its `.bak` copy, and the sha256 of
 * that copy. `uninstall` uses this to locate AND verify the bytes to restore.
 * The first (pristine) record is never overwritten, so a later refresh cannot
 * mistake iflow's own managed block for the user's original content.
 */
function recordBackup(agentDir, { target, existedBefore, backupPath }) {
  const manifest = readManifest(agentDir);
  if (manifest.entries.some((entry) => entry.target === target)) return manifest;
  const hash = backupPath && existsSync(backupPath) ? sha256(readFileSync(backupPath, "utf8")) : null;
  manifest.entries.push({
    target,
    existedBefore,
    backupPath: backupPath ?? null,
    algo: "sha256",
    hash,
    savedAt: new Date().toISOString(),
  });
  writeManifest(agentDir, manifest);
  return manifest;
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

/** Wrap the framework shell + shadow imports in the managed-block markers. */
function buildManagedBlock(template, shadowSection) {
  return `${BLOCK_BEGIN}\n${template.replace(/\s+$/, "")}${shadowSection}\n${BLOCK_END}`;
}

/** The bytes of `existing` that lie outside the managed block (user content). */
function contentOutsideBlock(existing) {
  const begin = existing.indexOf(BLOCK_BEGIN);
  if (begin === -1) return existing;
  const end = existing.indexOf(BLOCK_END, begin);
  if (end === -1) return existing;
  return existing.slice(0, begin) + existing.slice(end + BLOCK_END.length);
}

/**
 * Insert or refresh the managed block WITHOUT touching user content:
 *   - markers present     -> replace only the marked region (inclusive)
 *   - content, no markers -> append the block after a blank-line separator
 *   - empty/absent        -> the block becomes the whole file
 */
function mergeManagedBlock(existing, block) {
  const begin = existing.indexOf(BLOCK_BEGIN);
  if (begin !== -1) {
    const end = existing.indexOf(BLOCK_END, begin);
    if (end !== -1) return existing.slice(0, begin) + block + existing.slice(end + BLOCK_END.length);
  }
  const base = existing.replace(/\s+$/, "");
  return base.length ? `${base}\n\n${block}\n` : `${block}\n`;
}

/**
 * Augment `<agentDir>/AGENTS.md` with the iflow managed block, preserving any
 * pre-existing (user-authored) content. Shadow `@`-imports for other providers'
 * user-level files live inside the block so re-runs refresh them.
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

  const target = path.join(agentDir, "AGENTS.md");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const body = mergeManagedBlock(existing, buildManagedBlock(template, shadowSection));

  const changed = body !== existing;
  const created = existing.length === 0;
  const preservedExisting = contentOutsideBlock(existing).trim().length > 0;

  let backupPath = null;
  if (!dryRun && changed) {
    mkdirSync(agentDir, { recursive: true });
    backupPath = backup(target);
    recordBackup(agentDir, { target, existedBefore: !created, backupPath });
    writeFileSync(target, body);
  }
  return {
    path: target,
    frameworkRule: "rules/iflow-framework.md",
    shadowed,
    backupPath,
    text: body,
    changed,
    created,
    preservedExisting,
  };
}

/** Run both writers. Returns a report the caller renders. */
export function runSetup({ agentDir = resolveAgentDir(), pkgRoot = PKG_ROOT, home = os.homedir(), dryRun = false } = {}) {
  const config = mergeConfig(agentDir, { dryRun });
  const context = writeContextShell(agentDir, { pkgRoot, home, dryRun });
  return { agentDir, config, context, dryRun };
}

/** Render a report as the lines both the CLI and `/sc:setup` print. */
export function formatReport(report) {
  const ctx = report.context;
  const state = !ctx.changed
    ? "已是最新（未改动）"
    : ctx.created
      ? "已新建（仅含 iflow 托管区块）"
      : "已刷新其中的 iflow 托管区块";
  const lines = [
    report.dryRun ? "iflow-zh /sc:setup (dry run)" : "iflow-zh /sc:setup",
    "",
    `agent 目录: ${report.agentDir}`,
    `框架规则:   ${ctx.frameworkRule}（注入全部 task 子 Agent；主会话不加载）`,
    "",
    `设置: ${report.config.path}`,
    "  iflow 不写入任何模型配置（modelRoles / task.agentModelOverrides /",
    "  retry.fallbackChains 全部由你自己的 config.yml 控制，iflow 不创建、",
    "  不覆盖、不删除；旧版 iflow 留下的键原样保留）。",
  ];

  lines.push("", `上下文: ${ctx.path}`);
  lines.push(`  ${state}：iflow 仅维护标记界定的托管区块，绝不替换你已有的内容。`);
  if (ctx.preservedExisting) lines.push("  已保留文件中你原有的内容。");
  if (ctx.backupPath) lines.push(`  首次改动前的备份: ${ctx.backupPath}（后续运行不覆盖）`);
  lines.push(
    ctx.shadowed.length
      ? `  已按引用接回被遮蔽的 ${ctx.shadowed.length} 份用户级上下文`
      : "  没有检测到被遮蔽的用户级上下文文件",
  );
  lines.push("  卸载并恢复原文件：npx iflow-zh --uninstall（依据备份清单还原）");

  lines.push("", "改动要下一个会话才生效：请退出并重新启动 omp。");
  return lines.join("\n");
}

/**
 * Verify whether a live session already has setup applied. The setup-owned
 * artifact is the marker-delimited iflow block in AGENTS.md; its begin marker
 * (or, for blocks written by older versions, the framework-rule reference) is
 * the signal. Anything else in the file is the user's and is not inspected.
 */
export function checkApplied({ agentDir = resolveAgentDir(), contextText } = {}) {
  const text = contextText ?? (existsSync(path.join(agentDir, "AGENTS.md"))
    ? readFileSync(path.join(agentDir, "AGENTS.md"), "utf8")
    : "");
  return {
    agentDir,
    hasFrameworkNote: text.includes(BLOCK_BEGIN) || text.includes("iflow-framework.md"),
  };
}

/**
 * Reverse `runSetup`, using the backup manifest as the source of truth. For
 * each recorded target:
 *   - existed before iflow -> restore its `.bak`, but only after the copy's
 *     sha256 matches the recorded hash (a mismatch means the backup was altered,
 *     so refuse rather than write suspect bytes);
 *   - created by iflow     -> pre-install state was "no file", so strip the
 *     managed block and, if nothing the user later added remains, remove it.
 * Handled entries are dropped from the manifest; the sidecar is deleted once
 * empty, and a consumed `.bak` is removed.
 */
export function uninstall({ agentDir = resolveAgentDir(), dryRun = false } = {}) {
  const file = manifestPath(agentDir);
  const manifest = readManifest(agentDir);
  const manifestFound = existsSync(file) && manifest.entries.length > 0;
  const results = [];
  const remaining = [];
  for (const entry of manifest.entries) {
    const outcome = restoreEntry(entry, { dryRun });
    results.push(outcome);
    if (!outcome.done) remaining.push(entry);
  }
  if (!dryRun && manifestFound) {
    if (remaining.length === 0) rmSync(file);
    else writeManifest(agentDir, { ...manifest, entries: remaining });
  }
  return { agentDir, manifestPath: file, manifestFound, results, dryRun };
}

/** Restore or clear a single manifest entry. Never throws on a missing file. */
function restoreEntry(entry, { dryRun }) {
  const { target } = entry;
  if (entry.existedBefore) {
    if (!entry.backupPath || !existsSync(entry.backupPath)) {
      return { target, action: "restore", done: false, reason: "backup-missing", backupPath: entry.backupPath ?? null };
    }
    const content = readFileSync(entry.backupPath, "utf8");
    const actual = sha256(content);
    if (entry.hash && actual !== entry.hash) {
      return { target, action: "restore", done: false, reason: "hash-mismatch", expected: entry.hash, actual };
    }
    if (!dryRun) {
      writeFileSync(target, content);
      rmSync(entry.backupPath);
    }
    return { target, action: "restore", done: true, backupPath: entry.backupPath };
  }
  if (!existsSync(target)) return { target, action: "remove", done: true, note: "already-absent" };
  const rest = contentOutsideBlock(readFileSync(target, "utf8")).trim();
  if (rest.length === 0) {
    if (!dryRun) rmSync(target);
    return { target, action: "remove", done: true };
  }
  if (!dryRun) writeFileSync(target, `${rest}\n`);
  return { target, action: "strip", done: true, note: "kept-user-content" };
}

/** Render the uninstall report the CLI prints. */
export function formatUninstallReport(report) {
  const short = (hash) => (typeof hash === "string" ? `${hash.slice(0, 12)}…` : "?");
  const lines = [
    report.dryRun ? "iflow-zh 卸载（dry run，未写入）" : "iflow-zh 卸载",
    "",
    `agent 目录: ${report.agentDir}`,
  ];
  if (!report.manifestFound) {
    lines.push("", `未找到 iflow 备份清单（${MANIFEST_NAME}）：没有需要恢复的文件。`);
    return lines.join("\n");
  }
  lines.push("", `备份清单: ${report.manifestPath}`);
  for (const r of report.results) {
    if (r.action === "restore" && r.done) {
      lines.push(`✔ 已恢复: ${r.target}`, `    ← 备份 ${r.backupPath}（sha256 校验通过，已移除备份）`);
    } else if (r.reason === "backup-missing") {
      lines.push(`✘ 未恢复: ${r.target}`, `    备份文件缺失: ${r.backupPath ?? "（清单未记录）"}`);
    } else if (r.reason === "hash-mismatch") {
      lines.push(`✘ 未恢复: ${r.target}`, "    备份 sha256 与清单不符（疑似被改动），已跳过。", `    期望 ${short(r.expected)} 实得 ${short(r.actual)}`);
    } else if (r.action === "remove" && r.note === "already-absent") {
      lines.push(`· 无需处理: ${r.target}（文件已不存在）`);
    } else if (r.action === "remove") {
      lines.push(`✔ 已删除: ${r.target}（安装前不存在此文件）`);
    } else if (r.action === "strip") {
      lines.push(`✔ 已移除托管区块: ${r.target}`, "    （检测到你后来添加的内容，已保留）");
    }
  }
  if (!report.dryRun) {
    lines.push("", "AGENTS.md 已按备份还原；随后从 omp 移除插件：omp plugin uninstall iflow-zh");
  }
  return lines.join("\n");
}

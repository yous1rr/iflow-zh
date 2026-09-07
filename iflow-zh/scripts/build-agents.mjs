#!/usr/bin/env node
/**
 * Generates the build outputs of the iflow-zh plugin package from `.iflow/`,
 * which stays the single source of truth. Two directories and one rule are
 * generated and must never be hand-edited:
 *
 *   agents/     <- .iflow/agents/**.md, frontmatter adapted for omp task agents
 *   framework/  <- .iflow/commands/sc/*.md (command bodies)
 *   rules/iflow-framework.md <- the `@` import chain reachable from
 *                  .iflow/IFLOW.md rendered as one always-apply rule scoped to
 *                  task subagents, never the main dispatcher, so subagents
 *                  receive the full framework configuration (omp filters
 *                  context files out of subagents, rules are forwarded)
 *
 * Frontmatter adaptation (inherited from the previous scripts/sync-omp-agents.mjs):
 *
 *   kept:    name, description, model (Role aliases only; a thinking-depth
 *            suffix like `@slow:high` passes ROLE_MODEL and is preserved
 *            verbatim — omp expands it natively)
 *   added:   spawns: "*" for the omni coordinator agent
 *   dropped: category / tools (personas inherit all tools), when-to-use,
 *            mcp-servers, agent-type, concrete model selectors, color,
 *            allowed-tools/-mcps, capabilities, inherit-* and any other
 *            Claude-specific keys
 *
 * After writing, two assertions run. Each failure exits non-zero, because a
 * dangling agent name that only surfaces at runtime costs a user a broken
 * `task` call, while a build failure costs nobody anything:
 *
 *   1. every `@` import in the chain resolves to a real file
 *   2. every agent name referenced by TASK_ROUTES in extension/iflow.ts
 *      exists (package agent or omp builtin)
 *
 * Note: templates/config.patch.yml no longer carries a
 * `task.agentModelOverrides` block — iflow seeds no model/role mappings
 * (they stay user-owned in config.yml), so there is nothing to cross-check
 * here anymore.
 *
 * Run from anywhere: node iflow-zh/scripts/build-agents.mjs
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(PKG, "..");
const IFLOW = path.join(ROOT, ".iflow");
const SRC_AGENTS = path.join(IFLOW, "agents");
const SRC_COMMANDS = path.join(IFLOW, "commands", "sc");
const DEST_AGENTS = path.join(PKG, "agents");
const DEST_FRAMEWORK = path.join(PKG, "framework");
const DEST_COMMANDS = path.join(DEST_FRAMEWORK, "commands", "sc");

/** omp ships these; they are legal `task` targets without a package file. */
const BUILTIN_AGENTS = ["scout", "reviewer", "security-reviewer", "task", "sonic"];

/** omp resolves at most five hops of `@` imports (omp://context-files.md:160-167). */
const MAX_IMPORT_DEPTH = 5;

const ROLE_MODEL = /^@[A-Za-z0-9_-]+(?::(?:minimal|low|medium|high|xhigh|max))?$/;

const failures = [];

function fail(headline, names) {
  failures.push({ headline, names });
}

function collectAgentFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectAgentFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function splitFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { fm: {}, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: normalized };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "");
  const fm = {};
  for (const line of header.split("\n")) {
    if (/^\s*-/.test(line)) continue; // list item -> part of a dropped key
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    fm[key] = value.replace(/^['"]|['"]$/g, "").trim();
  }
  return { fm, body };
}

function convertAgent(file) {
  const { fm, body } = splitFrontmatter(readFileSync(file, "utf8"));
  if (!fm.name || !fm.description) {
    throw new Error(`${file}: agent frontmatter must define both name and description`);
  }
  const lines = ["---", `name: ${fm.name}`];
  // Always double-quote descriptions: deterministic YAML regardless of
  // colons, percent signs, emoji or other indicator characters inside.
  const escapedDescription = fm.description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  lines.push(`description: "${escapedDescription}"`);
  if (typeof fm.model === "string" && ROLE_MODEL.test(fm.model)) {
    lines.push(`model: "${fm.model}"`);
  }
  if (fm.name === "universal-omni-agent-v8") lines.push('spawns: "*"');
  lines.push("---", "");
  return { name: fm.name, text: lines.join("\n") + body.replace(/\n*$/, "\n") };
}

function buildAgents() {
  rmSync(DEST_AGENTS, { recursive: true, force: true });
  mkdirSync(DEST_AGENTS, { recursive: true });
  const names = [];
  const writtenBy = new Map();
  for (const file of collectAgentFiles(SRC_AGENTS)) {
    const base = path.basename(file);
    // omp's agent directories are flat, so a recursive source tree with two
    // same-named files would silently drop one definition.
    const clash = writtenBy.get(base);
    if (clash) throw new Error(`${file}: flattens onto the same name as ${clash}`);
    writtenBy.set(base, file);
    const { name, text } = convertAgent(file);
    writeFileSync(path.join(DEST_AGENTS, base), text);
    names.push(name);
  }
  return names;
}

/**
 * Walks the `@` import chain from IFLOW.md the way omp does, and returns every
 * file that has to travel with the package. A missing target is a build
 * failure here; omp itself would leave the bare `@token` in the prompt.
 */
function collectChainFiles() {
  const chain = [];
  const seen = new Set();
  const walk = (file, depth) => {
    const rel = path.relative(IFLOW, file);
    if (seen.has(rel)) return;
    seen.add(rel);
    chain.push(rel);
    if (depth >= MAX_IMPORT_DEPTH) return;
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      fail("chain imports a file that does not exist:", [rel]);
      return;
    }
    for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
      const match = /^@([A-Za-z0-9._/-]+\.md)\s*$/.exec(line.trim());
      if (!match) continue;
      walk(path.resolve(path.dirname(file), match[1]), depth + 1);
    }
  };
  walk(path.join(IFLOW, "IFLOW.md"), 0);
  return chain;
}

function buildFramework() {
  const chain = collectChainFiles();
  rmSync(DEST_FRAMEWORK, { recursive: true, force: true });
  mkdirSync(DEST_COMMANDS, { recursive: true });
  const commands = readdirSync(SRC_COMMANDS).filter((entry) => entry.endsWith(".md")).sort();
  for (const entry of commands) {
    copyFileSync(path.join(SRC_COMMANDS, entry), path.join(DEST_COMMANDS, entry));
  }
  return { chain, commands };
}

/**
 * Renders the framework chain as the always-apply rule `rules/iflow-framework.md`.
 * Context files (`AGENTS.md` and friends) never reach `task` subagents — omp
 * filters them out by file name — but rules are forwarded, so this is the
 * channel that gives every subagent the full framework configuration. The
 * `agents` allowlist scopes the rule to task subagents and keeps it out of the
 * main dispatcher session: omp matches those globs against the session's agent
 * name (`main` is reserved for the top-level session, a named subagent
 * evaluates as its definition name, an unnamed one as `sub`), and the matcher
 * is a pure allowlist without negation, so "every task subagent, never main"
 * must enumerate the roster — `sub` plus every agent definition name this
 * package ships or routes to. IFLOW.md's entry boilerplate and every `@` import
 * line stay out; the downstream files are inlined in chain order, CRLF
 * normalized, parts separated by blank lines.
 */
function buildAgentConfigRule(chain, agentNames) {
  const agentRoster = ["sub", ...new Set([...agentNames, ...BUILTIN_AGENTS].sort())].join(", ");
  const frontmatter = ["---", "alwaysApply: true", `agents: [${agentRoster}]`, "---"].join("\n");
  const note = [
    "# iflow V8 — 完整框架配置（构建产物，勿手改）",
    "",
    "由 scripts/build-agents.mjs 从 .iflow/ 导入链生成（FLAGS → RULES → 五个行为模式）。",
    "omp 将本规则注入全部 task 子 Agent（`agents:` 白名单枚举，主会话不加载本规则）；调度者指令在 rules/iflow-dispatch.md，仅主会话。",
  ].join("\n");
  const parts = chain
    .filter((rel) => rel !== "IFLOW.md")
    .map((rel) =>
      readFileSync(path.join(IFLOW, rel), "utf8")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((line) => !/^@[A-Za-z0-9._/-]+\.md\s*$/.test(line.trim()))
        .join("\n")
        .trim(),
    );
  writeFileSync(path.join(PKG, "rules", "iflow-framework.md"), [frontmatter, note, ...parts].join("\n\n") + "\n");
}

/** Collects the `agent:` values of TASK_ROUTES in the packaged extension. */
function readRoutedAgents() {
  const file = path.join(PKG, "extension", "iflow.ts");
  const source = readFileSync(file, "utf8");
  const start = source.indexOf("const TASK_ROUTES");
  if (start === -1) throw new Error(`${file}: no TASK_ROUTES declaration`);
  const end = source.indexOf("\n];", start);
  if (end === -1) throw new Error(`${file}: unterminated TASK_ROUTES declaration`);
  const agents = [...source.slice(start, end).matchAll(/agent:\s*"([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  if (!agents.length) throw new Error(`${file}: TASK_ROUTES declares no agents`);
  return agents;
}

const agentNames = buildAgents();
const { chain, commands } = buildFramework();
buildAgentConfigRule(chain, agentNames);

const referenced = new Set([...readRoutedAgents()]);
const known = new Set([...agentNames, ...BUILTIN_AGENTS]);

const dangling = [...referenced].filter((name) => !known.has(name)).sort();
if (dangling.length) {
  fail("referenced agent names that no definition provides:", dangling);
}

// NOTE: the former "every agent has a Role mapping or a routing rule"
// assertion is gone with the config.patch.yml override block: iflow seeds no
// role mappings, so an agent may be reachable by name (omp task-agent
// discovery) without appearing in TASK_ROUTES — that is fine.

if (failures.length) {
  for (const { headline, names } of failures) {
    console.error(`build-agents: ${headline}`);
    for (const name of names) console.error(`  - ${name}`);
  }
  process.exit(1);
}

console.log(
  `build-agents: ${agentNames.length} agents, ${chain.length} chain files, 1 rule, ${commands.length} commands`,
);

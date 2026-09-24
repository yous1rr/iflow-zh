#!/usr/bin/env node
/**
 * `npx iflow-zh` — the one-command install path.
 *
 * Two steps, in this order:
 *   1. `omp plugin install iflow-zh@<this version>` — lets omp own the plugin
 *      root (it runs `bun install` there). We deliberately do NOT
 *      `omp plugin link` this npx cache directory: npm may reclaim it, and omp
 *      would be left with a dangling symlink whose symptom is "all /sc:*
 *      commands vanished one day".
 *   2. `setup.mjs` against the freshly installed root, because a plugin cannot
 *      contribute settings or a context file by discovery.
 *
 * Step 2 must target the INSTALLED copy, not this cache directory, so the `@`
 * import in `AGENTS.md` points at a path that survives cache eviction.
 *
 * `--uninstall` reverses both steps: it restores each file from the backup
 * manifest written at setup time (located by path, verified by sha256), then
 * `omp plugin uninstall`s the plugin.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
const spec = `${manifest.name}@${manifest.version}`;

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

// `--uninstall` reverses a prior `npx iflow-zh`: restore files from the backup
// manifest (via the local setup.mjs — restoration reads only the agent dir, so
// it does not need the installed plugin root), then remove the plugin from omp.
const argv = process.argv.slice(2);
if (argv.includes("--uninstall") || argv.includes("-u")) {
  const dryRun = argv.includes("--dry-run") || argv.includes("-n");
  const setupUrl = pathToFileURL(path.join(PKG_ROOT, "extension", "setup.mjs")).href;
  const { uninstall, formatUninstallReport } = await import(setupUrl);
  const agentDir = capture("omp", ["config", "path"]);
  try {
    console.log(formatUninstallReport(uninstall(agentDir ? { agentDir, dryRun } : { dryRun })));
  } catch (error) {
    console.error(`iflow-zh: 恢复备份失败：${error instanceof Error ? error.message : error}`);
  }
  console.log(`iflow-zh: removing ${manifest.name} from omp`);
  const pluginArgs = ["plugin", "uninstall", manifest.name];
  if (dryRun) pluginArgs.push("--dry-run");
  const status = run("omp", pluginArgs);
  if (status !== 0) {
    console.error(
      "iflow-zh: `omp plugin uninstall` failed (plugin may not be installed, or omp is not on PATH).",
    );
    process.exit(status);
  }
  process.exit(0);
}

console.log(`iflow-zh: installing ${spec} into omp's plugin root`);
const installStatus = run("omp", ["plugin", "install", spec]);
if (installStatus !== 0) {
  console.error(
    "iflow-zh: `omp plugin install` failed. Is omp on PATH? " +
      "Install it first, then re-run `npx iflow-zh`.",
  );
  process.exit(installStatus);
}

/**
 * Locate the installed root. `omp plugin list --json` is authoritative — the
 * plugins dir can be XDG-redirected on Linux/macOS, so the layout probe below
 * is only a fallback. Its shape is buckets keyed by source
 * (`{ npm: [{ name, version, path, ... }], ... }`), so walk every array value
 * rather than assuming one key. The call is retried once: the CLI occasionally
 * aborts under Bun before producing output.
 */
function resolveInstalledRoot(agentDir) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const listed = capture("omp", ["plugin", "list", "--json"]);
    if (!listed) continue;
    try {
      const parsed = JSON.parse(listed);
      const buckets = Array.isArray(parsed) ? [parsed] : Object.values(parsed).filter(Array.isArray);
      for (const bucket of buckets) {
        for (const entry of bucket) {
          if (entry?.name !== manifest.name) continue;
          if (typeof entry.path === "string" && existsSync(entry.path)) return entry.path;
        }
      }
    } catch {
      // fall through to the layout probe
    }
  }
  const configRoot = path.dirname(agentDir);
  const candidate = path.join(configRoot, "plugins", "node_modules", manifest.name);
  return existsSync(candidate) ? candidate : null;
}

const agentDirOut = capture("omp", ["config", "path"]);
if (!agentDirOut) {
  console.error("iflow-zh: could not read `omp config path` — run /sc:setup inside omp instead.");
  process.exit(1);
}

const installedRoot = resolveInstalledRoot(agentDirOut);
if (!installedRoot) {
  console.error(
    `iflow-zh: installed ${spec}, but could not locate its plugin root. ` +
      "Start omp and run /sc:setup to finish.",
  );
  process.exit(1);
}

// Windows rejects a bare absolute path in dynamic import ("C:\…" parses as a
// protocol), so always hand it a file:// URL.
const setupUrl = pathToFileURL(path.join(installedRoot, "extension", "setup.mjs")).href;
const { runSetup, formatReport } = await import(setupUrl);
console.log(formatReport(runSetup({ agentDir: agentDirOut, pkgRoot: installedRoot })));

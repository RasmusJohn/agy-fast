#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PLUGIN_NAME = "agy-fast";

const RUNTIME_FILES = [
  "plugin.json",
  "mcp_config.json",
  "hooks.json",
  "rules/AGENTS.md",
  "assets/logo.svg",
  "dist/mcp-server.mjs",
  "dist/session-start.mjs",
  "dist/benchmark.mjs",
  "scripts/install.mjs",
  "LICENSE",
];

const OPTIONAL_DOC_FILES = [
  "README.md",
  "README.zh-CN.md",
  "docs/ANALYSIS_REPORT.md",
  "docs/ANALYSIS_REPORT.zh-CN.md",
];

function getGlobalPluginDir() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".gemini", "config", "plugins", PLUGIN_NAME);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = "install";
  let targetDir = "";
  let projectDir = "";
  let useLink = false;
  let skipEnable = false;
  let quiet = false;
  let showHelp = false;

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      showHelp = true;
    } else if (a === "--link") {
      useLink = true;
    } else if (a === "--no-enable") {
      skipEnable = true;
    } else if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else if (a === "--target") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing directory path after --target");
      }
      targetDir = path.resolve(args[++i]);
    } else if (a === "--project") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        projectDir = path.resolve(args[++i]);
      } else {
        projectDir = process.cwd();
      }
    } else if (!a.startsWith("-")) {
      positional.push(a);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  if (positional.length > 1) {
    throw new Error(
      `Unexpected extra argument: '${positional[1]}'. Run with --help for usage.`,
    );
  }
  if (positional.length === 1) {
    command = positional[0];
  }

  const isCustomTarget = Boolean(targetDir);
  if (!targetDir) {
    targetDir = projectDir
      ? path.join(projectDir, ".agents", "plugins", PLUGIN_NAME)
      : getGlobalPluginDir();
  }

  return {
    command,
    targetDir,
    isProject: Boolean(projectDir),
    isCustomTarget,
    useLink,
    skipEnable,
    quiet,
    showHelp,
  };
}

function printHelp() {
  console.log(`agy-fast installer

Usage:
  node scripts/install.mjs [command] [options]

Commands:
  install      Install agy-fast plugin (default)
  uninstall    Remove installed agy-fast plugin
  status       Check installation and run live health checks
  doctor       Alias for status

Options:
  --project [dir]   Install into <dir>/.agents/plugins/agy-fast instead of global
  --target <dir>    Install into a custom plugin directory
  --link            Create a symlink to this repository (for local development)
  --no-enable       Skip running 'agy plugin enable agy-fast'
  -h, --help        Show this help
`);
}

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  if (major < 20) {
    throw new Error(
      `Node.js >= 20 is required (current version: v${process.versions.node})`,
    );
  }
  return process.versions.node;
}

function hasCommand(bin, args = ["--version"]) {
  const res = spawnSync(bin, args, {
    stdio: "ignore",
    timeout: 3000,
    windowsHide: true,
  });
  return !res.error && res.status === 0;
}

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function verifyMcpServerLive(mcpScriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MCP server smoke test timed out after 5s"));
    }, 5000);
    timer.unref();

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) {
        reject(
          new Error(
            `MCP server returned incomplete response (exit ${code}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      try {
        const initResp = JSON.parse(lines[0]);
        const listResp = JSON.parse(lines[1]);
        const tools = listResp?.result?.tools;
        if (!initResp?.result?.serverInfo || !Array.isArray(tools)) {
          reject(new Error("Invalid MCP JSON-RPC responses"));
          return;
        }
        resolve({
          protocolVersion: initResp.result.protocolVersion,
          tools: tools.map((t) => t.name),
        });
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "agy-fast-doctor", version: "1.0" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
    );
    child.stdin.end();
  });
}

async function verifySessionStartLive(hookScriptPath, sampleWorkspace) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("SessionStart hook smoke test timed out after 5s"));
    }, 5000);
    timer.unref();

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`SessionStart hook exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const msg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        resolve({
          durationMs: Date.now() - start,
          bytes: Buffer.byteLength(msg, "utf8"),
        });
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.end(
      JSON.stringify({
        cwd: sampleWorkspace,
        workspacePaths: [sampleWorkspace],
        hookEventName: "SessionStart",
      }),
    );
  });
}

async function assertSourceFilesPresent(srcRoot) {
  for (const rel of RUNTIME_FILES) {
    const src = path.join(srcRoot, rel);
    if (!(await pathExists(src))) {
      throw new Error(
        `Missing required file: ${rel}. Run 'npm run build' first if installing from source.`,
      );
    }
  }
}

async function copyRuntimeFiles(srcRoot, dstRoot) {
  await assertSourceFilesPresent(srcRoot);
  await fs.mkdir(dstRoot, { recursive: true });
  const toCopy = [...RUNTIME_FILES];
  for (const opt of OPTIONAL_DOC_FILES) {
    if (await pathExists(path.join(srcRoot, opt))) {
      toCopy.push(opt);
    }
  }
  for (const rel of toCopy) {
    const src = path.join(srcRoot, rel);
    const dst = path.join(dstRoot, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }
}

async function runDoctor(targetDir, quiet = false) {
  const nodeVer = checkNodeVersion();
  const hasRg = hasCommand("rg", ["--version"]);
  const hasAgy = hasCommand("agy", ["--version"]);
  const exists = await pathExists(targetDir);

  const report = {
    nodeVersion: nodeVer,
    ripgrep: hasRg,
    agyCli: hasAgy,
    targetDir,
    installed: exists,
    mcpTools: [],
    hookLatencyMs: null,
    hookBytes: null,
    agyValidated: null,
  };

  if (!exists) {
    if (!quiet) {
      console.log(`agy-fast is not installed at: ${targetDir}`);
    }
    return { ok: false, report };
  }

  const mcpPath = path.join(targetDir, "dist", "mcp-server.mjs");
  const hookPath = path.join(targetDir, "dist", "session-start.mjs");
  const mcpCheck = await verifyMcpServerLive(mcpPath);
  const hookCheck = await verifySessionStartLive(hookPath, targetDir);

  report.mcpTools = mcpCheck.tools;
  report.hookLatencyMs = hookCheck.durationMs;
  report.hookBytes = hookCheck.bytes;

  if (hasAgy) {
    const valRes = spawnSync("agy", ["plugin", "validate", "--strict", targetDir], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    report.agyValidated = !valRes.error && valRes.status === 0;
  }

  if (!quiet) {
    console.log("agy-fast health check:");
    console.log(`  - Plugin path : ${targetDir}`);
    console.log(`  - Node.js     : v${nodeVer} (OK)`);
    console.log(
      `  - ripgrep (rg): ${hasRg ? "available (fast search active)" : "not found (automatic Node.js fallback active)"}`,
    );
    console.log(
      `  - MCP server  : OK (${mcpCheck.tools.length} tools: ${mcpCheck.tools.join(", ")})`,
    );
    console.log(
      `  - SessionStart: ${hookCheck.bytes > 0 ? "OK" : "EMPTY (FAILED)"} (${hookCheck.durationMs}ms, ${hookCheck.bytes} bytes)`,
    );
    if (hasAgy) {
      console.log(
        `  - agy validate: ${report.agyValidated ? "PASSED (--strict)" : "FAILED"}`,
      );
    }
  }

  const ok =
    mcpCheck.tools.length === 4 &&
    hookCheck.bytes > 0 &&
    (report.agyValidated === null || report.agyValidated === true);
  return { ok, report };
}

async function runInstall(opts) {
  checkNodeVersion();

  const resolvedSrc = path.resolve(REPO_ROOT);
  const resolvedDst = path.resolve(opts.targetDir);
  const sameDirectory = resolvedSrc === resolvedDst;

  await assertSourceFilesPresent(resolvedSrc);

  if (sameDirectory) {
    if (!opts.quiet) {
      console.log(`Repository is already at target plugin directory: ${resolvedDst}`);
    }
  } else if (opts.useLink) {
    await fs.mkdir(path.dirname(resolvedDst), { recursive: true });
    if (await pathExists(resolvedDst)) {
      await fs.rm(resolvedDst, { recursive: true, force: true });
    }
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(resolvedSrc, resolvedDst, linkType);
    if (!opts.quiet) {
      console.log(`Linked ${resolvedDst} -> ${resolvedSrc}`);
    }
  } else {
    // Preserve clean target directory when re-installing / upgrading
    if (await pathExists(resolvedDst)) {
      await fs.rm(resolvedDst, { recursive: true, force: true });
    }
    await copyRuntimeFiles(resolvedSrc, resolvedDst);
    if (!opts.quiet) {
      console.log(`Installed agy-fast to ${resolvedDst}`);
    }
  }

  const hasAgy = hasCommand("agy", ["--version"]);
  const isGlobalTarget = !opts.isProject && !opts.isCustomTarget;
  if (hasAgy && !opts.skipEnable && isGlobalTarget) {
    const enableRes = spawnSync("agy", ["plugin", "enable", PLUGIN_NAME], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (!opts.quiet) {
      if (!enableRes.error && enableRes.status === 0) {
        console.log(`Enabled plugin '${PLUGIN_NAME}' via agy CLI.`);
      } else {
        console.log(
          `Note: could not auto-enable via 'agy plugin enable ${PLUGIN_NAME}'. Enable it in Antigravity Customizations UI.`,
        );
      }
    }
  }

  const { ok } = await runDoctor(resolvedDst, opts.quiet);
  if (!ok) {
    throw new Error("Post-install health check failed.");
  }

  if (!opts.quiet) {
    console.log("");
    console.log("Installation complete. Next steps:");
    console.log("  - Antigravity CLI (agy)    : Start a new session to activate agy-fast.");
    console.log("  - Antigravity Desktop / IDE: Open Customizations -> Installed and ensure 'agy-fast' is enabled.");
  }
}

async function runUninstall(opts) {
  const resolvedDst = path.resolve(opts.targetDir);
  if (!(await pathExists(resolvedDst))) {
    if (!opts.quiet) {
      console.log(`Nothing to remove (${resolvedDst} does not exist).`);
    }
    return;
  }

  const isSourceRepo =
    path.resolve(REPO_ROOT) === resolvedDst &&
    (await pathExists(path.join(REPO_ROOT, "src")));
  if (isSourceRepo) {
    throw new Error(
      `Refusing to delete the active source repository at ${resolvedDst}. Remove it manually if desired.`,
    );
  }

  const isGlobalTarget = !opts.isProject && !opts.isCustomTarget;
  if (hasCommand("agy", ["--version"]) && !opts.skipEnable && isGlobalTarget) {
    spawnSync("agy", ["plugin", "disable", PLUGIN_NAME], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
  }

  await fs.rm(resolvedDst, { recursive: true, force: true });
  if (!opts.quiet) {
    console.log(`Removed agy-fast from ${resolvedDst}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.showHelp) {
    printHelp();
    return;
  }

  switch (opts.command) {
    case "install":
      await runInstall(opts);
      break;
    case "uninstall":
      await runUninstall(opts);
      break;
    case "status":
    case "doctor": {
      const { ok } = await runDoctor(opts.targetDir, opts.quiet);
      if (!ok) process.exitCode = 1;
      break;
    }
    default:
      throw new Error(`Unknown command: ${opts.command}. Run with --help for usage.`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

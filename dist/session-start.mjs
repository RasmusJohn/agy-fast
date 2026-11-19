// agy-fast SessionStart Hook (bundled zero-dependency ESM)


// src/utils/snapshot.ts
import { promises as fs } from "node:fs";
import path from "node:path";

// src/utils/exec-utils.ts
import { spawn } from "node:child_process";
var DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
function killChildTree(pid, detached) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.unref();
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    }
    return;
  }
  try {
    if (detached) {
      process.kill(-pid, "SIGTERM");
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
  }
  setTimeout(() => {
    try {
      if (detached) {
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
    }
  }, 400).unref();
}
function execBinaryAsync(bin, args, options) {
  return spawnAndCollect(bin, args, false, options);
}
function spawnAndCollect(commandOrBin, args, shell, options) {
  const startMs = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const detached = process.platform !== "win32";
  return new Promise((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    let child;
    try {
      child = spawn(commandOrBin, args, {
        cwd: options.cwd,
        shell,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startMs,
        stdout: "",
        stderr: "",
        truncated: false,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    let settleFallbackTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child.pid, detached);
      settleFallbackTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, "SIGKILL");
      }, 1500);
      settleFallbackTimer.unref();
    }, Math.max(100, options.timeoutMs));
    timer.unref();
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startMs,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        truncated,
        error
      });
    };
    child.stdout?.on("data", (chunk) => {
      if (stdoutBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - stderrBytes;
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        truncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.on("error", (err) => {
      finish(null, null, err.message);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

// src/utils/fs-utils.ts
var DEFAULT_IGNORE_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  "vendor"
]);

// src/utils/snapshot.ts
async function getGitSummary(workspaceDir, timeoutMs) {
  const [branchRes, symRefRes, statusRes, logRes] = await Promise.all([
    execBinaryAsync("git", ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 4096
    }),
    execBinaryAsync("git", ["--no-optional-locks", "symbolic-ref", "--short", "HEAD"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 4096
    }),
    execBinaryAsync("git", ["--no-optional-locks", "status", "--porcelain=v1"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 32768
    }),
    execBinaryAsync("git", ["--no-optional-locks", "log", "-n", "3", "--format=%h %s"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 8192
    })
  ]);
  const hasValidRepo = !branchRes.error && branchRes.exitCode === 0 || !symRefRes.error && symRefRes.exitCode === 0 || !statusRes.error && statusRes.exitCode === 0;
  if (!hasValidRepo) {
    return null;
  }
  const branch = branchRes.exitCode === 0 && branchRes.stdout.trim() || symRefRes.exitCode === 0 && symRefRes.stdout.trim() || "HEAD";
  const isUnborn = branchRes.exitCode !== 0 && symRefRes.exitCode === 0;
  const statusLines = statusRes.exitCode === 0 ? statusRes.stdout.split(/\r?\n/).filter((l) => {
    const trimmed = l.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("?? ")) {
      const topSeg = trimmed.slice(3).split("/")[0]?.replace(/\/$/, "");
      if (topSeg && DEFAULT_IGNORE_DIRS.has(topSeg)) return false;
    }
    return true;
  }) : [];
  const logLines = logRes.exitCode === 0 ? logRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const parts = [
    isUnborn ? `Git: branch \`${branch}\` (unborn, no commits yet)` : `Git: branch \`${branch}\``
  ];
  if (statusLines.length === 0) {
    parts.push("Working tree: clean");
  } else {
    const shown = statusLines.slice(0, 20).map((l) => l.trim());
    const more = statusLines.length > 20 ? ` (+${statusLines.length - 20} more)` : "";
    parts.push(`Modified (${statusLines.length}): ${shown.join(", ")}${more}`);
  }
  if (logLines.length > 0) {
    parts.push(
      `Recent commits:
${logLines.map((l) => `  - ${l.slice(0, 90)}`).join("\n")}`
    );
  }
  return parts.join("\n");
}
async function getTwoLevelTree(workspaceDir) {
  let topEntries;
  try {
    topEntries = await fs.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const filteredTop = topEntries.filter((e) => {
    if (e.name === ".DS_Store") return false;
    if (e.isDirectory() && DEFAULT_IGNORE_DIRS.has(e.name)) return false;
    return true;
  }).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (filteredTop.length === 0) return null;
  const lines = [];
  const maxTop = 20;
  const shownTop = filteredTop.slice(0, maxTop);
  const subResults = await Promise.all(
    shownTop.map(async (entry) => {
      if (!entry.isDirectory()) {
        return { name: entry.name, isDir: false, children: [], more: 0 };
      }
      try {
        const sub = await fs.readdir(path.join(workspaceDir, entry.name), {
          withFileTypes: true
        });
        const valid = sub.filter(
          (s) => s.name !== ".DS_Store" && !(s.isDirectory() && DEFAULT_IGNORE_DIRS.has(s.name))
        ).sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const maxSub = 8;
        const children = valid.slice(0, maxSub).map((s) => s.isDirectory() ? `${s.name}/` : s.name);
        return {
          name: `${entry.name}/`,
          isDir: true,
          children,
          more: Math.max(0, valid.length - maxSub)
        };
      } catch {
        return { name: `${entry.name}/`, isDir: true, children: [], more: 0 };
      }
    })
  );
  for (const item of subResults) {
    if (!item.isDir || item.children.length === 0) {
      lines.push(`  ${item.name}`);
    } else {
      const more = item.more > 0 ? `, +${item.more}` : "";
      lines.push(`  ${item.name} (${item.children.join(", ")}${more})`);
    }
  }
  if (filteredTop.length > maxTop) {
    lines.push(`  ... (+${filteredTop.length - maxTop} more top-level entries)`);
  }
  return `Layout (2 levels):
${lines.join("\n")}`;
}
async function getProjectManifestSummary(workspaceDir) {
  const hints = [];
  await Promise.all([
    // package.json
    (async () => {
      try {
        const raw = await fs.readFile(path.join(workspaceDir, "package.json"), "utf8");
        const pkg = JSON.parse(raw);
        const scriptNames = pkg.scripts ? Object.keys(pkg.scripts).slice(0, 15) : [];
        const label = pkg.name ? `package.json (${pkg.name})` : "package.json";
        hints.push(
          scriptNames.length > 0 ? `${label} scripts: ${scriptNames.join(", ")}` : label
        );
      } catch {
      }
    })(),
    // Makefile
    (async () => {
      for (const name of ["Makefile", "makefile"]) {
        try {
          const raw = await fs.readFile(path.join(workspaceDir, name), "utf8");
          const targets = [];
          for (const line of raw.split(/\r?\n/)) {
            const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
            if (m && m[1] && !m[1].startsWith(".")) {
              if (!targets.includes(m[1])) targets.push(m[1]);
              if (targets.length >= 12) break;
            }
          }
          hints.push(
            targets.length > 0 ? `${name} targets: ${targets.join(", ")}` : name
          );
          break;
        } catch {
        }
      }
    })(),
    // pyproject.toml
    (async () => {
      try {
        const raw = await fs.readFile(path.join(workspaceDir, "pyproject.toml"), "utf8");
        const tools = [];
        if (/\[tool\.pytest/.test(raw)) tools.push("pytest");
        if (/\[tool\.ruff/.test(raw)) tools.push("ruff");
        if (/\[tool\.mypy/.test(raw)) tools.push("mypy");
        if (/\[tool\.poetry/.test(raw)) tools.push("poetry");
        if (/\[tool\.uv/.test(raw)) tools.push("uv");
        hints.push(
          tools.length > 0 ? `pyproject.toml (${tools.join(", ")})` : "pyproject.toml"
        );
      } catch {
      }
    })(),
    // Cargo.toml
    (async () => {
      try {
        const raw = await fs.readFile(path.join(workspaceDir, "Cargo.toml"), "utf8");
        const isWorkspace = /\[workspace\]/.test(raw);
        hints.push(isWorkspace ? "Cargo.toml (workspace)" : "Cargo.toml");
      } catch {
      }
    })(),
    // go.mod
    (async () => {
      try {
        const raw = await fs.readFile(path.join(workspaceDir, "go.mod"), "utf8");
        const m = /^module\s+(\S+)/m.exec(raw);
        hints.push(m?.[1] ? `go.mod (${m[1]})` : "go.mod");
      } catch {
      }
    })()
  ]);
  if (hints.length === 0) return null;
  hints.sort();
  return `Project:
${hints.map((h) => `  - ${h}`).join("\n")}`;
}
async function buildWorkspaceSnapshot(workspaceDir, options = {}) {
  const maxChars = options.maxChars ?? 1500;
  const gitTimeoutMs = options.gitTimeoutMs ?? 800;
  try {
    const stat = await fs.stat(workspaceDir);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  const [gitSummary, treeSummary, projectSummary] = await Promise.all([
    getGitSummary(workspaceDir, gitTimeoutMs),
    getTwoLevelTree(workspaceDir),
    getProjectManifestSummary(workspaceDir)
  ]);
  const sections = [
    `[agy-fast startup snapshot] Workspace: ${workspaceDir}`,
    gitSummary,
    projectSummary,
    treeSummary
  ].filter((s) => Boolean(s));
  if (sections.length <= 1) return null;
  const full = sections.join("\n");
  if (full.length <= maxChars) return full;
  const suffix = "\n... [snapshot capped]";
  if (maxChars <= suffix.length) {
    return full.slice(0, Math.max(0, maxChars));
  }
  const cutoff = maxChars - suffix.length;
  let trimmed = full.slice(0, cutoff);
  const lastNl = trimmed.lastIndexOf("\n");
  if (lastNl > cutoff * 0.6) {
    trimmed = trimmed.slice(0, lastNl);
  }
  return `${trimmed}${suffix}`;
}

// src/session-start.ts
function firstNonEmptyPath(list) {
  if (!Array.isArray(list)) return "";
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  return "";
}
async function readStdin(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    process.stdin.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}
async function main() {
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      process.stdout.write("{}\n");
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      process.stdout.write("{}\n");
      return;
    }
    const workspaceDir = typeof payload.cwd === "string" && payload.cwd.trim() || firstNonEmptyPath(payload.workspacePaths) || firstNonEmptyPath(payload.workspace_paths) || firstNonEmptyPath(payload.workspaceRoots) || firstNonEmptyPath(payload.workspace_roots);
    if (!workspaceDir) {
      process.stdout.write("{}\n");
      return;
    }
    const snapshot = await buildWorkspaceSnapshot(workspaceDir, {
      maxChars: 1500,
      gitTimeoutMs: 800
    });
    if (!snapshot) {
      process.stdout.write("{}\n");
      return;
    }
    const response = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: snapshot
          }
        }
      ]
    };
    process.stdout.write(`${JSON.stringify(response)}
`);
  } catch {
    process.stdout.write("{}\n");
  }
}
void main();

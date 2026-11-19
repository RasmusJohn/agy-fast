import { promises as fs } from "node:fs";
import path from "node:path";
import { execBinaryAsync } from "./exec-utils.js";
import { DEFAULT_IGNORE_DIRS } from "./fs-utils.js";

export interface SnapshotOptions {
  maxChars?: number;
  gitTimeoutMs?: number;
}

async function getGitSummary(
  workspaceDir: string,
  timeoutMs: number,
): Promise<string | null> {
  const [branchRes, symRefRes, statusRes, logRes] = await Promise.all([
    execBinaryAsync("git", ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 4096,
    }),
    execBinaryAsync("git", ["--no-optional-locks", "symbolic-ref", "--short", "HEAD"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 4096,
    }),
    execBinaryAsync("git", ["--no-optional-locks", "status", "--porcelain=v1"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 32_768,
    }),
    execBinaryAsync("git", ["--no-optional-locks", "log", "-n", "3", "--format=%h %s"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 8192,
    }),
  ]);

  const hasValidRepo =
    (!branchRes.error && branchRes.exitCode === 0) ||
    (!symRefRes.error && symRefRes.exitCode === 0) ||
    (!statusRes.error && statusRes.exitCode === 0);

  if (!hasValidRepo) {
    return null;
  }

  const branch =
    (branchRes.exitCode === 0 && branchRes.stdout.trim()) ||
    (symRefRes.exitCode === 0 && symRefRes.stdout.trim()) ||
    "HEAD";
  const isUnborn = branchRes.exitCode !== 0 && symRefRes.exitCode === 0;
  const statusLines = statusRes.exitCode === 0
    ? statusRes.stdout
        .split(/\r?\n/)
        .filter((l) => {
          const trimmed = l.trim();
          if (!trimmed) return false;
          if (trimmed.startsWith("?? ")) {
            const topSeg = trimmed.slice(3).split("/")[0]?.replace(/\/$/, "");
            if (topSeg && DEFAULT_IGNORE_DIRS.has(topSeg)) return false;
          }
          return true;
        })
    : [];
  const logLines = logRes.exitCode === 0
    ? logRes.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

  const parts: string[] = [
    isUnborn ? `Git: branch \`${branch}\` (unborn, no commits yet)` : `Git: branch \`${branch}\``,
  ];
  if (statusLines.length === 0) {
    parts.push("Working tree: clean");
  } else {
    const shown = statusLines.slice(0, 20).map((l) => l.trim());
    const more =
      statusLines.length > 20 ? ` (+${statusLines.length - 20} more)` : "";
    parts.push(`Modified (${statusLines.length}): ${shown.join(", ")}${more}`);
  }
  if (logLines.length > 0) {
    parts.push(
      `Recent commits:\n${logLines.map((l) => `  - ${l.slice(0, 90)}`).join("\n")}`,
    );
  }
  return parts.join("\n");
}

async function getTwoLevelTree(workspaceDir: string): Promise<string | null> {
  let topEntries;
  try {
    topEntries = await fs.readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const filteredTop = topEntries
    .filter((e) => {
      if (e.name === ".DS_Store") return false;
      if (e.isDirectory() && DEFAULT_IGNORE_DIRS.has(e.name)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  if (filteredTop.length === 0) return null;

  const lines: string[] = [];
  const maxTop = 20;
  const shownTop = filteredTop.slice(0, maxTop);

  const subResults = await Promise.all(
    shownTop.map(async (entry) => {
      if (!entry.isDirectory()) {
        return { name: entry.name, isDir: false, children: [] as string[], more: 0 };
      }
      try {
        const sub = await fs.readdir(path.join(workspaceDir, entry.name), {
          withFileTypes: true,
        });
        const valid = sub
          .filter(
            (s) =>
              s.name !== ".DS_Store" &&
              !(s.isDirectory() && DEFAULT_IGNORE_DIRS.has(s.name)),
          )
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        const maxSub = 8;
        const children = valid
          .slice(0, maxSub)
          .map((s) => (s.isDirectory() ? `${s.name}/` : s.name));
        return {
          name: `${entry.name}/`,
          isDir: true,
          children,
          more: Math.max(0, valid.length - maxSub),
        };
      } catch {
        return { name: `${entry.name}/`, isDir: true, children: [], more: 0 };
      }
    }),
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

  return `Layout (2 levels):\n${lines.join("\n")}`;
}

async function getProjectManifestSummary(workspaceDir: string): Promise<string | null> {
  const hints: string[] = [];

  await Promise.all([
    // package.json
    (async () => {
      try {
        const raw = await fs.readFile(path.join(workspaceDir, "package.json"), "utf8");
        const pkg = JSON.parse(raw) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        const scriptNames = pkg.scripts ? Object.keys(pkg.scripts).slice(0, 15) : [];
        const label = pkg.name ? `package.json (${pkg.name})` : "package.json";
        hints.push(
          scriptNames.length > 0
            ? `${label} scripts: ${scriptNames.join(", ")}`
            : label,
        );
      } catch {
        // not present
      }
    })(),

    // Makefile
    (async () => {
      for (const name of ["Makefile", "makefile"]) {
        try {
          const raw = await fs.readFile(path.join(workspaceDir, name), "utf8");
          const targets: string[] = [];
          for (const line of raw.split(/\r?\n/)) {
            const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
            if (m && m[1] && !m[1].startsWith(".")) {
              if (!targets.includes(m[1])) targets.push(m[1]);
              if (targets.length >= 12) break;
            }
          }
          hints.push(
            targets.length > 0
              ? `${name} targets: ${targets.join(", ")}`
              : name,
          );
          break;
        } catch {
          // not present
        }
      }
    })(),

    // pyproject.toml
    (async () => {
      try {
        const raw = await fs.readFile(path.join(workspaceDir, "pyproject.toml"), "utf8");
        const tools: string[] = [];
        if (/\[tool\.pytest/.test(raw)) tools.push("pytest");
        if (/\[tool\.ruff/.test(raw)) tools.push("ruff");
        if (/\[tool\.mypy/.test(raw)) tools.push("mypy");
        if (/\[tool\.poetry/.test(raw)) tools.push("poetry");
        if (/\[tool\.uv/.test(raw)) tools.push("uv");
        hints.push(
          tools.length > 0
            ? `pyproject.toml (${tools.join(", ")})`
            : "pyproject.toml",
        );
      } catch {
        // not present
      }
    })(),

    // Cargo.toml
    (async () => {
      try {
        const raw = await fs.readFile(path.join(workspaceDir, "Cargo.toml"), "utf8");
        const isWorkspace = /\[workspace\]/.test(raw);
        hints.push(isWorkspace ? "Cargo.toml (workspace)" : "Cargo.toml");
      } catch {
        // not present
      }
    })(),

    // go.mod
    (async () => {
      try {
        const raw = await fs.readFile(path.join(workspaceDir, "go.mod"), "utf8");
        const m = /^module\s+(\S+)/m.exec(raw);
        hints.push(m?.[1] ? `go.mod (${m[1]})` : "go.mod");
      } catch {
        // not present
      }
    })(),
  ]);

  if (hints.length === 0) return null;
  hints.sort();
  return `Project:\n${hints.map((h) => `  - ${h}`).join("\n")}`;
}

export async function buildWorkspaceSnapshot(
  workspaceDir: string,
  options: SnapshotOptions = {},
): Promise<string | null> {
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
    getProjectManifestSummary(workspaceDir),
  ]);

  const sections = [
    `[agy-fast startup snapshot] Workspace: ${workspaceDir}`,
    gitSummary,
    projectSummary,
    treeSummary,
  ].filter((s): s is string => Boolean(s));

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

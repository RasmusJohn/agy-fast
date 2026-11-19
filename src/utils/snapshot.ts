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
    const prefix = `Modified (${statusLines.length}): `;
    const maxModifiedChars = 260;
    const maxItems = 8;
    const shown: string[] = [];
    let currentLen = prefix.length;
    for (let i = 0; i < Math.min(statusLines.length, maxItems); i++) {
      const raw = statusLines[i]!.trim();
      const item = raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
      const sepLen = shown.length > 0 ? 2 : 0;
      const remainingAfter = statusLines.length - (i + 1);
      const moreReserve = remainingAfter > 0 ? ` (+${remainingAfter} more)`.length : 0;
      if (shown.length > 0 && currentLen + sepLen + item.length + moreReserve > maxModifiedChars) {
        break;
      }
      shown.push(item);
      currentLen += sepLen + item.length;
    }
    const more =
      shown.length < statusLines.length
        ? ` (+${statusLines.length - shown.length} more)`
        : "";
    parts.push(`${prefix}${shown.join(", ")}${more}`);
  }
  if (logLines.length > 0) {
    parts.push(
      `Recent commits:\n${logLines.map((l) => `  - ${l.slice(0, 72)}`).join("\n")}`,
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

function fitSectionToChars(
  section: string,
  budget: number,
  marker: string,
): string {
  if (budget <= 0) return "";
  if (section.length <= budget) return section;
  if (budget <= marker.length + 1) {
    return section.slice(0, budget);
  }
  const cutoff = budget - marker.length - 1;
  let trimmed = section.slice(0, cutoff);
  const lastNl = trimmed.lastIndexOf("\n");
  if (lastNl > 0) {
    trimmed = trimmed.slice(0, lastNl);
  }
  return `${trimmed}\n${marker}`;
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

  const header = `[agy-fast startup snapshot] Workspace: ${workspaceDir}`;
  const sections = [header, gitSummary, projectSummary, treeSummary].filter(
    (s): s is string => Boolean(s),
  );

  if (sections.length <= 1) return null;

  const full = sections.join("\n");
  if (full.length <= maxChars) return full;

  const suffix = "... [snapshot capped]";
  if (maxChars <= header.length + suffix.length + 4) {
    return fitSectionToChars(full, maxChars, suffix);
  }

  // Allocate per-section budgets so a large dirty git status cannot erase Project or Layout
  const remainingAfterHeader = maxChars - header.length;
  const nonEmptyCount =
    (gitSummary ? 1 : 0) + (projectSummary ? 1 : 0) + (treeSummary ? 1 : 0);
  const availableForBodies = remainingAfterHeader - nonEmptyCount; // reserve \n separators

  let projectPart = "";
  let gitPart = "";
  let treePart = "";
  let budgetLeft = availableForBodies;

  if (projectSummary) {
    const otherPresent = Boolean(gitSummary || treeSummary);
    const projectCap = otherPresent
      ? Math.min(projectSummary.length, Math.max(80, Math.floor(availableForBodies * 0.25)))
      : budgetLeft;
    projectPart = fitSectionToChars(
      projectSummary,
      Math.min(budgetLeft, projectCap),
      "  ... [project capped]",
    );
    budgetLeft -= projectPart.length;
  }

  if (gitSummary && budgetLeft > 0) {
    const gitCap = treeSummary
      ? Math.min(gitSummary.length, Math.max(100, Math.floor(budgetLeft * 0.48)))
      : budgetLeft;
    gitPart = fitSectionToChars(
      gitSummary,
      Math.min(budgetLeft, gitCap),
      "  ... [git capped]",
    );
    budgetLeft -= gitPart.length;
  }

  if (treeSummary && budgetLeft > 0) {
    treePart = fitSectionToChars(treeSummary, budgetLeft, suffix);
    budgetLeft -= treePart.length;
  }

  const assembled = [header, gitPart, projectPart, treePart]
    .filter(Boolean)
    .join("\n");
  if (assembled.length <= maxChars) return assembled;
  return fitSectionToChars(assembled, maxChars, suffix);
}

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzePaths,
  formatCompareMarkdown,
  formatMetricsMarkdown,
} from "./benchmark-core.js";

async function assertPathsExist(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    try {
      await fs.stat(path.resolve(p));
    } catch {
      process.stderr.write(`Error: path does not exist: ${p}\n`);
      return false;
    }
  }
  return true;
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  node dist/benchmark.mjs analyze <path...> [--recent <N>] [--json]",
      "  node dist/benchmark.mjs analyze --local [--recent <N>] [--json]",
      "  node dist/benchmark.mjs compare --before <path> --after <path> [--json]",
      "",
      "Options:",
      "  --local       Scan ~/.gemini/antigravity/brain and ~/.gemini/antigravity-cli/brain",
      "  --recent <N>  Analyze only the N most recently modified transcripts",
      "  --json        Output raw JSON metrics",
    ].join("\n") + "\n",
  );
}

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    return;
  }

  const cmd = args[0];

  if (cmd === "analyze") {
    const targets: string[] = [];
    const explicitTargets: string[] = [];
    let recent: number | undefined;
    let asJson = false;
    let afterDoubleDash = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (!afterDoubleDash && a === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && a === "--json") {
        asJson = true;
        continue;
      }
      if (!afterDoubleDash && a === "--local") {
        targets.push(
          path.join(os.homedir(), ".gemini", "antigravity", "brain"),
          path.join(os.homedir(), ".gemini", "antigravity-cli", "brain"),
        );
        continue;
      }
      if (!afterDoubleDash && (a === "--recent" || a.startsWith("--recent="))) {
        const raw = a === "--recent" ? args[++i] : a.slice("--recent=".length);
        const parsed = raw !== undefined ? parsePositiveInt(raw) : null;
        if (parsed === null) {
          process.stderr.write("Error: --recent must be a positive integer\n");
          process.exitCode = 1;
          return;
        }
        recent = parsed;
        continue;
      }
      if (!afterDoubleDash && a.startsWith("-")) {
        process.stderr.write(`Error: unknown option: ${a}\n`);
        process.exitCode = 1;
        return;
      }
      targets.push(a);
      explicitTargets.push(a);
    }
    if (targets.length === 0) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    if (explicitTargets.length > 0 && !(await assertPathsExist(explicitTargets))) {
      process.exitCode = 1;
      return;
    }
    const metrics = await analyzePaths(
      targets,
      recent !== undefined ? { recent } : {},
    );
    process.stdout.write(
      asJson
        ? `${JSON.stringify(metrics, null, 2)}\n`
        : `${formatMetricsMarkdown(metrics)}\n`,
    );
    return;
  }

  if (cmd === "compare") {
    let beforePath = "";
    let afterPath = "";
    let asJson = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--json") {
        asJson = true;
      } else if (a === "--before" || a.startsWith("--before=")) {
        const val = a === "--before" ? args[++i] : a.slice("--before=".length);
        if (!val || (a === "--before" && val.startsWith("-"))) {
          process.stderr.write("Error: --before requires a path\n");
          process.exitCode = 1;
          return;
        }
        beforePath = val;
      } else if (a === "--after" || a.startsWith("--after=")) {
        const val = a === "--after" ? args[++i] : a.slice("--after=".length);
        if (!val || (a === "--after" && val.startsWith("-"))) {
          process.stderr.write("Error: --after requires a path\n");
          process.exitCode = 1;
          return;
        }
        afterPath = val;
      } else {
        process.stderr.write(`Error: unknown option: ${a}\n`);
        process.exitCode = 1;
        return;
      }
    }
    if (!beforePath || !afterPath) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    if (!(await assertPathsExist([beforePath, afterPath]))) {
      process.exitCode = 1;
      return;
    }
    const [before, after] = await Promise.all([
      analyzePaths([beforePath]),
      analyzePaths([afterPath]),
    ]);
    process.stdout.write(
      asJson
        ? `${JSON.stringify({ before, after }, null, 2)}\n`
        : `${formatCompareMarkdown(before, after)}\n`,
    );
    return;
  }

  printUsage();
  process.exitCode = 1;
}

void main(process.argv);

import { promises as fs } from "node:fs";
import {
  formatCorruptedArrayError,
  isPlainObject,
  parseMaybeJsonArray,
  type CorruptedItem,
} from "../utils/arg-validation.js";
import { runShellCommandAsync, type ExecResult } from "../utils/exec-utils.js";
import { resolvePath } from "../utils/fs-utils.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  fitSectionsToByteBudget,
  formatCompactCommandOutput,
  normalizeTerminalOutput,
  truncateWithByteNotice,
  truncateWithNotice,
} from "../utils/output-filter.js";

export interface CheckCommandSpec {
  name?: string;
  command: string;
  cwd?: string;
  timeoutSec?: number;
}

export interface RunChecksInput {
  cwd?: string;
  commands: Array<string | CheckCommandSpec>;
  concurrency?: number;
  timeoutSec?: number;
  outputMode?: "compact" | "full";
  maxChars?: number;
}

interface NormalizedCommand {
  index: number;
  name: string;
  command: string;
  cwd: string;
  timeoutMs: number;
}

interface CheckRunOutcome {
  spec: NormalizedCommand;
  result: ExecResult;
  passed: boolean;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function runChecks(
  input: RunChecksInput,
): Promise<{ text: string; isError: boolean }> {
  const parsedCommands = parseMaybeJsonArray(input?.commands);
  if (!parsedCommands.ok) {
    if (
      parsedCommands.kind === "wrong_type" &&
      (typeof input?.commands === "boolean" || input?.commands === null)
    ) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed",
          toolName: "run_checks",
          items: [{ label: "commands", value: input.commands, expected: "an array of command specs" }],
          fallbackAdvice: "immediately fall back to a single compound run_command call.",
        }),
        isError: true,
      };
    }
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true,
    };
  }
  const rawCommands = parsedCommands.value;
  if (rawCommands.length === 0) {
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true,
    };
  }
  if (rawCommands.length > 12) {
    return {
      text: "Error: 'commands' supports at most 12 commands per call.",
      isError: true,
    };
  }

  const corruptedCommands: CorruptedItem[] = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    if (typeof raw !== "string" && !isPlainObject(raw)) {
      corruptedCommands.push({
        label: `commands[${i}]`,
        value: raw,
        expected: "a command string or object ({ name?, command, cwd?, timeoutSec? })",
      });
    }
  }
  if (corruptedCommands.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "run_checks",
        items: corruptedCommands,
        fallbackAdvice: "immediately fall back to a single compound run_command call.",
      }),
      isError: true,
    };
  }

  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }

  const concurrency = clampInt(input.concurrency ?? 4, 1, 8);
  const defaultTimeoutSec = clampInt(input.timeoutSec ?? 60, 1, 300);
  const outputMode = input.outputMode === "full" ? "full" : "compact";
  const maxChars = clampInt(input.maxChars ?? 8_000, 500, DEFAULT_INLINE_MAX_BYTES);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;

  const normalized: NormalizedCommand[] = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    const spec: CheckCommandSpec =
      typeof raw === "string" ? { command: raw } : (raw as unknown as CheckCommandSpec);
    if (!spec || typeof spec.command !== "string" || !spec.command.trim()) {
      return {
        text: `Error: commands[${i}] must contain a non-empty 'command' string.`,
        isError: true,
      };
    }
    const cmdCwd = spec.cwd ? resolvePath(spec.cwd, baseCwd) : baseCwd;
    if (spec.cwd) {
      try {
        const st = await fs.stat(cmdCwd);
        if (!st.isDirectory()) {
          return {
            text: `Error: commands[${i}].cwd is not a directory: ${cmdCwd}`,
            isError: true,
          };
        }
      } catch {
        return {
          text: `Error: commands[${i}].cwd does not exist: ${cmdCwd}`,
          isError: true,
        };
      }
    }
    const cmdTimeoutSec = clampInt(
      spec.timeoutSec ?? defaultTimeoutSec,
      1,
      300,
    );
    normalized.push({
      index: i,
      name: spec.name?.trim() || `check-${i + 1}`,
      command: spec.command.trim(),
      cwd: cmdCwd,
      timeoutMs: cmdTimeoutSec * 1000,
    });
  }

  const wallStart = Date.now();
  const outcomes = await mapWithConcurrency<NormalizedCommand, CheckRunOutcome>(
    normalized,
    concurrency,
    async (spec) => {
      const result = await runShellCommandAsync(spec.command, {
        cwd: spec.cwd,
        timeoutMs: spec.timeoutMs,
      });
      const passed = !result.error && !result.timedOut && result.exitCode === 0;
      return { spec, result, passed };
    },
  );
  const wallMs = Date.now() - wallStart;

  const passedCount = outcomes.filter((o) => o.passed).length;
  const failedCount = outcomes.length - passedCount;

  const summaryHeader =
    failedCount === 0
      ? `Checks: ${passedCount}/${outcomes.length} passed (wall: ${wallMs}ms)`
      : `Checks: ${passedCount}/${outcomes.length} passed, ${failedCount} failed (wall: ${wallMs}ms)`;

  // Allocate larger output share to failing checks than passing checks
  const usableChars = Math.max(200, maxChars - summaryHeader.length - 4);
  const failedBudget =
    failedCount > 0
      ? Math.max(160, Math.floor((usableChars - passedCount * 120) / failedCount))
      : 320;
  const fullPerCmdBudget = Math.max(
    160,
    Math.floor(usableChars / outcomes.length),
  );

  const blocks = outcomes.map(({ spec, result, passed }) => {
    const badge = result.error
      ? "ERROR"
      : result.timedOut
        ? "TIMEOUT"
        : passed
          ? "PASS"
          : `FAIL (exit ${result.exitCode ?? "err"})`;

    if (outputMode === "full") {
      const combined = [
        normalizeTerminalOutput(result.stdout),
        normalizeTerminalOutput(result.stderr),
      ]
        .filter(Boolean)
        .join("\n");
      const body = result.error
        ? `spawn error: ${result.error}`
        : truncateWithNotice(combined || "(no output)", fullPerCmdBudget);
      return `## [${badge}] ${spec.name} (${result.durationMs}ms)\n$ ${spec.command}\n${body}`;
    }

    const body = formatCompactCommandOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      error: result.error,
      maxChars: passed ? 300 : failedBudget,
    });

    if (passed) {
      return `- [PASS ${result.durationMs}ms] ${spec.name} (\`${spec.command}\`): ${body}`;
    }
    return `## [${badge} ${result.durationMs}ms] ${spec.name}\n$ ${spec.command}\n${body}`;
  });

  const bodyBudget = Math.max(0, maxChars - summaryHeader.length - 2);
  const bodyByteBudget =
    maxBytes !== undefined
      ? Math.max(0, maxBytes - Buffer.byteLength(summaryHeader, "utf8") - 2)
      : undefined;
  const fittedBlocks = fitSectionsToByteBudget(
    blocks,
    bodyBudget,
    bodyByteBudget,
    "\n\n",
  );
  let text = truncateWithNotice(
    `${summaryHeader}\n\n${fittedBlocks}`,
    maxChars,
  );
  if (maxBytes !== undefined) {
    text = truncateWithByteNotice(text, maxBytes);
  }
  return { text, isError: false };
}

function clampInt(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.trunc(val)));
}

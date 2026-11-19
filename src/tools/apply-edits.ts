import { promises as fs } from "node:fs";
import path from "node:path";
import { runShellCommandAsync } from "../utils/exec-utils.js";
import { readTextFile, resolvePath, toPosixPath } from "../utils/fs-utils.js";
import { formatCompactCommandOutput } from "../utils/output-filter.js";

export interface EditHunk {
  target: string;
  replacement: string;
  startLine?: number;
  endLine?: number;
  replaceAll?: boolean;
}

export interface FileEdit {
  path: string;
  hunks?: EditHunk[];
  create?: string;
  overwrite?: boolean;
}

export interface VerifySpec {
  command: string;
  cwd?: string;
  timeoutSec?: number;
}

export interface ApplyEditsInput {
  cwd?: string;
  edits: FileEdit[];
  dryRun?: boolean;
  verify?: string | VerifySpec;
  verifyTimeoutSec?: number;
  maxVerifyChars?: number;
}

interface MatchSpan {
  start: number;
  end: number;
  replacement: string;
  hunkIndex: number;
}

interface PlannedWrite {
  absPath: string;
  writeTargetPath: string;
  relPath: string;
  existed: boolean;
  originalBuffer: Buffer | null;
  originalMode: number | null;
  newContent: string;
  hunkCount: number;
  lineDelta: number;
  created: boolean;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}

function getLineWindowOffsets(
  text: string,
  lineStarts: number[],
  startLine?: number,
  endLine?: number,
): { windowStart: number; windowEnd: number } {
  if (
    startLine !== undefined &&
    (typeof startLine !== "number" || !Number.isFinite(startLine) || startLine < 1)
  ) {
    throw new Error(`Invalid startLine: ${String(startLine)} (must be integer >= 1)`);
  }
  if (
    endLine !== undefined &&
    (typeof endLine !== "number" || !Number.isFinite(endLine) || endLine < 1)
  ) {
    throw new Error(`Invalid endLine: ${String(endLine)} (must be integer >= 1)`);
  }

  const totalLines = lineStarts.length;
  const sLine = startLine !== undefined ? Math.trunc(startLine) : 1;
  const eLine =
    endLine !== undefined ? Math.min(totalLines, Math.trunc(endLine)) : totalLines;

  if (sLine > totalLines) {
    return { windowStart: text.length, windowEnd: text.length };
  }
  if (eLine < sLine) {
    throw new Error(`Invalid line range: startLine (${sLine}) > endLine (${eLine})`);
  }

  const windowStart = lineStarts[sLine - 1]!;
  const windowEnd =
    eLine < totalLines ? lineStarts[eLine]! : text.length;
  return { windowStart, windowEnd };
}

function formatNearbyLines(
  text: string,
  startLine?: number,
  endLine?: number,
): string {
  const lines = text.split("\n");
  if (startLine === undefined && endLine === undefined) return "";
  const from = Math.max(1, (startLine ?? endLine ?? 1) - 2);
  const to = Math.min(lines.length, (endLine ?? startLine ?? 1) + 2);
  const snippet: string[] = [];
  for (let ln = from; ln <= to; ln++) {
    snippet.push(`    ${ln}: ${lines[ln - 1] ?? ""}`);
  }
  return `\n  Nearby lines (${from}-${to}):\n${snippet.join("\n")}`;
}

function planHunksForContent(
  normalizedContent: string,
  hunks: EditHunk[],
  displayPath: string,
): { newNormalized: string; appliedMatches: number; errors: string[] } {
  const lineStarts = computeLineStarts(normalizedContent);
  const spans: MatchSpan[] = [];
  const errors: string[] = [];

  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx]!;
    if (typeof hunk.target !== "string" || hunk.target.length === 0) {
      errors.push(`${displayPath} hunk #${idx + 1}: 'target' must be a non-empty string`);
      continue;
    }
    if (typeof hunk.replacement !== "string") {
      errors.push(`${displayPath} hunk #${idx + 1}: 'replacement' must be a string`);
      continue;
    }

    const normTarget = hunk.target.replace(/\r\n/g, "\n");
    const normReplacement = hunk.replacement.replace(/\r\n/g, "\n");

    let windowStart = 0;
    let windowEnd = normalizedContent.length;
    try {
      const win = getLineWindowOffsets(
        normalizedContent,
        lineStarts,
        hunk.startLine,
        hunk.endLine,
      );
      windowStart = win.windowStart;
      windowEnd = win.windowEnd;
    } catch (err) {
      errors.push(
        `${displayPath} hunk #${idx + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const foundOffsets: number[] = [];
    let pos = windowStart;
    while (pos <= windowEnd - normTarget.length) {
      const found = normalizedContent.indexOf(normTarget, pos);
      if (found === -1 || found + normTarget.length > windowEnd) break;
      foundOffsets.push(found);
      pos = found + Math.max(1, normTarget.length);
    }

    if (foundOffsets.length === 0) {
      const rangeNote =
        hunk.startLine !== undefined || hunk.endLine !== undefined
          ? ` within lines ${hunk.startLine ?? 1}-${hunk.endLine ?? lineStarts.length}`
          : "";
      const nearby = formatNearbyLines(
        normalizedContent,
        hunk.startLine,
        hunk.endLine,
      );
      errors.push(
        `${displayPath} hunk #${idx + 1}: target text not found${rangeNote}.${nearby}`,
      );
      continue;
    }

    if (foundOffsets.length > 1 && !hunk.replaceAll) {
      const lines = foundOffsets
        .slice(0, 10)
        .map((o) => offsetToLine(lineStarts, o))
        .join(", ");
      errors.push(
        `${displayPath} hunk #${idx + 1}: target matched ${foundOffsets.length} times (lines: ${lines}). Provide startLine/endLine, more surrounding context, or set replaceAll: true.`,
      );
      continue;
    }

    for (const start of foundOffsets) {
      spans.push({
        start,
        end: start + normTarget.length,
        replacement: normReplacement,
        hunkIndex: idx,
      });
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!;
    const curr = spans[i]!;
    if (curr.start < prev.end) {
      const line = offsetToLine(lineStarts, curr.start);
      errors.push(
        `${displayPath}: hunk #${prev.hunkIndex + 1} and hunk #${curr.hunkIndex + 1} overlap near line ${line}.`,
      );
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }

  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(normalizedContent.slice(cursor, span.start));
    pieces.push(span.replacement);
    cursor = span.end;
  }
  pieces.push(normalizedContent.slice(cursor));

  return {
    newNormalized: pieces.join(""),
    appliedMatches: spans.length,
    errors: [],
  };
}

function countLines(text: string): number {
  if (!text) return 0;
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  if (end === 0) return 1;
  let count = 1;
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

async function commitPlannedWrites(plans: PlannedWrite[]): Promise<void> {
  const written: PlannedWrite[] = [];

  try {
    for (const plan of plans) {
      const target = plan.writeTargetPath;
      const dir = path.dirname(target);
      await fs.mkdir(dir, { recursive: true });
      const tmpPath = `${target}.agy-fast-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fs.writeFile(tmpPath, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          await fs.chmod(tmpPath, plan.originalMode);
        }
        await fs.rename(tmpPath, target);
      } catch (renameErr) {
        // Fallback if rename across filesystems or directory permissions fails
        try {
          await fs.unlink(tmpPath);
        } catch {
          // ignore cleanup failure
        }
        await fs.writeFile(target, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          try {
            await fs.chmod(target, plan.originalMode);
          } catch {
            // ignore chmod failure on unsupported filesystems
          }
        }
        void renameErr;
      }
      written.push(plan);
    }
  } catch (err) {
    // Rollback all previously written files
    for (let i = written.length - 1; i >= 0; i--) {
      const item = written[i]!;
      const target = item.writeTargetPath;
      try {
        if (item.existed && item.originalBuffer !== null) {
          await fs.writeFile(target, item.originalBuffer);
          if (item.originalMode !== null && process.platform !== "win32") {
            await fs.chmod(target, item.originalMode);
          }
        } else if (!item.existed) {
          await fs.unlink(target);
        }
      } catch {
        // Best-effort rollback
      }
    }
    throw err;
  }
}

export async function runApplyEdits(
  input: ApplyEditsInput,
): Promise<{ text: string; isError: boolean }> {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return {
      text: "Error: 'edits' must be a non-empty array of file edit objects.",
      isError: true,
    };
  }
  if (input.edits.length > 50) {
    return {
      text: "Error: 'edits' supports at most 50 file entries per call.",
      isError: true,
    };
  }

  const baseCwd = resolvePath(input.cwd || process.cwd());

  // Merge entries targeting the same resolved file (including symlink aliases)
  const mergedByPath = new Map<
    string,
    {
      absPath: string;
      writeTargetPath: string;
      relPath: string;
      create?: string;
      overwrite?: boolean;
      hunks: EditHunk[];
    }
  >();
  const errors: string[] = [];

  for (let i = 0; i < input.edits.length; i++) {
    const entry = input.edits[i]!;
    if (!entry || typeof entry.path !== "string" || !entry.path.trim()) {
      errors.push(`edits[${i}]: 'path' must be a non-empty string`);
      continue;
    }

    const absPath = resolvePath(entry.path, baseCwd);
    let writeTargetPath = absPath;
    try {
      // Canonicalize existing paths (including symlinks and symlinked parent dirs like /var -> /private/var)
      writeTargetPath = await fs.realpath(absPath);
    } catch {
      // File does not exist yet or broken symlink — keep absPath
    }
    const relPath = toPosixPath(path.relative(baseCwd, absPath)) || path.basename(absPath);
    const hasCreate = typeof entry.create === "string";
    const hasHunks = Array.isArray(entry.hunks) && entry.hunks.length > 0;

    if (!hasCreate && !hasHunks) {
      errors.push(`${relPath}: must specify either non-empty 'hunks' or 'create'`);
      continue;
    }
    if (hasCreate && hasHunks) {
      errors.push(`${relPath}: cannot specify both 'create' and 'hunks' on the same entry`);
      continue;
    }

    const existing = mergedByPath.get(writeTargetPath);
    if (!existing) {
      mergedByPath.set(writeTargetPath, {
        absPath,
        writeTargetPath,
        relPath,
        create: hasCreate ? entry.create : undefined,
        overwrite: entry.overwrite,
        hunks: hasHunks ? [...entry.hunks!] : [],
      });
    } else {
      if (hasCreate || existing.create !== undefined) {
        errors.push(`${relPath}: duplicate entries cannot mix 'create' with other edits`);
        continue;
      }
      existing.hunks.push(...entry.hunks!);
    }
  }

  if (errors.length > 0) {
    return {
      text: `Validation failed (0 files modified):\n- ${errors.join("\n- ")}`,
      isError: true,
    };
  }

  // Phase 1: validate and plan every file in memory
  const plans: PlannedWrite[] = [];
  for (const item of mergedByPath.values()) {
    if (item.create !== undefined) {
      let exists = false;
      let originalBuffer: Buffer | null = null;
      let originalMode: number | null = null;
      try {
        const st = await fs.stat(item.writeTargetPath);
        if (st.isDirectory()) {
          errors.push(`${item.relPath}: target path is a directory`);
          continue;
        }
        exists = true;
        if (!item.overwrite) {
          errors.push(
            `${item.relPath}: file already exists (set overwrite: true to replace it)`,
          );
          continue;
        }
        originalMode = st.mode & 0o7777;
        originalBuffer = await fs.readFile(item.writeTargetPath);
      } catch {
        exists = false;
      }

      const oldLines = originalBuffer ? countLines(originalBuffer.toString("utf8")) : 0;
      const newLines = countLines(item.create);
      plans.push({
        absPath: item.absPath,
        writeTargetPath: item.writeTargetPath,
        relPath: item.relPath,
        existed: exists,
        originalBuffer,
        originalMode,
        newContent: item.create,
        hunkCount: 1,
        lineDelta: newLines - oldLines,
        created: !exists,
      });
      continue;
    }

    // Existing file hunks
    let fileData;
    try {
      fileData = await readTextFile(item.writeTargetPath);
    } catch (err) {
      errors.push(
        `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const normalizedOriginal = fileData.content.replace(/\r\n/g, "\n");
    const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
    if (planned.errors.length > 0) {
      errors.push(...planned.errors);
      continue;
    }

    const finalContent =
      fileData.eol === "\r\n"
        ? planned.newNormalized.replace(/\n/g, "\r\n")
        : planned.newNormalized;

    const lineDelta =
      countLines(planned.newNormalized) - countLines(normalizedOriginal);

    plans.push({
      absPath: item.absPath,
      writeTargetPath: item.writeTargetPath,
      relPath: item.relPath,
      existed: true,
      originalBuffer: fileData.rawBuffer,
      originalMode: fileData.mode,
      newContent: finalContent,
      hunkCount: planned.appliedMatches,
      lineDelta,
      created: false,
    });
  }

  if (errors.length > 0) {
    return {
      text: `Atomic edit aborted (0 files modified):\n- ${errors.join("\n- ")}`,
      isError: true,
    };
  }

  // Phase 2: write atomically (unless dryRun)
  if (!input.dryRun) {
    try {
      await commitPlannedWrites(plans);
    } catch (err) {
      return {
        text: `Write failed (changes rolled back): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  const summaryLines = plans.map((p) => {
    const deltaStr = p.lineDelta >= 0 ? `+${p.lineDelta}` : `${p.lineDelta}`;
    const action = p.created ? "created" : `updated (${p.hunkCount} match${p.hunkCount === 1 ? "" : "es"})`;
    return `- ${p.relPath}: ${action}, lines ${deltaStr}`;
  });

  const header = input.dryRun
    ? `Dry run validated ${plans.length} file(s) (0 files modified):`
    : `Applied edits to ${plans.length} file(s):`;
  const parts = [`${header}\n${summaryLines.join("\n")}`];

  // Phase 3: optional inline verify
  if (!input.dryRun && input.verify) {
    const verifySpec: VerifySpec =
      typeof input.verify === "string" ? { command: input.verify } : input.verify;
    if (verifySpec.command && verifySpec.command.trim()) {
      const verifyCwd = verifySpec.cwd ? resolvePath(verifySpec.cwd, baseCwd) : baseCwd;
      const timeoutMs =
        Math.max(
          1,
          Math.min(
            300,
            Math.trunc(verifySpec.timeoutSec ?? input.verifyTimeoutSec ?? 60),
          ),
        ) * 1000;
      const maxVerifyChars = Math.max(
        300,
        Math.min(20_000, Math.trunc(input.maxVerifyChars ?? 4000)),
      );

      const res = await runShellCommandAsync(verifySpec.command, {
        cwd: verifyCwd,
        timeoutMs,
      });

      const status = res.timedOut
        ? "TIMEOUT"
        : res.exitCode === 0
          ? "PASS"
          : `FAIL (exit ${res.exitCode ?? "err"})`;
      const formatted = formatCompactCommandOutput({
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        error: res.error,
        maxChars: maxVerifyChars,
      });

      parts.push(
        `\nVerify [${status} in ${res.durationMs}ms] \`${verifySpec.command}\`:\n${formatted}`,
      );
    }
  }

  return { text: parts.join("\n"), isError: false };
}

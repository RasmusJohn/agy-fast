// Matches standard ANSI CSI / OSC escape sequences
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Clean terminal carriage-return progress overwrites so only the final frame of
 * each line remains.
 */
export function normalizeTerminalOutput(raw: string): string {
  const clean = stripAnsi(raw).replace(/\r\n/g, "\n");
  return clean
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r").filter((p) => p.length > 0);
      return parts[parts.length - 1] ?? "";
    })
    .join("\n")
    .trimEnd();
}

/**
 * Antigravity spills call_mcp_tool responses over ~10 KB UTF-8 to disk
 * (`The output was large and was saved to: ...`), forcing an extra LLM turn
 * to read_file(output.txt). Keeping default tool responses <= 8,800 UTF-8 bytes
 * guarantees inline delivery with headroom for timestamp/JSON wrappers.
 */
export const DEFAULT_INLINE_MAX_BYTES = 8_800;

export type TruncateMode = "head" | "head-tail";

export function sliceUtf8Bytes(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const unitLen = cp > 0xffff ? 2 : 1;
    const chBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return text.slice(0, endIndex);
}

export function sliceUtf8BytesTail(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let startIndex = text.length;
  for (let i = text.length; i > 0; ) {
    let unitLen = 1;
    let cp: number;
    const code = text.charCodeAt(i - 1);
    if (
      i >= 2 &&
      code >= 0xdc00 &&
      code <= 0xdfff &&
      text.charCodeAt(i - 2) >= 0xd800 &&
      text.charCodeAt(i - 2) <= 0xdbff
    ) {
      unitLen = 2;
      cp = text.codePointAt(i - 2)!;
    } else {
      cp = code;
    }
    const chBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i -= unitLen;
    startIndex = i;
  }
  return text.slice(startIndex);
}

export function truncateHeadTailWithByteNotice(
  text: string,
  maxBytes: number,
): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;

  if (limit < 120) {
    return truncateWithByteNotice(text, limit);
  }

  const maxMarkerBytes = Buffer.byteLength(
    `\n... [truncated: folded ${totalBytes} middle bytes; total ${totalBytes} bytes] ...\n`,
    "utf8",
  );
  const contentBytes = limit - maxMarkerBytes;
  if (contentBytes < 40) {
    return truncateWithByteNotice(text, limit);
  }

  const headBudget = Math.max(16, Math.floor(contentBytes * 0.38));
  const tailBudget = Math.max(24, contentBytes - headBudget);

  let head = sliceUtf8Bytes(text, headBudget);
  const lastNewline = head.lastIndexOf("\n");
  if (
    lastNewline > 0 &&
    Buffer.byteLength(head.slice(0, lastNewline), "utf8") > headBudget * 0.5
  ) {
    head = head.slice(0, lastNewline);
  }

  let tail = sliceUtf8BytesTail(text, tailBudget);
  const firstNewline = tail.indexOf("\n");
  if (
    firstNewline !== -1 &&
    Buffer.byteLength(tail.slice(firstNewline + 1), "utf8") > tailBudget * 0.5
  ) {
    tail = tail.slice(firstNewline + 1);
  }

  const headBytes = Buffer.byteLength(head, "utf8");
  const tailBytes = Buffer.byteLength(tail, "utf8");
  const omittedBytes = Math.max(1, totalBytes - headBytes - tailBytes);
  const marker = `\n... [truncated: folded ${omittedBytes} middle bytes; total ${totalBytes} bytes] ...\n`;
  const result = `${head}${marker}${tail}`;
  return Buffer.byteLength(result, "utf8") <= limit
    ? result
    : truncateWithByteNotice(result, limit);
}

export function truncateWithByteNotice(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;

  if (limit < 56) {
    if (limit <= 3) return sliceUtf8Bytes(text, limit);
    return `${sliceUtf8Bytes(text, limit - 3)}...`;
  }

  const maxNoticeBytes = Buffer.byteLength(
    `\n... [truncated: showed ${totalBytes} of ${totalBytes} bytes]`,
    "utf8",
  );
  const cutoffBytes = Math.max(0, limit - maxNoticeBytes);
  if (cutoffBytes < 8) {
    return `${sliceUtf8Bytes(text, limit - 3)}...`;
  }
  let slice = sliceUtf8Bytes(text, cutoffBytes);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(slice.slice(0, lastNewline), "utf8") > cutoffBytes * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const shownBytes = Buffer.byteLength(slice, "utf8");
  const result = `${slice}\n... [truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  return Buffer.byteLength(result, "utf8") <= limit
    ? result
    : sliceUtf8Bytes(result, limit);
}

export function sliceSafeChars(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let end = limit;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function sliceSafeCharsTail(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let start = text.length - limit;
  if (start < text.length) {
    const firstCode = text.charCodeAt(start);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      start += 1;
    }
  }
  return text.slice(start);
}

export function truncateHeadTailWithNotice(
  text: string,
  maxChars: number,
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;

  if (limit < 120) {
    return truncateWithNotice(text, limit);
  }

  const maxMarkerLen =
    `\n... [truncated: folded ${text.length} middle chars; total ${text.length} chars] ...\n`
      .length;
  const contentBudget = limit - maxMarkerLen;
  if (contentBudget < 40) {
    return truncateWithNotice(text, limit);
  }

  const headBudget = Math.max(16, Math.floor(contentBudget * 0.38));
  const tailBudget = Math.max(24, contentBudget - headBudget);

  let head = sliceSafeChars(text, headBudget);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > headBudget * 0.5) {
    head = head.slice(0, lastNewline);
  }

  let tail = sliceSafeCharsTail(text, tailBudget);
  const firstNewline = tail.indexOf("\n");
  if (firstNewline !== -1 && tail.length - (firstNewline + 1) > tailBudget * 0.5) {
    tail = tail.slice(firstNewline + 1);
  }

  const omittedChars = Math.max(1, text.length - head.length - tail.length);
  const marker = `\n... [truncated: folded ${omittedChars} middle chars; total ${text.length} chars] ...\n`;
  const result = `${head}${marker}${tail}`;
  return result.length <= limit ? result : truncateWithNotice(result, limit);
}

export function truncateWithNotice(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;

  if (limit < 48) {
    if (limit <= 3) return sliceSafeChars(text, limit);
    return `${sliceSafeChars(text, limit - 3)}...`;
  }

  const maxNoticeLen = `\n... [truncated: showed ${text.length} of ${text.length} chars]`.length;
  const cutoff = Math.max(0, limit - maxNoticeLen);
  if (cutoff < 8) {
    return `${sliceSafeChars(text, limit - 3)}...`;
  }
  let slice = sliceSafeChars(text, cutoff);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > cutoff * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const result = `${slice}\n... [truncated: showed ${slice.length} of ${text.length} chars]`;
  return result.length <= limit ? result : sliceSafeChars(result, limit);
}

/**
 * Water-filling character budget allocator: short sections keep their full
 * text, and remaining budget is split evenly among longer sections so total
 * joined length stays strictly within maxChars.
 */
export function fitSectionsToBudget(
  sections: string[],
  maxChars: number,
  separator = "\n\n",
  truncateMode: TruncateMode = "head",
): string {
  if (sections.length === 0 || !Number.isFinite(maxChars) || maxChars <= 0) return "";
  const truncateChar =
    truncateMode === "head-tail" ? truncateHeadTailWithNotice : truncateWithNotice;
  const joined = sections.join(separator);
  if (joined.length <= maxChars) return joined;

  const sepTotal = separator.length * (sections.length - 1);
  if (sepTotal >= maxChars) {
    return truncateChar(joined, maxChars);
  }

  let remainingBudget = maxChars - sepTotal;
  const budgets = new Array<number>(sections.length).fill(0);
  const order = sections
    .map((s, idx) => ({ idx, len: s.length }))
    .sort((a, b) => a.len - b.len);

  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBudget / remainingCount);
    const item = order[i]!;
    if (item.len <= share) {
      budgets[item.idx] = item.len;
      remainingBudget -= item.len;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBudget / rem);
        budgets[order[j]!.idx] = alloc;
        remainingBudget -= alloc;
      }
      break;
    }
  }

  const fitted = sections
    .map((sec, idx) => truncateChar(sec, budgets[idx] ?? 0))
    .join(separator);
  return fitted.length <= maxChars ? fitted : truncateChar(fitted, maxChars);
}

/**
 * Fits sections within both a character budget and an optional UTF-8 byte
 * budget (water-filling by UTF-8 byte size when CJK/multi-byte characters
 * push the joined string over maxBytes).
 */
export function fitSectionsToByteBudget(
  sections: string[],
  maxChars: number,
  maxBytes?: number,
  separator = "\n\n",
  truncateMode: TruncateMode = "head",
): string {
  const truncateBytes =
    truncateMode === "head-tail"
      ? truncateHeadTailWithByteNotice
      : truncateWithByteNotice;
  const charFitted = fitSectionsToBudget(sections, maxChars, separator, truncateMode);
  if (maxBytes === undefined) {
    return charFitted;
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  if (Buffer.byteLength(charFitted, "utf8") <= maxBytes) {
    return charFitted;
  }

  const sepBytes = Buffer.byteLength(separator, "utf8") * (sections.length - 1);
  if (sepBytes >= maxBytes) {
    return truncateBytes(charFitted, maxBytes);
  }

  let remainingBytes = maxBytes - sepBytes;
  const byteBudgets = new Array<number>(sections.length).fill(0);
  const order = sections
    .map((s, idx) => ({ idx, bytes: Buffer.byteLength(s, "utf8") }))
    .sort((a, b) => a.bytes - b.bytes);

  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBytes / remainingCount);
    const item = order[i]!;
    if (item.bytes <= share) {
      byteBudgets[item.idx] = item.bytes;
      remainingBytes -= item.bytes;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBytes / rem);
        byteBudgets[order[j]!.idx] = alloc;
        remainingBytes -= alloc;
      }
      break;
    }
  }

  const byteFittedSections = sections.map((sec, idx) =>
    truncateBytes(sec, byteBudgets[idx] ?? 0),
  );
  let fitted = byteFittedSections.join(separator);
  if (fitted.length > maxChars) {
    fitted = fitSectionsToBudget(
      byteFittedSections,
      maxChars,
      separator,
      truncateMode,
    );
  }
  return Buffer.byteLength(fitted, "utf8") <= maxBytes
    ? fitted
    : truncateBytes(fitted, maxBytes);
}

const ERROR_LINE_PATTERN =
  /(?:\berr!|\b(?:error|fail|failed|failing|exception|traceback|panic|fatal|assertion|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined)\b|caused by:|application failed to start|compilation error|<<<\s*(?:failure|error)|找不到符号|符号:|位置:)/i;

const ROOT_CAUSE_HEADER_PATTERN =
  /(?:^\s*(?:description|action):|caused by:|application failed to start|⎯+\s*failed tests|compilation error)/i;

const JSON_INFO_LOG_PATTERNS: RegExp[] = [
  /^\s*\{"level":(?:10|20|30)\b/,
  /^\s*\{[^}]*"level"\s*:\s*"(?:trace|debug|info)"/i,
];

const ALWAYS_NOISE_LINE_PATTERNS: RegExp[] = [
  /^\[ERROR\]\s*(?:To see the full stack trace|Re-run Maven using the -X|For more information about the errors|\[Help \d+\]|->\s*\[Help \d+\])/i,
  /^\(node:\d+\)\s*ExperimentalWarning:/,
  /^\(Use `node --trace-warnings/,
];

function isFailureNoiseLine(line: string): boolean {
  if (ALWAYS_NOISE_LINE_PATTERNS.some((re) => re.test(line))) return true;
  if (JSON_INFO_LOG_PATTERNS.some((re) => re.test(line))) {
    // Never strip a structured log line if it reports an actual 5xx/error/exception
    return !/"statusCode"\s*:\s*5\d\d|\b(?:error|exception|failed|fatal)\b/i.test(line);
  }
  return false;
}

const SUMMARY_LINE_PATTERN =
  /\b(passed|tests?|specs?|suites?|ok|warnings?|errors?|built in|compiled|done in|finished)\b/i;

export function formatCompactCommandOutput(params: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  maxChars: number;
}): string {
  const out = normalizeTerminalOutput(params.stdout);
  const err = normalizeTerminalOutput(params.stderr);
  const combined = [out, err].filter(Boolean).join("\n");

  if (params.error) {
    return truncateWithNotice(`spawn error: ${params.error}`, params.maxChars);
  }

  if (params.timedOut) {
    const tail = getTailLines(combined, 20);
    return truncateHeadTailWithNotice(
      tail ? `TIMED OUT\n${tail}` : "TIMED OUT (no output)",
      params.maxChars,
    );
  }

  if (params.exitCode === 0) {
    if (!combined) return truncateWithNotice("OK", params.maxChars);
    const lines = combined
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // Keep at most 2 concise summary lines on success
    const summaryLines = lines.filter((l) => SUMMARY_LINE_PATTERN.test(l));
    const picked =
      summaryLines.length > 0
        ? summaryLines.slice(-2)
        : lines.length <= 2
          ? lines
          : [lines[lines.length - 1]!];
    return truncateWithNotice(picked.join(" | "), Math.min(params.maxChars, 320));
  }

  // Non-zero exit: drop noisy info JSON / Maven boilerplate lines first
  const rawLines = combined.split("\n");
  const filteredLines = rawLines.filter((line) => !isFailureNoiseLine(line));
  const lines = filteredLines.length > 0 ? filteredLines : rawLines;
  const cleanedCombined = lines.join("\n");

  if (cleanedCombined.length <= params.maxChars) {
    return (
      cleanedCombined ||
      truncateWithNotice(
        `Exited with code ${params.exitCode ?? "unknown"}`,
        params.maxChars,
      )
    );
  }

  const keepIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (ROOT_CAUSE_HEADER_PATTERN.test(line)) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 8);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    } else if (ERROR_LINE_PATTERN.test(line)) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 3);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    }
  }

  // Always include the last 12 non-noise lines for final summary/stack tail
  const tailStart = Math.max(0, lines.length - 12);
  for (let i = tailStart; i < lines.length; i++) {
    keepIndices.add(i);
  }

  const sorted = [...keepIndices].sort((a, b) => a - b);
  const outLines: string[] = [];
  let prev = -1;
  for (const idx of sorted) {
    if (prev !== -1 && idx > prev + 1) {
      outLines.push(`... (${idx - prev - 1} lines omitted) ...`);
    }
    outLines.push(lines[idx]!);
    prev = idx;
  }

  return truncateHeadTailWithNotice(outLines.join("\n"), params.maxChars);
}

function getTailLines(text: string, count: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(-count).join("\n");
}

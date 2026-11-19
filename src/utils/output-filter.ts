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

export function sliceUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const unitLen = cp > 0xffff ? 2 : 1;
    const chBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return text.slice(0, endIndex);
}

export function truncateWithByteNotice(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return text;

  if (maxBytes < 56) {
    if (maxBytes <= 3) return sliceUtf8Bytes(text, maxBytes);
    return `${sliceUtf8Bytes(text, maxBytes - 3)}...`;
  }

  const maxNoticeBytes = Buffer.byteLength(
    `\n... [truncated: showed ${totalBytes} of ${totalBytes} bytes]`,
    "utf8",
  );
  const cutoffBytes = Math.max(0, maxBytes - maxNoticeBytes);
  let slice = sliceUtf8Bytes(text, cutoffBytes);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(slice.slice(0, lastNewline), "utf8") > cutoffBytes * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const shownBytes = Buffer.byteLength(slice, "utf8");
  const result = `${slice}\n... [truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  return Buffer.byteLength(result, "utf8") <= maxBytes
    ? result
    : sliceUtf8Bytes(result, maxBytes);
}

export function truncateWithNotice(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  if (maxChars < 48) {
    if (maxChars <= 3) return text.slice(0, maxChars);
    return `${text.slice(0, maxChars - 3)}...`;
  }

  const maxNoticeLen = `\n... [truncated: showed ${text.length} of ${text.length} chars]`.length;
  const cutoff = Math.max(0, maxChars - maxNoticeLen);
  let slice = text.slice(0, cutoff);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > cutoff * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const result = `${slice}\n... [truncated: showed ${slice.length} of ${text.length} chars]`;
  return result.length <= maxChars ? result : result.slice(0, maxChars);
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
): string {
  if (sections.length === 0 || maxChars <= 0) return "";
  const joined = sections.join(separator);
  if (joined.length <= maxChars) return joined;

  const sepTotal = separator.length * (sections.length - 1);
  if (sepTotal >= maxChars) {
    return truncateWithNotice(joined, maxChars);
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
    .map((sec, idx) => truncateWithNotice(sec, budgets[idx] ?? 0))
    .join(separator);
  return fitted.length <= maxChars ? fitted : truncateWithNotice(fitted, maxChars);
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
): string {
  const charFitted = fitSectionsToBudget(sections, maxChars, separator);
  if (maxBytes === undefined || Buffer.byteLength(charFitted, "utf8") <= maxBytes) {
    return charFitted;
  }

  const sepBytes = Buffer.byteLength(separator, "utf8") * (sections.length - 1);
  if (sepBytes >= maxBytes) {
    return truncateWithByteNotice(charFitted, maxBytes);
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

  let fitted = sections
    .map((sec, idx) => truncateWithByteNotice(sec, byteBudgets[idx] ?? 0))
    .join(separator);
  if (fitted.length > maxChars) {
    fitted = truncateWithNotice(fitted, maxChars);
  }
  return Buffer.byteLength(fitted, "utf8") <= maxBytes
    ? fitted
    : truncateWithByteNotice(fitted, maxBytes);
}

const ERROR_LINE_PATTERN =
  /(?:\berr!|\b(?:error|fail|failed|failing|exception|traceback|panic|fatal|assertion|syntaxerror|typeerror|referenceerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined)\b)/i;

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
    return truncateWithNotice(
      tail ? `TIMED OUT\n${tail}` : "TIMED OUT (no output)",
      params.maxChars,
    );
  }

  if (params.exitCode === 0) {
    if (!combined) return "OK";
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

  // Non-zero exit: extract error-relevant windows plus tail
  const lines = combined.split("\n");
  if (combined.length <= params.maxChars) {
    return combined || `Exited with code ${params.exitCode ?? "unknown"}`;
  }

  const keepIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_LINE_PATTERN.test(lines[i]!)) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 3);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    }
  }

  // Always include the last 15 lines for final summary/stack tail
  const tailStart = Math.max(0, lines.length - 15);
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

  return truncateWithNotice(outLines.join("\n"), params.maxChars);
}

function getTailLines(text: string, count: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(-count).join("\n");
}

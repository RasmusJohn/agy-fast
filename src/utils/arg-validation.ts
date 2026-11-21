export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function describeValueType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array (len=${value.length})`;
  if (typeof value === "boolean") return `boolean (${String(value)})`;
  if (typeof value === "number") return `number (${String(value)})`;
  if (typeof value === "string") return `string (len=${value.length})`;
  return typeof value;
}

export type ParsedArrayResult =
  | { ok: true; value: unknown[] }
  | { ok: false; kind: "missing" | "invalid_json" | "wrong_type"; detail: string };

/**
 * Accept a native JSON array or a stringified JSON array (some tool wrappers
 * stringify nested array arguments). Reject primitives/objects cleanly.
 */
export function parseMaybeJsonArray(value: unknown): ParsedArrayResult {
  if (value === undefined) {
    return { ok: false, kind: "missing", detail: "undefined" };
  }
  if (Array.isArray(value)) {
    return { ok: true, value };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return { ok: true, value: parsed };
        }
      } catch (err) {
        return {
          ok: false,
          kind: "invalid_json",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  return {
    ok: false,
    kind: "wrong_type",
    detail: describeValueType(value),
  };
}

export interface CorruptedItem {
  label: string;
  value: unknown;
  expected?: string;
}

export function formatCorruptedArrayError(options: {
  header: string;
  toolName: string;
  items: CorruptedItem[];
  fallbackAdvice: string;
}): string {
  const details = options.items
    .slice(0, 8)
    .map(
      (item) =>
        `- ${item.label}: received ${describeValueType(item.value)} instead of ${item.expected ?? "an object"}`,
    );
  if (options.items.length > 8) {
    details.push(`- ... (+${options.items.length - 8} more corrupted entries)`);
  }
  return [
    `${options.header}: nested argument serialization corruption detected in call_mcp_tool.`,
    ...details,
    "",
    `Hint: untyped call_mcp_tool Arguments can occasionally collapse nested objects/arrays into booleans or null. Do NOT retry the same ${options.toolName} payload — ${options.fallbackAdvice}`,
  ].join("\n");
}

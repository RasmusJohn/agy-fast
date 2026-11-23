import { runApplyEdits, type ApplyEditsInput } from "./tools/apply-edits.js";
import {
  runBatchSearch,
  type BatchSearchInput,
  type SearchQuery,
} from "./tools/batch-search.js";
import {
  runQuickOutline,
  runReadSlices,
  type QuickOutlineInput,
  type ReadSlicesInput,
} from "./tools/read-slices.js";
import { runChecks, type RunChecksInput } from "./tools/run-checks.js";

export type CliCanonicalTool =
  | "batch_search"
  | "quick_outline"
  | "read_slices"
  | "apply_edits"
  | "run_checks";

export interface CliIo {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  cwd?: string;
}

const MAX_CLI_STDIN_BYTES = 2 * 1024 * 1024;
const IMPLICIT_STDIN_FIRST_BYTE_TIMEOUT_MS = 500;

const TOOL_ALIASES: Record<string, CliCanonicalTool> = {
  search: "batch_search",
  batch_search: "batch_search",
  outline: "quick_outline",
  quick_outline: "quick_outline",
  slice: "read_slices",
  slices: "read_slices",
  read_slices: "read_slices",
  edit: "apply_edits",
  apply_edits: "apply_edits",
  check: "run_checks",
  checks: "run_checks",
  run_checks: "run_checks",
};

export function resolveCliToolAlias(name: string | undefined): CliCanonicalTool | null {
  if (!name) return null;
  return TOOL_ALIASES[name.trim().toLowerCase()] ?? null;
}

export function formatCliUsage(): string {
  return [
    "agy-fast direct CLI mode (for Swarm workers, scripts, and non-MCP environments)",
    "",
    "Usage:",
    "  node <plugin>/dist/mcp-server.mjs --cli <command> [options] [args...]",
    "",
    "Commands (aliases):",
    "  outline | quick_outline <file...> [--cwd <dir>] [--max-chars <N>]",
    "  slice   | read_slices   <path:start-end,...> [--outline <file>] [--cwd <dir>]",
    "  search  | batch_search  [--text <p>] [--regex <p>] [--glob <p>] [--fuzzy <p>] [--git <cmd>]",
    "                          [--path <dir>] [--file-type <t>] [--glob-filter <g>]",
    "                          [--output-mode content|files_with_matches|count] [--sort-by path|mtime]",
    "                          [--context <0..5>] [--max-results <N>] [-i|--ignore-case] [--multiline]",
    "  check   | run_checks    <cmd...> [--compact|--full] [--concurrency <N>] [--timeout <sec>]",
    "  edit    | apply_edits   [--best-effort] [--dry-run] [--verify <cmd>] (JSON via --json or stdin)",
    "",
    "JSON input (works for every command using the exact MCP tool schema):",
    "  --json '<json>'         Pass tool arguments JSON object (or shorthand array) inline",
    "  --stdin                 Read tool arguments JSON from stdin (or pipe/heredoc with no positional args)",
    "  --cwd <dir>             Override working directory (defaults to shell CWD)",
    "  --max-chars <N>         Override output character cap (hard UTF-8 ceiling <= 8800 bytes)",
  ].join("\n");
}

function parseIntFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) {
    throw new Error(`Expected integer value after ${flag}`);
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer value after ${flag}: ${raw}`);
  }
  return n;
}

function requireValue(flag: string, argv: string[], index: number): string {
  const next = argv[index + 1];
  if (next === undefined) {
    throw new Error(`Missing value after ${flag}`);
  }
  return next;
}

async function readStdinText(
  stream: NodeJS.ReadableStream & { isTTY?: boolean },
  explicitStdin: boolean,
): Promise<string> {
  if (!explicitStdin && stream.isTTY) {
    return "";
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (firstByteTimer !== undefined) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };

    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      if (firstByteTimer !== undefined) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.length;
      if (totalBytes > MAX_CLI_STDIN_BYTES) {
        fail(new Error(`stdin payload exceeds ${MAX_CLI_STDIN_BYTES} bytes limit`));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      finish(Buffer.concat(chunks).toString("utf8"));
    };

    const onError = (err: Error) => {
      fail(err);
    };

    if (!explicitStdin) {
      firstByteTimer = setTimeout(() => {
        if (totalBytes === 0) {
          if (typeof (stream as { pause?: () => void }).pause === "function") {
            (stream as { pause: () => void }).pause();
          }
          finish("");
        }
      }, IMPLICIT_STDIN_FIRST_BYTE_TIMEOUT_MS);
    }

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    if (typeof (stream as { resume?: () => void }).resume === "function") {
      (stream as { resume: () => void }).resume();
    }
  });
}

function parseJsonPayload(
  rawText: string,
  tool: CliCanonicalTool,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Invalid JSON input for '${tool}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (Array.isArray(parsed)) {
    if (tool === "batch_search") return { queries: parsed };
    if (tool === "apply_edits") return { edits: parsed };
    if (tool === "quick_outline") return { paths: parsed };
    if (tool === "read_slices") {
      if (parsed.every((item) => typeof item === "string")) {
        return { lineRanges: parsed };
      }
      return { slices: parsed };
    }
    if (tool === "run_checks") {
      return {
        commands: parsed.map((item) =>
          typeof item === "string" ? { command: item } : item,
        ),
      };
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { ...(parsed as Record<string, unknown>) };
  }
  throw new Error(`JSON input for '${tool}' must be an object (or shorthand array).`);
}

interface ParsedCliOptions {
  cwd?: string;
  maxChars?: number;
  jsonRaw?: string;
  explicitStdin: boolean;
  positionals: string[];
  // search flags
  searchQueries: SearchQuery[];
  searchPath?: string;
  searchFileType?: string;
  searchGlobFilter?: string;
  searchOutputMode?: "content" | "files_with_matches" | "count";
  searchSortBy?: "path" | "mtime";
  searchContextLines?: number;
  searchMaxResults?: number;
  searchCaseSensitive?: boolean;
  searchMultiline?: boolean;
  // slice flags
  outlineFiles: string[];
  // check flags
  outputMode?: "compact" | "full";
  concurrency?: number;
  timeoutSec?: number;
  // edit flags
  bestEffort?: boolean;
  dryRun?: boolean;
  verify?: string;
}

function parseToolFlags(tool: CliCanonicalTool, args: string[]): ParsedCliOptions {
  const opts: ParsedCliOptions = {
    explicitStdin: false,
    positionals: [],
    searchQueries: [],
    outlineFiles: [],
  };

  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (afterDoubleDash) {
      opts.positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg === "--cwd") {
      opts.cwd = requireValue(arg, args, i);
      i += 1;
      continue;
    }
    if (arg === "--max-chars") {
      opts.maxChars = parseIntFlag(arg, requireValue(arg, args, i));
      i += 1;
      continue;
    }
    if (arg === "--json") {
      opts.jsonRaw = requireValue(arg, args, i);
      i += 1;
      continue;
    }
    if (arg === "--stdin") {
      opts.explicitStdin = true;
      continue;
    }

    if (tool === "batch_search") {
      if (arg === "--text" || arg === "-t") {
        opts.searchQueries.push({ type: "text", pattern: requireValue(arg, args, i) });
        i += 1;
        continue;
      }
      if (arg === "--regex" || arg === "-r") {
        opts.searchQueries.push({ type: "regex", pattern: requireValue(arg, args, i) });
        i += 1;
        continue;
      }
      if (arg === "--glob" || arg === "-g") {
        opts.searchQueries.push({ type: "glob", pattern: requireValue(arg, args, i) });
        i += 1;
        continue;
      }
      if (arg === "--fuzzy" || arg === "-f") {
        opts.searchQueries.push({ type: "fuzzy", pattern: requireValue(arg, args, i) });
        i += 1;
        continue;
      }
      if (arg === "--git") {
        opts.searchQueries.push({ type: "git", pattern: requireValue(arg, args, i) });
        i += 1;
        continue;
      }
      if (arg === "--path" || arg === "-p") {
        opts.searchPath = requireValue(arg, args, i);
        i += 1;
        continue;
      }
      if (arg === "--file-type") {
        opts.searchFileType = requireValue(arg, args, i);
        i += 1;
        continue;
      }
      if (arg === "--glob-filter") {
        opts.searchGlobFilter = requireValue(arg, args, i);
        i += 1;
        continue;
      }
      if (arg === "--output-mode") {
        const mode = requireValue(arg, args, i);
        if (mode !== "content" && mode !== "files_with_matches" && mode !== "count") {
          throw new Error(`Invalid --output-mode: ${mode}`);
        }
        opts.searchOutputMode = mode;
        i += 1;
        continue;
      }
      if (arg === "--sort-by") {
        const sortBy = requireValue(arg, args, i);
        if (sortBy !== "path" && sortBy !== "mtime") {
          throw new Error(`Invalid --sort-by: ${sortBy}`);
        }
        opts.searchSortBy = sortBy;
        i += 1;
        continue;
      }
      if (arg === "--context" || arg === "-C") {
        opts.searchContextLines = parseIntFlag(arg, requireValue(arg, args, i));
        i += 1;
        continue;
      }
      if (arg === "--max-results") {
        opts.searchMaxResults = parseIntFlag(arg, requireValue(arg, args, i));
        i += 1;
        continue;
      }
      if (arg === "--ignore-case" || arg === "-i") {
        opts.searchCaseSensitive = false;
        continue;
      }
      if (arg === "--multiline") {
        opts.searchMultiline = true;
        continue;
      }
    } else if (tool === "read_slices") {
      if (arg === "--outline" || arg === "-o") {
        opts.outlineFiles.push(requireValue(arg, args, i));
        i += 1;
        continue;
      }
    } else if (tool === "run_checks") {
      if (arg === "--compact") {
        opts.outputMode = "compact";
        continue;
      }
      if (arg === "--full") {
        opts.outputMode = "full";
        continue;
      }
      if (arg === "--output-mode") {
        const mode = requireValue(arg, args, i);
        if (mode !== "compact" && mode !== "full") {
          throw new Error(`Invalid --output-mode for check: ${mode}`);
        }
        opts.outputMode = mode;
        i += 1;
        continue;
      }
      if (arg === "--concurrency") {
        opts.concurrency = parseIntFlag(arg, requireValue(arg, args, i));
        i += 1;
        continue;
      }
      if (arg === "--timeout") {
        opts.timeoutSec = parseIntFlag(arg, requireValue(arg, args, i));
        i += 1;
        continue;
      }
    } else if (tool === "apply_edits") {
      if (arg === "--best-effort") {
        opts.bestEffort = true;
        continue;
      }
      if (arg === "--dry-run") {
        opts.dryRun = true;
        continue;
      }
      if (arg === "--verify") {
        opts.verify = requireValue(arg, args, i);
        i += 1;
        continue;
      }
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option '${arg}' for '${tool}'. Run with '--cli --help' for usage.`);
    }
    opts.positionals.push(arg);
  }

  return opts;
}

export async function runAgyFastCli(
  argv: string[],
  io: CliIo = {},
): Promise<number> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const defaultCwd = io.cwd ?? process.cwd();

  const cmdArg = argv[0];
  if (!cmdArg || cmdArg === "--help" || cmdArg === "-h" || cmdArg === "help") {
    stdout.write(`${formatCliUsage()}\n`);
    return 0;
  }

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    stdout.write(`${formatCliUsage()}\n`);
    return 0;
  }

  const tool = resolveCliToolAlias(cmdArg);
  if (!tool) {
    stderr.write(
      `Error: unknown --cli command '${cmdArg}'. Expected one of: search, outline, slice, edit, check (or --help).\n`,
    );
    return 1;
  }

  let opts: ParsedCliOptions;
  try {
    opts = parseToolFlags(tool, rest);
  } catch (err) {
    stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const hasShorthandArgs =
    opts.positionals.length > 0 ||
    opts.searchQueries.length > 0 ||
    opts.outlineFiles.length > 0;

  let jsonInput: Record<string, unknown> | null = null;
  try {
    if (opts.jsonRaw !== undefined) {
      jsonInput = parseJsonPayload(opts.jsonRaw, tool);
    } else if (opts.explicitStdin || !hasShorthandArgs) {
      const stdinText = (await readStdinText(stdin, opts.explicitStdin)).trim();
      if (stdinText) {
        jsonInput = parseJsonPayload(stdinText, tool);
      }
    }
  } catch (err) {
    stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let result: { text: string; isError: boolean };
  const effectiveCwd = opts.cwd ?? (typeof jsonInput?.cwd === "string" ? jsonInput.cwd : defaultCwd);

  if (tool === "batch_search") {
    let payload: BatchSearchInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as BatchSearchInput),
        cwd: effectiveCwd,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      const queries: SearchQuery[] = [
        ...opts.searchQueries,
        ...opts.positionals.map((pattern): SearchQuery => ({ type: "text", pattern })),
      ].map((q) => ({
        ...q,
        ...(opts.searchPath && !q.path ? { path: opts.searchPath } : {}),
        ...(opts.searchFileType && !q.fileType ? { fileType: opts.searchFileType } : {}),
        ...(opts.searchGlobFilter && !q.glob ? { glob: opts.searchGlobFilter } : {}),
        ...(opts.searchOutputMode && !q.outputMode ? { outputMode: opts.searchOutputMode } : {}),
        ...(opts.searchSortBy && !q.sortBy ? { sortBy: opts.searchSortBy } : {}),
        ...(opts.searchContextLines !== undefined && q.contextLines === undefined
          ? { contextLines: opts.searchContextLines }
          : {}),
        ...(opts.searchMaxResults !== undefined && q.maxResults === undefined
          ? { maxResults: opts.searchMaxResults }
          : {}),
        ...(opts.searchCaseSensitive !== undefined && q.caseSensitive === undefined
          ? { caseSensitive: opts.searchCaseSensitive }
          : {}),
        ...(opts.searchMultiline !== undefined && q.multiline === undefined
          ? { multiline: opts.searchMultiline }
          : {}),
      }));
      if (queries.length === 0) {
        stderr.write(
          "Error: 'search' requires at least one query (--text/--regex/--glob/--fuzzy/--git, --json, or JSON on stdin).\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        queries,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runBatchSearch(payload);
  } else if (tool === "quick_outline") {
    let payload: QuickOutlineInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as QuickOutlineInput),
        cwd: effectiveCwd,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      if (opts.positionals.length === 0) {
        stderr.write(
          "Error: 'outline' requires one or more file paths (e.g. --cli outline src/a.ts src/b.ts) or JSON input.\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        paths: opts.positionals,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runQuickOutline(payload);
  } else if (tool === "read_slices") {
    let payload: ReadSlicesInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as ReadSlicesInput),
        cwd: effectiveCwd,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      if (opts.positionals.length === 0 && opts.outlineFiles.length === 0) {
        stderr.write(
          "Error: 'slice' requires lineRanges specs (e.g. src/a.ts:1-60), --outline <file>, or JSON input.\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        ...(opts.outlineFiles.length > 0 ? { outlines: opts.outlineFiles } : {}),
        ...(opts.positionals.length > 0 ? { lineRanges: opts.positionals } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runReadSlices(payload);
  } else if (tool === "apply_edits") {
    if (!jsonInput) {
      stderr.write(
        "Error: 'edit' requires JSON input via --json or stdin (e.g. {\"edits\":[...],\"bestEffort\":true}).\n",
      );
      return 1;
    }
    const payload: ApplyEditsInput = {
      ...(jsonInput as unknown as ApplyEditsInput),
      cwd: effectiveCwd,
      ...(opts.bestEffort !== undefined ? { bestEffort: opts.bestEffort } : {}),
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
    };
    result = await runApplyEdits(payload);
  } else {
    let payload: RunChecksInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as RunChecksInput),
        cwd: effectiveCwd,
        ...(opts.outputMode !== undefined ? { outputMode: opts.outputMode } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      if (opts.positionals.length === 0) {
        stderr.write(
          "Error: 'check' requires one or more shell command strings (e.g. --cli check \"npm run typecheck\" \"npm test\") or JSON input.\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        commands: opts.positionals.map((command) => ({ command })),
        ...(opts.outputMode !== undefined ? { outputMode: opts.outputMode } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runChecks(payload);
  }

  stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  return result.isError ? 1 : 0;
}

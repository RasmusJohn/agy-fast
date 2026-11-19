import { promises as fs } from "node:fs";
import path from "node:path";
import { execBinaryAsync, isRipgrepAvailable } from "../utils/exec-utils.js";
import {
  globToRegExp,
  isLikelyBinary,
  resolvePath,
  toPosixPath,
  walkFiles,
} from "../utils/fs-utils.js";
import { fitSectionsToBudget } from "../utils/output-filter.js";

export type SearchQueryType = "text" | "regex" | "glob" | "git";

export interface SearchQuery {
  type: SearchQueryType;
  pattern: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
}

export interface BatchSearchInput {
  cwd?: string;
  queries: SearchQuery[];
  maxChars?: number;
}

export interface BatchSearchRuntimeOptions {
  forceNodeFallback?: boolean;
}

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "blame",
  "shortlog",
  "describe",
  "tag",
  "remote",
]);

const FORBIDDEN_GIT_GLOBAL_FLAGS = new Set([
  "-c",
  "--config",
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--textconv",
  "--output",
  "--exec",
  "--upload-pack",
  "--git-dir",
  "--work-tree",
]);

const ALLOWED_BRANCH_BOOL_FLAGS = new Set([
  "--all",
  "--remotes",
  "--verbose",
  "--list",
  "--show-current",
  "--no-abbrev",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column",
  "--quiet",
  "--merged",
  "--no-merged",
]);

const ALLOWED_BRANCH_VALUE_FLAGS = new Set([
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at",
  "--sort",
  "--format",
  "--abbrev",
  "--color",
  "--column",
]);

const ALLOWED_BRANCH_SHORT_CHARS = new Set(["a", "r", "v", "l", "q", "i"]);

const ALLOWED_TAG_BOOL_FLAGS = new Set([
  "--list",
  "--verify",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column",
  "--merged",
  "--no-merged",
]);

const ALLOWED_TAG_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
  "--color",
  "--column",
]);

const ALLOWED_TAG_SHORT_CHARS = new Set(["l", "v", "i"]);

const ALLOWED_REMOTE_SUBCOMMANDS = new Set(["show", "get-url"]);

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote) {
    throw new Error("Unterminated quote in git query");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function validateReadonlyGitArgs(pattern: string): string[] {
  const rawTokens = tokenizeArgs(pattern.trim());
  const tokens = rawTokens[0] === "git" ? rawTokens.slice(1) : rawTokens;
  if (tokens.length === 0) {
    throw new Error("Empty git query. Example: 'status --short' or 'log -n 5 --oneline'");
  }

  const subcmd = tokens[0]!;
  if (subcmd.startsWith("-")) {
    throw new Error(
      `Git query must start with a read-only subcommand (got '${subcmd}')`,
    );
  }
  if (!READONLY_GIT_SUBCOMMANDS.has(subcmd)) {
    throw new Error(
      `Git subcommand '${subcmd}' is not allowed in batch_search (read-only only: ${[...READONLY_GIT_SUBCOMMANDS].join(", ")})`,
    );
  }

  const rest = tokens.slice(1);
  for (const arg of rest) {
    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (
      FORBIDDEN_GIT_GLOBAL_FLAGS.has(flagName) ||
      arg.startsWith("--output=") ||
      (arg.startsWith("-c") && arg.length > 2)
    ) {
      throw new Error(`Flag '${arg}' is not allowed in read-only git query`);
    }
  }

  if (subcmd === "branch") {
    let hasListFlag = false;
    let expectValue = false;
    for (const arg of rest) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (arg === "--") {
        if (!hasListFlag) {
          throw new Error(
            "Positional branch arguments are only allowed with --list in read-only mode",
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (!ALLOWED_BRANCH_VALUE_FLAGS.has(flagName)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
        } else if (ALLOWED_BRANCH_VALUE_FLAGS.has(flagName)) {
          if (flagName !== "--merged" && flagName !== "--no-merged") {
            expectValue = true;
          }
        } else if (!ALLOWED_BRANCH_BOOL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
        }
        if (flagName === "--list") hasListFlag = true;
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (!ALLOWED_BRANCH_SHORT_CHARS.has(ch)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
          if (ch === "l") hasListFlag = true;
        }
      } else if (!hasListFlag) {
        throw new Error(
          `Positional branch argument '${arg}' is only allowed with --list in read-only mode`,
        );
      }
    }
  } else if (subcmd === "tag") {
    let allowsPositionals = false;
    let expectValue = false;
    for (const arg of rest) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (arg === "--") {
        if (!allowsPositionals) {
          throw new Error(
            "Positional tag arguments are only allowed with --list or --verify in read-only mode",
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (!ALLOWED_TAG_VALUE_FLAGS.has(flagName)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
          }
        } else if (ALLOWED_TAG_VALUE_FLAGS.has(flagName)) {
          if (flagName !== "--merged" && flagName !== "--no-merged") {
            expectValue = true;
          }
        } else if (!ALLOWED_TAG_BOOL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
        }
        if (flagName === "--list" || flagName === "--verify") {
          allowsPositionals = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        if (/^-n\d*$/.test(arg)) {
          allowsPositionals = true;
        } else {
          for (const ch of arg.slice(1)) {
            if (!ALLOWED_TAG_SHORT_CHARS.has(ch)) {
              throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
            }
            if (ch === "l" || ch === "v") allowsPositionals = true;
          }
        }
      } else if (!allowsPositionals) {
        throw new Error(
          `Positional tag argument '${arg}' is only allowed with --list in read-only mode`,
        );
      }
    }
  } else if (subcmd === "remote") {
    let remoteSubcmd: string | null = null;
    for (const arg of rest) {
      if (!remoteSubcmd) {
        if (arg === "-v" || arg === "--verbose") continue;
        if (arg.startsWith("-")) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git remote query`);
        }
        if (!ALLOWED_REMOTE_SUBCOMMANDS.has(arg)) {
          throw new Error(`Mutating git remote subcommand '${arg}' is not allowed`);
        }
        remoteSubcmd = arg;
      } else if (arg.startsWith("-")) {
        const okFlag =
          (remoteSubcmd === "show" && arg === "-n") ||
          (remoteSubcmd === "get-url" && (arg === "--push" || arg === "--all"));
        if (!okFlag) {
          throw new Error(
            `Flag '${arg}' is not allowed for read-only git remote ${remoteSubcmd}`,
          );
        }
      }
    }
  }

  return ["--no-pager", subcmd, ...rest];
}

interface SearchLine {
  lineNumber: number;
  text: string;
  isMatch: boolean;
}

interface FileMatches {
  file: string;
  lines: SearchLine[];
}

async function runTextOrRegexWithRg(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
): Promise<{ files: FileMatches[]; totalMatches: number; truncated: boolean }> {
  const maxResults = clampInt(query.maxResults ?? 40, 1, 200);
  const contextLines = clampInt(query.contextLines ?? 0, 0, 5);
  const args: string[] = [
    "--json",
    "--no-messages",
    "--max-filesize",
    "2M",
  ];

  if (query.type === "text") {
    args.push("--fixed-strings");
  }
  if (query.caseSensitive === false) {
    args.push("--ignore-case");
  }
  if (contextLines > 0) {
    args.push("-C", String(contextLines));
  }
  if (query.glob) {
    args.push(`--glob=${query.glob}`);
  }
  // Always skip heavy vendor/build noise directories unless explicitly targeted
  const normRoot = toPosixPath(searchRoot);
  for (const dir of [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "coverage",
    "__pycache__",
    ".venv",
    ".next",
  ]) {
    if (!normRoot.split("/").includes(dir)) {
      args.push(`--glob=!**/${dir}/**`);
    }
  }
  // Cap per-file matches so a single minified file cannot consume the budget
  args.push("--max-count", String(Math.min(maxResults, 50)));
  args.push("--", query.pattern, searchRoot);

  const res = await execBinaryAsync("rg", args, {
    cwd: baseCwd,
    timeoutMs: 15_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });

  if (res.error) {
    throw new Error(`rg spawn error: ${res.error}`);
  }
  // rg exit code 0 = matches found, 1 = no matches, 2 = error (e.g. bad regex)
  if (res.exitCode === 2) {
    throw new Error(res.stderr.trim() || `rg failed for pattern: ${query.pattern}`);
  }

  const byFile = new Map<string, Map<number, SearchLine>>();
  let totalMatches = 0;
  let truncated = false;
  let pendingBeforeContext: Array<{ relFile: string; lineNumber: number; text: string }> = [];
  let lastKeptMatchFile = "";
  let lastKeptMatchLine = -1;

  const upsertLine = (relFile: string, entry: SearchLine): void => {
    let lineMap = byFile.get(relFile);
    if (!lineMap) {
      lineMap = new Map<number, SearchLine>();
      byFile.set(relFile, lineMap);
    }
    const existing = lineMap.get(entry.lineNumber);
    if (!existing || entry.isMatch) {
      lineMap.set(entry.lineNumber, {
        lineNumber: entry.lineNumber,
        text: entry.text,
        isMatch: entry.isMatch || Boolean(existing?.isMatch),
      });
    }
  };

  for (const rawLine of res.stdout.split("\n")) {
    if (!rawLine.trim()) continue;
    let ev: {
      type?: string;
      data?: {
        path?: { text?: string; bytes?: string };
        line_number?: number;
        lines?: { text?: string; bytes?: string };
      };
    };
    try {
      ev = JSON.parse(rawLine);
    } catch {
      continue;
    }

    if (ev.type === "begin" || ev.type === "end") {
      pendingBeforeContext = [];
      lastKeptMatchFile = "";
      lastKeptMatchLine = -1;
      continue;
    }
    if (ev.type !== "match" && ev.type !== "context") continue;
    const rawFile =
      ev.data?.path?.text ??
      (ev.data?.path?.bytes ? Buffer.from(ev.data.path.bytes, "base64").toString("utf8") : undefined);
    const lineNumber = ev.data?.line_number;
    const rawText =
      ev.data?.lines?.text ??
      (ev.data?.lines?.bytes ? Buffer.from(ev.data.lines.bytes, "base64").toString("utf8") : "");
    const lineText = rawText.replace(/\r?\n$/, "");
    if (!rawFile || typeof lineNumber !== "number") continue;

    const absFile = path.isAbsolute(rawFile) ? rawFile : path.resolve(baseCwd, rawFile);
    const relFile = toPosixPath(path.relative(baseCwd, absFile)) || path.basename(absFile);

    if (ev.type === "context") {
      if (
        lastKeptMatchFile === relFile &&
        lastKeptMatchLine !== -1 &&
        lineNumber > lastKeptMatchLine &&
        lineNumber <= lastKeptMatchLine + contextLines
      ) {
        upsertLine(relFile, { lineNumber, text: lineText, isMatch: false });
      } else if (!truncated) {
        pendingBeforeContext.push({ relFile, lineNumber, text: lineText });
      }
      continue;
    }

    // ev.type === "match"
    if (totalMatches >= maxResults) {
      truncated = true;
      pendingBeforeContext = [];
      continue;
    }
    totalMatches += 1;
    for (const ctx of pendingBeforeContext) {
      if (ctx.relFile === relFile) {
        upsertLine(ctx.relFile, {
          lineNumber: ctx.lineNumber,
          text: ctx.text,
          isMatch: false,
        });
      }
    }
    pendingBeforeContext = [];
    upsertLine(relFile, { lineNumber, text: lineText, isMatch: true });
    lastKeptMatchFile = relFile;
    lastKeptMatchLine = lineNumber;
  }

  const files: FileMatches[] = [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, lineMap]) => ({
      file,
      lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber),
    }));

  return { files, totalMatches, truncated: truncated || res.truncated };
}

async function runTextOrRegexWithNode(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
): Promise<{ files: FileMatches[]; totalMatches: number; truncated: boolean }> {
  const maxResults = clampInt(query.maxResults ?? 40, 1, 200);
  const contextLines = clampInt(query.contextLines ?? 0, 0, 5);
  const caseSensitive = query.caseSensitive !== false;

  let regex: RegExp;
  if (query.type === "regex") {
    try {
      regex = new RegExp(query.pattern, caseSensitive ? "" : "i");
    } catch (err) {
      throw new Error(
        `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    const escaped = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, caseSensitive ? "" : "i");
  }

  const globRegex = query.glob ? globToRegExp(query.glob) : null;
  const globMatchesFile = (relPosix: string): boolean => {
    if (!globRegex) return true;
    if (globRegex.test(relPosix)) return true;
    // Also match basename when pattern has no slash (like '*.ts')
    if (!query.glob!.includes("/")) {
      const base = relPosix.split("/").pop() ?? relPosix;
      return globRegex.test(base);
    }
    return false;
  };

  const stat = await fs.stat(searchRoot);
  let targetFiles: string[];
  if (stat.isFile()) {
    const relPosix =
      toPosixPath(path.relative(baseCwd, searchRoot)) || path.basename(searchRoot);
    targetFiles = globMatchesFile(relPosix) ? [searchRoot] : [];
  } else {
    const includeHidden = Boolean(
      query.glob && (query.glob.startsWith(".") || query.glob.includes("/.")),
    );
    const walked = await walkFiles(searchRoot, {
      maxFiles: 8000,
      includeHidden,
      fileFilter: globMatchesFile,
    });
    targetFiles = walked.files.map((rel) => path.join(searchRoot, rel));
  }

  const files: FileMatches[] = [];
  let totalMatches = 0;
  let truncated = false;

  const buildFileMatches = (
    relFile: string,
    allLines: string[],
    keptIndices: number[],
  ): FileMatches => {
    const lineMap = new Map<number, SearchLine>();
    for (const mIdx of keptIndices) {
      const from = Math.max(0, mIdx - contextLines);
      const to = Math.min(allLines.length - 1, mIdx + contextLines);
      for (let j = from; j <= to; j++) {
        const ln = j + 1;
        const prev = lineMap.get(ln);
        lineMap.set(ln, {
          lineNumber: ln,
          text: allLines[j]!,
          isMatch: j === mIdx || Boolean(prev?.isMatch),
        });
      }
    }
    return {
      file: relFile,
      lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber),
    };
  };

  const batchSize = 16;
  for (let i = 0; i < targetFiles.length && !truncated; i += batchSize) {
    const batch = targetFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (absFile): Promise<{ relFile: string; lines: string[]; matchedIndices: number[] } | null> => {
        try {
          const st = await fs.stat(absFile);
          if (st.size > 2 * 1024 * 1024) return null;
          const buf = await fs.readFile(absFile);
          if (isLikelyBinary(buf)) return null;
          const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");

          const matchedIndices: number[] = [];
          for (let idx = 0; idx < lines.length; idx++) {
            if (regex.test(lines[idx]!)) {
              matchedIndices.push(idx);
              if (matchedIndices.length >= 50) break;
            }
          }
          if (matchedIndices.length === 0) return null;

          const relFile =
            toPosixPath(path.relative(baseCwd, absFile)) || path.basename(absFile);
          return { relFile, lines, matchedIndices };
        } catch {
          return null;
        }
      }),
    );

    for (const item of results) {
      if (!item) continue;
      if (totalMatches + item.matchedIndices.length > maxResults) {
        const remaining = maxResults - totalMatches;
        if (remaining > 0) {
          const kept = item.matchedIndices.slice(0, remaining);
          files.push(buildFileMatches(item.relFile, item.lines, kept));
          totalMatches += kept.length;
        }
        truncated = true;
        break;
      }
      files.push(buildFileMatches(item.relFile, item.lines, item.matchedIndices));
      totalMatches += item.matchedIndices.length;
    }
  }

  return { files, totalMatches, truncated };
}

async function runGlobQuery(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
  isFileTarget: boolean,
): Promise<string> {
  const maxResults = clampInt(query.maxResults ?? 80, 1, 300);
  const pattern = query.pattern.trim() || "**/*";
  const matcher = globToRegExp(pattern);
  const matchBasename = !pattern.includes("/");

  if (isFileTarget) {
    const rel = toPosixPath(path.relative(baseCwd, searchRoot)) || path.basename(searchRoot);
    const base = path.basename(searchRoot);
    const matched = matcher.test(rel) || (matchBasename && matcher.test(base));
    return matched ? rel : "(no files matched)";
  }

  const walked = await walkFiles(searchRoot, {
    maxFiles: maxResults + 1,
    includeHidden: pattern.startsWith(".") || pattern.includes("/."),
    fileFilter: (relPosix) => {
      if (matcher.test(relPosix)) return true;
      if (matchBasename) {
        const base = relPosix.split("/").pop() ?? relPosix;
        return matcher.test(base);
      }
      return false;
    },
  });

  const relPrefix = toPosixPath(path.relative(baseCwd, searchRoot));
  const items = walked.files.slice(0, maxResults).map((f) => {
    if (!relPrefix || relPrefix === ".") return f;
    return `${relPrefix}/${f}`;
  });
  const truncated = walked.truncated || walked.files.length > maxResults;

  if (items.length === 0) {
    return "(no files matched)";
  }
  const suffix = truncated ? `\n... [truncated at ${maxResults} files]` : "";
  return `${items.join("\n")}${suffix}`;
}

async function runGitQuery(query: SearchQuery, searchRoot: string): Promise<string> {
  const gitArgs = validateReadonlyGitArgs(query.pattern);
  const res = await execBinaryAsync("git", ["--no-optional-locks", ...gitArgs], {
    cwd: searchRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 512 * 1024,
  });

  if (res.error) {
    throw new Error(`git execution error: ${res.error}`);
  }
  if (res.timedOut) {
    throw new Error("git query timed out");
  }
  if (res.exitCode !== 0) {
    const msg = (res.stderr || res.stdout).trim();
    throw new Error(msg || `git exited with code ${res.exitCode}`);
  }

  const out = res.stdout.trimEnd();
  return out || "(empty output)";
}

function formatFileMatches(
  files: FileMatches[],
  totalMatches: number,
  truncated: boolean,
): string {
  if (files.length === 0) {
    return "(no matches)";
  }
  const blocks: string[] = [];
  for (const fm of files) {
    const lines = fm.lines.map((l) => {
      const sep = l.isMatch ? ":" : "-";
      const text = l.text.length > 240 ? `${l.text.slice(0, 240)}...` : l.text;
      return `  ${l.lineNumber}${sep} ${text}`;
    });
    blocks.push(`${fm.file}\n${lines.join("\n")}`);
  }
  const footer = truncated ? `\n... [truncated at ${totalMatches} matches]` : "";
  return `${blocks.join("\n")}${footer}`;
}

async function executeSingleQuery(
  query: SearchQuery,
  index: number,
  baseCwd: string,
  useRg: boolean,
): Promise<string> {
  const header = `## Query ${index + 1} [${query.type}] ${query.pattern}${query.path ? ` (in ${query.path})` : ""}`;
  try {
    if (!query.pattern || typeof query.pattern !== "string") {
      throw new Error("Query 'pattern' must be a non-empty string");
    }
    const searchRoot = query.path ? resolvePath(query.path, baseCwd) : baseCwd;
    let targetStat;
    try {
      targetStat = await fs.stat(searchRoot);
    } catch {
      throw new Error(`Path does not exist: ${query.path || baseCwd}`);
    }

    if (query.type === "git") {
      const gitCwd = targetStat.isFile() ? path.dirname(searchRoot) : searchRoot;
      const out = await runGitQuery(query, gitCwd);
      return `${header}\n${out}`;
    }

    if (query.type === "glob") {
      const out = await runGlobQuery(query, searchRoot, baseCwd, targetStat.isFile());
      return `${header}\n${out}`;
    }

    if (query.type === "text" || query.type === "regex") {
      let res;
      if (useRg) {
        try {
          res = await runTextOrRegexWithRg(query, searchRoot, baseCwd);
        } catch (err) {
          // Only fallback on spawn error; surface regex errors directly
          if (err instanceof Error && err.message.startsWith("rg spawn error:")) {
            res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
          } else {
            throw err;
          }
        }
      } else {
        res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
      }
      return `${header}\n${formatFileMatches(res.files, res.totalMatches, res.truncated)}`;
    }

    throw new Error(`Unsupported query type: ${String(query.type)}`);
  } catch (err) {
    return `${header}\nERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function runBatchSearch(
  input: BatchSearchInput,
  options: BatchSearchRuntimeOptions = {},
): Promise<{ text: string; isError: boolean }> {
  if (!Array.isArray(input.queries) || input.queries.length === 0) {
    return {
      text: "Error: 'queries' must be a non-empty array of search queries.",
      isError: true,
    };
  }
  if (input.queries.length > 20) {
    return {
      text: "Error: 'queries' supports at most 20 queries per call.",
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

  const maxChars = clampInt(input.maxChars ?? 12_000, 500, 60_000);
  const needsTextSearch = input.queries.some(
    (q) => q.type === "text" || q.type === "regex",
  );
  const useRg =
    needsTextSearch && !options.forceNodeFallback && (await isRipgrepAvailable());

  const sections = await Promise.all(
    input.queries.map((q, idx) => executeSingleQuery(q, idx, baseCwd, useRg)),
  );

  // Allocate budget fairly across queries via water-filling within maxChars
  return { text: fitSectionsToBudget(sections, maxChars, "\n\n"), isError: false };
}

function clampInt(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.trunc(val)));
}

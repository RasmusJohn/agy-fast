import path from "node:path";
import { readTextFile, resolvePath, toPosixPath } from "../utils/fs-utils.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  fitSectionsToByteBudget,
} from "../utils/output-filter.js";

export interface SliceRequest {
  path: string;
  ranges: Array<[number, number]>;
}

export interface ReadSlicesInput {
  cwd?: string;
  outlines?: string[];
  slices?: SliceRequest[];
  maxChars?: number;
}

export interface SymbolEntry {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
  depth: number;
}

type BraceLang = "js" | "c" | "shell" | "json";

interface ScanState {
  inBlockComment: boolean;
  templateExprStack: number[]; // tracks open `{` depth inside `${...}` of nested template strings
  inBacktick: boolean;
}

function isRegexStartContext(line: string, slashIdx: number): boolean {
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j]!)) j--;
  if (j < 0) return true;
  const prev = line[j]!;
  if ("=(,:![&|?{};~+-*%^<>".includes(prev)) return true;
  // Check preceding keyword (return, case, throw, in, of, typeof, void, delete, new)
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(line[k]!)) k--;
  const word = line.slice(k + 1, j + 1);
  return (
    word === "return" ||
    word === "case" ||
    word === "throw" ||
    word === "in" ||
    word === "of" ||
    word === "typeof" ||
    word === "void" ||
    word === "delete" ||
    word === "new"
  );
}

function scanBracesOnLine(
  line: string,
  state: ScanState,
  lang: BraceLang,
): { open: number; close: number; openParen: number; closeParen: number; endsWithSemi: boolean } {
  let open = 0;
  let close = 0;
  let openParen = 0;
  let closeParen = 0;
  let inSingle = false;
  let inDouble = false;
  let inRegex = false;
  let inRegexClass = false;
  let escape = false;
  let lastCodeChar = "";

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const next = line[i + 1];

    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }

    if (inRegex) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === "[") {
        inRegexClass = true;
      } else if (ch === "]") {
        inRegexClass = false;
      } else if (ch === "/" && !inRegexClass) {
        inRegex = false;
        lastCodeChar = "/";
      }
      continue;
    }

    if (state.inBacktick) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === "`") {
        state.inBacktick = false;
        lastCodeChar = "`";
      } else if (lang === "js" && ch === "$" && next === "{") {
        state.inBacktick = false;
        state.templateExprStack.push(0);
        i++;
      }
      continue;
    }

    if (inSingle) {
      if (ch === "\\") escape = true;
      else if (ch === "'") {
        inSingle = false;
        lastCodeChar = "'";
      }
      continue;
    }

    if (inDouble) {
      if (ch === "\\") escape = true;
      else if (ch === '"') {
        inDouble = false;
        lastCodeChar = '"';
      }
      continue;
    }

    // Comments
    if (lang === "shell" && ch === "#") break;
    if ((lang === "js" || lang === "c") && ch === "/" && next === "/") break;
    if ((lang === "js" || lang === "c") && ch === "/" && next === "*") {
      state.inBlockComment = true;
      i++;
      continue;
    }

    // Regex literal (JS/TS only)
    if (lang === "js" && ch === "/" && next !== "/" && next !== "*" && isRegexStartContext(line, i)) {
      inRegex = true;
      inRegexClass = false;
      continue;
    }

    if (ch === "'" && lang !== "json") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`" && (lang === "js" || lang === "c")) {
      state.inBacktick = true;
      continue;
    }

    if (ch === "{") {
      if (state.templateExprStack.length > 0) {
        state.templateExprStack[state.templateExprStack.length - 1]! += 1;
      } else {
        open++;
      }
      lastCodeChar = "{";
    } else if (ch === "}") {
      if (state.templateExprStack.length > 0) {
        const top = state.templateExprStack[state.templateExprStack.length - 1]!;
        if (top === 0) {
          state.templateExprStack.pop();
          state.inBacktick = true;
        } else {
          state.templateExprStack[state.templateExprStack.length - 1] = top - 1;
        }
      } else {
        close++;
      }
      lastCodeChar = "}";
    } else if (ch === "(") {
      openParen++;
      lastCodeChar = "(";
    } else if (ch === ")") {
      closeParen++;
      lastCodeChar = ")";
    } else if (!/\s/.test(ch)) {
      lastCodeChar = ch;
    }
  }

  return {
    open,
    close,
    openParen,
    closeParen,
    endsWithSemi: lastCodeChar === ";",
  };
}

function findBraceBlockEnd(
  lines: string[],
  startIdx: number,
  lang: BraceLang = "c",
): number {
  let depth = 0;
  let parenDepth = 0;
  let seenOpen = false;
  const state: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
  };
  const maxScan = Math.min(lines.length, startIdx + 2000);

  for (let i = startIdx; i < maxScan; i++) {
    const { open, close, openParen, closeParen, endsWithSemi } = scanBracesOnLine(
      lines[i]!,
      state,
      lang,
    );
    if (open > 0) seenOpen = true;
    depth += open - close;
    parenDepth += openParen - closeParen;
    if (seenOpen && depth <= 0) {
      return i + 1;
    }
    if (!seenOpen && parenDepth <= 0 && endsWithSemi) {
      return i + 1;
    }
    // Multiline signature without opening brace after 15 lines
    if (!seenOpen && i > startIdx + 15) {
      return startIdx + 1;
    }
  }
  return seenOpen ? Math.min(lines.length, maxScan) : startIdx + 1;
}

function hasArrowOrBraceWithin(lines: string[], startIdx: number, maxLookahead = 12): { hasArrow: boolean; hasBrace: boolean } {
  const state: ScanState = { inBlockComment: false, templateExprStack: [], inBacktick: false };
  let parenDepth = 0;
  let seenParen = false;
  let hasArrow = false;
  const end = Math.min(lines.length, startIdx + maxLookahead);
  for (let i = startIdx; i < end; i++) {
    const line = lines[i]!;
    const { open, openParen, closeParen, endsWithSemi } = scanBracesOnLine(line, state, "js");
    if (openParen > 0) seenParen = true;
    parenDepth += openParen - closeParen;
    if (line.includes("=>")) hasArrow = true;
    if (open > 0 && (!seenParen || parenDepth <= 0)) {
      return { hasArrow, hasBrace: true };
    }
    if (seenParen && parenDepth <= 0 && endsWithSemi) {
      return { hasArrow, hasBrace: false };
    }
  }
  return { hasArrow, hasBrace: false };
}

function extractTsJsSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const patterns: Array<{ re: RegExp; kind: string; nameGroup: number }> = [
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      kind: "class",
      nameGroup: 1,
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      kind: "interface",
      nameGroup: 1,
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
      kind: "type",
      nameGroup: 1,
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
      kind: "enum",
      nameGroup: 1,
    },
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
      kind: "function",
      nameGroup: 1,
    },
    {
      re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
      kind: "function",
      nameGroup: 1,
    },
  ];
  const multilineArrowStartRe =
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(/;

  const methodHeaderRe =
    /^([ \t]{1,4})(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
  const controlKeywords = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "try",
    "return",
    "new",
    "throw",
    "await",
    "super",
    "typeof",
    "delete",
  ]);

  let currentClassEnd = -1;
  let currentClassIndent = -1;
  const commentState: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const wasInComment = commentState.inBlockComment;
    scanBracesOnLine(line, commentState, "js");
    if (wasInComment) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    let matchedTop = false;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      for (const p of patterns) {
        const m = p.re.exec(line);
        if (m && m[p.nameGroup]) {
          const endLine = findBraceBlockEnd(lines, i, "js");
          symbols.push({
            kind: p.kind,
            name: m[p.nameGroup]!,
            startLine: i + 1,
            endLine,
            depth: 0,
          });
          if (p.kind === "class") {
            currentClassEnd = endLine;
            currentClassIndent = -1;
          }
          matchedTop = true;
          break;
        }
      }

      if (!matchedTop) {
        const ma = multilineArrowStartRe.exec(line);
        if (ma && ma[1]) {
          const { hasArrow } = hasArrowOrBraceWithin(lines, i, 12);
          if (hasArrow) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "function",
              name: ma[1],
              startLine: i + 1,
              endLine,
              depth: 0,
            });
            matchedTop = true;
          }
        }
      }
    }

    if (!matchedTop && i + 1 <= currentClassEnd) {
      const mm = methodHeaderRe.exec(line);
      if (mm && mm[1] && mm[2] && !controlKeywords.has(mm[2])) {
        const indentWidth = mm[1].replace(/\t/g, "  ").length;
        if (currentClassIndent === -1) {
          currentClassIndent = indentWidth;
        }
        if (indentWidth === currentClassIndent) {
          const { hasBrace } = hasArrowOrBraceWithin(lines, i, 10);
          if (hasBrace) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "method",
              name: mm[2],
              startLine: i + 1,
              endLine,
              depth: 1,
            });
          }
        }
      }
    }
  }

  return symbols;
}

function extractPythonSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const re = /^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;

  // Pre-compute whether each line starts inside a triple-quoted multiline string
  const inTripleString = new Array<boolean>(lines.length).fill(false);
  let activeQuote: '"""' | "'''" | null = null;
  for (let i = 0; i < lines.length; i++) {
    inTripleString[i] = activeQuote !== null;
    const line = lines[i]!;
    let j = 0;
    while (j < line.length) {
      if (activeQuote) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeQuote, j)) {
          activeQuote = null;
          j += 3;
          continue;
        }
        j++;
      } else {
        if (line[j] === "#") break;
        if (line.startsWith('"""', j)) {
          activeQuote = '"""';
          j += 3;
          continue;
        }
        if (line.startsWith("'''", j)) {
          activeQuote = "'''";
          j += 3;
          continue;
        }
        if (line[j] === '"' || line[j] === "'") {
          const q = line[j]!;
          j++;
          while (j < line.length && line[j] !== q) {
            if (line[j] === "\\") j += 2;
            else j++;
          }
          j++;
          continue;
        }
        j++;
      }
    }
  }

  const raw: Array<{ indent: number; kind: string; name: string; startIdx: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (inTripleString[i]) continue;
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.replace(/\t/g, "    ").length;
    const kind = m[2] === "class" ? "class" : indent > 0 ? "method" : "function";
    raw.push({ indent, kind, name: m[3]!, startIdx: i });
  }

  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx]!;
    let endIdx = lines.length - 1;
    for (let j = item.startIdx + 1; j < lines.length; j++) {
      if (inTripleString[j]) continue;
      const l = lines[j]!;
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
      if (curIndent <= item.indent) {
        endIdx = j - 1;
        break;
      }
    }
    while (endIdx > item.startIdx && !lines[endIdx]!.trim()) {
      endIdx--;
    }
    symbols.push({
      kind: item.kind,
      name: item.name,
      startLine: item.startIdx + 1,
      endLine: endIdx + 1,
      depth: item.indent > 0 ? 1 : 0,
    });
  }

  return symbols;
}

function extractGoSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const funcRe = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_]\w*)/;
  const typeRe = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fm = funcRe.exec(line);
    if (fm && fm[2]) {
      const recv = fm[1]?.trim();
      const name = recv ? `(${recv}) ${fm[2]}` : fm[2];
      symbols.push({
        kind: recv ? "method" : "function",
        name,
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: 0,
      });
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[1] && tm[2]) {
      symbols.push({
        kind: tm[2],
        name: tm[1],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: 0,
      });
    }
  }
  return symbols;
}

function extractRustSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const re =
    /^([ \t]*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][\w:<>,\s]*?)(?:\s*[\({;]|$)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = re.exec(line);
    if (!m || !m[2] || !m[3]) continue;
    const indent = m[1]!.length;
    if (indent > 4) continue;
    symbols.push({
      kind: m[2],
      name: m[3].trim(),
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "c"),
      depth: indent > 0 ? 1 : 0,
    });
  }
  return symbols;
}

function extractCLikeSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const typeRe =
    /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|export|partial)\s+)*(class|interface|enum|struct|record|protocol|namespace)\s+([A-Za-z_]\w*)/;
  const kwFuncRe =
    /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|override|virtual|inline|async|suspend|open|mutating)\s+)*(?:fun|func)\s+([A-Za-z_]\w*)/;
  // C / C++ / Java / C# functions and class methods (return-type + name + '(')
  const cMethodRe =
    /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|inline|constexpr|extern|async|synchronized|native|unsigned|signed|const)\s+)*(?:[A-Za-z_~][\w:<>,\[\]\s*&]*?\s+)([A-Za-z_~][\w:]*)\s*\([^;]*$/;
  const excludedNames = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "return",
    "sizeof",
    "alignof",
    "decltype",
    "new",
    "delete",
    "throw",
    "typedef",
    "using",
    "case",
  ]);

  const commentState: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const wasInComment = commentState.inBlockComment;
    scanBracesOnLine(line, commentState, "c");
    if (wasInComment) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
      continue;
    }

    const tm = typeRe.exec(line);
    if (tm && tm[2] && tm[3]) {
      const indented = (tm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: tm[2],
        name: tm[3],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0,
      });
      continue;
    }
    const fm = kwFuncRe.exec(line);
    if (fm && fm[2]) {
      const indented = (fm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: indented ? "method" : "function",
        name: fm[2],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0,
      });
      continue;
    }

    // Match C/C++/Java/C# function/method definitions that open a brace block
    const cm = cMethodRe.exec(line);
    if (cm && cm[2] && !excludedNames.has(cm[2]) && !trimmed.includes("=")) {
      const { hasBrace } = hasArrowOrBraceWithin(lines, i, 8);
      if (hasBrace) {
        const indented = (cm[1]?.length ?? 0) > 0;
        symbols.push({
          kind: indented ? "method" : "function",
          name: cm[2],
          startLine: i + 1,
          endLine: findBraceBlockEnd(lines, i, "c"),
          depth: indented ? 1 : 0,
        });
      }
    }
  }
  return symbols;
}

function extractShellSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const re = /^(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name) continue;
    symbols.push({
      kind: "function",
      name,
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "shell"),
      depth: 0,
    });
  }
  return symbols;
}

function extractMarkdownSymbols(lines: string[]): SymbolEntry[] {
  const raw: Array<{ level: number; name: string; startLine: number }> = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (m && m[1] && m[2]) {
      raw.push({ level: m[1].length, name: m[2], startLine: i + 1 });
    }
  }

  return raw.map((item, idx) => {
    let endLine = lines.length;
    for (let j = idx + 1; j < raw.length; j++) {
      if (raw[j]!.level <= item.level) {
        endLine = raw[j]!.startLine - 1;
        break;
      }
    }
    return {
      kind: `h${item.level}`,
      name: item.name,
      startLine: item.startLine,
      endLine: Math.max(item.startLine, endLine),
      depth: item.level - 1,
    };
  });
}

function extractJsonYamlSymbols(lines: string[], isJson: boolean): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  if (isJson) {
    // Detect top-level key indentation dynamically (supports 2-space, 4-space, or tabs)
    let keyIndent: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /^([ \t]+)"([^"]+)"\s*:/.exec(lines[i]!);
      if (m && m[1] && m[2]) {
        if (keyIndent === null) {
          keyIndent = m[1];
        }
        if (m[1] === keyIndent) {
          symbols.push({
            kind: "key",
            name: m[2],
            startLine: i + 1,
            endLine: i + 1,
            depth: 0,
          });
        }
      }
    }
    for (let idx = 0; idx < symbols.length; idx++) {
      const cur = symbols[idx]!;
      const nextStart =
        idx + 1 < symbols.length ? symbols[idx + 1]!.startLine - 1 : lines.length - 1;
      let endLine = Math.max(cur.startLine, nextStart);
      while (endLine > cur.startLine && /^\s*[}\]]?,?\s*$/.test(lines[endLine - 1] ?? "") && idx === symbols.length - 1) {
        endLine--;
      }
      cur.endLine = endLine;
    }
    return symbols;
  }

  // YAML top-level keys
  const re = /^([A-Za-z0-9_.-]+)\s*:/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (m && m[1]) {
      symbols.push({
        kind: "key",
        name: m[1],
        startLine: i + 1,
        endLine: i + 1,
        depth: 0,
      });
    }
  }
  for (let idx = 0; idx < symbols.length; idx++) {
    const cur = symbols[idx]!;
    let endLine =
      idx + 1 < symbols.length ? symbols[idx + 1]!.startLine - 1 : lines.length;
    while (endLine > cur.startLine && !(lines[endLine - 1] ?? "").trim()) {
      endLine--;
    }
    cur.endLine = Math.max(cur.startLine, endLine);
  }
  return symbols;
}

function extractSymbolsFromLines(filePath: string, lines: string[]): SymbolEntry[] {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return extractTsJsSymbols(lines);
    case ".py":
      return extractPythonSymbols(lines);
    case ".go":
      return extractGoSymbols(lines);
    case ".rs":
      return extractRustSymbols(lines);
    case ".java":
    case ".kt":
    case ".kts":
    case ".cs":
    case ".swift":
    case ".c":
    case ".cc":
    case ".cpp":
    case ".h":
    case ".hpp":
      return extractCLikeSymbols(lines);
    case ".sh":
    case ".bash":
    case ".zsh":
      return extractShellSymbols(lines);
    case ".md":
    case ".mdx":
      return extractMarkdownSymbols(lines);
    case ".json":
      return extractJsonYamlSymbols(lines, true);
    case ".yaml":
    case ".yml":
      return extractJsonYamlSymbols(lines, false);
    default:
      return extractTsJsSymbols(lines);
  }
}

export function extractSymbols(filePath: string, content: string): SymbolEntry[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return extractSymbolsFromLines(filePath, lines);
}

export async function runReadSlices(
  input: ReadSlicesInput,
): Promise<{ text: string; isError: boolean }> {
  const outlines = Array.isArray(input.outlines) ? input.outlines : [];
  const slices = Array.isArray(input.slices) ? input.slices : [];

  if (outlines.length === 0 && slices.length === 0) {
    return {
      text: "Error: provide at least one entry in 'outlines' or 'slices'.",
      isError: true,
    };
  }
  if (outlines.length > 20 || slices.length > 30) {
    return {
      text: "Error: limits exceeded (max 20 outlines and 30 slice files per call).",
      isError: true,
    };
  }

  const baseCwd = resolvePath(input.cwd || process.cwd());
  const maxChars = Math.max(
    1000,
    Math.min(80_000, Math.trunc(input.maxChars ?? 8_500)),
  );
  const maxBytes =
    input.maxChars === undefined ? DEFAULT_INLINE_MAX_BYTES : undefined;

  const fileCache = new Map<string, { lines: string[]; size: number }>();
  async function loadLines(absPath: string): Promise<{ lines: string[]; size: number }> {
    const cached = fileCache.get(absPath);
    if (cached) return cached;
    const data = await readTextFile(absPath);
    const lines = data.content.replace(/\r\n/g, "\n").split("\n");
    const entry = { lines, size: data.size };
    fileCache.set(absPath, entry);
    return entry;
  }

  const sections: string[] = [];

  // Process outlines concurrently
  if (outlines.length > 0) {
    const outlineResults = await Promise.all(
      outlines.map(async (rawPath) => {
        const absPath = resolvePath(rawPath, baseCwd);
        const relPath =
          toPosixPath(path.relative(baseCwd, absPath)) || path.basename(absPath);
        try {
          const { lines } = await loadLines(absPath);
          const symbols = extractSymbolsFromLines(absPath, lines);
          if (symbols.length === 0) {
            return `## Outline: ${relPath} (${lines.length} lines)\n(no top-level symbols detected)`;
          }
          const formatted = symbols.slice(0, 120).map((s) => {
            const indent = "  ".repeat(s.depth);
            const span =
              s.endLine > s.startLine
                ? `L${s.startLine}-L${s.endLine}`
                : `L${s.startLine}`;
            return `${indent}${span} [${s.kind}] ${s.name}`;
          });
          const extra =
            symbols.length > 120
              ? `\n... (${symbols.length - 120} more symbols omitted)`
              : "";
          return `## Outline: ${relPath} (${lines.length} lines)\n${formatted.join("\n")}${extra}`;
        } catch (err) {
          return `## Outline: ${relPath}\nERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      }),
    );
    sections.push(...outlineResults);
  }

  // Process slices concurrently
  if (slices.length > 0) {
    const sliceResults = await Promise.all(
      slices.map(async (req) => {
        if (!req || typeof req.path !== "string" || !req.path.trim()) {
          return "## Slice: (invalid)\nERROR: 'path' must be a non-empty string";
        }
        const absPath = resolvePath(req.path, baseCwd);
        const relPath =
          toPosixPath(path.relative(baseCwd, absPath)) || path.basename(absPath);

        if (!Array.isArray(req.ranges) || req.ranges.length === 0) {
          return `## Slice: ${relPath}\nERROR: 'ranges' must be a non-empty array of [startLine, endLine] pairs`;
        }

        try {
          const { lines } = await loadLines(absPath);
          const totalLines = lines.length;
          const blocks: string[] = [];

          for (const range of req.ranges) {
            if (!Array.isArray(range) || range.length < 2) {
              blocks.push("ERROR: each range must be [startLine, endLine]");
              continue;
            }
            const rawStart = Math.trunc(Number(range[0]));
            const rawEnd = Math.trunc(Number(range[1]));
            if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
              blocks.push(`ERROR: invalid range [${String(range[0])}, ${String(range[1])}]`);
              continue;
            }
            const start = Math.max(1, rawStart);
            const end = Math.min(totalLines, rawEnd);
            if (start > totalLines) {
              blocks.push(
                `--- L${rawStart}-L${rawEnd} (out of bounds; file has ${totalLines} lines) ---`,
              );
              continue;
            }
            if (end < start) {
              blocks.push(
                `ERROR: startLine (${rawStart}) > endLine (${rawEnd})`,
              );
              continue;
            }

            const width = String(end).length;
            const snippet: string[] = [`--- L${start}-L${end} (of ${totalLines}) ---`];
            for (let ln = start; ln <= end; ln++) {
              const num = String(ln).padStart(width, " ");
              snippet.push(`${num}: ${lines[ln - 1] ?? ""}`);
            }
            blocks.push(snippet.join("\n"));
          }

          return `## Slice: ${relPath} (${totalLines} lines)\n${blocks.join("\n")}`;
        } catch (err) {
          return `## Slice: ${relPath}\nERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      }),
    );
    sections.push(...sliceResults);
  }

  return {
    text: fitSectionsToByteBudget(sections, maxChars, maxBytes, "\n\n"),
    isError: false,
  };
}

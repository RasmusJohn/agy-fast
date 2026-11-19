#!/usr/bin/env node
// agy-fast Offline Transcript Benchmark CLI


// src/benchmark.ts
import { promises as fs2 } from "node:fs";
import os from "node:os";
import path2 from "node:path";

// src/benchmark-core.ts
import { promises as fs } from "node:fs";
import path from "node:path";
var BLOCKING_TOOLS = /* @__PURE__ */ new Set([
  "ask_question",
  "swarm_wait",
  "schedule",
  "manage_subagents",
  "wait_for_subagents"
]);
var READONLY_SIMPLE_CMDS = /* @__PURE__ */ new Set([
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ls",
  "tree",
  "wc",
  "head",
  "tail",
  "cat",
  "stat",
  "file"
]);
var BENIGN_GLUE_CMDS = /* @__PURE__ */ new Set([
  "cd",
  "true",
  ":",
  "echo",
  "printf",
  "pwd",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "column",
  "rev",
  "paste",
  "fold",
  "basename",
  "dirname",
  "less",
  "more"
]);
var FIND_MUTATING_ARGS = /* @__PURE__ */ new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls"
]);
var FD_MUTATING_ARGS = /* @__PURE__ */ new Set(["-x", "--exec", "-X", "--exec-batch"]);
var GIT_GLOBAL_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env"
]);
var GIT_GLOBAL_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--no-pager",
  "-P",
  "--paginate",
  "-p",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks"
]);
var GIT_ALWAYS_READONLY_SUBCMDS = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "grep",
  "blame",
  "shortlog",
  "describe",
  "ls-tree",
  "cat-file",
  "rev-list",
  "show-ref",
  "for-each-ref",
  "name-rev",
  "merge-base",
  "check-ignore"
]);
var GIT_BRANCH_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
  "--abbrev",
  "--color",
  "--column"
]);
var KNOWN_SYSTEM_BIN_PREFIXES = [
  "/bin/",
  "/usr/bin/",
  "/usr/local/bin/",
  "/opt/homebrew/bin/"
];
var AGY_FAST_TOOL_RE = /(?:^|[_:./-])(batch_search|apply_edits|read_slices|run_checks)$/;
function parseTimeMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
function unwrapJsonString(val) {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
    }
  } else if (trimmed.startsWith('"') && /<truncated \d+ bytes>$/.test(trimmed)) {
    const withoutTrailer = trimmed.slice(1).replace(/\r?\n?<truncated \d+ bytes>$/, "");
    return withoutTrailer.replace(
      /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g,
      (_m, hex, ch) => {
        if (hex !== void 0) {
          return String.fromCharCode(Number.parseInt(hex, 16));
        }
        switch (ch) {
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "	";
          case "b":
            return "\b";
          case "f":
            return "\f";
          default:
            return ch ?? "";
        }
      }
    );
  }
  return val;
}
function getCallArgs(call) {
  const raw = call.args ?? call.arguments;
  if (!raw) return void 0;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return void 0;
    }
    return void 0;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  return void 0;
}
function getCommandString(args) {
  if (!args) return "";
  const val = args.CommandLine ?? args.commandLine ?? args.command ?? args.cmd ?? "";
  return unwrapJsonString(val);
}
function getTargetPath(args) {
  if (!args) return "";
  const val = args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.file_path ?? args.filePath ?? "";
  return unwrapJsonString(val);
}
function parseSafeShellSegments(cmd) {
  const segments = [];
  let current = [];
  const len = cmd.length;
  let i = 0;
  const pushSegment = () => {
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };
  const readWord = () => {
    let value = "";
    let quoted = false;
    let hasChars = false;
    let isEnvAssign = false;
    while (i < len) {
      const ch = cmd[i];
      if (ch === "'") {
        quoted = true;
        hasChars = true;
        i += 1;
        while (i < len && cmd[i] !== "'") {
          value += cmd[i];
          i += 1;
        }
        if (i < len) i += 1;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        hasChars = true;
        i += 1;
        while (i < len && cmd[i] !== '"') {
          const inner = cmd[i];
          if (inner === "\\" && i + 1 < len) {
            const nxt = cmd[i + 1];
            if (nxt === "\n") {
              i += 2;
              continue;
            }
            if (nxt === '"' || nxt === "\\" || nxt === "$" || nxt === "`") {
              value += nxt;
              i += 2;
              continue;
            }
          }
          if (inner === "`" || inner === "$" && cmd[i + 1] === "(") {
            return null;
          }
          value += inner;
          i += 1;
        }
        if (i < len) i += 1;
        continue;
      }
      if (ch === "\\") {
        if (i + 1 < len) {
          const nxt = cmd[i + 1];
          if (nxt === "\n") {
            i += 2;
            continue;
          }
          if (nxt === "\r" && cmd[i + 2] === "\n") {
            i += 3;
            continue;
          }
          value += nxt;
          hasChars = true;
          i += 2;
          continue;
        }
        value += ch;
        hasChars = true;
        i += 1;
        continue;
      }
      if (ch === "`" || ch === "$" && cmd[i + 1] === "(") {
        return null;
      }
      if (ch === " " || ch === "	" || ch === "\r" || ch === "\n" || ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">" || ch === "(" || ch === ")") {
        break;
      }
      if (ch === "=" && !quoted && !isEnvAssign && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        isEnvAssign = true;
      }
      value += ch;
      hasChars = true;
      i += 1;
    }
    return hasChars ? { value, quoted, isEnvAssign } : { value: "", quoted: false, isEnvAssign: false };
  };
  while (i < len) {
    const ch = cmd[i];
    if (ch === " " || ch === "	") {
      i += 1;
      continue;
    }
    if (ch === "\\" && (cmd[i + 1] === "\n" || cmd[i + 1] === "\r" && cmd[i + 2] === "\n")) {
      i += cmd[i + 1] === "\r" ? 3 : 2;
      continue;
    }
    if (ch === "#") {
      while (i < len && cmd[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";") {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === "|") {
      pushSegment();
      i += cmd[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      if (cmd[i + 1] === "&") {
        pushSegment();
        i += 2;
        continue;
      }
      if (cmd[i + 1] === ">") {
        i += cmd[i + 2] === ">" ? 3 : 2;
        while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
        const target = readWord();
        if (!target || target.value !== "/dev/null") return null;
        continue;
      }
      return null;
    }
    if (ch === "(" || ch === ")") {
      return null;
    }
    let savedPos = i;
    let hasFdPrefix = false;
    while (i < len && cmd[i] >= "0" && cmd[i] <= "9") {
      i += 1;
      hasFdPrefix = true;
    }
    if (hasFdPrefix && (cmd[i] === ">" || cmd[i] === "<")) {
    } else {
      i = savedPos;
    }
    const op = cmd[i];
    if (op === ">") {
      i += 1;
      if (cmd[i] === "&") {
        i += 1;
        while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
        const target2 = readWord();
        if (!target2 || !/^(?:\d+|-)$/.test(target2.value)) return null;
        continue;
      }
      if (cmd[i] === ">" || cmd[i] === "|") i += 1;
      while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
      const target = readWord();
      if (!target || target.value !== "/dev/null") return null;
      continue;
    }
    if (op === "<") {
      if (cmd[i + 1] === "<") {
        if (cmd[i + 2] === "<") {
          i += 3;
          while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
          const word = readWord();
          if (!word) return null;
          continue;
        }
        return null;
      }
      if (cmd[i + 1] === ">") {
        return null;
      }
      i += 1;
      if (cmd[i] === "&") i += 1;
      while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
      const target = readWord();
      if (!target) return null;
      continue;
    }
    const tok = readWord();
    if (!tok) return null;
    if (tok.value.length > 0 || tok.quoted) {
      current.push(tok);
    }
  }
  pushSegment();
  return segments;
}
function normalizeCommandName(raw) {
  for (const prefix of KNOWN_SYSTEM_BIN_PREFIXES) {
    if (raw.startsWith(prefix)) {
      const rest = raw.slice(prefix.length);
      if (rest && !rest.includes("/")) return rest;
    }
  }
  return raw;
}
function isSedMutating(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a === "--in-place" || a.startsWith("--in-place=")) return true;
    if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
      i += 1;
      continue;
    }
    if (a.startsWith("-") && !a.startsWith("--") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const flag = a[j];
        if (flag === "e" || flag === "f") break;
        if (flag === "i") return true;
      }
    }
  }
  return false;
}
function isAwkMutating(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a === "-i" && args[i + 1] === "inplace") return true;
    if (a === "-iinplace" || a === "--include=inplace") return true;
    if (a === "--include" && args[i + 1] === "inplace") return true;
  }
  return false;
}
function isReadonlyGitBranch(args) {
  let explicitList = false;
  let positionalCount = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionalCount += args.length - i - 1;
      break;
    }
    if (a === "--list") {
      explicitList = true;
      continue;
    }
    if (a === "--delete" || a === "--move" || a === "--copy" || a === "--force" || a === "--unset-upstream" || a === "--edit-description" || a === "--create-reflog" || a === "--track" || a === "--no-track" || a === "--set-upstream-to" || a.startsWith("--set-upstream-to=")) {
      return false;
    }
    if (GIT_BRANCH_VALUE_FLAGS.has(a)) {
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (a.startsWith("--")) {
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (/[dDmMcCfu]/.test(a.slice(1))) return false;
      if (a.slice(1).includes("l")) explicitList = true;
      continue;
    }
    positionalCount += 1;
  }
  return explicitList || positionalCount === 0;
}
function isReadonlyGitRemote(args) {
  for (const a of args) {
    if (a === "-v" || a === "--verbose") continue;
    if (a === "show" || a === "get-url") return true;
    return false;
  }
  return true;
}
function isReadonlyGitTag(args) {
  let explicitList = false;
  let positionalCount = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionalCount += args.length - i - 1;
      break;
    }
    if (a === "-l" || a === "--list") {
      explicitList = true;
      continue;
    }
    if (a === "--delete" || a === "--annotate" || a === "--sign" || a === "--force" || a === "--message" || a.startsWith("--message=") || a === "--file" || a.startsWith("--file=") || a === "--local-user" || a.startsWith("--local-user=")) {
      return false;
    }
    if (a.startsWith("-") && !a.startsWith("--") && a.length > 1) {
      if (/[dasufmFv]/.test(a.slice(1))) return false;
      if (a.slice(1).includes("l")) explicitList = true;
      continue;
    }
    if (a.startsWith("--")) continue;
    positionalCount += 1;
  }
  return explicitList || positionalCount === 0;
}
function isReadonlyGit(args) {
  let idx = 0;
  while (idx < args.length) {
    const a = args[idx];
    if (!a.startsWith("-")) break;
    if (GIT_GLOBAL_BOOL_FLAGS.has(a)) {
      idx += 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(a)) {
      idx += 2;
      continue;
    }
    if (a.startsWith("-C") && a.length > 2 || a.startsWith("-c") && a.length > 2 || a.startsWith("--git-dir=") || a.startsWith("--work-tree=") || a.startsWith("--namespace=") || a.startsWith("--super-prefix=") || a.startsWith("--config-env=")) {
      idx += 1;
      continue;
    }
    return false;
  }
  const subcmd = args[idx];
  if (!subcmd) return false;
  const subArgs = args.slice(idx + 1);
  if (GIT_ALWAYS_READONLY_SUBCMDS.has(subcmd)) {
    if (subArgs.some((a) => a === "--output" || a.startsWith("--output="))) {
      return false;
    }
    return true;
  }
  if (subcmd === "branch") return isReadonlyGitBranch(subArgs);
  if (subcmd === "remote") return isReadonlyGitRemote(subArgs);
  if (subcmd === "tag") return isReadonlyGitTag(subArgs);
  return false;
}
function classifyShellSegment(tokens) {
  let idx = 0;
  while (idx < tokens.length && tokens[idx].isEnvAssign) {
    idx += 1;
  }
  if (idx >= tokens.length) return "benign_glue";
  if (normalizeCommandName(tokens[idx].value) === "env") {
    idx += 1;
    while (idx < tokens.length) {
      const t = tokens[idx];
      if (t.value === "--") {
        idx += 1;
        break;
      }
      if (t.value === "-i") {
        idx += 1;
        continue;
      }
      if (t.value === "-u" && idx + 1 < tokens.length) {
        idx += 2;
        continue;
      }
      if (t.isEnvAssign) {
        idx += 1;
        continue;
      }
      if (t.value.startsWith("-")) return "other";
      break;
    }
    if (idx >= tokens.length) return "other";
  }
  const cmdName = normalizeCommandName(tokens[idx].value);
  const args = tokens.slice(idx + 1).map((t) => t.value);
  if (READONLY_SIMPLE_CMDS.has(cmdName)) return "readonly_search";
  if (cmdName === "find") {
    return args.some((a) => FIND_MUTATING_ARGS.has(a)) ? "other" : "readonly_search";
  }
  if (cmdName === "fd") {
    return args.some(
      (a) => FD_MUTATING_ARGS.has(a) || a.startsWith("--exec=") || a.startsWith("--exec-batch=")
    ) ? "other" : "readonly_search";
  }
  if (cmdName === "sed") {
    return isSedMutating(args) ? "other" : "readonly_search";
  }
  if (cmdName === "awk" || cmdName === "gawk") {
    return isAwkMutating(args) ? "other" : "readonly_search";
  }
  if (cmdName === "git") {
    return isReadonlyGit(args) ? "readonly_search" : "other";
  }
  if (BENIGN_GLUE_CMDS.has(cmdName)) {
    return "benign_glue";
  }
  return "other";
}
function isReadonlySearchShell(cmd) {
  if (!cmd.trim()) return false;
  const segments = parseSafeShellSegments(cmd);
  if (!segments || segments.length === 0) return false;
  let hasReadonlySearch = false;
  for (const seg of segments) {
    const kind = classifyShellSegment(seg);
    if (kind === "other") return false;
    if (kind === "readonly_search") hasReadonlySearch = true;
  }
  return hasReadonlySearch;
}
function parseTranscriptJsonl(content) {
  const steps = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        steps.push(parsed);
      }
    } catch {
    }
  }
  return steps;
}
function analyzeTranscriptSessions(sessions) {
  let validSessions = 0;
  let llmTurns = 0;
  let toolTurns = 0;
  let singleToolTurns = 0;
  let totalToolCalls = 0;
  let consecutiveSingleChainsExtraTurns = 0;
  let activeTimeSec = 0;
  let llmTimeSec = 0;
  let streamWaitSec = 0;
  let toolExecTimeSec = 0;
  let totalOutputTokens = 0;
  let editFileCalls = 0;
  let redundantSameTurnEditFileCalls = 0;
  let runCommandCalls = 0;
  let readonlySearchRunCommandCalls = 0;
  const agyFastToolCalls = {
    batch_search: 0,
    apply_edits: 0,
    read_slices: 0,
    run_checks: 0
  };
  let contextSum = 0;
  let contextCount = 0;
  let over150kCount = 0;
  let cacheHitSum = 0;
  let cacheHitCount = 0;
  let turnGapsTotal = 0;
  let turnGapsOver60s = 0;
  for (const steps of sessions) {
    if (steps.length === 0) continue;
    let hasPlanner = false;
    let prevSingleToolName = null;
    let prevPlannerMs = null;
    let prevTurnHadUserInputBetween = false;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.type === "USER_INPUT") {
        prevSingleToolName = null;
        prevTurnHadUserInputBetween = true;
        continue;
      }
      if (step.type !== "PLANNER_RESPONSE") continue;
      hasPlanner = true;
      llmTurns += 1;
      const tPlanner = parseTimeMs(step.created_at);
      if (prevPlannerMs !== null && tPlanner !== null && !prevTurnHadUserInputBetween) {
        const gapSec = (tPlanner - prevPlannerMs) / 1e3;
        if (gapSec >= 0 && gapSec <= 3600) {
          turnGapsTotal += 1;
          if (gapSec > 60) turnGapsOver60s += 1;
        }
      }
      prevTurnHadUserInputBetween = false;
      if (tPlanner !== null) prevPlannerMs = tPlanner;
      const outTok = Number(step.output_tokens ?? 0);
      if (Number.isFinite(outTok) && outTok > 0) {
        totalOutputTokens += outTok;
      }
      const inTok = Number(step.input_tokens ?? 0);
      const cacheTok = Number(step.cache_read_tokens ?? 0);
      const ctxTok = (Number.isFinite(inTok) ? inTok : 0) + (Number.isFinite(cacheTok) ? cacheTok : 0);
      if (ctxTok > 0) {
        contextSum += ctxTok;
        contextCount += 1;
        if (ctxTok >= 15e4) over150kCount += 1;
        if (ctxTok >= 1e4) {
          cacheHitSum += cacheTok / ctxTok;
          cacheHitCount += 1;
        }
      }
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      const hasBlockingTool = calls.some(
        (c) => typeof c.name === "string" && BLOCKING_TOOLS.has(c.name)
      );
      if (calls.length > 0) {
        toolTurns += 1;
        totalToolCalls += calls.length;
        if (calls.length === 1) {
          singleToolTurns += 1;
          const singleName = calls[0]?.name ?? "";
          if (singleName && singleName === prevSingleToolName) {
            consecutiveSingleChainsExtraTurns += 1;
          }
          prevSingleToolName = singleName || null;
        } else {
          prevSingleToolName = null;
        }
        const editedFilesThisTurn = /* @__PURE__ */ new Map();
        for (const call of calls) {
          const name = call.name ?? "";
          const callArgs = getCallArgs(call);
          if (name === "edit_file") {
            editFileCalls += 1;
            const p = getTargetPath(callArgs);
            if (p) {
              const cnt = (editedFilesThisTurn.get(p) ?? 0) + 1;
              editedFilesThisTurn.set(p, cnt);
              if (cnt > 1) redundantSameTurnEditFileCalls += 1;
            }
          } else if (name === "run_command") {
            runCommandCalls += 1;
            const cmd = getCommandString(callArgs);
            if (isReadonlySearchShell(cmd)) {
              readonlySearchRunCommandCalls += 1;
            }
          } else {
            const m = AGY_FAST_TOOL_RE.exec(name);
            if (m && m[1] && agyFastToolCalls[m[1]] !== void 0) {
              agyFastToolCalls[m[1]] = (agyFastToolCalls[m[1]] ?? 0) + 1;
            }
          }
        }
      } else {
        prevSingleToolName = null;
      }
      const genericTimes = [];
      let nextPlannerMs = null;
      for (let j = i + 1; j < steps.length; j++) {
        const nxt = steps[j];
        if (nxt.type === "USER_INPUT") break;
        if (nxt.type === "PLANNER_RESPONSE") {
          nextPlannerMs = parseTimeMs(nxt.created_at);
          break;
        }
        if (nxt.type === "GENERIC") {
          const gt = parseTimeMs(nxt.created_at);
          if (gt !== null) genericTimes.push(gt);
        }
      }
      if (tPlanner !== null && !hasBlockingTool) {
        if (genericTimes.length > 0) {
          const firstGeneric = genericTimes[0];
          const lastGeneric = genericTimes[genericTimes.length - 1];
          const llmSec = Math.max(0, (firstGeneric - tPlanner) / 1e3);
          const spreadSec = Math.max(0, (lastGeneric - firstGeneric) / 1e3);
          const execSec = nextPlannerMs !== null ? Math.max(0, (nextPlannerMs - lastGeneric) / 1e3) : 0;
          if (llmSec <= 600) {
            llmTimeSec += llmSec;
            activeTimeSec += llmSec;
          }
          if (spreadSec <= 600) {
            streamWaitSec += spreadSec;
            activeTimeSec += spreadSec;
          }
          if (execSec <= 600) {
            toolExecTimeSec += execSec;
            activeTimeSec += execSec;
          }
        } else if (nextPlannerMs !== null) {
          const spanSec = Math.max(0, (nextPlannerMs - tPlanner) / 1e3);
          if (spanSec <= 600) {
            llmTimeSec += spanSec;
            activeTimeSec += spanSec;
          }
        }
      }
    }
    if (hasPlanner) validSessions += 1;
  }
  return {
    sessions: validSessions,
    llmTurns,
    toolTurns,
    totalToolCalls,
    singleToolTurnRatio: toolTurns > 0 ? singleToolTurns / toolTurns : 0,
    consecutiveSingleChainsExtraTurns,
    activeTimeSec: round2(activeTimeSec),
    llmTimeSec: round2(llmTimeSec),
    streamWaitSec: round2(streamWaitSec),
    toolExecTimeSec: round2(toolExecTimeSec),
    totalOutputTokens,
    effectiveTps: activeTimeSec > 0 ? round2(totalOutputTokens / activeTimeSec) : 0,
    editFileCalls,
    redundantSameTurnEditFileCalls,
    runCommandCalls,
    readonlySearchRunCommandCalls,
    agyFastToolCalls,
    avgContextTokens: contextCount > 0 ? Math.round(contextSum / contextCount) : 0,
    over150kContextRatio: contextCount > 0 ? over150kCount / contextCount : 0,
    avgCacheHitRate: cacheHitCount > 0 ? cacheHitSum / cacheHitCount : 0,
    over60sGapRatio: turnGapsTotal > 0 ? turnGapsOver60s / turnGapsTotal : 0
  };
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function pct(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}
var ALWAYS_SKIP_DIRS = /* @__PURE__ */ new Set(["chunks", "node_modules", ".git"]);
var BRAIN_SKIP_DIRS = /* @__PURE__ */ new Set([
  "scratch",
  "swarm",
  "media",
  ".tempmediaStorage",
  ".user_uploaded",
  "browser_sandbox",
  "browser_evidence"
]);
var SYSTEM_GENERATED_SKIP_DIRS = /* @__PURE__ */ new Set(["steps", "messages", "tasks"]);
function isBrainPath(target) {
  const parts = target.split(/[\\/]+/);
  return parts.includes(".system_generated") || parts.includes("brain");
}
async function collectTranscriptFiles(inputs) {
  const found = [];
  const seenRealFiles = /* @__PURE__ */ new Set();
  const visitedRealDirs = /* @__PURE__ */ new Set();
  async function recordFile(filePath) {
    let key;
    try {
      key = await fs.realpath(filePath);
    } catch {
      key = path.resolve(filePath);
    }
    if (seenRealFiles.has(key)) return;
    seenRealFiles.add(key);
    found.push(filePath);
  }
  async function walk(target, depth = 0, inBrainLayout = false) {
    if (depth > 10) return;
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (target.endsWith(".jsonl")) await recordFile(target);
      return;
    }
    if (!stat.isDirectory()) return;
    let realDir;
    try {
      realDir = await fs.realpath(target);
    } catch {
      realDir = path.resolve(target);
    }
    if (visitedRealDirs.has(realDir)) return;
    visitedRealDirs.add(realDir);
    let entries;
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch {
      return;
    }
    const resolvedEntries = [];
    for (const entry of entries) {
      const fullPath = path.join(target, entry.name);
      if (entry.isDirectory()) {
        resolvedEntries.push({
          name: entry.name,
          fullPath,
          isDir: true,
          isFile: false
        });
      } else if (entry.isFile()) {
        resolvedEntries.push({
          name: entry.name,
          fullPath,
          isDir: false,
          isFile: true
        });
      } else if (entry.isSymbolicLink()) {
        try {
          const linkStat = await fs.stat(fullPath);
          resolvedEntries.push({
            name: entry.name,
            fullPath,
            isDir: linkStat.isDirectory(),
            isFile: linkStat.isFile()
          });
        } catch {
        }
      }
    }
    const dirNames = new Set(
      resolvedEntries.filter((e) => e.isDir).map((e) => e.name)
    );
    const fileNames = new Set(
      resolvedEntries.filter((e) => e.isFile).map((e) => e.name)
    );
    const isSystemGeneratedDir = path.basename(target) === ".system_generated";
    const hasSystemGeneratedChild = dirNames.has(".system_generated");
    const brainContext = inBrainLayout || isSystemGeneratedDir || hasSystemGeneratedChild || isBrainPath(target);
    const hasFull = fileNames.has("transcript_full.jsonl");
    const hasBasic = fileNames.has("transcript.jsonl");
    if (hasFull) {
      await recordFile(path.join(target, "transcript_full.jsonl"));
    } else if (hasBasic) {
      await recordFile(path.join(target, "transcript.jsonl"));
    }
    for (const entry of resolvedEntries) {
      if (entry.isDir) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (brainContext && BRAIN_SKIP_DIRS.has(entry.name)) continue;
        if (hasSystemGeneratedChild && entry.name !== ".system_generated") {
          continue;
        }
        if (isSystemGeneratedDir && SYSTEM_GENERATED_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        await walk(entry.fullPath, depth + 1, brainContext);
      } else if (entry.isFile && entry.name.endsWith(".jsonl") && entry.name !== "transcript_full.jsonl" && entry.name !== "transcript.jsonl" && !brainContext && !hasFull && !hasBasic) {
        await recordFile(entry.fullPath);
      }
    }
  }
  for (const inp of inputs) {
    await walk(path.resolve(inp));
  }
  return found.sort();
}
async function sortFilesByRecentMtime(files) {
  const withMtime = [];
  const batchSize = 64;
  for (let i = 0; i < files.length; i += batchSize) {
    const slice = files.slice(i, i + batchSize);
    const results = await Promise.all(
      slice.map(async (file) => {
        try {
          const stat = await fs.stat(file);
          return { file, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    for (const item of results) {
      if (item !== null) withMtime.push(item);
    }
  }
  withMtime.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  );
  return withMtime.map((x) => x.file);
}
async function analyzePaths(inputs, options = {}) {
  const recent = options.recent;
  if (recent !== void 0 && (!Number.isSafeInteger(recent) || recent < 1)) {
    throw new RangeError("recent must be a positive integer");
  }
  const files = await collectTranscriptFiles(inputs);
  const orderedFiles = recent !== void 0 ? await sortFilesByRecentMtime(files) : files;
  const sessions = [];
  for (const file of orderedFiles) {
    try {
      const content = await fs.readFile(file, "utf8");
      const steps = parseTranscriptJsonl(content);
      if (recent !== void 0) {
        if (!steps.some((s) => s.type === "PLANNER_RESPONSE")) continue;
        sessions.push(steps);
        if (sessions.length >= recent) break;
      } else {
        sessions.push(steps);
      }
    } catch {
    }
  }
  return analyzeTranscriptSessions(sessions);
}
function formatMetricsMarkdown(m) {
  const fastTotal = Object.values(m.agyFastToolCalls).reduce((a, b) => a + b, 0);
  const editRedundancy = m.editFileCalls > 0 ? pct(m.redundantSameTurnEditFileCalls / m.editFileCalls) : "0.0%";
  const readonlyShellRatio = m.runCommandCalls > 0 ? pct(m.readonlySearchRunCommandCalls / m.runCommandCalls) : "0.0%";
  return [
    "# agy-fast Transcript Benchmark",
    "",
    "| Metric | Value |",
    "| :--- | ---: |",
    `| Sessions | ${m.sessions} |`,
    `| LLM turns | ${m.llmTurns} |`,
    `| Tool calls | ${m.totalToolCalls} |`,
    `| Active time (s) | ${m.activeTimeSec.toFixed(1)} |`,
    `| LLM wait & decode (s) | ${m.llmTimeSec.toFixed(1)} |`,
    `| Multi-tool stream buffer wait (s) | ${m.streamWaitSec.toFixed(1)} |`,
    `| Tool execution time (s) | ${m.toolExecTimeSec.toFixed(1)} |`,
    `| Effective throughput (tok/s) | ${m.effectiveTps.toFixed(1)} |`,
    `| Single-tool turn ratio | ${pct(m.singleToolTurnRatio)} |`,
    `| Consecutive same-tool extra turns | ${m.consecutiveSingleChainsExtraTurns} |`,
    `| Redundant same-turn edit_file ratio | ${editRedundancy} (${m.redundantSameTurnEditFileCalls}/${m.editFileCalls}) |`,
    `| Read-only search shell ratio | ${readonlyShellRatio} (${m.readonlySearchRunCommandCalls}/${m.runCommandCalls}) |`,
    `| Average context size (tokens) | ${m.avgContextTokens.toLocaleString("en-US")} |`,
    `| Turns >= 150k context | ${pct(m.over150kContextRatio)} |`,
    `| Average Prompt Cache hit rate | ${pct(m.avgCacheHitRate)} |`,
    `| Turn gaps > 60s | ${pct(m.over60sGapRatio)} |`,
    `| agy-fast tool calls | ${fastTotal} (search:${m.agyFastToolCalls.batch_search}, edit:${m.agyFastToolCalls.apply_edits}, slice:${m.agyFastToolCalls.read_slices}, check:${m.agyFastToolCalls.run_checks}) |`
  ].join("\n");
}
function formatCompareMarkdown(before, after) {
  const delta = (b, a) => {
    if (b === 0) return a === 0 ? "0.0%" : "n/a";
    const d = (a - b) / b * 100;
    return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
  };
  return [
    "# agy-fast A/B Comparison",
    "",
    "| Metric | Before | After | Change |",
    "| :--- | ---: | ---: | ---: |",
    `| Sessions | ${before.sessions} | ${after.sessions} | - |`,
    `| LLM turns | ${before.llmTurns} | ${after.llmTurns} | ${delta(before.llmTurns, after.llmTurns)} |`,
    `| Tool calls | ${before.totalToolCalls} | ${after.totalToolCalls} | ${delta(before.totalToolCalls, after.totalToolCalls)} |`,
    `| Active time (s) | ${before.activeTimeSec.toFixed(1)} | ${after.activeTimeSec.toFixed(1)} | ${delta(before.activeTimeSec, after.activeTimeSec)} |`,
    `| Tool execution time (s) | ${before.toolExecTimeSec.toFixed(1)} | ${after.toolExecTimeSec.toFixed(1)} | ${delta(before.toolExecTimeSec, after.toolExecTimeSec)} |`,
    `| Effective throughput (tok/s) | ${before.effectiveTps.toFixed(1)} | ${after.effectiveTps.toFixed(1)} | ${delta(before.effectiveTps, after.effectiveTps)} |`,
    `| Single-tool turn ratio | ${pct(before.singleToolTurnRatio)} | ${pct(after.singleToolTurnRatio)} | ${delta(before.singleToolTurnRatio, after.singleToolTurnRatio)} |`,
    `| Average context (tokens) | ${before.avgContextTokens} | ${after.avgContextTokens} | ${delta(before.avgContextTokens, after.avgContextTokens)} |`,
    `| Prompt Cache hit rate | ${pct(before.avgCacheHitRate)} | ${pct(after.avgCacheHitRate)} | ${delta(before.avgCacheHitRate, after.avgCacheHitRate)} |`,
    `| Turn gaps > 60s | ${pct(before.over60sGapRatio)} | ${pct(after.over60sGapRatio)} | ${delta(before.over60sGapRatio, after.over60sGapRatio)} |`
  ].join("\n");
}

// src/benchmark.ts
async function assertPathsExist(paths) {
  for (const p of paths) {
    try {
      await fs2.stat(path2.resolve(p));
    } catch {
      process.stderr.write(`Error: path does not exist: ${p}
`);
      return false;
    }
  }
  return true;
}
function parsePositiveInt(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}
function printUsage() {
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
      "  --json        Output raw JSON metrics"
    ].join("\n") + "\n"
  );
}
async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    return;
  }
  const cmd = args[0];
  if (cmd === "analyze") {
    const targets = [];
    const explicitTargets = [];
    let recent;
    let asJson = false;
    let afterDoubleDash = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
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
          path2.join(os.homedir(), ".gemini", "antigravity", "brain"),
          path2.join(os.homedir(), ".gemini", "antigravity-cli", "brain")
        );
        continue;
      }
      if (!afterDoubleDash && (a === "--recent" || a.startsWith("--recent="))) {
        const raw = a === "--recent" ? args[++i] : a.slice("--recent=".length);
        const parsed = raw !== void 0 ? parsePositiveInt(raw) : null;
        if (parsed === null) {
          process.stderr.write("Error: --recent must be a positive integer\n");
          process.exitCode = 1;
          return;
        }
        recent = parsed;
        continue;
      }
      if (!afterDoubleDash && a.startsWith("-")) {
        process.stderr.write(`Error: unknown option: ${a}
`);
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
    if (explicitTargets.length > 0 && !await assertPathsExist(explicitTargets)) {
      process.exitCode = 1;
      return;
    }
    const metrics = await analyzePaths(
      targets,
      recent !== void 0 ? { recent } : {}
    );
    process.stdout.write(
      asJson ? `${JSON.stringify(metrics, null, 2)}
` : `${formatMetricsMarkdown(metrics)}
`
    );
    return;
  }
  if (cmd === "compare") {
    let beforePath = "";
    let afterPath = "";
    let asJson = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--json") {
        asJson = true;
      } else if (a === "--before" || a.startsWith("--before=")) {
        const val = a === "--before" ? args[++i] : a.slice("--before=".length);
        if (!val || a === "--before" && val.startsWith("-")) {
          process.stderr.write("Error: --before requires a path\n");
          process.exitCode = 1;
          return;
        }
        beforePath = val;
      } else if (a === "--after" || a.startsWith("--after=")) {
        const val = a === "--after" ? args[++i] : a.slice("--after=".length);
        if (!val || a === "--after" && val.startsWith("-")) {
          process.stderr.write("Error: --after requires a path\n");
          process.exitCode = 1;
          return;
        }
        afterPath = val;
      } else {
        process.stderr.write(`Error: unknown option: ${a}
`);
        process.exitCode = 1;
        return;
      }
    }
    if (!beforePath || !afterPath) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    if (!await assertPathsExist([beforePath, afterPath])) {
      process.exitCode = 1;
      return;
    }
    const [before, after] = await Promise.all([
      analyzePaths([beforePath]),
      analyzePaths([afterPath])
    ]);
    process.stdout.write(
      asJson ? `${JSON.stringify({ before, after }, null, 2)}
` : `${formatCompareMarkdown(before, after)}
`
    );
    return;
  }
  printUsage();
  process.exitCode = 1;
}
void main(process.argv);

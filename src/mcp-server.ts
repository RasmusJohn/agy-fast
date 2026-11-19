import { McpStdioServer } from "./protocol/mcp.js";
import { runApplyEdits, type ApplyEditsInput } from "./tools/apply-edits.js";
import { runBatchSearch, type BatchSearchInput } from "./tools/batch-search.js";
import { runReadSlices, type ReadSlicesInput } from "./tools/read-slices.js";
import { runChecks, type RunChecksInput } from "./tools/run-checks.js";

const SERVER_VERSION = "0.1.0";

export function createAgyFastServer(): McpStdioServer {
  const server = new McpStdioServer({
    name: "agy-fast",
    version: SERVER_VERSION,
  });

  server.registerTool(
    {
      name: "batch_search",
      description:
        "Run multiple read-only text/regex searches, file globs, and read-only git queries (status/diff/log/show/branch) concurrently in one call with bounded output.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Workspace directory (defaults to current working directory).",
          },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            description: "List of search/glob/git queries to run concurrently.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["text", "regex", "glob", "git"],
                },
                pattern: {
                  type: "string",
                  description:
                    "Literal text, regex, glob pattern, or read-only git subcommand (e.g. 'status --short', 'log -n 5 --oneline').",
                },
                path: {
                  type: "string",
                  description: "Optional subdirectory or file relative to cwd.",
                },
                glob: {
                  type: "string",
                  description: "Optional file filter glob for text/regex queries (e.g. '*.ts').",
                },
                caseSensitive: {
                  type: "boolean",
                  description: "Case sensitivity for text/regex (default true).",
                },
                contextLines: {
                  type: "integer",
                  minimum: 0,
                  maximum: 5,
                  description: "Context lines around matches (default 0).",
                },
                maxResults: {
                  type: "integer",
                  minimum: 1,
                  maximum: 200,
                  description: "Max matches/files for this query (default 40).",
                },
              },
              required: ["type", "pattern"],
            },
          },
          maxChars: {
            type: "integer",
            minimum: 500,
            maximum: 60000,
            description: "Total character cap for combined results (default 8500, inline UTF-8 capped <= 8800 bytes).",
          },
        },
        required: ["queries"],
      },
    },
    (args) => runBatchSearch(args as unknown as BatchSearchInput),
  );

  server.registerTool(
    {
      name: "apply_edits",
      description:
        "Atomically apply multiple non-contiguous hunks across one or more files (all-or-nothing) with optional file creation and inline verify command.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Base directory for relative file paths and verify command.",
          },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description: "Files to edit or create.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                hunks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      target: { type: "string", description: "Exact text to replace." },
                      replacement: { type: "string", description: "Replacement text." },
                      startLine: {
                        type: "integer",
                        minimum: 1,
                        description: "Optional 1-based start line to narrow matching.",
                      },
                      endLine: {
                        type: "integer",
                        minimum: 1,
                        description: "Optional 1-based end line to narrow matching.",
                      },
                      replaceAll: {
                        type: "boolean",
                        description: "Replace every occurrence in range (default false).",
                      },
                    },
                    required: ["target", "replacement"],
                  },
                },
                create: {
                  type: "string",
                  description: "Create file with this full content instead of hunks.",
                },
                overwrite: {
                  type: "boolean",
                  description: "Allow overwriting existing file when using 'create'.",
                },
              },
              required: ["path"],
            },
          },
          dryRun: {
            type: "boolean",
            description: "Validate all hunks without writing files (default false).",
          },
          bestEffort: {
            type: "boolean",
            description:
              "When true, write valid files even if other files fail validation (each file remains atomic; failed files return closest-line snippets and verify is skipped until fixed). Default false (all-or-nothing).",
          },
          verify: {
            type: "string",
            description:
              "Optional shell command run right after writing (e.g. 'npm run typecheck').",
          },
          verifyTimeoutSec: {
            type: "integer",
            minimum: 1,
            maximum: 300,
            description: "Optional timeout in seconds for the verify command (default 60).",
          },
          maxVerifyChars: {
            type: "integer",
            minimum: 300,
            maximum: 20000,
          },
        },
        required: ["edits"],
      },
    },
    (args) => runApplyEdits(args as unknown as ApplyEditsInput),
  );

  server.registerTool(
    {
      name: "read_slices",
      description:
        "Extract symbol outlines (with line ranges) and/or batch-read exact line ranges across multiple files in one call to keep context compact.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          outlines: {
            type: "array",
            maxItems: 20,
            items: { type: "string" },
            description: "File paths to extract top-level symbol line ranges from.",
          },
          slices: {
            type: "array",
            maxItems: 30,
            description: "Files and 1-based inclusive [startLine, endLine] ranges to read.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                ranges: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "array",
                    minItems: 2,
                    maxItems: 2,
                    items: { type: "integer", minimum: 1 },
                  },
                },
              },
              required: ["path", "ranges"],
            },
          },
          maxChars: {
            type: "integer",
            minimum: 1000,
            maximum: 80000,
            description: "Total character cap across all outlines and slices (default 8500, inline UTF-8 capped <= 8800 bytes).",
          },
        },
      },
    },
    (args) => runReadSlices(args as unknown as ReadSlicesInput),
  );

  server.registerTool(
    {
      name: "run_checks",
      description:
        "Run multiple build, typecheck, lint, or test commands concurrently with compact output filtering (1-line pass summaries, error lines on failure).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description: "Commands to execute concurrently.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Short label (e.g. 'typecheck')." },
                command: { type: "string", description: "Shell command to run." },
                cwd: { type: "string", description: "Optional working directory override." },
                timeoutSec: { type: "integer", minimum: 1, maximum: 300 },
              },
              required: ["command"],
            },
          },
          concurrency: {
            type: "integer",
            minimum: 1,
            maximum: 8,
            description: "Max parallel commands (default 4).",
          },
          timeoutSec: {
            type: "integer",
            minimum: 1,
            maximum: 300,
            description: "Default per-command timeout in seconds (default 60).",
          },
          outputMode: {
            type: "string",
            enum: ["compact", "full"],
            description: "Compact hides verbose pass logs (default 'compact').",
          },
          maxChars: {
            type: "integer",
            minimum: 500,
            maximum: 60000,
            description: "Total character cap (default 8000, inline UTF-8 capped <= 8800 bytes).",
          },
        },
        required: ["commands"],
      },
    },
    (args) => runChecks(args as unknown as RunChecksInput),
  );

  return server;
}

function main(): void {
  const server = createAgyFastServer();
  const exitImmediately = () => {
    process.exit(0);
  };
  const flushAndExit = () => {
    // Wait for buffered stdout pipe writes (>64KB) to drain before exiting
    process.stdout.end(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", exitImmediately);
  process.on("SIGTERM", exitImmediately);
  server.listen(process.stdin, process.stdout, flushAndExit);
}

main();

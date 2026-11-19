import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const MCP_SERVER_SCRIPT = path.resolve(process.cwd(), "dist", "mcp-server.mjs");

function sendMessagesToServer(
  rawChunks: Array<string | Buffer>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SERVER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MCP server test timed out"));
    }, 10_000);
    timer.unref();

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    (async () => {
      for (const chunk of rawChunks) {
        child.stdin.write(chunk);
        await new Promise((r) => setTimeout(r, 10));
      }
      child.stdin.end();
    })();
  });
}

function hasDisallowedSchemaKeyword(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) return obj.some(hasDisallowedSchemaKeyword);
  for (const [k, v] of Object.entries(obj)) {
    if (k === "oneOf" || k === "anyOf" || k === "allOf") return true;
    if (hasDisallowedSchemaKeyword(v)) return true;
  }
  return false;
}

describe("MCP Stdio Server end-to-end", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-mcp-"));
    await fs.writeFile(
      path.join(tmpDir, "demo.ts"),
      "export function greet(name: string) {\n  return `hi ${name}`;\n}\n",
      "utf8",
    );
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("handles initialize, notifications, ping, tools/list, and all 4 tools over stdio", async () => {
    const msgs = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "batch_search",
          arguments: {
            cwd: tmpDir,
            queries: [{ type: "text", pattern: "greet" }],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "read_slices",
          arguments: {
            cwd: tmpDir,
            outlines: ["demo.ts"],
            slices: [{ path: "demo.ts", ranges: [[1, 3]] }],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "apply_edits",
          arguments: {
            cwd: tmpDir,
            edits: [
              {
                path: "demo.ts",
                hunks: [{ target: "hi ${name}", replacement: "hello ${name}" }],
              },
            ],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "run_checks",
          arguments: {
            cwd: tmpDir,
            commands: [
              {
                name: "ok",
                command: `${JSON.stringify(process.execPath)} -e "console.log('ok')"`,
              },
            ],
          },
        },
      },
    ];

    const res = await sendMessagesToServer(
      msgs.map((m) => `${JSON.stringify(m)}\n`),
    );

    assert.equal(res.code, 0);
    assert.equal(res.stderr, "");

    const responses = res.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // Notification must not emit a response -> 7 responses for ids 1..7
    assert.equal(responses.length, 7);

    const byId = new Map<number, Record<string, unknown>>(
      responses.map((r) => [r.id as number, r]),
    );

    const init = byId.get(1)?.result as {
      protocolVersion: string;
      serverInfo: { name: string };
    };
    assert.equal(init.protocolVersion, "2025-03-26");
    assert.equal(init.serverInfo.name, "agy-fast");

    assert.deepEqual(byId.get(2)?.result, {});

    const toolList = (
      byId.get(3)?.result as {
        tools: Array<{ name: string; inputSchema: unknown }>;
      }
    ).tools;
    assert.deepEqual(
      toolList.map((t) => t.name),
      ["batch_search", "apply_edits", "read_slices", "run_checks"],
    );
    // Ensure schemas avoid oneOf/anyOf/allOf for maximum client compatibility
    for (const tool of toolList) {
      assert.equal(
        hasDisallowedSchemaKeyword(tool.inputSchema),
        false,
        `Tool ${tool.name} schema should not contain oneOf/anyOf/allOf`,
      );
    }

    const searchText = (
      byId.get(4)?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.match(searchText ?? "", /demo\.ts/);

    const sliceText = (
      byId.get(5)?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.match(sliceText ?? "", /\[function\] greet/);

    const editText = (
      byId.get(6)?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.match(editText ?? "", /Applied edits to 1 file/);
    assert.match(await fs.readFile(path.join(tmpDir, "demo.ts"), "utf8"), /hello \$\{name\}/);

    const checkText = (
      byId.get(7)?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.match(checkText ?? "", /Checks: 1\/1 passed/);
  });

  it("handles JSON-RPC error codes, chunked UTF-8 input, and Content-Length framing", async () => {
    const brokenAndErrors = [
      "{malformed json\n",
      JSON.stringify({ jsonrpc: "2.0", id: 10, method: "no/such/method" }) + "\n",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "missing_tool", arguments: {} },
      }) + "\n",
    ];
    // Split a single request mid-UTF8 byte across chunks
    const pingJson = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: "中文-12", method: "ping" }) + "\n",
      "utf8",
    );
    const part1 = pingJson.subarray(0, 20);
    const part2 = pingJson.subarray(20);

    const res = await sendMessagesToServer([...brokenAndErrors, part1, part2]);
    assert.equal(res.code, 0);
    const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 4);
    assert.equal(lines[0].error.code, -32700);
    assert.equal(lines[1].error.code, -32601);
    assert.equal(lines[2].error.code, -32602);
    assert.equal(lines[3].id, "中文-12");
    assert.deepEqual(lines[3].result, {});

    // Test Content-Length framing (including preceding Content-Type header)
    const clBody = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" });
    const clFrame = `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(clBody, "utf8")}\r\n\r\n${clBody}`;
    const clRes = await sendMessagesToServer([clFrame]);
    assert.equal(clRes.code, 0);
    assert.match(clRes.stdout, /^Content-Length: \d+\r\n\r\n/);
    const jsonPart = clRes.stdout.split("\r\n\r\n")[1]!;
    assert.equal(JSON.parse(jsonPart).id, 99);
  });

  it("flushes large (>64KB) pipelined stdout responses completely on stdin EOF and enforces 8.8KB inline cap per tool call", async () => {
    const bigFile = path.join(tmpDir, "large.txt");
    const bigLines = Array.from(
      { length: 1200 },
      (_, i) => `line_${String(i + 1).padStart(4, "0")}: ${"abcdefghij".repeat(6)}`,
    );
    await fs.writeFile(bigFile, bigLines.join("\n"), "utf8");

    // Pipeline 10 calls totaling >75KB stdout while verifying each response stays <= 8,800 UTF-8 bytes even if caller passes maxChars: 80000
    const reqs = Array.from({ length: 10 }, (_, idx) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 200 + idx,
        method: "tools/call",
        params: {
          name: "read_slices",
          arguments: {
            cwd: tmpDir,
            slices: [{ path: "large.txt", ranges: [[idx * 100 + 1, idx * 100 + 200]] }],
            maxChars: 80_000,
          },
        },
      }) + "\n",
    );

    const res = await sendMessagesToServer([reqs.join("")]);
    assert.equal(res.code, 0);
    assert.equal(res.stderr, "");
    assert.ok(res.stdout.length > 75_000, `Expected >75KB pipelined stdout, got ${res.stdout.length}`);
    const parsed = res.stdout
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            id: number;
            result: { content: Array<{ text: string }> };
          },
      );
    assert.equal(parsed.length, 10);
    const ids = parsed.map((p) => p.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [200, 201, 202, 203, 204, 205, 206, 207, 208, 209]);
    for (const item of parsed) {
      const text = item.result.content[0]?.text ?? "";
      assert.ok(
        Buffer.byteLength(text, "utf8") <= 8_800,
        `Expected per-call inline cap <= 8800B, got ${Buffer.byteLength(text, "utf8")}`,
      );
      assert.match(text, /use parallel read_file/);
    }
  });
});

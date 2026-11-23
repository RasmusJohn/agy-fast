import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runAgyFastCli } from "../src/cli-runner.js";

const MCP_SERVER_SCRIPT = path.resolve(process.cwd(), "dist", "mcp-server.mjs");

function runCliSubprocess(
  args: string[],
  options: { cwd: string; stdin?: string; closeStdin?: boolean },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SERVER_SCRIPT, "--cli", ...args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    if (options.closeStdin !== false) {
      child.stdin.end();
    }
  });
}

describe("agy-fast --cli direct runner", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-cli-test-"));
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "math.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function multiply(a: number, b: number): number {",
        "  return a * b;",
        "}",
      ].join("\n") + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "src", "greet.ts"),
      [
        "export function greet(name: string): string {",
        "  return `hello ${name}`;",
        "}",
      ].join("\n") + "\n",
      "utf8",
    );
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("supports outline, slice, search, check, and edit via built dist/mcp-server.mjs --cli", async () => {
    // 1. Help
    const helpRes = await runCliSubprocess(["--help"], { cwd: tmpDir });
    assert.equal(helpRes.code, 0);
    assert.match(helpRes.stdout, /agy-fast direct CLI mode/);

    // 2. Positional outline (even when stdin is left open, must NOT hang!)
    const outlineRes = await runCliSubprocess(["outline", "src/math.ts", "src/greet.ts"], {
      cwd: tmpDir,
      closeStdin: false,
    });
    assert.equal(outlineRes.code, 0, outlineRes.stderr);
    assert.match(outlineRes.stdout, /\[function\] add/);
    assert.match(outlineRes.stdout, /\[function\] multiply/);
    assert.match(outlineRes.stdout, /\[function\] greet/);
    assert.ok(Buffer.byteLength(outlineRes.stdout, "utf8") <= 8800);

    // 3. Slice with positional lineRanges + --outline
    const sliceRes = await runCliSubprocess(
      ["slice", "src/math.ts:1-3", "--outline", "src/greet.ts"],
      { cwd: tmpDir },
    );
    assert.equal(sliceRes.code, 0, sliceRes.stderr);
    assert.match(sliceRes.stdout, /return a \+ b/);
    assert.match(sliceRes.stdout, /\[function\] greet/);

    // 4. Search via shorthand flags (multiple queries in one call)
    const searchFlagsRes = await runCliSubprocess(
      ["search", "--text", "multiply", "--glob", "src/*.ts"],
      { cwd: tmpDir },
    );
    assert.equal(searchFlagsRes.code, 0, searchFlagsRes.stderr);
    assert.match(searchFlagsRes.stdout, /Query 1 \[text\] multiply/);
    assert.match(searchFlagsRes.stdout, /Query 2 \[glob\] src\/\*\.ts/);
    assert.match(searchFlagsRes.stdout, /src\/greet\.ts/);

    // 5. Search via piped JSON shorthand array
    const searchPipeRes = await runCliSubprocess(["search"], {
      cwd: tmpDir,
      stdin: JSON.stringify([{ type: "text", pattern: "hello", path: "src" }]),
    });
    assert.equal(searchPipeRes.code, 0, searchPipeRes.stderr);
    assert.match(searchPipeRes.stdout, /src\/greet\.ts/);

    // 6. Check concurrent commands in compact & full modes
    const checkRes = await runCliSubprocess(
      ["check", "--full", "node -e \"console.log('ALPHA_OK')\"", "node -e \"console.log('BETA_OK')\""],
      { cwd: tmpDir },
    );
    assert.equal(checkRes.code, 0, checkRes.stderr);
    assert.match(checkRes.stdout, /Checks: 2\/2 passed/);
    assert.match(checkRes.stdout, /ALPHA_OK/);
    assert.match(checkRes.stdout, /BETA_OK/);

    // 7. Edit via piped stdin JSON + --verify override
    const editPayload = JSON.stringify({
      edits: [
        {
          path: "src/greet.ts",
          hunks: [{ target: "hello ${name}", replacement: "hi ${name}" }],
        },
      ],
    });
    const editRes = await runCliSubprocess(
      ["edit", "--verify", "node -e \"console.log('VERIFIED')\""],
      { cwd: tmpDir, stdin: editPayload },
    );
    assert.equal(editRes.code, 0, editRes.stderr);
    assert.match(editRes.stdout, /Applied edits to 1 file/);
    assert.match(editRes.stdout, /Verify \[PASS/);
    const updated = await fs.readFile(path.join(tmpDir, "src", "greet.ts"), "utf8");
    assert.match(updated, /hi \$\{name\}/);
  });

  it("handles errors cleanly and never hangs on open empty stdin", async () => {
    const unknownRes = await runCliSubprocess(["bogus"], { cwd: tmpDir });
    assert.equal(unknownRes.code, 1);
    assert.match(unknownRes.stderr, /unknown --cli command/);

    const badJsonRes = await runCliSubprocess(["edit", "--json", "{bad"], { cwd: tmpDir });
    assert.equal(badJsonRes.code, 1);
    assert.match(badJsonRes.stderr, /Invalid JSON input/);

    // Simulate non-TTY open pipe with no bytes sent and no positional args
    const openStdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    openStdin.isTTY = false;
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const out = new PassThrough();
    const err = new PassThrough();
    out.on("data", (d) => stdoutBuf.push(d.toString("utf8")));
    err.on("data", (d) => stderrBuf.push(d.toString("utf8")));

    const startedAt = Date.now();
    const code = await runAgyFastCli(["search"], {
      stdin: openStdin,
      stdout: out,
      stderr: err,
      cwd: tmpDir,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(code, 1);
    assert.match(stderrBuf.join(""), /requires at least one query/);
    assert.ok(elapsed < 2000, `Expected non-hanging open stdin guard, took ${elapsed}ms`);

    // Failed edit returns exit code 1 with diagnostic text on stdout
    const failEdit = await runCliSubprocess(
      [
        "edit",
        "--json",
        JSON.stringify({
          edits: [{ path: "src/math.ts", hunks: [{ target: "DOES_NOT_EXIST", replacement: "x" }] }],
        }),
      ],
      { cwd: tmpDir },
    );
    assert.equal(failEdit.code, 1);
    assert.match(failEdit.stdout, /target text not found/);
  });
});

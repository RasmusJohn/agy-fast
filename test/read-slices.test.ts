import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { extractSymbols, runReadSlices } from "../src/tools/read-slices.js";

describe("read_slices", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-slices-"));

    await fs.writeFile(
      path.join(tmpDir, "sample.ts"),
      [
        "export interface Config {",
        "  port: number;",
        "}",
        "",
        "export class Server {",
        "  start() {",
        "    return '{not a brace close}';",
        "  }",
        "",
        "  async stop(force: boolean): Promise<void> {",
        "    if (force) {",
        "      return;",
        "    }",
        "  }",
        "}",
        "",
        "export const createApp = (cfg: Config) => {",
        "  return new Server();",
        "};",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "sample.py"),
      [
        "class Worker:",
        "    def run(self):",
        "        return 42",
        "",
        "async def helper():",
        "    return True",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "sample.go"),
      [
        "package main",
        "",
        "type Engine struct {",
        "  Name string",
        "}",
        "",
        "func (e *Engine) Start() {",
        "  println(e.Name)",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "sample.rs"),
      [
        "pub struct Cache {",
        "  size: usize,",
        "}",
        "",
        "impl Cache {",
        "  pub fn new(size: usize) -> Self {",
        "    Self { size }",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "README.md"),
      [
        "# Title",
        "Intro line.",
        "```bash",
        "# not a heading",
        "```",
        "## Usage",
        "Details here.",
      ].join("\n"),
      "utf8",
    );
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts accurate multi-language symbol outlines with line spans", async () => {
    const tsSyms = extractSymbols(
      "sample.ts",
      await fs.readFile(path.join(tmpDir, "sample.ts"), "utf8"),
    );
    assert.deepEqual(
      tsSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      [
        "interface:Config:1-3",
        "class:Server:5-15",
        "method:start:6-8",
        "method:stop:10-14",
        "function:createApp:17-19",
      ],
    );

    const pySyms = extractSymbols(
      "sample.py",
      await fs.readFile(path.join(tmpDir, "sample.py"), "utf8"),
    );
    assert.deepEqual(
      pySyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      [
        "class:Worker:1-3",
        "method:run:2-3",
        "function:helper:5-6",
      ],
    );

    const goSyms = extractSymbols(
      "sample.go",
      await fs.readFile(path.join(tmpDir, "sample.go"), "utf8"),
    );
    assert.equal(goSyms.length, 2);
    assert.equal(goSyms[0]?.name, "Engine");
    assert.equal(goSyms[1]?.kind, "method");

    const rsSyms = extractSymbols(
      "sample.rs",
      await fs.readFile(path.join(tmpDir, "sample.rs"), "utf8"),
    );
    assert.ok(rsSyms.some((s) => s.kind === "struct" && s.name === "Cache"));
    assert.ok(rsSyms.some((s) => s.kind === "fn" && s.name === "new"));

    const mdSyms = extractSymbols(
      "README.md",
      await fs.readFile(path.join(tmpDir, "README.md"), "utf8"),
    );
    assert.deepEqual(
      mdSyms.map((s) => s.name),
      ["Title", "Usage"],
    );
  });

  it("returns combined outlines and multi-range slices with clamping and bounds handling", async () => {
    const res = await runReadSlices({
      cwd: tmpDir,
      outlines: ["sample.ts", "sample.py"],
      slices: [
        {
          path: "sample.ts",
          ranges: [
            [1, 3],
            [17, 50], // clamped to EOF (19)
            [99, 120], // out of bounds
          ],
        },
        {
          path: "missing.ts",
          ranges: [[1, 5]],
        },
      ],
    });

    assert.equal(res.isError, false);
    assert.match(res.text, /## Outline: sample\.ts \(19 lines\)/);
    assert.match(res.text, /L5-L15 \[class\] Server/);
    assert.match(res.text, /--- L1-L3 \(of 19\) ---/);
    assert.match(res.text, /1: export interface Config \{/);
    assert.match(res.text, /--- L17-L19 \(of 19\) ---/);
    assert.match(res.text, /out of bounds; file has 19 lines/);
    assert.match(res.text, /## Slice: missing\.ts\nERROR:/);
  });

  it("rejects empty requests", async () => {
    const res = await runReadSlices({ cwd: tmpDir });
    assert.equal(res.isError, true);
  });

  it("handles regex/comment braces, multiline TS methods, Java/C functions, Python docstrings, and 4-space JSON", async () => {
    const tsComplex = [
      "export class Multi {",
      "  async send(",
      "    payload: string,",
      "  ): Promise<void> {",
      "    const re = /\\{not_a_brace\\}/;",
      "    /* { block comment brace }",
      "       another line { */",
      "    return;",
      "  }",
      "}",
      "",
      "export const build = (",
      "  a: number,",
      "  b: number,",
      ") => {",
      "  return a + b;",
      "};",
    ].join("\n");
    const tsSyms = extractSymbols("complex.ts", tsComplex);
    assert.deepEqual(
      tsSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      [
        "class:Multi:1-10",
        "method:send:2-9",
        "function:build:12-17",
      ],
    );

    const javaSyms = extractSymbols(
      "Service.java",
      [
        "public class Service {",
        "  public int add(int a, int b) {",
        "    return a + b;",
        "  }",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(
      javaSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["class:Service:1-5", "method:add:2-4"],
    );

    const cSyms = extractSymbols(
      "main.c",
      [
        "int main(int argc, char **argv) {",
        "  return 0;",
        "}",
        "static void helper(void) {",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(
      cSyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["function:main:1-3", "function:helper:4-5"],
    );

    const pySyms = extractSymbols(
      "doc.py",
      [
        "def foo():",
        '    """',
        "Column 0 docstring line",
        '    """',
        "    return 1",
        "",
        "def bar():",
        "    return 2",
      ].join("\n"),
    );
    assert.deepEqual(
      pySyms.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`),
      ["function:foo:1-5", "function:bar:7-8"],
    );

    const jsonSyms = extractSymbols(
      "pkg.json",
      [
        "{",
        '    "name": "demo",',
        '    "scripts": {',
        '        "test": "node --test"',
        "    }",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(
      jsonSyms.map((s) => `${s.kind}:${s.name}`),
      ["key:name", "key:scripts"],
    );
  });
});

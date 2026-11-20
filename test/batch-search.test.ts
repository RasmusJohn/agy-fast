import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  runBatchSearch,
  tokenizeArgs,
  validateReadonlyGitArgs,
} from "../src/tools/batch-search.js";

describe("batch_search", () => {
  let tmpDir: string;

  for (const forceNodeFallback of [false, true]) {
    it(`supports file-only output, line counts and language filtering (forceNodeFallback=${forceNodeFallback})`, async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-search-modes-"));
      try {
        await fs.writeFile(path.join(cwd, "a.ts"), "needle needle\r\n".repeat(75));
        await fs.writeFile(path.join(cwd, "b.tsx"), "needle\n");
        await fs.writeFile(path.join(cwd, "c.py"), "needle\n");
        const search = { type: "text", pattern: "needle", fileType: "TypeScript" } as const;
        const { text } = await runBatchSearch({
          cwd,
          queries: [
            { ...search, outputMode: "count", glob: "*", maxResults: 1 },
            { ...search, outputMode: "files_with_matches", glob: "b.*" },
            { ...search, path: "c.py" },
            { type: "regex", pattern: "^$", outputMode: "count" },
          ],
        }, { forceNodeFallback });
        const sections = text.split("\n\n");
        assert.match(sections[0]!, /a\.ts: 75 matching lines/);
        assert.match(sections[0]!, /truncated; showing 1 files/);
        assert.equal(sections[1]!.split("\n").at(-1), "b.tsx");
        assert.match(sections[2]!, /\(no matches\)/);
        assert.match(sections[3]!, /\(no matches\)/);
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    });
  }

  for (const forceNodeFallback of [false, true]) {
    it(`supports multiline content, file lists and counts (forceNodeFallback=${forceNodeFallback})`, async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-multiline-"));
      try {
        await fs.writeFile(path.join(cwd, "a.ts"), "before\r\nstart one\r\nend\r\nafter\r\n");
        await fs.writeFile(path.join(cwd, "b.ts"), "begin end begin end\n");
        await fs.writeFile(path.join(cwd, "c.py"), "start two\nend\n");
        await fs.writeFile(path.join(cwd, "emoji.ts"), "A😀B\n");
        const search = { type: "regex", pattern: "^start.*?end$", fileType: "ts" } as const;
        const { text } = await runBatchSearch({
          cwd,
          queries: [
            { ...search, multiline: true, contextLines: 1 },
            { ...search, multiline: true, maxResults: 1 },
            { ...search, multiline: true, outputMode: "files_with_matches" },
            { ...search, multiline: true, outputMode: "count", pattern: "begin.*?end" },
            { ...search, multiline: true, outputMode: "count" },
            { ...search },
            { type: "text", pattern: "start one\r\nend", multiline: true, outputMode: "files_with_matches" },
            { ...search, path: "a.ts", multiline: true, outputMode: "count", pattern: "^$" },
            { ...search, path: "a.ts", multiline: true, outputMode: "count", pattern: "one|$" },
            { ...search, path: "emoji.ts", multiline: true, outputMode: "count", pattern: "A.B" },
          ],
        }, { forceNodeFallback });
        const sections = text.split("\n\n");
        assert.deepEqual(sections[0]!.split("\n").slice(1), [
          "a.ts", "  1- before", "  2: start one", "  3: end", "  4- after",
        ]);
        assert.match(sections[1]!, /2: start one\n\.\.\. \[truncated/);
        assert.equal(sections[2]!.split("\n").at(-1), "a.ts");
        assert.match(sections[3]!, /b\.ts: 2 matches/);
        assert.match(sections[4]!, /a\.ts: 1 matches/);
        assert.match(sections[5]!, /\(no matches\)/);
        assert.equal(sections[6]!.split("\n").at(-1), "a.ts");
        assert.match(sections[7]!, /\(no matches\)/);
        assert.match(sections[8]!, /a\.ts: 4 matches/);
        assert.match(sections[9]!, /emoji\.ts: 1 matches/);
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    });
  }

  it("ranks fuzzy paths and optionally sorts glob results by newest mtime", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-search-paths-"));
    try {
      for (const [file, seconds] of [["mcp-server.ts", 1000], ["mcpserv.ts", 2000], ["mcpserv.py", 3000]] as const) {
        const target = path.join(cwd, file);
        await fs.writeFile(target, "");
        await fs.utimes(target, seconds, seconds);
      }
      const { text } = await runBatchSearch({
        cwd,
        queries: [
          { type: "fuzzy", pattern: "MCPSERV", fileType: "ts" },
          { type: "fuzzy", pattern: "SERV MCP", fileType: "ts", maxResults: 1 },
          { type: "glob", pattern: "*.ts", sortBy: "mtime", maxResults: 1 },
          { type: "glob", pattern: "*.ts" },
        ],
      });
      const sections = text.split("\n\n");
      assert.deepEqual(sections[0]!.split("\n").slice(1), ["mcpserv.ts", "mcp-server.ts"]);
      assert.equal(sections[1]!.split("\n")[1], "mcpserv.ts");
      assert.match(sections[1]!, /truncated; showing 1 files/);
      assert.equal(sections[2]!.split("\n")[1], "mcpserv.ts");
      assert.deepEqual(sections[3]!.split("\n").slice(1), ["mcp-server.ts", "mcpserv.ts"]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });


  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-search-"));
    await fs.mkdir(path.join(tmpDir, "src", "api"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "node_modules", "ignored-pkg"), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(tmpDir, "src", "api", "routes.ts"),
      [
        "export function getUsers() {",
        "  return fetchUsers('active');",
        "}",
        "",
        "export function createOrder(id: string) {",
        "  return { id, status: 'PENDING' };",
        "}",
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(tmpDir, "src", "utils.py"),
      [
        "def fetch_users(mode):",
        "    # helper for FetchUsers",
        "    return [mode]",
      ].join("\n"),
      "utf8",
    );

    // Should be ignored by both rg and Node fallback
    await fs.writeFile(
      path.join(tmpDir, "node_modules", "ignored-pkg", "index.js"),
      "export function getUsers() { return 'ignored'; }\n",
      "utf8",
    );

    // Binary file containing NUL bytes
    await fs.writeFile(
      path.join(tmpDir, "src", "blob.bin"),
      Buffer.from([0x67, 0x65, 0x74, 0x55, 0x73, 0x65, 0x72, 0x73, 0x00, 0xff]),
    );

    // Hidden dotfile that both rg and Node fallback should skip by default
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      "SECRET_KEY=getUsers_secret_token\n",
      "utf8",
    );

    // Multi-file fixture for contextLines + maxResults orphan-context regression test
    await fs.mkdir(path.join(tmpDir, "ctx"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "ctx", "a.txt"),
      "a_pre\nCTX_NEEDLE\na_post\nmid1\nmid2\nmid3\na2_pre\nCTX_NEEDLE\na2_post\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "ctx", "b.txt"),
      "b_pre\nCTX_NEEDLE\nb_post\n",
      "utf8",
    );

    // Initialize git repo for read-only git query tests
    execFileSync("git", ["init", "-q"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tmpDir,
    });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    execFileSync("git", ["add", "src/api/routes.ts", "src/utils.py"], {
      cwd: tmpDir,
    });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], {
      cwd: tmpDir,
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("runs text, regex, glob, and git queries concurrently in one call", async () => {
    const res = await runBatchSearch({
      cwd: tmpDir,
      queries: [
        { type: "text", pattern: "getUsers", contextLines: 1 },
        { type: "regex", pattern: "fetch_?[uU]sers", caseSensitive: false },
        { type: "glob", pattern: "src/**/*.ts" },
        { type: "git", pattern: "log -n 1 --oneline" },
      ],
    });

    assert.equal(res.isError, false);
    assert.match(res.text, /src\/api\/routes\.ts/);
    assert.match(res.text, /1: export function getUsers/);
    assert.match(res.text, /2-   return fetchUsers/);
    assert.match(res.text, /src\/utils\.py/);
    assert.match(res.text, /initial commit/);
    assert.doesNotMatch(res.text, /ignored-pkg/);
    assert.doesNotMatch(res.text, /blob\.bin/);
  });

  it("produces consistent search matches between rg and Node fallback", async () => {
    const queries = [
      { type: "text" as const, pattern: "createOrder", glob: "*.ts" },
      { type: "regex" as const, pattern: "fetch[_U]sers", caseSensitive: false },
    ];
    const withRg = await runBatchSearch({ cwd: tmpDir, queries });
    const withNode = await runBatchSearch(
      { cwd: tmpDir, queries },
      { forceNodeFallback: true },
    );

    assert.equal(withRg.isError, false);
    assert.equal(withNode.isError, false);
    assert.match(withRg.text, /5: export function createOrder/);
    assert.match(withNode.text, /5: export function createOrder/);
    assert.match(withRg.text, /src\/utils\.py/);
    assert.match(withNode.text, /src\/utils\.py/);
    assert.doesNotMatch(withNode.text, /ignored-pkg/);
    assert.doesNotMatch(withNode.text, /blob\.bin/);

    // Neither rg nor Node fallback should leak hidden .env files by default
    const envRg = await runBatchSearch({
      cwd: tmpDir,
      queries: [{ type: "text", pattern: "getUsers_secret_token" }],
    });
    const envNode = await runBatchSearch(
      {
        cwd: tmpDir,
        queries: [{ type: "text", pattern: "getUsers_secret_token" }],
      },
      { forceNodeFallback: true },
    );
    assert.doesNotMatch(envRg.text, /\.env/);
    assert.doesNotMatch(envNode.text, /\.env/);
  });

  it("strips optional 'git ' prefix and allows read-only git commands", () => {
    assert.deepEqual(validateReadonlyGitArgs("status --short"), [
      "--no-pager",
      "status",
      "--short",
    ]);
    assert.deepEqual(validateReadonlyGitArgs('git log -n 5 --format="%h %s"'), [
      "--no-pager",
      "log",
      "-n",
      "5",
      "--format=%h %s",
    ]);
    assert.deepEqual(validateReadonlyGitArgs("branch --list"), [
      "--no-pager",
      "branch",
      "--list",
    ]);
    assert.deepEqual(validateReadonlyGitArgs("branch -av"), [
      "--no-pager",
      "branch",
      "-av",
    ]);
    assert.deepEqual(validateReadonlyGitArgs("branch --show-current"), [
      "--no-pager",
      "branch",
      "--show-current",
    ]);
    assert.deepEqual(validateReadonlyGitArgs("tag -l v*"), [
      "--no-pager",
      "tag",
      "-l",
      "v*",
    ]);
    assert.deepEqual(validateReadonlyGitArgs("remote -v"), [
      "--no-pager",
      "remote",
      "-v",
    ]);
    assert.deepEqual(validateReadonlyGitArgs("remote get-url origin"), [
      "--no-pager",
      "remote",
      "get-url",
      "origin",
    ]);
  });

  it("rejects mutating git subcommands, bypass flags, and combined short flags", () => {
    const blocked = [
      "commit -m evil",
      "push origin main",
      "reset --hard HEAD",
      "checkout main",
      "clean -fd",
      "branch -D feature",
      "branch -Dmain",
      "branch -mrenamed",
      "branch -l --no-list evil-branch",
      "branch -l --no-list -qD main",
      "branch -l --no-list -qm renamed",
      "branch --create-reflog",
      "branch new-branch",
      "tag v1.0.0",
      "tag -d v1.0.0",
      "tag -dv1.0.0",
      "tag -l -fd v1.0.0",
      "tag -l -am msg v1.0.0",
      "remote add origin https://example.com/repo.git",
      "remote show --prune origin",
      "diff --output=/tmp/leak",
      "diff -c core.pager=sh",
      "diff -ccore.pager=sh",
      "log --ext-diff",
      "-c core.fsmonitor=evil status",
      'log "unterminated',
    ];
    for (const cmd of blocked) {
      assert.throws(
        () => validateReadonlyGitArgs(cmd),
        `Expected '${cmd}' to be rejected`,
      );
    }
  });

  it("handles file targets for git/glob and avoids orphan context lines at maxResults", async () => {
    const filePathQueries = await runBatchSearch({
      cwd: tmpDir,
      queries: [
        { type: "git", pattern: "log -n 1 --oneline", path: "src/api/routes.ts" },
        { type: "glob", pattern: "*.ts", path: "src/api/routes.ts" },
      ],
    });
    assert.equal(filePathQueries.isError, false);
    assert.match(filePathQueries.text, /initial commit/);
    assert.match(filePathQueries.text, /src\/api\/routes\.ts/);
    assert.doesNotMatch(filePathQueries.text, /ENOTDIR/);

    const rgCtx = await runBatchSearch({
      cwd: path.join(tmpDir, "ctx"),
      queries: [{ type: "text", pattern: "CTX_NEEDLE", contextLines: 1, maxResults: 1 }],
    });
    const nodeCtx = await runBatchSearch(
      {
        cwd: path.join(tmpDir, "ctx"),
        queries: [{ type: "text", pattern: "CTX_NEEDLE", contextLines: 1, maxResults: 1 }],
      },
      { forceNodeFallback: true },
    );
    // Neither backend should include before-context for dropped matches
    assert.doesNotMatch(rgCtx.text, /a2_pre/);
    assert.doesNotMatch(nodeCtx.text, /a2_pre/);
    assert.doesNotMatch(nodeCtx.text, /b_pre/);
    // Ensure rg output contains only files that have at least one actual ':' match line
    const rgFileBlocks = rgCtx.text.split(/\n(?=[ab]\.txt\n)/).slice(1);
    for (const block of rgFileBlocks) {
      assert.match(block, /\d+: /, `Orphan context block without match:\n${block}`);
    }
  });

  it("tokenizes quoted arguments properly", () => {
    assert.deepEqual(tokenizeArgs(`log --grep="hello world" -n 3`), [
      "log",
      "--grep=hello world",
      "-n",
      "3",
    ]);
  });

  it("enforces strict output budgets and reports invalid inputs cleanly", async () => {
    const empty = await runBatchSearch({ cwd: tmpDir, queries: [] });
    assert.equal(empty.isError, true);

    const badCwd = await runBatchSearch({
      cwd: path.join(tmpDir, "does-not-exist"),
      queries: [{ type: "glob", pattern: "*" }],
    });
    assert.equal(badCwd.isError, true);

    const badRegex = await runBatchSearch(
      { cwd: tmpDir, queries: [{ type: "regex", pattern: "[invalid(" }] },
      { forceNodeFallback: true },
    );
    assert.equal(badRegex.isError, false);
    assert.match(badRegex.text, /ERROR:/);

    const tinyBudget = await runBatchSearch({
      cwd: tmpDir,
      maxChars: 500,
      queries: Array.from({ length: 6 }, (_, i) => ({
        type: "text" as const,
        pattern: i === 0 ? "e" : `QueryMiss_${i}`,
        maxResults: 50,
      })),
    });
    assert.ok(
      tinyBudget.text.length <= 500,
      `Expected <= 500 chars, got ${tinyBudget.text.length}`,
    );
    assert.match(tinyBudget.text, /## Query 6/);

    // Default call with heavy multi-byte UTF-8 matches must stay <= 8,800 UTF-8 bytes to avoid host spill-to-disk
    const cjkFile = path.join(tmpDir, "cjk-heavy.txt");
    const cjkLines = Array.from(
      { length: 120 },
      (_, i) => `第${i + 1}行：中文测试数据_CJK_MATCH_锚点_用于验证默认内联字节上限不触发落盘_${"测试内容".repeat(12)}`,
    );
    await fs.writeFile(cjkFile, cjkLines.join("\n"), "utf8");
    const cjkRes = await runBatchSearch({
      cwd: tmpDir,
      queries: [
        { type: "text", pattern: "CJK_MATCH", path: "cjk-heavy.txt", maxResults: 120 },
        { type: "text", pattern: "getUsers", path: "src/api/routes.ts" },
      ],
    });
    assert.equal(cjkRes.isError, false);
    const cjkBytes = Buffer.byteLength(cjkRes.text, "utf8");
    assert.ok(
      cjkBytes <= 8_800,
      `Expected default batch_search UTF-8 bytes <= 8800, got ${cjkBytes}`,
    );
    assert.match(cjkRes.text, /## Query 2/);
    assert.match(cjkRes.text, /getUsers/);

    // Explicit maxChars > 8800 is still hard-capped <= 8800 UTF-8 bytes
    const explicitLarge = await runBatchSearch({
      cwd: tmpDir,
      maxChars: 50_000,
      queries: [{ type: "text", pattern: "CJK_MATCH", path: "cjk-heavy.txt", maxResults: 120 }],
    });
    assert.equal(explicitLarge.isError, false);
    assert.ok(Buffer.byteLength(explicitLarge.text, "utf8") <= 8_800);

    // Glob truncation reports omitted top-level directories
    const globDir = path.join(tmpDir, "glob-many");
    await fs.mkdir(path.join(globDir, "alpha"), { recursive: true });
    await fs.mkdir(path.join(globDir, "views"), { recursive: true });
    await fs.mkdir(path.join(globDir, "components"), { recursive: true });
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(globDir, "alpha", `a${i}.ts`), "x", "utf8");
      await fs.writeFile(path.join(globDir, "views", `v${i}.vue`), "x", "utf8");
      await fs.writeFile(path.join(globDir, "components", `c${i}.vue`), "x", "utf8");
    }
    const globTrunc = await runBatchSearch({
      cwd: globDir,
      queries: [{ type: "glob", pattern: "**/*", maxResults: 5 }],
    });
    assert.equal(globTrunc.isError, false);
    assert.match(globTrunc.text, /truncated at 5 of 18 files/);
    assert.match(globTrunc.text, /omitted dirs:/);
    assert.match(globTrunc.text, /views\/ \(6\)/);
  });

  it("auto-recovers regex alternation and bare keywords passed to glob queries", async () => {
    const globDir = path.join(tmpDir, "glob-fallback");
    await fs.mkdir(path.join(globDir, "proxy"), { recursive: true });
    await fs.mkdir(path.join(globDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(globDir, "proxy", "network.ts"), "export {};", "utf8");
    await fs.writeFile(path.join(globDir, "scripts", "live-smoke.ts"), "export {};", "utf8");
    await fs.writeFile(path.join(globDir, "scripts", "mission-check.mjs"), "export {};", "utf8");

    const res = await runBatchSearch({
      cwd: globDir,
      queries: [
        { type: "glob", pattern: "proxy" },
        { type: "glob", pattern: "smoke|mission|lock", path: "scripts" },
        { type: "glob", pattern: "foo|bar", path: "scripts" },
        { type: "glob", pattern: "missing.ts" },
      ],
    });
    assert.equal(res.isError, false);
    assert.match(res.text, /auto-expanded regex '\|'/);
    assert.match(res.text, /showing case-insensitive path matches for "\*proxy\*"/);
    assert.match(res.text, /proxy\/network\.ts/);
    assert.match(res.text, /scripts\/live-smoke\.ts/);
    assert.match(res.text, /scripts\/mission-check\.mjs/);
    assert.match(res.text, /hint: glob uses \* and \{a,b\}, not regex \|/);
    // Missing exact filename with extension stays clean "(no files matched)"
    assert.match(res.text, /## Query 4 \[glob\] missing\.ts\n\(no files matched\)/);

    // If an exact bare file exists, exact match wins without triggering fallback note
    await fs.writeFile(path.join(globDir, "proxy", "exactfile"), "x", "utf8");
    const exactRes = await runBatchSearch({
      cwd: globDir,
      queries: [{ type: "glob", pattern: "exactfile" }],
    });
    assert.equal(exactRes.isError, false);
    assert.match(exactRes.text, /proxy\/exactfile/);
    assert.doesNotMatch(exactRes.text, /auto-expanded|showing case-insensitive/);
  });
});

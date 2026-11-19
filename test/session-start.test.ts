import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOOK_SCRIPT = path.resolve(process.cwd(), "dist", "session-start.mjs");

function runHook(stdinText: string): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, durationMs: Date.now() - start }),
    );
    child.stdin.end(stdinText);
  });
}

describe("session-start hook", () => {
  let gitDir: string;
  let plainDir: string;

  before(async () => {
    gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-git-"));
    plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-plain-"));

    await fs.mkdir(path.join(gitDir, "src"), { recursive: true });
    await fs.mkdir(path.join(gitDir, "node_modules", "noisy"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(gitDir, "package.json"),
      JSON.stringify({
        name: "demo-app",
        scripts: { build: "tsc", test: "node --test", lint: "eslint ." },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(gitDir, "Makefile"),
      "build:\n\techo build\ntest:\n\techo test\n",
      "utf8",
    );
    await fs.writeFile(path.join(gitDir, "src", "index.ts"), "export {};\n", "utf8");
    await fs.writeFile(
      path.join(gitDir, "node_modules", "noisy", "junk.js"),
      "module.exports = {};\n",
      "utf8",
    );

    execFileSync("git", ["init", "-q"], { cwd: gitDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: gitDir,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
    execFileSync("git", ["add", "package.json", "Makefile", "src/index.ts"], {
      cwd: gitDir,
    });
    execFileSync("git", ["commit", "-q", "-m", "feat: initial setup"], {
      cwd: gitDir,
    });
    // Create dirty file
    await fs.writeFile(path.join(gitDir, "src", "dirty.ts"), "export const x = 1;\n", "utf8");

    // Non-git workspace
    await fs.writeFile(path.join(plainDir, "go.mod"), "module example.com/demo\n", "utf8");
  });

  after(async () => {
    await fs.rm(gitDir, { recursive: true, force: true });
    await fs.rm(plainDir, { recursive: true, force: true });
  });

  it("injects a compact git + project + 2-level tree snapshot within 1500 chars", async () => {
    const res = await runHook(
      JSON.stringify({
        cwd: gitDir,
        workspacePaths: [gitDir],
        hookEventName: "SessionStart",
      }),
    );

    assert.equal(res.code, 0);
    assert.equal(res.stderr, "");
    const parsed = JSON.parse(res.stdout);
    const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.equal(typeof msg, "string");
    assert.ok(msg.length <= 1500, `Snapshot exceeded 1500 chars: ${msg.length}`);
    assert.match(msg, /Git: branch/);
    assert.match(msg, /feat: initial setup/);
    assert.match(msg, /dirty\.ts/);
    assert.match(msg, /package\.json \(demo-app\) scripts: build, test, lint/);
    assert.match(msg, /Makefile targets: build, test/);
    assert.doesNotMatch(msg, /node_modules/);
  });

  it("works cleanly in non-git directories", async () => {
    const res = await runHook(JSON.stringify({ workspacePaths: [plainDir] }));
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.match(msg, /go\.mod \(example\.com\/demo\)/);
    assert.doesNotMatch(msg, /Git: branch/);
  });

  it("fails open with {} on empty, malformed, or missing workspace stdin", async () => {
    for (const input of [
      "",
      "{not-valid-json",
      JSON.stringify({ cwd: path.join(gitDir, "nonexistent-dir") }),
    ]) {
      const res = await runHook(input);
      assert.equal(res.code, 0);
      assert.deepEqual(JSON.parse(res.stdout), {});
    }
  });

  it("handles unborn git repos (0 commits) and snake_case workspace_roots payloads", async () => {
    const unbornDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-unborn-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: unbornDir });
      await fs.writeFile(path.join(unbornDir, "hello.ts"), "export const a = 1;\n", "utf8");

      const res = await runHook(JSON.stringify({ workspace_roots: [unbornDir] }));
      assert.equal(res.code, 0);
      const parsed = JSON.parse(res.stdout);
      const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.match(msg, /Git: branch `main` \(unborn, no commits yet\)/);
      assert.match(msg, /hello\.ts/);
    } finally {
      await fs.rm(unbornDir, { recursive: true, force: true });
    }
  });
});

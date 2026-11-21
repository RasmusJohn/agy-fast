import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOOK_SCRIPT = path.resolve(process.cwd(), "dist", "session-start.mjs");

function runHook(
  stdinText: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, AGY_FAST_AUTO_UPDATE: "off" };
    delete env.ANTIGRAVITY_LS_VERSION;
    delete env.ANTIGRAVITY_APP_DATA_DIR;
    delete env.AGY_FAST_HOST;
    delete env.AGY_FAST_EDITS_FORMAT;
    delete env.AGY_FAST_CACHE_DIR;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
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

  it("preserves Project and Layout sections even when a repo has 50+ long-path modified files", async () => {
    const dirtyDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-dirty-"));
    try {
      await fs.mkdir(path.join(dirtyDir, "packages", "service-alpha", "src", "adapters", "very-deep-module"), {
        recursive: true,
      });
      await fs.mkdir(path.join(dirtyDir, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(dirtyDir, "package.json"),
        JSON.stringify({
          name: "monorepo-heavy",
          scripts: { build: "tsc", test: "vitest", lint: "eslint ." },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(dirtyDir, "docs", "README.md"), "# docs\n", "utf8");

      // Create and commit 55 files with long paths, then modify all 55 (reproducing 139-file dirty workspace truncation)
      const longFiles = Array.from({ length: 55 }, (_, i) =>
        path.join(
          dirtyDir,
          "packages",
          "service-alpha",
          "src",
          "adapters",
          "very-deep-module",
          `LongServiceAdapterImplementationFile_${String(i).padStart(2, "0")}.ts`,
        ),
      );
      await Promise.all(
        longFiles.map((f, i) => fs.writeFile(f, `export const idx = ${i};\n`, "utf8")),
      );

      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dirtyDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dirtyDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dirtyDir });
      execFileSync("git", ["add", "."], { cwd: dirtyDir });
      execFileSync("git", ["commit", "-q", "-m", "feat: baseline commit with a fairly descriptive message for testing"], {
        cwd: dirtyDir,
      });

      await Promise.all(
        longFiles.map((f, i) => fs.writeFile(f, `export const idx = ${i + 100};\n`, "utf8")),
      );

      const res = await runHook(JSON.stringify({ cwd: dirtyDir, workspacePaths: [dirtyDir] }));
      assert.equal(res.code, 0);
      const parsed = JSON.parse(res.stdout);
      const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.equal(typeof msg, "string");
      assert.ok(msg.length <= 1500, `Snapshot exceeded 1500 chars: ${msg.length}`);
      assert.match(msg, /Git: branch `main`/);
      assert.match(msg, /Modified \(55\):/);
      assert.match(msg, /\(\+\d+ more\)/);
      assert.match(msg, /Project:\n  - package\.json \(monorepo-heavy\) scripts: build, test, lint/);
      assert.match(msg, /Layout \(2 levels\):/);
      assert.match(msg, /packages\//);
    } finally {
      await fs.rm(dirtyDir, { recursive: true, force: true });
    }
  });

  it("detects multi-module subproject manifests (pom.xml + web/package.json) and collapses noisy tmp/output dirs", async () => {
    const monoDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-mono-"));
    try {
      await fs.mkdir(path.join(monoDir, ".claude", "memory"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "server", "src"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "web", "src"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "output"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "tmp"), { recursive: true });

      await fs.writeFile(
        path.join(monoDir, "server", "pom.xml"),
        "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><artifactId>autocard-server</artifactId></project>\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(monoDir, "web", "package.json"),
        JSON.stringify({ name: "autocard-web", scripts: { dev: "vite", build: "vite build", test: "node --test" } }),
        "utf8",
      );
      for (let i = 0; i < 15; i++) {
        await fs.writeFile(
          path.join(monoDir, "output", `很长的中文交付报告文件名_${i}_20261119.docx`),
          "x",
          "utf8",
        );
        await fs.writeFile(path.join(monoDir, "tmp", `scratch_temp_file_${i}.txt`), "x", "utf8");
      }

      const res = await runHook(JSON.stringify({ cwd: monoDir, workspacePaths: [monoDir] }));
      assert.equal(res.code, 0);
      const parsed = JSON.parse(res.stdout);
      const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.ok(msg.length <= 1500, `Snapshot exceeded 1500 chars: ${msg.length}`);
      assert.match(msg, /server\/pom\.xml \(autocard-server, maven\)/);
      assert.match(msg, /web\/package\.json \(autocard-web\) scripts: dev, build, test/);
      assert.match(msg, /web\//);
      assert.match(msg, /output\/ \(15 entries\)/);
      assert.match(msg, /tmp\/ \(15 entries\)/);
      assert.doesNotMatch(msg, /\.claude\//);

      // Verify 2nd-level subdir prioritization & build/report filtering (e.g. SourcingAgent/ in monorepo)
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "data"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "dist-server"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "docs"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "memory"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "playwright-report"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "public"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "src"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "tests"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "zebra"), { recursive: true });

      const res2 = await runHook(JSON.stringify({ cwd: monoDir, workspacePaths: [monoDir] }));
      assert.equal(res2.code, 0);
      const msg2: string = JSON.parse(res2.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.match(msg2, /SourcingAgent\/ \(src\/, tests\//);
      assert.doesNotMatch(msg2, /dist-server/);
      assert.doesNotMatch(msg2, /playwright-report/);
    } finally {
      await fs.rm(monoDir, { recursive: true, force: true });
    }
  });

  it("exits promptly when stdin stays open without EOF and enforces <=1500 UTF-8 bytes with zero lone surrogates", async () => {
    const cjkDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-cjk-"));
    try {
      // Create CJK + 4-byte emoji filenames positioned across shortEntryName(28) and byte cap boundaries
      await fs.writeFile(path.join(cjkDir, `${"a".repeat(24)}🚀b.ts`), "export const a = 1;\n", "utf8");
      for (let i = 0; i < 20; i++) {
        await fs.writeFile(
          path.join(cjkDir, `中文模块文件名称很长_${String(i).padStart(2, "0")}_🚀数据.ts`),
          "export {};\n",
          "utf8",
        );
      }
      const res = await runHook(JSON.stringify({ cwd: cjkDir, workspacePaths: [cjkDir] }));
      assert.equal(res.code, 0);
      const msg: string = JSON.parse(res.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.equal(typeof msg, "string");
      assert.ok(
        Buffer.byteLength(msg, "utf8") <= 1500,
        `Expected snapshot <= 1500 UTF-8 bytes, got ${Buffer.byteLength(msg, "utf8")}`,
      );
      assert.equal(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(msg),
        false,
        "Snapshot must not contain unpaired UTF-16 surrogates",
      );

      // Verify hook exits cleanly after readStdin timeout even if parent never closes stdin
      const noEofResult = await new Promise<{ code: number | null; stdout: string; durationMs: number }>(
        (resolve, reject) => {
          const start = Date.now();
          const child = spawn(process.execPath, [HOOK_SCRIPT], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, AGY_FAST_AUTO_UPDATE: "off" },
          });
          let stdout = "";
          const killer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("SessionStart hook hung when stdin stayed open without EOF"));
          }, 3500);
          killer.unref();
          child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
          child.on("error", (err) => {
            clearTimeout(killer);
            reject(err);
          });
          child.on("close", (code) => {
            clearTimeout(killer);
            resolve({ code, stdout, durationMs: Date.now() - start });
          });
          // Write payload WITHOUT calling child.stdin.end()
          child.stdin.write(JSON.stringify({ cwd: cjkDir }));
        },
      );
      assert.equal(noEofResult.code, 0);
      const parsed = JSON.parse(noEofResult.stdout);
      assert.match(parsed?.injectSteps?.[0]?.systemMessage?.systemMessage ?? "", /agy-fast startup snapshot/);

      // Verify SessionStart git snapshot does NOT execute untrusted .git/config core.fsmonitor
      const untrustedGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-fsmon-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: untrustedGitDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: untrustedGitDir });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: untrustedGitDir });
        await fs.writeFile(path.join(untrustedGitDir, "a.txt"), "1\n", "utf8");
        execFileSync("git", ["add", "."], { cwd: untrustedGitDir });
        execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: untrustedGitDir });
        const markerFs = path.join(untrustedGitDir, "pwn_hook_fs");
        const touchCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(markerFs)},'1')`)}`;
        execFileSync("git", ["config", "core.fsmonitor", touchCmd], { cwd: untrustedGitDir });
        const snapRes = await runHook(JSON.stringify({ cwd: untrustedGitDir }));
        assert.equal(snapRes.code, 0);
        assert.equal(await fs.access(markerFs).then(() => true, () => false), false);
      } finally {
        await fs.rm(untrustedGitDir, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(cjkDir, { recursive: true, force: true });
    }
  });

  it("injects [agy-fast compat] notice only on pre-eager CLI 1.5.0-1.5.7 and adds 0 bytes on CLI >=1.5.8 / Desktop / IDE", async () => {
    const cliOldRes = await runHook(
      JSON.stringify({
        cwd: plainDir,
        transcriptPath: "/Users/dev/.gemini/antigravity-cli/brain/1/transcript.jsonl",
      }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.7" },
    );
    assert.equal(cliOldRes.code, 0);
    const cliOldMsg: string = JSON.parse(cliOldRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.ok(Buffer.byteLength(cliOldMsg, "utf8") <= 1500);
    assert.match(cliOldMsg, /\[agy-fast compat\] host=cli@1\.5\.7/);
    assert.match(cliOldMsg, /JSON array string/);

    // Eager-capable CLI >=1.5.8 omits the compat notice (0 extra tokens/bytes; avoids conflicting with typed eager tools)
    const cliEagerRes = await runHook(
      JSON.stringify({
        cwd: plainDir,
        transcriptPath: "/Users/dev/.gemini/antigravity-cli/brain/1/transcript.jsonl",
      }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.13" },
    );
    const cliEagerMsg: string = JSON.parse(cliEagerRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.doesNotMatch(cliEagerMsg, /\[agy-fast compat\]/);

    // Desktop 2.0 & IDE omit the compat line (0 extra tokens/bytes)
    const desktopRes = await runHook(
      JSON.stringify({
        cwd: plainDir,
        transcriptPath: "/Users/dev/.gemini/antigravity/brain/1/transcript.jsonl",
      }),
      { ANTIGRAVITY_LS_VERSION: "desktop-2.34.0" },
    );
    const desktopMsg: string = JSON.parse(desktopRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.doesNotMatch(desktopMsg, /\[agy-fast compat\]/);

    // IDE path with conflicting ambient pre-eager CLI env still resolves IDE (no compat notice)
    const ideRes = await runHook(
      JSON.stringify({
        cwd: plainDir,
        transcriptPath: "/Users/dev/.gemini/antigravity-ide/brain/1/transcript.jsonl",
      }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.7" },
    );
    const ideMsg: string = JSON.parse(ideRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.doesNotMatch(ideMsg, /\[agy-fast compat\]/);

    // Explicit AGY_FAST_EDITS_FORMAT=array suppresses notice even on CLI 1.5.7; =string forces it on CLI 1.5.13
    const overrideArrRes = await runHook(
      JSON.stringify({ cwd: plainDir }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.7", AGY_FAST_EDITS_FORMAT: "array" },
    );
    const overrideArrMsg: string = JSON.parse(overrideArrRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.doesNotMatch(overrideArrMsg, /\[agy-fast compat\]/);

    const overrideStrRes = await runHook(
      JSON.stringify({ cwd: plainDir }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.13", AGY_FAST_EDITS_FORMAT: "string" },
    );
    const overrideStrMsg: string = JSON.parse(overrideStrRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.match(overrideStrMsg, /\[agy-fast compat\] host=cli@1\.5\.13/);
  });
});

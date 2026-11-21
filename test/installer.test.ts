import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const INSTALL_SCRIPT = path.resolve(process.cwd(), "scripts", "install.mjs");
const INSTALL_SH = path.resolve(process.cwd(), "install.sh");
const INSTALL_PS1 = path.resolve(process.cwd(), "install.ps1");

describe("installer", () => {
  let fakeHome: string;
  let fakeProject: string;

  before(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-home-"));
    fakeProject = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-proj-"));
  });

  after(async () => {
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.rm(fakeProject, { recursive: true, force: true });
  });

  it("installs, runs doctor, upgrades idempotently, and uninstalls cleanly in isolated HOME", async () => {
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
    const expectedDir = path.join(fakeHome, ".gemini", "config", "plugins", "agy-fast");

    const out1 = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.match(out1, /Installed agy-fast/);
    assert.match(out1, /MCP server\s+: OK \(4 tools:/);
    assert.match(out1, /SessionStart: OK/);

    // Verify all runtime files (including installer for self-doctor) are present and no node_modules copied
    for (const rel of [
      "plugin.json",
      "mcp_config.json",
      "hooks.json",
      "rules/AGENTS.md",
      "assets/logo.svg",
      "dist/mcp-server.mjs",
      "dist/session-start.mjs",
      "dist/benchmark.mjs",
      "dist/updater.mjs",
      "scripts/install.mjs",
    ]) {
      const stat = await fs.stat(path.join(expectedDir, rel));
      assert.ok(stat.isFile(), `Expected file ${rel}`);
    }
    await assert.rejects(fs.stat(path.join(expectedDir, "node_modules")));

    // Doctor passes when run both from source and from installed directory
    const docOut = execFileSync(process.execPath, [INSTALL_SCRIPT, "doctor"], {
      env,
      encoding: "utf8",
    });
    assert.match(docOut, /MCP server\s+: OK/);
    assert.match(docOut, /Version\s+: v\d+\.\d+\.\d+/);
    assert.match(docOut, /Auto-update\s+: auto/);
    const installedDocOut = execFileSync(
      process.execPath,
      [path.join(expectedDir, "scripts", "install.mjs"), "doctor"],
      { env, encoding: "utf8" },
    );
    assert.match(installedDocOut, /MCP server\s+: OK/);

    // Re-install over existing directory succeeds idempotently
    execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--no-enable"],
      { env, encoding: "utf8" },
    );

    // Uninstall removes directory
    const rmOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "uninstall", "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.match(rmOut, /Removed agy-fast/);
    await assert.rejects(fs.stat(expectedDir));
  });

  it("supports --project and --link modes and valid shell syntax in install.sh", async () => {
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
    const projectTarget = path.join(fakeProject, ".agents", "plugins", "agy-fast");

    execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--project", fakeProject, "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.ok((await fs.stat(path.join(projectTarget, "plugin.json"))).isFile());

    const linkTarget = path.join(fakeHome, "linked-agy-fast");
    execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", linkTarget, "--link", "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.ok((await fs.lstat(linkTarget)).isSymbolicLink());

    // Shell syntax check and local invocation via install.sh (install, doctor, uninstall)
    execFileSync("sh", ["-n", INSTALL_SH], { encoding: "utf8" });
    const shTarget = path.join(fakeHome, "sh-installed-agy-fast");
    const shOut = execFileSync("sh", [INSTALL_SH, "--target", shTarget, "--no-enable"], {
      env,
      encoding: "utf8",
    });
    assert.match(shOut, /Installation complete/);

    // Subcommands forwarded cleanly via install.sh (doctor & uninstall must NOT install!)
    const shDoc = execFileSync("sh", [INSTALL_SH, "doctor", "--target", shTarget], {
      env,
      encoding: "utf8",
    });
    assert.match(shDoc, /MCP server\s+: OK/);

    const shUn = execFileSync("sh", [INSTALL_SH, "uninstall", "--target", shTarget], {
      env,
      encoding: "utf8",
    });
    assert.match(shUn, /Removed agy-fast/);
    await assert.rejects(fs.stat(shTarget));

    // Uninstall via install.sh on clean HOME must NOT accidentally install
    const cleanHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-clean-"));
    try {
      const unOut = execFileSync("sh", [INSTALL_SH, "uninstall", "--no-enable"], {
        env: { ...process.env, HOME: cleanHome, USERPROFILE: cleanHome },
        encoding: "utf8",
      });
      assert.match(unOut, /Nothing to remove/);
      await assert.rejects(
        fs.stat(path.join(cleanHome, ".gemini", "config", "plugins", "agy-fast")),
      );
    } finally {
      await fs.rm(cleanHome, { recursive: true, force: true });
    }

    // Missing --target value must fail with a clear error
    assert.throws(() => {
      execFileSync(process.execPath, [INSTALL_SCRIPT, "install", "--target"], {
        env,
        stdio: "pipe",
      });
    });

    // Verify uninstall refuses to delete the active source repo itself
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [INSTALL_SCRIPT, "uninstall", "--target", process.cwd(), "--no-enable"],
        { env, stdio: "pipe" },
      );
    });
  });

  it("keeps install.ps1 safe for Windows PowerShell 5.1 irm | iex and single-arg splatting", async () => {
    const ps1 = await fs.readFile(INSTALL_PS1, "utf8");
    // Pure ASCII avoids Windows PowerShell 5.1 non-BOM UTF-8/CP936 misparsing
    assert.ok(/^[\x00-\x7f]*$/.test(ps1), "install.ps1 must stay pure ASCII");
    // Never splat a potentially unwrapped 1-element $forwardArgs directly after $installer
    assert.doesNotMatch(ps1, /& node\s+\$\w+\s+@forwardArgs/);
    assert.doesNotMatch(ps1, /& node\s+\(Join-Path[^)]+\)\s+@forwardArgs/);
    // Must guard exit so `irm ... | iex` does not close the user's interactive terminal
    assert.match(ps1, /if \(\$__agyFastWasFile\)\s*\{[\s\S]*exit \$__agyFastFinalExit/);
    assert.match(ps1, /System\.Collections\.Generic\.List\[string\]/);
  });

  it("protects source repo across symlink/case variants, rejects ancestors and non-plugin dirs, and handles empty/symlink targets safely", async () => {
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
    const linkType = process.platform === "win32" ? "junction" : "dir";
    const run = (args: string[]) =>
      execFileSync(process.execPath, args, { env, encoding: "utf8", stdio: "pipe" });
    const expectFail = (args: string[], pattern: RegExp) => {
      assert.throws(() => run(args), (err: unknown) => {
        assert.match(String((err as { stderr?: string })?.stderr ?? ""), pattern);
        return true;
      });
    };

    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-safety-"));
    const parentAlias = path.join(sandbox, "repo-parent-link");
    try {
      // 1. Symlinked-parent & case-variant same-directory protection
      await fs.symlink(path.dirname(process.cwd()), parentAlias, linkType);
      const aliasedRepo = path.join(parentAlias, path.basename(process.cwd()));
      assert.match(
        run([INSTALL_SCRIPT, "install", "--target", aliasedRepo, "--no-enable"]),
        /Repository is already at target plugin directory/,
      );
      expectFail(
        [INSTALL_SCRIPT, "uninstall", "--target", aliasedRepo, "--no-enable"],
        /Refusing to delete the active source repository/,
      );
      assert.ok((await fs.stat(path.join(process.cwd(), "src"))).isDirectory());

      if (process.platform === "win32" || process.platform === "darwin") {
        const cwd = process.cwd();
        const caseVariant = cwd.toLowerCase() === cwd ? cwd.toUpperCase() : cwd.toLowerCase();
        assert.notEqual(caseVariant, cwd);
        assert.match(
          run([INSTALL_SCRIPT, "install", "--target", caseVariant, "--no-enable"]),
          /Repository is already at target plugin directory/,
        );
        expectFail(
          [INSTALL_SCRIPT, "uninstall", "--target", caseVariant, "--no-enable"],
          /Refusing to delete the active source repository/,
        );
        assert.ok((await fs.stat(path.join(cwd, "src"))).isDirectory());
      }

      // 2. Reject ancestor directory of REPO_ROOT even with a matching plugin.json
      const ancestorDir = path.join(sandbox, "ancestor-root");
      const nestedRepo = path.join(ancestorDir, "nested-repo");
      run([INSTALL_SCRIPT, "install", "--target", nestedRepo, "--no-enable"]);
      await fs.mkdir(path.join(nestedRepo, "src"), { recursive: true });
      await fs.writeFile(path.join(ancestorDir, "plugin.json"), JSON.stringify({ name: "agy-fast" }), "utf8");
      const nestedInstaller = path.join(nestedRepo, "scripts", "install.mjs");
      expectFail([nestedInstaller, "install", "--target", ancestorDir, "--no-enable"], /ancestor directory/);
      expectFail([nestedInstaller, "install", "--target", ancestorDir, "--link", "--no-enable"], /ancestor directory/);
      expectFail([nestedInstaller, "uninstall", "--target", ancestorDir, "--no-enable"], /ancestor directory/);
      assert.ok((await fs.stat(path.join(nestedRepo, "src"))).isDirectory());

      // 3. Reject non-empty non-agy-fast target dirs, other plugins, and regular files
      const nonPluginDir = path.join(sandbox, "user-projects");
      await fs.mkdir(nonPluginDir, { recursive: true });
      const keepUserFile = path.join(nonPluginDir, "important.txt");
      await fs.writeFile(keepUserFile, "do-not-delete", "utf8");
      expectFail([INSTALL_SCRIPT, "install", "--target", nonPluginDir, "--no-enable"], /Refusing to delete non-empty directory/);
      expectFail([INSTALL_SCRIPT, "install", "--target", nonPluginDir, "--link", "--no-enable"], /Refusing to delete non-empty directory/);
      expectFail([INSTALL_SCRIPT, "uninstall", "--target", nonPluginDir, "--no-enable"], /Refusing to delete non-empty directory/);
      assert.equal(await fs.readFile(keepUserFile, "utf8"), "do-not-delete");

      const otherPluginDir = path.join(sandbox, "other-plugin");
      await fs.mkdir(otherPluginDir, { recursive: true });
      await fs.writeFile(path.join(otherPluginDir, "plugin.json"), JSON.stringify({ name: "other-plugin" }), "utf8");
      expectFail([INSTALL_SCRIPT, "install", "--target", otherPluginDir, "--no-enable"], /Refusing to delete non-empty directory/);
      expectFail([INSTALL_SCRIPT, "uninstall", "--target", otherPluginDir, "--no-enable"], /Refusing to delete non-empty directory/);

      const regularFileTarget = path.join(sandbox, "regular-file.txt");
      await fs.writeFile(regularFileTarget, "keep-file", "utf8");
      expectFail([INSTALL_SCRIPT, "install", "--target", regularFileTarget, "--no-enable"], /Refusing to delete/);
      expectFail([INSTALL_SCRIPT, "uninstall", "--target", regularFileTarget, "--no-enable"], /Refusing to delete/);
      assert.equal(await fs.readFile(regularFileTarget, "utf8"), "keep-file");

      // 4. Empty dir, overwrite upgrade, self-uninstall (no src/), and symlink/broken-link safety
      const emptyForInstall = path.join(sandbox, "empty-install");
      await fs.mkdir(emptyForInstall, { recursive: true });
      run([INSTALL_SCRIPT, "install", "--target", emptyForInstall, "--no-enable"]);
      const staleMarker = path.join(emptyForInstall, "stale.tmp");
      await fs.writeFile(staleMarker, "old", "utf8");
      run([INSTALL_SCRIPT, "install", "--target", emptyForInstall, "--no-enable"]);
      await assert.rejects(fs.stat(staleMarker));
      run([path.join(emptyForInstall, "scripts", "install.mjs"), "uninstall", "--target", emptyForInstall, "--no-enable"]);
      await assert.rejects(fs.lstat(emptyForInstall));

      const emptyForUninstall = path.join(sandbox, "empty-uninstall");
      await fs.mkdir(emptyForUninstall, { recursive: true });
      run([INSTALL_SCRIPT, "uninstall", "--target", emptyForUninstall, "--no-enable"]);
      await assert.rejects(fs.lstat(emptyForUninstall));

      const repoLinkTarget = path.join(sandbox, "dev-link");
      run([INSTALL_SCRIPT, "install", "--target", repoLinkTarget, "--link", "--no-enable"]);
      const symlinkInstaller = path.join(repoLinkTarget, "scripts", "install.mjs");
      run(["--preserve-symlinks-main", symlinkInstaller, "install", "--target", repoLinkTarget, "--link", "--no-enable"]);
      assert.equal(await fs.realpath(repoLinkTarget), await fs.realpath(process.cwd()));
      run(["--preserve-symlinks-main", symlinkInstaller, "install", "--target", repoLinkTarget, "--no-enable"]);
      assert.ok(!(await fs.lstat(repoLinkTarget)).isSymbolicLink());
      assert.ok((await fs.stat(path.join(repoLinkTarget, "plugin.json"))).isFile());
      run([INSTALL_SCRIPT, "install", "--target", repoLinkTarget, "--link", "--no-enable"]);
      run([INSTALL_SCRIPT, "uninstall", "--target", repoLinkTarget, "--no-enable"]);
      await assert.rejects(fs.lstat(repoLinkTarget));
      assert.ok((await fs.stat(path.join(process.cwd(), "src"))).isDirectory());

      const extLink = path.join(sandbox, "ext-link-rm");
      await fs.symlink(nonPluginDir, extLink, linkType);
      run([INSTALL_SCRIPT, "uninstall", "--target", extLink, "--no-enable"]);
      await assert.rejects(fs.lstat(extLink));
      assert.equal(await fs.readFile(keepUserFile, "utf8"), "do-not-delete");

      const deadTarget = path.join(sandbox, "dead-target");
      const brokenLink = path.join(sandbox, "broken-link");
      await fs.mkdir(deadTarget, { recursive: true });
      await fs.symlink(deadTarget, brokenLink, linkType);
      await fs.rmdir(deadTarget);
      run([INSTALL_SCRIPT, "uninstall", "--target", brokenLink, "--no-enable"]);
      await assert.rejects(fs.lstat(brokenLink));
    } finally {
      await fs.unlink(parentAlias).catch(() => {});
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const INSTALL_SCRIPT = path.resolve(process.cwd(), "scripts", "install.mjs");
const INSTALL_SH = path.resolve(process.cwd(), "install.sh");

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
});

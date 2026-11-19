import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  compareSemver,
  consumeSnapshotUpdateNotice,
  pickLatestSemverTag,
  readInstalledVersion,
  runPluginUpdate,
  shouldTriggerBackgroundCheck,
  UPDATER_RUNTIME_FILES,
} from "../src/utils/updater-core.js";

const REPO_ROOT = process.cwd();
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install.mjs");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function copyRuntimeFixture(dstDir: string, version: string, marker: string): Promise<void> {
  await fs.mkdir(dstDir, { recursive: true });
  for (const rel of UPDATER_RUNTIME_FILES) {
    const src = path.join(REPO_ROOT, rel);
    const dst = path.join(dstDir, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }
  const manifestPath = path.join(dstDir, "plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = version;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const rulesPath = path.join(dstDir, "rules", "AGENTS.md");
  const rules = await fs.readFile(rulesPath, "utf8");
  await fs.writeFile(rulesPath, `${rules}\n<!-- marker:${marker} -->\n`, "utf8");
}

function runSessionStartHook(
  hookPath: string,
  workspaceDir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ cwd: workspaceDir }));
  });
}

describe("auto-updater", () => {
  let rootTmp: string;
  let originRepoDir: string;
  let originRepoUrl: string;
  let workRepoDir: string;

  before(async () => {
    rootTmp = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-updater-"));
    originRepoDir = path.join(rootTmp, "origin.git");
    workRepoDir = path.join(rootTmp, "work");
    await fs.mkdir(originRepoDir, { recursive: true });
    await fs.mkdir(workRepoDir, { recursive: true });

    git(originRepoDir, ["init", "--bare"]);
    originRepoUrl = pathToFileURL(originRepoDir).href;

    git(workRepoDir, ["init", "-b", "main"]);
    git(workRepoDir, ["config", "user.email", "test@example.com"]);
    git(workRepoDir, ["config", "user.name", "Test"]);
    git(workRepoDir, ["remote", "add", "origin", originRepoUrl]);

    // Publish v0.2.0
    await copyRuntimeFixture(workRepoDir, "0.2.0", "release-0.2.0");
    git(workRepoDir, ["add", "."]);
    git(workRepoDir, ["commit", "-m", "release v0.2.0"]);
    git(workRepoDir, ["tag", "-a", "v0.2.0", "-m", "v0.2.0"]);

    // Publish v0.3.0
    await copyRuntimeFixture(workRepoDir, "0.3.0", "release-0.3.0");
    git(workRepoDir, ["add", "."]);
    git(workRepoDir, ["commit", "-m", "release v0.3.0"]);
    git(workRepoDir, ["tag", "-a", "v0.3.0", "-m", "v0.3.0"]);
    git(workRepoDir, ["push", "origin", "main", "--tags"]);
  });

  after(async () => {
    await fs.rm(rootTmp, { recursive: true, force: true });
  });

  it("parses semver tags accurately and skips prereleases", () => {
    assert.equal(compareSemver("0.10.0", "0.2.0"), 1);
    assert.equal(compareSemver("v0.2.0", "0.2.0"), 0);
    assert.equal(compareSemver("0.1.9", "0.2.0"), -1);

    const lsOut = [
      "111111 refs/tags/v0.1.0",
      "222222 refs/tags/v0.2.0",
      "333333 refs/tags/v0.2.0^{}",
      "444444 refs/tags/v0.10.0",
      "555555 refs/tags/v0.11.0-beta.1",
    ].join("\n");
    const best = pickLatestSemverTag(lsOut);
    assert.deepEqual(best, {
      tag: "v0.10.0",
      version: "0.10.0",
      commitSha: "444444",
    });

    const now = Date.now();
    assert.equal(
      shouldTriggerBackgroundCheck(
        { lastCheckAt: new Date(now - 60_000).toISOString() },
        now,
        12 * 3600 * 1000,
      ),
      false,
    );
    assert.equal(
      shouldTriggerBackgroundCheck(
        { lastCheckAt: new Date(now - 13 * 3600 * 1000).toISOString() },
        now,
        12 * 3600 * 1000,
      ),
      true,
    );
  });

  it("auto-updates a copied install atomically, emits one-shot SessionStart notice, and respects notify/off modes", async () => {
    const fakeHome = path.join(rootTmp, "home-copied");
    const pluginDir = path.join(fakeHome, ".gemini", "config", "plugins", "agy-fast");
    const cacheDir = path.join(fakeHome, ".gemini", "cache", "agy-fast");
    await copyRuntimeFixture(pluginDir, "0.2.0", "release-0.2.0");

    const envBase: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      AGY_FAST_CACHE_DIR: cacheDir,
      AGY_FAST_REPO: originRepoUrl,
    };

    // 1. Disabled mode skips background checks completely
    const disabledRes = await runPluginUpdate({
      pluginDir,
      background: true,
      env: { ...envBase, AGY_FAST_AUTO_UPDATE: "off" },
    });
    assert.equal(disabledRes.status, "skipped-disabled");
    assert.equal(await readInstalledVersion(pluginDir), "0.2.0");

    // 2. Notify mode reports available update without overwriting files
    const notifyRes = await runPluginUpdate({
      pluginDir,
      background: true,
      env: { ...envBase, AGY_FAST_AUTO_UPDATE: "notify" },
    });
    assert.equal(notifyRes.status, "available");
    assert.equal(notifyRes.latestVersion, "0.3.0");
    assert.equal(await readInstalledVersion(pluginDir), "0.2.0");
    const notifyNotice = await consumeSnapshotUpdateNotice(pluginDir, "0.2.0", envBase);
    assert.match(notifyNotice ?? "", /Update available: v0\.2\.0 -> v0\.3\.0/);
    // Second read does NOT spam again for the same version
    assert.equal(await consumeSnapshotUpdateNotice(pluginDir, "0.2.0", envBase), null);

    // 3. Auto mode validates staged MCP server and atomically upgrades to v0.3.0
    const autoRes = await runPluginUpdate({
      pluginDir,
      background: true,
      env: { ...envBase, AGY_FAST_AUTO_UPDATE: "auto" },
    });
    assert.equal(autoRes.status, "updated");
    assert.equal(autoRes.latestVersion, "0.3.0");
    assert.equal(await readInstalledVersion(pluginDir), "0.3.0");
    assert.match(
      await fs.readFile(path.join(pluginDir, "rules", "AGENTS.md"), "utf8"),
      /marker:release-0\.3\.0/,
    );

    // 4. Next SessionStart injects the one-shot auto-updated notice, then stops repeating it
    const hookEnv: NodeJS.ProcessEnv = {
      ...envBase,
      AGY_FAST_AUTO_UPDATE: "auto",
      AGY_FAST_UPDATE_INTERVAL_HOURS: "24",
    };
    const hook1 = await runSessionStartHook(
      path.join(pluginDir, "dist", "session-start.mjs"),
      REPO_ROOT,
      hookEnv,
    );
    assert.equal(hook1.code, 0);
    const msg1 = JSON.parse(hook1.stdout).injectSteps[0].systemMessage.systemMessage as string;
    assert.match(msg1, /Auto-updated v0\.2\.0 -> v0\.3\.0/);

    const hook2 = await runSessionStartHook(
      path.join(pluginDir, "dist", "session-start.mjs"),
      REPO_ROOT,
      hookEnv,
    );
    const msg2 = JSON.parse(hook2.stdout).injectSteps[0].systemMessage.systemMessage as string;
    assert.doesNotMatch(msg2, /Auto-updated v0\.2\.0 -> v0\.3\.0/);

    // 5. Re-running update now reports up-to-date
    const upToDate = await runPluginUpdate({
      pluginDir,
      env: { ...envBase, AGY_FAST_AUTO_UPDATE: "auto" },
    });
    assert.equal(upToDate.status, "up-to-date");
  });

  it("protects symlinks, dirty git clones, concurrent locks, and rejects broken staged releases", async () => {
    const fakeHome = path.join(rootTmp, "home-guards");
    const cacheDir = path.join(fakeHome, ".gemini", "cache", "agy-fast");
    const envBase: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      AGY_FAST_CACHE_DIR: cacheDir,
      AGY_FAST_REPO: originRepoUrl,
      AGY_FAST_AUTO_UPDATE: "auto",
    };

    // 1. Symlink install is never overwritten
    const realTarget = path.join(rootTmp, "dev-real");
    await copyRuntimeFixture(realTarget, "0.2.0", "dev-0.2.0");
    const linkDir = path.join(fakeHome, ".gemini", "config", "plugins", "agy-fast");
    await fs.mkdir(path.dirname(linkDir), { recursive: true });
    await fs.symlink(realTarget, linkDir, process.platform === "win32" ? "junction" : "dir");
    const linkRes = await runPluginUpdate({ pluginDir: linkDir, background: true, env: envBase });
    assert.equal(linkRes.status, "available");
    assert.equal(linkRes.installKind, "symlink");
    assert.equal(await readInstalledVersion(realTarget), "0.2.0");

    // 2. Clean git-clone inside plugins/agy-fast auto-updates cleanly; dirty clone is protected
    const cloneHome = path.join(rootTmp, "home-gitclone");
    const cloneDir = path.join(cloneHome, ".gemini", "config", "plugins", "agy-fast");
    await fs.mkdir(path.dirname(cloneDir), { recursive: true });
    git(path.dirname(cloneDir), ["clone", "--branch", "v0.2.0", originRepoUrl, cloneDir]);
    const cloneEnv: NodeJS.ProcessEnv = {
      ...envBase,
      HOME: cloneHome,
      USERPROFILE: cloneHome,
      AGY_FAST_CACHE_DIR: path.join(cloneHome, ".gemini", "cache", "agy-fast"),
    };

    // Dirty tree -> notify only
    await fs.writeFile(path.join(cloneDir, "local-edit.txt"), "dirty", "utf8");
    const dirtyRes = await runPluginUpdate({ pluginDir: cloneDir, background: true, env: cloneEnv });
    assert.equal(dirtyRes.status, "available");
    assert.equal(dirtyRes.installKind, "git-dirty");
    assert.equal(await readInstalledVersion(cloneDir), "0.2.0");

    // Clean tree -> auto-updates git clone to v0.3.0
    await fs.rm(path.join(cloneDir, "local-edit.txt"));
    const cleanRes = await runPluginUpdate({ pluginDir: cloneDir, background: true, env: cloneEnv });
    assert.equal(cleanRes.status, "updated");
    assert.equal(cleanRes.installKind, "git-clone");
    assert.equal(await readInstalledVersion(cloneDir), "0.3.0");

    // 3. Active lock prevents concurrent duplicate updates
    const lockDir = path.join(rootTmp, "lock-cache");
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "update.lock"),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );
    const lockedRes = await runPluginUpdate({
      pluginDir: cloneDir,
      env: { ...cloneEnv, AGY_FAST_CACHE_DIR: lockDir },
    });
    assert.equal(lockedRes.status, "skipped-locked");

    // 4. Publish broken v0.4.0 (syntax error in dist/mcp-server.mjs) -> pre-swap smoke test rejects it and preserves v0.3.0
    await copyRuntimeFixture(workRepoDir, "0.4.0", "broken-0.4.0");
    await fs.writeFile(
      path.join(workRepoDir, "dist", "mcp-server.mjs"),
      "throw new Error('broken release');\n",
      "utf8",
    );
    git(workRepoDir, ["add", "."]);
    git(workRepoDir, ["commit", "-m", "broken v0.4.0"]);
    git(workRepoDir, ["tag", "-a", "v0.4.0", "-m", "v0.4.0"]);
    git(workRepoDir, ["push", "origin", "main", "--tags"]);

    const safeCopiedDir = path.join(rootTmp, "safe-copied");
    await copyRuntimeFixture(safeCopiedDir, "0.3.0", "release-0.3.0");
    const brokenRes = await runPluginUpdate({
      pluginDir: safeCopiedDir,
      env: {
        ...envBase,
        AGY_FAST_CACHE_DIR: path.join(rootTmp, "broken-cache"),
      },
    });
    assert.equal(brokenRes.status, "error");
    assert.match(brokenRes.message, /smoke check failed/i);
    assert.equal(await readInstalledVersion(safeCopiedDir), "0.3.0");

    // Remove broken v0.4.0 tag from origin so CLI test sees clean v0.3.0
    git(workRepoDir, ["push", "origin", ":refs/tags/v0.4.0"]);
    git(workRepoDir, ["tag", "-d", "v0.4.0"]);
  });

  it("supports 'scripts/install.mjs config' and 'scripts/install.mjs update --check / update'", async () => {
    const cliHome = path.join(rootTmp, "home-cli");
    const pluginDir = path.join(cliHome, ".gemini", "config", "plugins", "agy-fast");
    const cacheDir = path.join(cliHome, ".gemini", "cache", "agy-fast");
    await copyRuntimeFixture(pluginDir, "0.2.0", "release-0.2.0");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: cliHome,
      USERPROFILE: cliHome,
      AGY_FAST_CACHE_DIR: cacheDir,
    };

    const cfgOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "config", "--auto-update", "notify", "--interval", "24", "--repo", originRepoUrl],
      { env, encoding: "utf8" },
    );
    assert.match(cfgOut, /autoUpdate\s+: notify/);
    assert.match(cfgOut, /checkIntervalHours: 24/);

    const checkOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "update", "--check", "--target", pluginDir],
      { env, encoding: "utf8" },
    );
    assert.match(checkOut, /Update available: v0\.2\.0 -> v0\.3\.0/);
    assert.equal(await readInstalledVersion(pluginDir), "0.2.0");

    const applyOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "update", "--target", pluginDir],
      { env, encoding: "utf8" },
    );
    assert.match(applyOut, /Updated agy-fast v0\.2\.0 -> v0\.3\.0/);
    assert.match(applyOut, /Version\s+: v0\.3\.0/);
    assert.equal(await readInstalledVersion(pluginDir), "0.3.0");
  });
});

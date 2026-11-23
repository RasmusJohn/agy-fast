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
  fetchLatestRemoteVersion,
  pickLatestSemverTag,
  readInstalledVersion,
  runPluginUpdate,
  shouldTriggerBackgroundCheck,
  UPDATER_RUNTIME_FILES,
  validateRepoUrl,
  verifyStagedPlugin,
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
  for (const rel of [...UPDATER_RUNTIME_FILES, ".gitignore"]) {
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
        4 * 3600 * 1000,
      ),
      false,
    );
    assert.equal(
      shouldTriggerBackgroundCheck(
        { lastCheckAt: new Date(now - 5 * 3600 * 1000).toISOString() },
        now,
        4 * 3600 * 1000,
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
    delete env.GEMINI_HOME;
    delete env.ANTIGRAVITY_APP_DATA_DIR;

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

    // Global update (without --target) also syncs any discovered T3 Code ACP profile
    const t3ProfileRoot = path.join(cliHome, ".t3", "userdata", "providers", "antigravity", "abcd1234");
    await fs.mkdir(path.join(t3ProfileRoot, "config"), { recursive: true });
    const t3PluginDir = path.join(t3ProfileRoot, "config", "plugins", "agy-fast");

    const applyOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "update"],
      { env, encoding: "utf8" },
    );
    assert.match(applyOut, /Updated agy-fast v0\.2\.0 -> v0\.3\.0/);
    assert.match(applyOut, /Synced T3 Code ACP \(abcd1234\)/);
    assert.match(applyOut, /Version\s+: v0\.3\.0/);
    assert.equal(await readInstalledVersion(pluginDir), "0.3.0");
    assert.equal(await readInstalledVersion(t3PluginDir), "0.3.0");
  });

  it("prevents main-channel silent downgrades, keeps plugin.json last on swap failure, fetches git-clone from verified staging, protects dev-source, and reclaims dead-PID locks", async () => {
    // 1. Untagged repo at v0.2.0 on main must NOT silently downgrade v0.3.0 or redundantly overwrite v0.2.0
    const untaggedBare = path.join(rootTmp, "untagged-origin.git");
    const untaggedWork = path.join(rootTmp, "untagged-work");
    await fs.mkdir(untaggedBare, { recursive: true });
    await fs.mkdir(untaggedWork, { recursive: true });
    git(untaggedBare, ["init", "--bare"]);
    const untaggedUrl = pathToFileURL(untaggedBare).href;
    git(untaggedWork, ["init", "-b", "main"]);
    git(untaggedWork, ["config", "user.email", "test@example.com"]);
    git(untaggedWork, ["config", "user.name", "Test"]);
    git(untaggedWork, ["remote", "add", "origin", untaggedUrl]);
    await copyRuntimeFixture(untaggedWork, "0.2.0", "untagged-0.2.0");
    git(untaggedWork, ["add", "."]);
    git(untaggedWork, ["commit", "-m", "main v0.2.0"]);
    git(untaggedWork, ["push", "origin", "main"]);

    const downgradePlugin = path.join(rootTmp, "downgrade-guard", "plugins", "agy-fast");
    await copyRuntimeFixture(downgradePlugin, "0.3.0", "installed-0.3.0");
    const dgRes = await runPluginUpdate({
      pluginDir: downgradePlugin,
      channel: "main",
      repoUrl: untaggedUrl,
      env: { ...process.env, AGY_FAST_CACHE_DIR: path.join(rootTmp, "dg-cache") },
    });
    assert.equal(dgRes.status, "up-to-date");
    assert.equal(await readInstalledVersion(downgradePlugin), "0.3.0");
    assert.match(await fs.readFile(path.join(downgradePlugin, "rules", "AGENTS.md"), "utf8"), /marker:installed-0\.3\.0/);

    const sameVerPlugin = path.join(rootTmp, "samever-guard", "plugins", "agy-fast");
    await copyRuntimeFixture(sameVerPlugin, "0.2.0", "installed-0.2.0");
    const svRes = await runPluginUpdate({
      pluginDir: sameVerPlugin,
      channel: "main",
      repoUrl: untaggedUrl,
      env: { ...process.env, AGY_FAST_CACHE_DIR: path.join(rootTmp, "sv-cache") },
    });
    assert.equal(svRes.status, "up-to-date");
    assert.match(await fs.readFile(path.join(sameVerPlugin, "rules", "AGENTS.md"), "utf8"), /marker:installed-0\.2\.0/);

    // 2. syncRuntimeFilesAtomically writes plugin.json LAST so a failure on dist/mcp-server.mjs does not advance version or leak tmp files
    const partialPlugin = path.join(rootTmp, "partial-swap");
    await copyRuntimeFixture(partialPlugin, "0.2.0", "partial-0.2.0");
    const mcpDst = path.join(partialPlugin, "dist", "mcp-server.mjs");
    const origCopyFile = fs.copyFile;
    const origRename = fs.rename;
    fs.rename = (async (...args: Parameters<typeof origRename>) => {
      if (String(args[1]) === mcpDst) {
        const err = new Error("EBUSY") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return origRename(...args);
    }) as typeof fs.rename;
    fs.copyFile = (async (...args: Parameters<typeof origCopyFile>) => {
      if (String(args[1]) === mcpDst) {
        const err = new Error("EBUSY") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return origCopyFile(...args);
    }) as typeof fs.copyFile;
    try {
      const failRes = await runPluginUpdate({
        pluginDir: partialPlugin,
        repoUrl: originRepoUrl,
        env: { ...process.env, AGY_FAST_CACHE_DIR: path.join(rootTmp, "partial-cache") },
      });
      assert.equal(failRes.status, "error");
    } finally {
      fs.copyFile = origCopyFile;
      fs.rename = origRename;
    }
    assert.equal(await readInstalledVersion(partialPlugin), "0.2.0");
    assert.equal((await fs.readdir(path.join(partialPlugin, "dist"))).some((n) => n.includes(".agy-tmp.")), false);

    // 3. git-clone honors --repo override (fetching from verified stagingDir even if origin is broken)
    const overrideCloneDir = path.join(rootTmp, "override-home", ".gemini", "config", "plugins", "agy-fast");
    await fs.mkdir(path.dirname(overrideCloneDir), { recursive: true });
    git(path.dirname(overrideCloneDir), ["clone", "--branch", "v0.2.0", originRepoUrl, overrideCloneDir]);
    git(overrideCloneDir, ["remote", "set-url", "origin", "file:///nonexistent-agy-fast-origin.git"]);
    const overrideRes = await runPluginUpdate({
      pluginDir: overrideCloneDir,
      repoUrl: originRepoUrl,
      env: { ...process.env, AGY_FAST_CACHE_DIR: path.join(rootTmp, "override-cache") },
    });
    assert.equal(overrideRes.status, "updated");
    assert.equal(await readInstalledVersion(overrideCloneDir), "0.3.0");

    // 4. dev-source outside plugins/agy-fast stays notify-only even with force: true
    const devCheckout = path.join(rootTmp, "dev-checkout");
    git(rootTmp, ["clone", "--branch", "v0.2.0", originRepoUrl, devCheckout]);
    const devRes = await runPluginUpdate({
      pluginDir: devCheckout,
      force: true,
      repoUrl: originRepoUrl,
      env: { ...process.env, AGY_FAST_CACHE_DIR: path.join(rootTmp, "dev-cache") },
    });
    assert.equal(devRes.status, "available");
    assert.equal(devRes.installKind, "dev-source");
    assert.equal(await readInstalledVersion(devCheckout), "0.2.0");

    // 5. Stale lock held by a dead PID (< 10 min old) is reclaimed immediately
    const deadLockCache = path.join(rootTmp, "dead-lock-cache");
    await fs.mkdir(deadLockCache, { recursive: true });
    const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
    const deadPid = deadChild.pid!;
    await new Promise<void>((resolve) => deadChild.on("close", () => resolve()));
    await fs.writeFile(
      path.join(deadLockCache, "update.lock"),
      JSON.stringify({ pid: deadPid, createdAt: new Date().toISOString() }),
      "utf8",
    );
    const reclaimedRes = await runPluginUpdate({
      pluginDir: overrideCloneDir,
      repoUrl: originRepoUrl,
      env: { ...process.env, AGY_FAST_CACHE_DIR: deadLockCache },
    });
    assert.equal(reclaimedRes.status, "up-to-date");

    // 6. User-authored rules/AGENTS.local.md survives BOTH copied auto-updates AND git-clone updates (no git-dirty!)
    const localCopiedDir = path.join(rootTmp, "local-copied-plugin");
    await copyRuntimeFixture(localCopiedDir, "0.2.0", "release-0.2.0");
    await fs.writeFile(
      path.join(localCopiedDir, "rules", "AGENTS.local.md"),
      "---\ntrigger: always_on\n---\n# Personal local rule\n",
      "utf8",
    );
    const copiedLocalRes = await runPluginUpdate({
      pluginDir: localCopiedDir,
      repoUrl: originRepoUrl,
      env: { ...process.env, AGY_FAST_CACHE_DIR: path.join(rootTmp, "local-copied-cache") },
    });
    assert.equal(copiedLocalRes.status, "updated");
    assert.equal(
      await fs.readFile(path.join(localCopiedDir, "rules", "AGENTS.local.md"), "utf8"),
      "---\ntrigger: always_on\n---\n# Personal local rule\n",
    );

    const localGitDir = path.join(rootTmp, "local-git-home", ".gemini", "config", "plugins", "agy-fast");
    await fs.mkdir(path.dirname(localGitDir), { recursive: true });
    git(path.dirname(localGitDir), ["clone", "--branch", "v0.2.0", originRepoUrl, localGitDir]);
    await fs.writeFile(
      path.join(localGitDir, "rules", "AGENTS.local.md"),
      "---\ntrigger: always_on\n---\n# Git clone local rule\n",
      "utf8",
    );
    const gitLocalRes = await runPluginUpdate({
      pluginDir: localGitDir,
      repoUrl: originRepoUrl,
      env: { ...process.env, AGY_FAST_CACHE_DIR: path.join(rootTmp, "local-git-cache") },
    });
    assert.equal(gitLocalRes.status, "updated");
    assert.equal(gitLocalRes.installKind, "git-clone");
    assert.equal(
      await fs.readFile(path.join(localGitDir, "rules", "AGENTS.local.md"), "utf8"),
      "---\ntrigger: always_on\n---\n# Git clone local rule\n",
    );

    // 7. Persisted toolLoading: "lazy" in config.json is preserved across copied auto-updates
    const lazyUpdateDir = path.join(rootTmp, "lazy-copied-plugin");
    const lazyCacheDir = path.join(rootTmp, "lazy-copied-cache");
    await copyRuntimeFixture(lazyUpdateDir, "0.2.0", "release-0.2.0");
    await fs.mkdir(lazyCacheDir, { recursive: true });
    await fs.writeFile(
      path.join(lazyCacheDir, "config.json"),
      JSON.stringify({ toolLoading: "lazy" }),
      "utf8",
    );
    const lazyUpdRes = await runPluginUpdate({
      pluginDir: lazyUpdateDir,
      repoUrl: originRepoUrl,
      env: { ...process.env, AGY_FAST_CACHE_DIR: lazyCacheDir },
    });
    assert.equal(lazyUpdRes.status, "updated");
    const updatedMcpCfg = JSON.parse(
      await fs.readFile(path.join(lazyUpdateDir, "mcp_config.json"), "utf8"),
    );
    assert.equal(updatedMcpCfg.mcpServers.fast.tools, undefined);
  });

  it("blocks git option injection in repoUrl, avoids release->main error fallback, and handles verifyStagedPlugin EPIPE/stderr", async () => {
    // 1. Option-like or control-char repoUrl values are rejected before spawning git
    for (const bad of ["--upload-pack=evil", "-c", "https://example.com\n--upload-pack=x", ""]) {
      assert.throws(() => validateRepoUrl(bad), /Invalid update repository URL/);
      await assert.rejects(
        () => fetchLatestRemoteVersion({ repoUrl: bad, channel: "release", timeoutMs: 2000 }),
        /Invalid update repository URL/,
      );
    }

    // 2. Transient/unreachable release remote throws immediately instead of falling through to main
    await assert.rejects(
      () =>
        fetchLatestRemoteVersion({
          repoUrl: pathToFileURL(path.join(rootTmp, "definitely-missing-repo.git")).href,
          channel: "release",
          timeoutMs: 3000,
        }),
    );

    // 3. verifyStagedPlugin survives immediate crash (EPIPE) and >128 KiB stderr without crashing or deadlocking
    const crashStage = path.join(rootTmp, "crash-stage");
    await copyRuntimeFixture(crashStage, "0.9.0", "crash");
    await fs.writeFile(path.join(crashStage, "dist", "mcp-server.mjs"), "process.exit(1);\n", "utf8");
    const crashCheck = await verifyStagedPlugin(crashStage);
    assert.equal(crashCheck.ok, false);

    const loudStage = path.join(rootTmp, "loud-stderr-stage");
    await copyRuntimeFixture(loudStage, "0.9.1", "loud");
    await fs.writeFile(
      path.join(loudStage, "dist", "mcp-server.mjs"),
      `process.stderr.write("E".repeat(160 * 1024));
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  if (msg.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }] } }) + "\\n");
});\n`,
      "utf8",
    );
    const loudCheck = await verifyStagedPlugin(loudStage);
    assert.equal(loudCheck.ok, true);
  });
});

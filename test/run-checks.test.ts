import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runChecks } from "../src/tools/run-checks.js";
import {
  formatPowerShellCommand,
  needsPowerShellOnWindows,
  resetWindowsShellCache,
  resolveWindowsPowerShell,
} from "../src/utils/exec-utils.js";

describe("run_checks", () => {
  const nodeBin = JSON.stringify(process.execPath);

  it("executes multiple commands concurrently and compacts passing output", async () => {
    const start = Date.now();
    const res = await runChecks({
      concurrency: 3,
      outputMode: "compact",
      commands: [
        {
          name: "c1",
          command: `${nodeBin} -e "setTimeout(() => console.log('line1\\nline2\\nAll 10 tests passed'), 180)"`,
        },
        {
          name: "c2",
          command: `${nodeBin} -e "setTimeout(() => console.log('Build done in 0.2s'), 180)"`,
        },
        {
          name: "c3",
          command: `${nodeBin} -e "setTimeout(() => console.log('0 errors'), 180)"`,
        },
      ],
    });
    const elapsed = Date.now() - start;

    assert.equal(res.isError, false);
    assert.match(res.text, /Checks: 3\/3 passed/);
    assert.match(res.text, /\[PASS \d+ms\] c1/);
    assert.match(res.text, /All 10 tests passed/);
    // Should clearly execute concurrently rather than 3 * 180ms = 540ms+ serially
    assert.ok(elapsed < 480, `Expected concurrent execution <480ms, got ${elapsed}ms`);
  });

  it("extracts error lines on failure and strips ANSI escape codes", async () => {
    const script = [
      "for (let i = 0; i < 40; i++) console.log('info step ' + i);",
      "console.error('\\x1b[31mError: TS2322 type mismatch at src/a.ts:12\\x1b[0m');",
      "console.log('progress 10%\\rprogress 100%');",
      "process.exit(2);",
    ].join(" ");

    const res = await runChecks({
      outputMode: "compact",
      commands: [{ name: "typecheck", command: `${nodeBin} -e "${script}"` }],
    });

    assert.equal(res.isError, false);
    assert.match(res.text, /Checks: 0\/1 passed, 1 failed/);
    assert.match(res.text, /FAIL \(exit 2\)/);
    assert.match(res.text, /Error: TS2322 type mismatch/);
    assert.doesNotMatch(res.text, /\x1b\[31m/);
    assert.match(res.text, /progress 100%/);
  });

  it("enforces command timeouts cleanly", async () => {
    const res = await runChecks({
      timeoutSec: 1,
      commands: [
        {
          name: "hang",
          command: `${nodeBin} -e "setTimeout(() => console.log('never'), 10000)"`,
        },
      ],
    });

    assert.equal(res.isError, false);
    assert.match(res.text, /TIMEOUT/);
  });

  it("supports full output mode and rejects invalid inputs", async () => {
    const full = await runChecks({
      outputMode: "full",
      commands: [`${nodeBin} -e "console.log('alpha\\nbeta\\ngamma')"`],
    });
    assert.equal(full.isError, false);
    assert.match(full.text, /alpha\nbeta\ngamma/);

    const empty = await runChecks({ commands: [] });
    assert.equal(empty.isError, true);

    const badSubCwd = await runChecks({
      commands: [{ name: "badcwd", command: "echo hi", cwd: "/nonexistent-agy-fast-dir-12345" }],
    });
    assert.equal(badSubCwd.isError, true);
    assert.match(badSubCwd.text, /does not exist/);
  });

  it("captures npm ERR! lines and respects tight maxChars across multiple failures", async () => {
    const npmErrScript = [
      "for (let i = 0; i < 80; i++) console.log('verbose build step number ' + i + ' padding padding');",
      "console.error('npm ERR! code ELIFECYCLE');",
      "console.error('npm ERR! errno 1');",
      "for (let i = 0; i < 40; i++) console.log('trailing line ' + i + ' padding padding');",
      "process.exit(1);",
    ].join(" ");

    const res = await runChecks({
      outputMode: "compact",
      maxChars: 1200,
      commands: [
        { name: "npm-fail-1", command: `${nodeBin} -e "${npmErrScript}"` },
        { name: "npm-fail-2", command: `${nodeBin} -e "console.error('FAIL_TWO_MARKER'); process.exit(1)"` },
      ],
    });
    assert.equal(res.isError, false);
    assert.ok(res.text.length <= 1200, `Exceeded maxChars: ${res.text.length}`);
    assert.match(res.text, /npm ERR! code ELIFECYCLE/);
    assert.match(res.text, /FAIL_TWO_MARKER/);
  });

  it("detects PowerShell syntax vs cross-platform commands and formats quoted executables", () => {
    assert.equal(
      needsPowerShellOnWindows('node "$env:USERPROFILE\\.gemini\\dist\\benchmark.mjs" --help'),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows("Get-ChildItem src | Select-Object -First 5"),
      true,
    );
    assert.equal(
      needsPowerShellOnWindows("if (Test-Path dist) { Write-Output $LASTEXITCODE }"),
      true,
    );
    assert.equal(needsPowerShellOnWindows("$x = 1; echo $x"), true);

    assert.equal(needsPowerShellOnWindows("npm test"), false);
    assert.equal(needsPowerShellOnWindows("npm run test-unit"), false);
    assert.equal(
      needsPowerShellOnWindows('"D:\\Program Files\\nodejs\\node.exe" -e "console.log(1)"'),
      false,
    );
    assert.equal(needsPowerShellOnWindows("echo %USERPROFILE%"), false);
    assert.equal(
      needsPowerShellOnWindows('pwsh -NoProfile -Command "Write-Output ok"'),
      false,
    );

    assert.equal(
      formatPowerShellCommand('"$env:USERPROFILE\\bin\\tool.exe" --version'),
      '& "$env:USERPROFILE\\bin\\tool.exe" --version',
    );
    assert.equal(formatPowerShellCommand('"hello" | Out-Null'), '"hello" | Out-Null');
    assert.equal(
      formatPowerShellCommand('node "$env:USERPROFILE\\a.js"'),
      'node "$env:USERPROFILE\\a.js"',
    );
  });

  it("resolves pwsh -> powershell.exe -> null fallback chain and caches probe results", async () => {
    try {
      resetWindowsShellCache();
      const probed: string[] = [];
      const first = await resolveWindowsPowerShell(async (bin) => {
        probed.push(bin);
        return bin === "pwsh";
      });
      const cached = await resolveWindowsPowerShell(async (bin) => {
        probed.push(`unexpected-${bin}`);
        return false;
      });
      assert.equal(first, "pwsh");
      assert.equal(cached, "pwsh");
      assert.deepEqual(probed, ["pwsh"]);

      resetWindowsShellCache();
      const fallbackProbed: string[] = [];
      const second = await resolveWindowsPowerShell(async (bin) => {
        fallbackProbed.push(bin);
        return bin === "powershell.exe";
      });
      assert.equal(second, "powershell.exe");
      assert.deepEqual(fallbackProbed, ["pwsh", "powershell.exe"]);

      resetWindowsShellCache();
      const noneProbed: string[] = [];
      const third = await resolveWindowsPowerShell(async (bin) => {
        noneProbed.push(bin);
        return false;
      });
      assert.equal(third, null);
      assert.deepEqual(noneProbed, ["pwsh", "powershell.exe"]);
    } finally {
      resetWindowsShellCache();
    }
  });

  if (process.platform === "win32") {
    it("executes PowerShell $env: variables and cmdlets cleanly on Windows", async () => {
      const prev = process.env.AGY_FAST_PWSH_TEST;
      process.env.AGY_FAST_PWSH_TEST = "pwsh_env_expanded_ok";
      try {
        const res = await runChecks({
          outputMode: "full",
          commands: [
            {
              name: "win-ps-env",
              command: `${nodeBin} -e "console.log(process.argv[1])" "$env:AGY_FAST_PWSH_TEST"`,
            },
            {
              name: "win-ps-cmdlet",
              command: "Write-Output $env:AGY_FAST_PWSH_TEST",
            },
          ],
        });
        assert.equal(res.isError, false);
        assert.match(res.text, /Checks: 2\/2 passed/);
        assert.match(res.text, /pwsh_env_expanded_ok/);
      } finally {
        if (prev === undefined) {
          delete process.env.AGY_FAST_PWSH_TEST;
        } else {
          process.env.AGY_FAST_PWSH_TEST = prev;
        }
      }
    });
  }
});

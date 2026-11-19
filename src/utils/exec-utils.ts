import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

function killChildTree(pid: number | undefined, detached: boolean): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already exited
      }
    }
    return;
  }

  try {
    if (detached) {
      process.kill(-pid, "SIGTERM");
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process may already have exited
  }
  setTimeout(() => {
    try {
      if (detached) {
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Already exited
    }
  }, 400).unref();
}

export function execBinaryAsync(
  bin: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return spawnAndCollect(bin, args, false, options);
}

export type WindowsPowerShellBin = "pwsh" | "powershell.exe";
export type WindowsShellProbe = (bin: WindowsPowerShellBin) => Promise<boolean>;

const WINDOWS_PS_ENV_OR_VAR_RE =
  /\$env:[A-Za-z_][A-Za-z0-9_]*|\$(?:LASTEXITCODE|PSVersionTable|PSScriptRoot|PROFILE|HOME|PWD|null|true|false|_)\b|\$\([^)]|@\(|(?:^|[;\r\n])\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=/m;
const WINDOWS_PS_CMDLET_RE =
  /(?:^|[;|&({\r\n]\s*)(?:Get|Set|New|Remove|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|ConvertTo|ConvertFrom|Export|Import|Invoke|Start|Stop|Restart|Wait|Read|Write|Out|Format|Resolve|Join|Split|Copy|Move|Rename|Clear|Add|Push|Pop|Enable|Disable)-[A-Za-z]+\b/i;
const EXPLICIT_POWERSHELL_INVOCATION_RE =
  /^\s*(?:["']?)(?:pwsh|powershell)(?:\.exe)?(?:["']?)(?:\s|$)/i;

/**
 * Detects whether a Windows command uses PowerShell syntax (`$env:VAR`, automatic
 * variables, subexpressions, or `Verb-Noun` cmdlets) so cross-platform/cmd
 * commands keep fast `cmd.exe` execution without altering quoting behavior.
 */
export function needsPowerShellOnWindows(command: string): boolean {
  if (!command || EXPLICIT_POWERSHELL_INVOCATION_RE.test(command)) {
    return false;
  }
  return (
    WINDOWS_PS_ENV_OR_VAR_RE.test(command) || WINDOWS_PS_CMDLET_RE.test(command)
  );
}

/**
 * Prepends `&` when a PowerShell command starts with a quoted executable path
 * followed by arguments (e.g. `"C:\Program Files\nodejs\node.exe" -v`).
 */
export function formatPowerShellCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed || (trimmed[0] !== '"' && trimmed[0] !== "'")) {
    return command;
  }
  const quote = trimmed[0];
  let idx = 1;
  while (idx < trimmed.length) {
    if (trimmed[idx] === "`" && idx + 1 < trimmed.length) {
      idx += 2;
      continue;
    }
    if (trimmed[idx] === quote) {
      const rest = trimmed.slice(idx + 1).trimStart();
      if (rest && !/^(?:[|;&+})]|$)/.test(rest)) {
        return `& ${trimmed}`;
      }
      return command;
    }
    idx++;
  }
  return command;
}

let cachedWindowsPowerShell: WindowsPowerShellBin | null | undefined;
let pendingWindowsPowerShellProbe: Promise<WindowsPowerShellBin | null> | null = null;

async function defaultProbeWindowsShell(bin: WindowsPowerShellBin): Promise<boolean> {
  const res = await execBinaryAsync(
    bin,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {
      cwd: process.cwd(),
      timeoutMs: 3000,
      maxOutputBytes: 4096,
    },
  );
  return !res.error && res.exitCode === 0;
}

/**
 * Resolves the preferred PowerShell executable on Windows (`pwsh` -> `powershell.exe`
 * -> `null`), caching the probe result across calls.
 */
export async function resolveWindowsPowerShell(
  probe: WindowsShellProbe = defaultProbeWindowsShell,
): Promise<WindowsPowerShellBin | null> {
  if (cachedWindowsPowerShell !== undefined) {
    return cachedWindowsPowerShell;
  }
  if (pendingWindowsPowerShellProbe) {
    return pendingWindowsPowerShellProbe;
  }

  pendingWindowsPowerShellProbe = (async () => {
    try {
      if (await probe("pwsh")) {
        cachedWindowsPowerShell = "pwsh";
        return cachedWindowsPowerShell;
      }
      if (await probe("powershell.exe")) {
        cachedWindowsPowerShell = "powershell.exe";
        return cachedWindowsPowerShell;
      }
      cachedWindowsPowerShell = null;
      return null;
    } finally {
      pendingWindowsPowerShellProbe = null;
    }
  })();

  return pendingWindowsPowerShellProbe;
}

export function resetWindowsShellCache(): void {
  cachedWindowsPowerShell = undefined;
  pendingWindowsPowerShellProbe = null;
}

export async function runShellCommandAsync(
  command: string,
  options: ExecOptions,
): Promise<ExecResult> {
  if (process.platform === "win32" && needsPowerShellOnWindows(command)) {
    const psBin = await resolveWindowsPowerShell();
    if (psBin) {
      return spawnAndCollect(
        psBin,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          formatPowerShellCommand(command),
        ],
        false,
        options,
      );
    }
  }
  return spawnAndCollect(command, [], true, options);
}

function spawnAndCollect(
  commandOrBin: string,
  args: string[],
  shell: boolean,
  options: ExecOptions,
): Promise<ExecResult> {
  const startMs = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const detached = process.platform !== "win32";

  return new Promise<ExecResult>((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let child;
    try {
      child = spawn(commandOrBin, args, {
        cwd: options.cwd,
        shell,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startMs,
        stdout: "",
        stderr: "",
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let settleFallbackTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child.pid, detached);
      settleFallbackTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, "SIGKILL");
      }, 1500);
      settleFallbackTimer.unref();
    }, Math.max(100, options.timeoutMs));
    timer.unref();

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      error?: string,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startMs,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        truncated,
        error,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - stderrBytes;
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        truncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on("error", (err) => {
      finish(null, null, err.message);
    });

    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

let cachedRgAvailable: boolean | null = null;

export async function isRipgrepAvailable(): Promise<boolean> {
  if (cachedRgAvailable !== null) return cachedRgAvailable;
  const res = await execBinaryAsync("rg", ["--version"], {
    cwd: process.cwd(),
    timeoutMs: 2000,
    maxOutputBytes: 4096,
  });
  cachedRgAvailable = !res.error && res.exitCode === 0;
  return cachedRgAvailable;
}

export function resetRipgrepCache(): void {
  cachedRgAvailable = null;
}

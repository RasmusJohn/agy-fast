import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspaceSnapshot } from "./utils/snapshot.js";
import {
  consumeSnapshotUpdateNotice,
  readInstalledVersion,
  readUpdateState,
  resolveUpdaterSettings,
  shouldTriggerBackgroundCheck,
  spawnBackgroundUpdateCheck,
  writeUpdateState,
} from "./utils/updater-core.js";

interface SessionStartPayload {
  cwd?: string;
  workspacePaths?: string[];
  workspace_paths?: string[];
  workspaceRoots?: string[];
  workspace_roots?: string[];
  hookEventName?: string;
  hook_event_name?: string;
}

function firstNonEmptyPath(list: unknown): string {
  if (!Array.isArray(list)) return "";
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  return "";
}

async function readStdin(timeoutMs = 1500): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref();

    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

async function main(): Promise<void> {
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      process.stdout.write("{}\n");
      return;
    }

    let payload: SessionStartPayload;
    try {
      payload = JSON.parse(raw) as SessionStartPayload;
    } catch {
      process.stdout.write("{}\n");
      return;
    }

    const workspaceDir =
      (typeof payload.cwd === "string" && payload.cwd.trim()) ||
      firstNonEmptyPath(payload.workspacePaths) ||
      firstNonEmptyPath(payload.workspace_paths) ||
      firstNonEmptyPath(payload.workspaceRoots) ||
      firstNonEmptyPath(payload.workspace_roots);

    if (!workspaceDir) {
      process.stdout.write("{}\n");
      return;
    }

    const snapshot = await buildWorkspaceSnapshot(workspaceDir, {
      maxChars: 1500,
      gitTimeoutMs: 800,
    });

    if (!snapshot) {
      process.stdout.write("{}\n");
      return;
    }

    let updateNotice: string | null = null;
    try {
      const pluginDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
      );
      const settings = await resolveUpdaterSettings();
      if (settings.mode !== "off") {
        const [currentVersion, state] = await Promise.all([
          readInstalledVersion(pluginDir),
          readUpdateState(),
        ]);
        updateNotice = await consumeSnapshotUpdateNotice(
          pluginDir,
          currentVersion,
        );
        if (shouldTriggerBackgroundCheck(state, Date.now(), settings.checkIntervalMs)) {
          const updaterPath = path.join(pluginDir, "dist", "updater.mjs");
          const hasUpdater = await fs
            .access(updaterPath)
            .then(() => true)
            .catch(() => false);
          if (hasUpdater) {
            await writeUpdateState({
              lastCheckAttemptAt: new Date().toISOString(),
            }).catch(() => {});
            spawnBackgroundUpdateCheck(pluginDir);
          }
        }
      }
    } catch {
      // Never block or break SessionStart on updater errors
    }

    const messageText = updateNotice
      ? `${snapshot}\n${updateNotice}`
      : snapshot;

    const response = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: messageText,
          },
        },
      ],
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch {
    // Always fail open so session startup is never blocked
    process.stdout.write("{}\n");
  }
}

void main();

import { buildWorkspaceSnapshot } from "./utils/snapshot.js";

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

    const response = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: snapshot,
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

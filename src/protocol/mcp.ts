import type { Readable, Writable } from "node:stream";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

export type McpToolHandler = (
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

export interface RegisteredTool {
  definition: McpToolDefinition;
  handler: McpToolHandler;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

export class McpStdioServer {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly serverName: string;
  private readonly serverVersion: string;
  private inFlight = 0;
  private stdinEnded = false;
  private onDrainExit?: () => void;

  constructor(options: { name: string; version: string }) {
    this.serverName = options.name;
    this.serverVersion = options.version;
  }

  registerTool(definition: McpToolDefinition, handler: McpToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  async handleMessage(raw: unknown): Promise<JsonRpcResponse | null> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    const msg = raw as JsonRpcRequest;
    const hasId =
      Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== undefined;
    const id = hasId ? (msg.id ?? null) : null;
    const method = typeof msg.method === "string" ? msg.method : "";

    if (!method) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: missing method" },
      };
    }

    // Notifications (no id) must not produce a response
    if (!hasId) {
      return null;
    }

    if (method === "initialize") {
      const requested =
        typeof msg.params?.protocolVersion === "string"
          ? msg.params.protocolVersion.trim()
          : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: this.serverName,
            version: this.serverVersion,
          },
        },
      };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      const definitions = [...this.tools.values()].map((t) => t.definition);
      return { jsonrpc: "2.0", id, result: { tools: definitions } };
    }

    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }

    if (method === "resources/templates/list") {
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    }

    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }

    if (method === "tools/call") {
      const name =
        typeof msg.params?.name === "string" ? msg.params.name : "";
      const tool = this.tools.get(name);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` },
        };
      }

      const rawArgs = msg.params?.arguments;
      let args: Record<string, unknown>;
      if (rawArgs === undefined || rawArgs === null) {
        args = {};
      } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        args = rawArgs as Record<string, unknown>;
      } else if (typeof rawArgs === "string" && rawArgs.trim().startsWith("{")) {
        try {
          const parsedArgs: unknown = JSON.parse(rawArgs);
          if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
            args = parsedArgs as Record<string, unknown>;
          } else {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: `Invalid params: 'arguments' for '${name}' must be a JSON object`,
              },
            };
          }
        } catch {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Invalid params: malformed JSON string in 'arguments' for '${name}'`,
            },
          };
        }
      } else {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Invalid params: 'arguments' for '${name}' must be an object (received ${Array.isArray(rawArgs) ? "array" : typeof rawArgs})`,
          },
        };
      }

      try {
        const res = await tool.handler(args);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: res.text }],
            isError: Boolean(res.isError),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Tool error: ${message}` }],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  listen(
    input: Readable = process.stdin,
    output: Writable = process.stdout,
    onExit?: () => void,
  ): void {
    this.onDrainExit = onExit;
    let buffer: Buffer = Buffer.alloc(0);

    const writeResponse = (
      payload: JsonRpcResponse | JsonRpcResponse[],
      useContentLength: boolean,
    ): void => {
      const serialized = JSON.stringify(payload);
      if (useContentLength) {
        const len = Buffer.byteLength(serialized, "utf8");
        output.write(`Content-Length: ${len}\r\n\r\n${serialized}`);
      } else {
        output.write(`${serialized}\n`);
      }
    };

    const dispatchRawJson = (jsonText: string, useContentLength: boolean): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        writeResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          },
          useContentLength,
        );
        return;
      }

      this.inFlight += 1;
      const finish = () => {
        this.inFlight -= 1;
        if (this.stdinEnded && this.inFlight === 0) {
          this.onDrainExit?.();
        }
      };

      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          writeResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid Request: empty batch" },
            },
            useContentLength,
          );
          finish();
          return;
        }
        Promise.all(parsed.map((item) => this.handleMessage(item)))
          .then((responses) => {
            const nonNull = responses.filter(
              (r): r is JsonRpcResponse => r !== null,
            );
            if (nonNull.length > 0) {
              writeResponse(nonNull, useContentLength);
            }
          })
          .finally(finish);
        return;
      }

      this.handleMessage(parsed)
        .then((response) => {
          if (response !== null) {
            writeResponse(response, useContentLength);
          }
        })
        .finally(finish);
    };

    const drainBuffer = (): void => {
      while (buffer.length > 0) {
        // Trim leading blank lines / whitespace
        let offset = 0;
        while (
          offset < buffer.length &&
          (buffer[offset] === 0x0a || buffer[offset] === 0x0d)
        ) {
          offset++;
        }
        if (offset > 0) {
          buffer = buffer.subarray(offset);
          if (buffer.length === 0) break;
        }

        // Check for optional Content-Length / Content-Type LSP-style header framing
        const headerProbe = buffer.subarray(0, 16).toString("latin1").toLowerCase();
        if (
          headerProbe.startsWith("content-length:") ||
          headerProbe.startsWith("content-type:")
        ) {
          const crlfEnd = buffer.indexOf("\r\n\r\n");
          const lfEnd = buffer.indexOf("\n\n");
          let sepIdx = -1;
          let sepLen = 0;
          if (crlfEnd !== -1 && (lfEnd === -1 || crlfEnd < lfEnd)) {
            sepIdx = crlfEnd;
            sepLen = 4;
          } else if (lfEnd !== -1) {
            sepIdx = lfEnd;
            sepLen = 2;
          }
          if (sepIdx === -1) break; // wait for complete header

          const headerText = buffer.subarray(0, sepIdx).toString("latin1");
          const clMatches = [...headerText.matchAll(/^content-length:[ \t]*(\d+)[ \t]*\r?$/gim)];
          const maxFrameBytes = 64 * 1024 * 1024;
          if (clMatches.length !== 1) {
            writeResponse(
              {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32600, message: "Invalid Request: invalid Content-Length header" },
              },
              true,
            );
            buffer = buffer.subarray(sepIdx + sepLen);
            continue;
          }
          const contentLength = Number(clMatches[0]![1]!);
          if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxFrameBytes) {
            writeResponse(
              {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32600, message: "Invalid Request: Content-Length out of bounds" },
              },
              true,
            );
            buffer = Buffer.alloc(0);
            break;
          }
          const bodyStart = sepIdx + sepLen;
          if (buffer.length < bodyStart + contentLength) {
            break; // wait for complete body
          }
          const bodyText = buffer
            .subarray(bodyStart, bodyStart + contentLength)
            .toString("utf8");
          buffer = buffer.subarray(bodyStart + contentLength);
          dispatchRawJson(bodyText, true);
          continue;
        }

        // Standard MCP Stdio newline-delimited JSON framing
        const newlineIdx = buffer.indexOf(0x0a);
        if (newlineIdx === -1) break;

        const lineBuf = buffer.subarray(0, newlineIdx);
        buffer = buffer.subarray(newlineIdx + 1);
        const line = lineBuf.toString("utf8").trim();
        if (line.length > 0) {
          dispatchRawJson(line, false);
        }
      }
    };

    input.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
      drainBuffer();
    });

    input.on("end", () => {
      // Flush any trailing line without newline
      const remaining = buffer.toString("utf8").trim();
      buffer = Buffer.alloc(0);
      const lowerRem = remaining.toLowerCase();
      if (
        remaining.length > 0 &&
        !lowerRem.startsWith("content-length:") &&
        !lowerRem.startsWith("content-type:")
      ) {
        dispatchRawJson(remaining, false);
      }
      this.stdinEnded = true;
      if (this.inFlight === 0) {
        this.onDrainExit?.();
      }
    });

    input.on("error", () => {
      this.stdinEnded = true;
      if (this.inFlight === 0) {
        this.onDrainExit?.();
      }
    });
  }
}

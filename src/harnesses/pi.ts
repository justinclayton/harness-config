import { join } from "node:path";
import { homedir } from "node:os";
import type { HarnessAdapter, McpJsonEntry, Scope } from "./types.ts";
import type { McpDef } from "../manifest/schema.ts";
import {
  parseStdioCommand,
  resolveEnvItems,
  buildHeaders,
  isStdio,
} from "./mcp-util.ts";

export const pi: HarnessAdapter = {
  name: "pi",
  displayName: "Pi",
  mcpJsonKey: "mcpServers",
  supportsAgents: true,

  mcpConfigPath(scope: Scope): string {
    // Pi reads .mcp.json at project level (same as Claude Code)
    return scope === "global"
      ? join(homedir(), ".pi", "agent", "mcp.json")
      : ".mcp.json";
  },

  agentDir(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".pi", "agent", "agents")
      : join(".pi", "agents");
  },

  skillDir(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".pi", "agent", "skills")
      : join(".pi", "skills");
  },

  configRoot(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".pi", "agent")
      : ".pi";
  },

  translateMcp(name: string, def: McpDef, wrapperPath?: string): McpJsonEntry {
    // Pi uses the same MCP JSON format as Claude Code (.mcp.json)
    if (isStdio(def)) {
      if (wrapperPath) {
        return {
          command: wrapperPath,
          args: [],
          ...(resolveEnvItems(def.env) && { env: resolveEnvItems(def.env) }),
        };
      }
      const { command, args } = parseStdioCommand(def.stdio);
      return {
        command,
        args,
        ...(resolveEnvItems(def.env) && { env: resolveEnvItems(def.env) }),
      };
    }

    // HTTP/SSE
    const headers = buildHeaders(def.auth, def.headers);
    return {
      url: def.url,
      ...(headers && { headers }),
    };
  },

  binaryNames: ["pi"],
};

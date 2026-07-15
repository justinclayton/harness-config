import { join } from "node:path";
import { homedir } from "node:os";
import type { HarnessAdapter, McpJsonEntry, Scope } from "./types.ts";
import type { McpDef } from "../manifest/schema.ts";
import {
  parseStdioCommand,
  isStdio,
} from "./mcp-util.ts";

function resolveBobHeaderValue(value: string): string {
  if (value.startsWith("env:") || value.startsWith("keychain:")) {
    throw new Error(
      "IBM Bob IDE does not document environment or keychain interpolation in MCP headers; use a literal value or a credential-providing MCP server",
    );
  }
  return value;
}

function buildBobHeaders(
  auth?: string,
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  if (auth) result.Authorization = `Bearer ${resolveBobHeaderValue(auth)}`;
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key] = resolveBobHeaderValue(value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * IBM Bob — IBM's AI-first development partner / IDE.
 *
 * Config conventions (see https://bob.ibm.com/docs/ide):
 * - MCP: project `.bob/mcp.json`, global `~/.bob/settings/mcp.json`, key `mcpServers`
 * - Skills: `.bob/skills/<name>/SKILL.md` (project) or `~/.bob/skills/<name>/` (global)
 * - Agents are custom mode entries in `custom_modes.yaml`
 */
export const bob: HarnessAdapter = {
  name: "bob",
  displayName: "IBM Bob",
  mcpJsonKey: "mcpServers",
  supportsAgents: true,

  mcpConfigPath(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".bob", "settings", "mcp.json")
      : join(".bob", "mcp.json");
  },

  agentDir(_scope: Scope): string | null {
    return null;
  },

  agentConfigPath(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".bob", "settings", "custom_modes.yaml")
      : join(".bob", "custom_modes.yaml");
  },

  skillDir(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".bob", "skills")
      : join(".bob", "skills");
  },

  configRoot(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".bob")
      : ".bob";
  },

  translateMcp(name: string, def: McpDef, wrapperPath?: string): McpJsonEntry {
    if (isStdio(def)) {
      if (wrapperPath) {
        return {
          command: wrapperPath,
          args: [],
          ...(def.cwd && { cwd: def.cwd }),
          ...(def.alwaysAllow && { alwaysAllow: def.alwaysAllow }),
          ...(def.disabled !== undefined && { disabled: def.disabled }),
        };
      }
      const { command, args } = parseStdioCommand(def.stdio);
      return {
        command,
        args,
        ...(def.cwd && { cwd: def.cwd }),
        ...(def.alwaysAllow && { alwaysAllow: def.alwaysAllow }),
        ...(def.disabled !== undefined && { disabled: def.disabled }),
      };
    }

    const headers = buildBobHeaders(def.auth, def.headers);
    return {
      ...(def.transport !== "sse" && { type: "streamable-http" }),
      url: def.url,
      ...(headers && { headers }),
      ...(def.alwaysAllow && { alwaysAllow: def.alwaysAllow }),
      ...(def.disabled !== undefined && { disabled: def.disabled }),
    };
  },

  binaryNames: ["bobide"],
  detectionPaths: [
    "/Applications/IBM Bob.app",
    join(homedir(), "AppData", "Local", "Programs", "IBM Bob", "IBM Bob.exe"),
  ],
};

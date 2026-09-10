import { join } from "node:path";
import { homedir } from "node:os";
import type { HarnessAdapter, McpJsonEntry, Scope } from "./types.ts";
import type { EnvItem, McpDef } from "../manifest/schema.ts";
import { parseStdioCommand, isStdio } from "./mcp-util.ts";

function passthroughEnvVars(envItems: EnvItem[] | undefined): string[] {
  if (!envItems) return [];
  // Codex's `env_vars` list only whitelists bare passthrough names from the
  // host environment. Keychain-backed values are handled by the wrapper
  // script instead (see the wrapperPath branch below), so they never reach
  // this list.
  return envItems.filter((item): item is string => typeof item === "string");
}

function resolveCodexHeaderRef(value: string): { envVar: string } | { literal: string } {
  if (value.startsWith("keychain:")) {
    throw new Error(
      "Codex CLI's HTTP MCP transport has no subprocess to inject secrets into, " +
        "so keychain-backed auth/headers aren't supported for it; use a literal value, " +
        "env:VAR, or a stdio MCP server instead.",
    );
  }
  if (value.startsWith("env:")) {
    return { envVar: value.slice(4) };
  }
  return { literal: value };
}

/**
 * Codex CLI (OpenAI's coding agent).
 *
 * Config conventions (see https://developers.openai.com/codex/config-reference):
 * - MCP: global `~/.codex/config.toml` under `[mcp_servers.<id>]` tables (TOML, not JSON)
 * - Skills: `~/.agents/skills/<name>/SKILL.md` — Codex has no project-scoped skill dir
 * - No custom subagent/mode concept, so `agents` is unsupported
 *
 * Stdio servers whitelist passthrough env vars via `env_vars` rather than
 * interpolating `${env:VAR}` inline like the JSON-based harnesses. HTTP
 * servers authenticate via `bearer_token_env_var` and source headers from
 * `env_http_headers`, both by naming an environment variable rather than
 * embedding its value.
 */
export const codex: HarnessAdapter = {
  name: "codex",
  displayName: "Codex CLI",
  mcpJsonKey: "mcp_servers",
  mcpConfigFormat: "toml",
  supportsAgents: false,

  mcpConfigPath(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".codex", "config.toml")
      : join(".codex", "config.toml");
  },

  agentDir(_scope: Scope): string | null {
    return null;
  },

  skillDir(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".agents", "skills")
      : join(".agents", "skills");
  },

  configRoot(scope: Scope): string {
    return scope === "global"
      ? join(homedir(), ".codex")
      : ".codex";
  },

  translateMcp(name: string, def: McpDef, wrapperPath?: string): McpJsonEntry {
    if (isStdio(def)) {
      if (wrapperPath) {
        // The wrapper resolves keychain secrets and exports them itself,
        // so Codex just needs to launch it with no extra env wiring.
        return { command: wrapperPath, args: [] };
      }
      const { command, args } = parseStdioCommand(def.stdio);
      const envVars = passthroughEnvVars(def.env);
      return {
        command,
        args,
        ...(envVars.length > 0 && { env_vars: envVars }),
      };
    }

    // HTTP/streamable server
    const entry: McpJsonEntry = { url: def.url };

    if (def.auth) {
      const resolved = resolveCodexHeaderRef(def.auth);
      if ("envVar" in resolved) {
        entry.bearer_token_env_var = resolved.envVar;
      } else {
        entry.http_headers = { Authorization: `Bearer ${resolved.literal}` };
      }
    }

    if (def.headers) {
      const literalHeaders: Record<string, string> = {};
      const envHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(def.headers)) {
        const resolved = resolveCodexHeaderRef(value);
        if ("envVar" in resolved) {
          envHeaders[key] = resolved.envVar;
        } else {
          literalHeaders[key] = resolved.literal;
        }
      }
      if (Object.keys(literalHeaders).length > 0) {
        entry.http_headers = { ...(entry.http_headers as object), ...literalHeaders };
      }
      if (Object.keys(envHeaders).length > 0) {
        entry.env_http_headers = envHeaders;
      }
    }

    return entry;
  },

  binaryNames: ["codex"],
  detectionPaths: [join(homedir(), ".codex")],
};

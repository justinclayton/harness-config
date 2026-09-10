import { resolve } from "node:path";
import type { HarnessAdapter, Scope } from "../harnesses/types.ts";
import type { McpDef, NormalizedManifest } from "../manifest/schema.ts";
import { readJsonFile, writeJsonFile, mergeMcpEntries, removeMcpEntries } from "../util/json.ts";
import { readTomlFile, writeTomlFile } from "../util/toml.ts";

/**
 * Read a harness's MCP config file, dispatching to the right parser for its
 * declared format. Any code that inspects an MCP config file — not just the
 * add/remove functions below — must go through this rather than reaching for
 * readJsonFile directly, or it'll silently mis-parse TOML-based harnesses.
 */
export async function readMcpConfig(
  adapter: HarnessAdapter,
  configPath: string,
): Promise<Record<string, unknown>> {
  return adapter.mcpConfigFormat === "toml"
    ? readTomlFile(configPath)
    : readJsonFile(configPath);
}

async function writeMcpConfig(
  adapter: HarnessAdapter,
  configPath: string,
  data: Record<string, unknown>,
): Promise<void> {
  return adapter.mcpConfigFormat === "toml"
    ? writeTomlFile(configPath, data)
    : writeJsonFile(configPath, data);
}

export interface McpAddResult {
  harness: string;
  servers: string[];
  configPath: string;
}

export interface McpRmResult {
  harness: string;
  removed: string[];
  configPath: string;
}

/**
 * Install MCP servers to a harness config.
 * Additive: merges into existing config, overwrites matching entries.
 */
export async function addMcps(
  adapter: HarnessAdapter,
  mcps: Record<string, McpDef>,
  scope: Scope,
  wrapperPaths: Record<string, string>,
  cwd: string,
): Promise<McpAddResult> {
  const configPath = resolve(cwd, adapter.mcpConfigPath(scope));

  // Translate each MCP to harness-native format
  const entries: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(mcps)) {
    const wrapperPath = wrapperPaths[name];
    entries[name] = adapter.translateMcp(name, def, wrapperPath);
  }

  // Read existing, merge, write
  const existing = await readMcpConfig(adapter, configPath);
  const merged = mergeMcpEntries(existing, adapter.mcpJsonKey, entries);
  await writeMcpConfig(adapter, configPath, merged);

  return {
    harness: adapter.displayName,
    servers: Object.keys(mcps),
    configPath,
  };
}

/**
 * Remove MCP servers from a harness config by name.
 */
export async function removeMcps(
  adapter: HarnessAdapter,
  names: string[],
  scope: Scope,
  cwd: string,
): Promise<McpRmResult> {
  const configPath = resolve(cwd, adapter.mcpConfigPath(scope));

  const existing = await readMcpConfig(adapter, configPath);
  const updated = removeMcpEntries(existing, adapter.mcpJsonKey, names);
  await writeMcpConfig(adapter, configPath, updated);

  return {
    harness: adapter.displayName,
    removed: names,
    configPath,
  };
}

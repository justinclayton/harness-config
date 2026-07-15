import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import type { HarnessName } from "../manifest/schema.ts";
import type { HarnessAdapter } from "./types.ts";
import { claude } from "./claude.ts";
import { opencode } from "./opencode.ts";
import { copilot } from "./copilot.ts";
import { pi } from "./pi.ts";
import { bob } from "./bob.ts";

export { type HarnessAdapter, type Scope } from "./types.ts";
export { parseStdioCommand, resolveEnvItems, buildHeaders, hasKeychainEnvRefs, isStdio } from "./mcp-util.ts";

const registry: Record<HarnessName, HarnessAdapter> = {
  claude,
  opencode,
  copilot,
  pi,
  bob,
};

/**
 * Get the adapter for a harness by name.
 */
export function getHarness(name: HarnessName): HarnessAdapter {
  return registry[name];
}

/**
 * Get all registered harness adapters.
 */
export function getAllHarnesses(): HarnessAdapter[] {
  return Object.values(registry);
}

/**
 * Get adapters for a list of harness names.
 */
export function getHarnesses(names: HarnessName[]): HarnessAdapter[] {
  return names.map((n) => registry[n]);
}

/** Cache of binary detection results (per process). */
const detectionCache = new Map<string, boolean>();

/**
 * Check if a binary is available on the system PATH.
 * Results are cached for the lifetime of the process.
 */
export function isBinaryInstalled(binaryName: string): boolean {
  if (detectionCache.has(binaryName)) {
    return detectionCache.get(binaryName)!;
  }
  let found: boolean;
  try {
    const lookup = platform() === "win32" ? "where.exe" : "which";
    execFileSync(lookup, [binaryName], { stdio: "ignore" });
    found = true;
  } catch {
    found = false;
  }
  detectionCache.set(binaryName, found);
  return found;
}

/**
 * Detect if a harness is installed on the machine by checking for its binary.
 * Returns true if ANY of the adapter's binaryNames are found on PATH.
 */
export function isHarnessDetected(adapter: HarnessAdapter): boolean {
  return adapter.binaryNames.some((bin) => isBinaryInstalled(bin)) ||
    (adapter.detectionPaths?.some((path) => isDetectionPathInstalled(path)) ?? false);
}

function isDetectionPathInstalled(path: string): boolean {
  const cacheKey = `path:${path}`;
  if (detectionCache.has(cacheKey)) return detectionCache.get(cacheKey)!;
  const found = existsSync(path);
  detectionCache.set(cacheKey, found);
  return found;
}

/**
 * Clear the detection cache (useful for testing).
 */
export function clearDetectionCache(): void {
  detectionCache.clear();
}

/**
 * Seed the detection cache with known values (useful for testing).
 */
export function seedDetectionCache(entries: Record<string, boolean>): void {
  for (const [key, value] of Object.entries(entries)) {
    detectionCache.set(key, value);
  }
}

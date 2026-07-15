import { basename } from "node:path";
import type { NormalizedManifest, HarnessName, HarnessConfig, FileMapping } from "./manifest/schema.ts";
import { getHarness, type Scope } from "./harnesses/index.ts";
import { addMcps, removeMcps } from "./components/mcps.ts";
import { addAgent, removeAgent, resolveAgentContent } from "./components/agents.ts";
import { addSkill, preflightBobSkill, removeSkill } from "./components/skills.ts";
import { addFile, componentDestination, removeFile } from "./components/files.ts";
import { generateWrappers, getWrapperPath } from "./keychain/wrappers.ts";
import { needsKeychainWrapper } from "./keychain/resolve.ts";
import { buildBobMode } from "./components/bob-modes.ts";

export interface EngineOptions {
  /** Target harnesses (subset filter). If empty, uses all from manifest. */
  harnesses?: HarnessName[];
  /** Scope: project-local or global (home directory) */
  scope: Scope;
  /** Working directory — where output configs are written */
  cwd: string;
  /** Optional callback fired after each operation completes */
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  type: "mcp" | "agent" | "skill" | "file";
  name: string;
  path: string;
  action: "added" | "updated" | "removed" | "unchanged" | "skipped";
  harness: string;
}

export interface EngineResult {
  /** Per-harness results */
  results: HarnessResult[];
  /** Warnings (e.g., missing keychain items) */
  warnings: string[];
}

export interface HarnessResult {
  harness: string;
  mcps: string[];
  agents: ItemResult[];
  skills: ItemResult[];
  files: ItemResult[];
  skipped: { component: string; reason: string }[];
}

export interface ItemResult {
  name: string;
  path: string;
  unchanged: boolean;
}

/**
 * Execute the `add` operation: install manifest components to harnesses.
 */
export async function executeAdd(
  manifest: NormalizedManifest,
  options: EngineOptions,
): Promise<EngineResult> {
  const { harnesses: targetHarnesses, warnings } = resolveTargetHarnesses(manifest, options.harnesses);
  const results: HarnessResult[] = [];

  // Source paths resolve relative to manifest location; output relative to cwd
  const sourceDir = manifest.baseDir ?? options.cwd;

  // Validate every harness translation before writing any config or wrapper.
  for (const harnessName of targetHarnesses) {
    const adapter = getHarness(harnessName);
    for (const [name, def] of Object.entries(manifest.mcps)) {
      adapter.translateMcp(
        name,
        def,
        needsKeychainWrapper(def) ? getWrapperPath(name, def) : undefined,
      );
    }
    if (adapter.name === "bob") {
      const config = manifest.harnesses.get(harnessName);
      const skillPaths = [...manifest.skills, ...(config?.skills ?? [])];
      for (const skillPath of skillPaths) await preflightBobSkill(skillPath, sourceDir);

      const effectiveSlugs = new Set<string>();
      const agents = [
        ...(manifest.agents ?? []).map((agent) => ({ source: agent.source, overrides: agent.overrides.get(harnessName) })),
        ...(config?.agents ?? []).map((source) => ({ source, overrides: undefined })),
      ];
      for (const agent of agents) {
        const mode = buildBobMode(
          await resolveAgentContent(agent.source, sourceDir),
          agent.source,
          agent.overrides,
        );
        if (effectiveSlugs.has(mode.slug)) throw new Error(`Duplicate IBM Bob mode slug: ${mode.slug}`);
        effectiveSlugs.add(mode.slug);
      }
    }
  }

  // Generate wrappers for servers that need keychain resolution
  const wrapperPaths = await generateWrappers(manifest.mcps);

  for (const harnessName of targetHarnesses) {
    const adapter = getHarness(harnessName);
    const harnessConfig = manifest.harnesses.get(harnessName) ?? null;
    const result: HarnessResult = {
      harness: adapter.displayName,
      mcps: [],
      agents: [],
      skills: [],
      files: [],
      skipped: [],
    };

    // --- MCPs (universal) ---
    if (Object.keys(manifest.mcps).length > 0) {
      const mcpResult = await addMcps(adapter, manifest.mcps, options.scope, wrapperPaths, options.cwd);
      result.mcps = mcpResult.servers;
      if (options.onProgress) {
        for (const name of mcpResult.servers) {
          options.onProgress({ type: "mcp", name, path: mcpResult.configPath, action: "updated", harness: adapter.displayName });
        }
      }
    }

    // --- Skills (universal) — fetch all concurrently ---
    const skillResults = await Promise.all(
      manifest.skills.map((skillPath) => addSkill(adapter, skillPath, options.scope, sourceDir, options.cwd)),
    );
    for (let i = 0; i < manifest.skills.length; i++) {
      const skillPath = manifest.skills[i];
      const skillResult = skillResults[i];
      const skillItem: ItemResult = {
        name: basename(skillPath),
        path: skillResult.installed,
        unchanged: skillResult.unchanged ?? false,
      };
      result.skills.push(skillItem);
      if (options.onProgress) {
        options.onProgress({ type: "skill", name: skillItem.name, path: skillItem.path, action: skillItem.unchanged ? "unchanged" : "added", harness: adapter.displayName });
      }
    }

    // --- Universal Agents ---
    for (const agent of manifest.agents ?? []) {
      // Get per-harness overrides if any
      const overrides = agent.overrides.get(harnessName);
      const agentResult = await addAgent(adapter, agent.source, options.scope, sourceDir, options.cwd, overrides);
      if ("installed" in agentResult) {
        const item: ItemResult = {
          name: basename(agent.source),
          path: agentResult.installed,
          unchanged: agentResult.unchanged ?? false,
        };
        result.agents.push(item);
        if (options.onProgress) {
          options.onProgress({ type: "agent", name: item.name, path: item.path, action: item.unchanged ? "unchanged" : "added", harness: adapter.displayName });
        }
      } else {
        result.skipped.push({ component: agent.source, reason: agentResult.reason });
        if (options.onProgress) {
          options.onProgress({ type: "agent", name: basename(agent.source), path: "", action: "skipped", harness: adapter.displayName });
        }
      }
    }

    // --- Harness-specific components ---
    if (harnessConfig) {
      // Harness-specific agents
      if (harnessConfig.agents) {
        for (const agentPath of harnessConfig.agents) {
          const agentResult = await addAgent(adapter, agentPath, options.scope, sourceDir, options.cwd);
          if ("installed" in agentResult) {
            const item: ItemResult = {
              name: basename(agentPath),
              path: agentResult.installed,
              unchanged: agentResult.unchanged ?? false,
            };
            result.agents.push(item);
            if (options.onProgress) {
              options.onProgress({ type: "agent", name: item.name, path: item.path, action: item.unchanged ? "unchanged" : "added", harness: adapter.displayName });
            }
          } else {
            result.skipped.push({ component: agentPath, reason: agentResult.reason });
            if (options.onProgress) {
              options.onProgress({ type: "agent", name: basename(agentPath), path: "", action: "skipped", harness: adapter.displayName });
            }
          }
        }
      }

      // Harness-specific skills
      if (harnessConfig.skills) {
        const harnessSkillResults = await Promise.all(
          harnessConfig.skills.map((skillPath) => addSkill(adapter, skillPath, options.scope, sourceDir, options.cwd)),
        );
        for (let i = 0; i < harnessConfig.skills.length; i++) {
          const skillPath = harnessConfig.skills[i];
          const skillResult = harnessSkillResults[i];
          const skillItem: ItemResult = {
            name: basename(skillPath),
            path: skillResult.installed,
            unchanged: skillResult.unchanged ?? false,
          };
          result.skills.push(skillItem);
          if (options.onProgress) {
            options.onProgress({ type: "skill", name: skillItem.name, path: skillItem.path, action: skillItem.unchanged ? "unchanged" : "added", harness: adapter.displayName });
          }
        }
      }

      // Harness-specific files (escape hatch)
      if (harnessConfig.files) {
        for (const fileMapping of harnessConfig.files) {
          const fileResult = await addFile(adapter, fileMapping, options.scope, sourceDir, options.cwd);
          const fileItem: ItemResult = {
            name: fileMapping.dest,
            path: fileResult.installed,
            unchanged: fileResult.unchanged ?? false,
          };
          result.files.push(fileItem);
          if (options.onProgress) {
            options.onProgress({ type: "file", name: fileItem.name, path: fileItem.path, action: fileItem.unchanged ? "unchanged" : "added", harness: adapter.displayName });
          }
        }
      }

      // Rules and commands are just file copies to the config root
      if (harnessConfig.rules) {
        for (const rulePath of harnessConfig.rules) {
          const mapping: FileMapping = {
            source: rulePath,
            dest: componentDestination(adapter, "rules", rulePath),
          };
          const fileResult = await addFile(adapter, mapping, options.scope, sourceDir, options.cwd);
          const fileItem: ItemResult = {
            name: mapping.dest,
            path: fileResult.installed,
            unchanged: fileResult.unchanged ?? false,
          };
          result.files.push(fileItem);
          if (options.onProgress) {
            options.onProgress({ type: "file", name: fileItem.name, path: fileItem.path, action: fileItem.unchanged ? "unchanged" : "added", harness: adapter.displayName });
          }
        }
      }

      if (harnessConfig.commands) {
        for (const cmdPath of harnessConfig.commands) {
          const mapping: FileMapping = {
            source: cmdPath,
            dest: componentDestination(adapter, "commands", cmdPath),
          };
          const fileResult = await addFile(adapter, mapping, options.scope, sourceDir, options.cwd);
          const fileItem: ItemResult = {
            name: mapping.dest,
            path: fileResult.installed,
            unchanged: fileResult.unchanged ?? false,
          };
          result.files.push(fileItem);
          if (options.onProgress) {
            options.onProgress({ type: "file", name: fileItem.name, path: fileItem.path, action: fileItem.unchanged ? "unchanged" : "added", harness: adapter.displayName });
          }
        }
      }
    }

    results.push(result);
  }

  return { results, warnings };
}

/**
 * Execute the `rm` operation: remove manifest components from harnesses.
 */
export async function executeRm(
  manifest: NormalizedManifest,
  options: EngineOptions,
): Promise<EngineResult> {
  const { harnesses: targetHarnesses, warnings } = resolveTargetHarnesses(manifest, options.harnesses);
  const results: HarnessResult[] = [];
  const sourceDir = manifest.baseDir ?? options.cwd;

  for (const harnessName of targetHarnesses) {
    const adapter = getHarness(harnessName);
    const harnessConfig = manifest.harnesses.get(harnessName) ?? null;
    const result: HarnessResult = {
      harness: adapter.displayName,
      mcps: [],
      agents: [],
      skills: [],
      files: [],
      skipped: [],
    };

    // --- MCPs ---
    const mcpNames = Object.keys(manifest.mcps);
    if (mcpNames.length > 0) {
      const mcpResult = await removeMcps(adapter, mcpNames, options.scope, options.cwd);
      result.mcps = mcpResult.removed;
      if (options.onProgress) {
        for (const name of mcpResult.removed) {
          options.onProgress({ type: "mcp", name, path: mcpResult.configPath, action: "removed", harness: adapter.displayName });
        }
      }
    }

    // --- Skills ---
    for (const skillPath of manifest.skills) {
      const skillResult = await removeSkill(adapter, skillPath, options.scope, options.cwd, sourceDir);
      if ("removed" in skillResult) {
        result.skills.push({ name: basename(skillPath), path: skillResult.removed, unchanged: false });
        if (options.onProgress) {
          options.onProgress({ type: "skill", name: basename(skillPath), path: skillResult.removed, action: "removed", harness: adapter.displayName });
        }
      } else {
        result.skipped.push({ component: skillPath, reason: skillResult.reason });
        if (options.onProgress) {
          options.onProgress({ type: "skill", name: basename(skillPath), path: "", action: "skipped", harness: adapter.displayName });
        }
      }
    }

    // --- Universal Agents ---
    for (const agent of manifest.agents ?? []) {
      const agentName = basename(agent.source);
      const agentResult = await removeAgent(
        adapter,
        agentName,
        options.scope,
        options.cwd,
        undefined,
        agent.overrides.get(harnessName),
      );
      if ("removed" in agentResult) {
        result.agents.push({ name: agentName, path: agentResult.removed, unchanged: false });
        if (options.onProgress) {
          options.onProgress({ type: "agent", name: agentName, path: agentResult.removed, action: "removed", harness: adapter.displayName });
        }
      } else {
        result.skipped.push({ component: agent.source, reason: agentResult.reason });
        if (options.onProgress) {
          options.onProgress({ type: "agent", name: agentName, path: "", action: "skipped", harness: adapter.displayName });
        }
      }
    }

    // --- Harness-specific components ---
    if (harnessConfig) {
      // Harness-specific agents
      if (harnessConfig.agents) {
        for (const agentPath of harnessConfig.agents) {
          const agentName = basename(agentPath, ".md");
          const agentResult = await removeAgent(adapter, basename(agentPath), options.scope, options.cwd);
          if ("removed" in agentResult) {
            result.agents.push({ name: agentName, path: agentResult.removed, unchanged: false });
            if (options.onProgress) {
              options.onProgress({ type: "agent", name: agentName, path: agentResult.removed, action: "removed", harness: adapter.displayName });
            }
          } else {
            result.skipped.push({ component: agentPath, reason: agentResult.reason });
            if (options.onProgress) {
              options.onProgress({ type: "agent", name: agentName, path: "", action: "skipped", harness: adapter.displayName });
            }
          }
        }
      }

      if (harnessConfig.skills) {
        for (const skillPath of harnessConfig.skills) {
          const skillResult = await removeSkill(adapter, skillPath, options.scope, options.cwd, sourceDir);
          if ("removed" in skillResult) {
            result.skills.push({ name: basename(skillPath), path: skillResult.removed, unchanged: false });
            if (options.onProgress) {
              options.onProgress({ type: "skill", name: basename(skillPath), path: skillResult.removed, action: "removed", harness: adapter.displayName });
            }
          }
        }
      }
      if (harnessConfig.files) {
        for (const fileMapping of harnessConfig.files) {
          const fileResult = await removeFile(adapter, fileMapping, options.scope, options.cwd);
          if ("removed" in fileResult) {
            result.files.push({ name: fileMapping.dest, path: fileResult.removed, unchanged: false });
            if (options.onProgress) {
              options.onProgress({ type: "file", name: fileMapping.dest, path: fileResult.removed, action: "removed", harness: adapter.displayName });
            }
          }
        }
      }
      if (harnessConfig.rules) {
        for (const rulePath of harnessConfig.rules) {
          const mapping: FileMapping = { source: rulePath, dest: componentDestination(adapter, "rules", rulePath) };
          const fileResult = await removeFile(adapter, mapping, options.scope, options.cwd);
          if ("removed" in fileResult) {
            result.files.push({ name: mapping.dest, path: fileResult.removed, unchanged: false });
            if (options.onProgress) {
              options.onProgress({ type: "file", name: mapping.dest, path: fileResult.removed, action: "removed", harness: adapter.displayName });
            }
          }
        }
      }
      if (harnessConfig.commands) {
        for (const cmdPath of harnessConfig.commands) {
          const mapping: FileMapping = { source: cmdPath, dest: componentDestination(adapter, "commands", cmdPath) };
          const fileResult = await removeFile(adapter, mapping, options.scope, options.cwd);
          if ("removed" in fileResult) {
            result.files.push({ name: mapping.dest, path: fileResult.removed, unchanged: false });
            if (options.onProgress) {
              options.onProgress({ type: "file", name: mapping.dest, path: fileResult.removed, action: "removed", harness: adapter.displayName });
            }
          }
        }
      }
    }

    results.push(result);
  }

  return { results, warnings };
}

/**
 * Determine which harnesses to target.
 * If options.harnesses is specified, use them all but warn about undeclared ones.
 */
function resolveTargetHarnesses(
  manifest: NormalizedManifest,
  filterHarnesses?: HarnessName[],
): { harnesses: HarnessName[]; warnings: string[] } {
  const declaredHarnesses = Array.from(manifest.harnesses.keys());
  const warnings: string[] = [];

  if (!filterHarnesses || filterHarnesses.length === 0) {
    return { harnesses: declaredHarnesses, warnings };
  }

  return { harnesses: filterHarnesses, warnings };
}

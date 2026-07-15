import { resolve, basename, join } from "node:path";
import { stat, readFile, readdir } from "node:fs/promises";
import type { NormalizedManifest, HarnessName, FileMapping } from "./manifest/schema.ts";
import { getHarness, isHarnessDetected, type Scope } from "./harnesses/index.ts";
import { readJsonFile } from "./util/json.ts";
import { resolveSkillSource, toKebabCase, validateBobSkill } from "./components/skills.ts";
import { isUrl } from "./util/fetch.ts";
import { needsKeychainWrapper } from "./keychain/resolve.ts";
import { mergeAgentOverrides } from "./util/frontmatter.ts";
import { getWrapperPath } from "./keychain/wrappers.ts";
import { buildBobMode, deriveBobModeSlug, readBobModes } from "./components/bob-modes.ts";
import { resolveAgentContent } from "./components/agents.ts";
import { componentDestination, resolveSafeDestination } from "./components/files.ts";

export type PlanAction = "add" | "remove" | "update" | "noop";

export interface PlanItem {
  type: "mcp" | "skill" | "agent" | "file";
  name: string;
  destination: string;
  action: PlanAction;
  reason?: string; // for noop: "unchanged" or "not found"
  overrideKeys?: string[]; // for agents with frontmatter overrides: keys being merged
}

export interface HarnessPlan {
  harnessName: HarnessName;
  displayName: string;
  detected: boolean;
  items: PlanItem[];
}

/**
 * Build an execution plan by inspecting current state vs desired state.
 * Does NOT make any changes — read-only inspection.
 */
export async function buildPlan(
  manifest: NormalizedManifest,
  command: "add" | "rm",
  targetHarnesses: HarnessName[],
  scope: Scope,
  cwd: string,
): Promise<HarnessPlan[]> {
  const plans: HarnessPlan[] = [];
  const sourceDir = manifest.baseDir ?? cwd;

  for (const harnessName of targetHarnesses) {
    const adapter = getHarness(harnessName);
    const detected = isHarnessDetected(adapter);
    const items: PlanItem[] = [];

    // --- MCPs ---
    const mcpNames = Object.keys(manifest.mcps);
    if (mcpNames.length > 0) {
      const configPath = resolve(cwd, adapter.mcpConfigPath(scope));
      const existing = await readJsonFile(configPath);
      const existingServers = (existing[adapter.mcpJsonKey] as Record<string, unknown>) ?? {};

      for (const name of mcpNames) {
        const destination = adapter.mcpConfigPath(scope);
        const isPresent = name in existingServers;

        if (command === "rm") {
          items.push({
            type: "mcp",
            name,
            destination,
            action: isPresent ? "remove" : "noop",
            reason: isPresent ? undefined : "not found",
          });
        } else {
          // add — compare desired config with existing
          let action: PlanAction = "add";
          if (isPresent) {
            const def = manifest.mcps[name];
             const wrapperPath = needsKeychainWrapper(def) ? getWrapperPath(name, def) : undefined;
            const desired = adapter.translateMcp(name, def, wrapperPath);
            action = deepEqual(existingServers[name], desired) ? "noop" : "update";
          }
          items.push({
            type: "mcp",
            name,
            destination,
            action,
            reason: action === "noop" ? "unchanged" : undefined,
          });
        }
      }
    }

    // --- Skills (universal) ---
    for (const skillPath of manifest.skills) {
      const item = await planSkillItem(adapter, skillPath, command, scope, sourceDir, cwd);
      items.push(item);
    }

    // --- Universal Agents ---
    for (const agent of manifest.agents ?? []) {
      const agentDir = adapter.agentDir(scope);
      const agentPath = agent.source;
      if (adapter.name === "bob") {
        const { modes } = await readBobModes(adapter, scope, cwd);
        if (command === "rm") {
          const slug = deriveBobModeSlug(agentPath, agent.overrides.get(harnessName));
          const existing = modes.find((candidate) => candidate.slug === slug);
          items.push({
            type: "agent",
            name: slug,
            destination: `${adapter.agentConfigPath!(scope)}#${slug}`,
            action: existing ? "remove" : "noop",
            reason: existing ? undefined : "not found",
          });
          continue;
        }
        const content = await resolveAgentContent(agentPath, sourceDir);
        const mode = buildBobMode(content, agentPath, agent.overrides.get(harnessName));
        const existing = modes.find((candidate) => candidate.slug === mode.slug);
        const action = !existing ? "add" : deepEqual(existing, mode) ? "noop" : "update";
        items.push({
          type: "agent",
          name: mode.slug,
          destination: `${adapter.agentConfigPath!(scope)}#${mode.slug}`,
          action,
          reason: action === "noop" ? "unchanged" : undefined,
          overrideKeys: Object.keys(agent.overrides.get(harnessName) ?? {}).filter((key) => agent.overrides.get(harnessName)?.[key] !== null),
        });
        continue;
      }
      if (!agentDir) {
        items.push({
          type: "agent",
          name: basename(agentPath, ".md"),
          destination: "",
          action: "noop",
          reason: "not supported",
        });
        continue;
      }

      const filename = basename(agentPath).endsWith(".md")
        ? basename(agentPath)
        : `${basename(agentPath)}.md`;
      const destPath = resolve(cwd, agentDir, filename);
      const destination = join(agentDir, filename);
      const isPresent = await fileExists(destPath);

      if (command === "rm") {
        items.push({
          type: "agent",
          name: basename(agentPath, ".md"),
          destination,
          action: isPresent ? "remove" : "noop",
          reason: isPresent ? undefined : "not found",
        });
      } else {
        let action: PlanAction = "add";
        if (isPresent && !isUrl(agentPath) && !isUrl(sourceDir)) {
          const srcPath = resolve(sourceDir, agentPath);
          const overrides = agent.overrides.get(harnessName);
          if (overrides && Object.keys(overrides).length > 0) {
            // Compare merged content to installed file
            try {
              const srcContent = await readFile(srcPath, "utf-8");
              const mergedContent = mergeAgentOverrides(srcContent, overrides);
              const destContent = await readFile(destPath, "utf-8");
              action = mergedContent === destContent ? "noop" : "update";
            } catch {
              action = "update";
            }
          } else {
            const unchanged = await fileContentsMatch(srcPath, destPath);
            action = unchanged ? "noop" : "update";
          }
        } else if (isPresent) {
          action = "update";
        }
        // Include override keys hint if overrides exist for this harness
        const overrides = agent.overrides.get(harnessName);
        const overrideKeys = overrides ? Object.keys(overrides).filter(k => overrides[k] !== null) : undefined;
        items.push({
          type: "agent",
          name: basename(agentPath, ".md"),
          destination,
          action,
          reason: action === "noop" ? "unchanged" : undefined,
          overrideKeys: overrideKeys && overrideKeys.length > 0 ? overrideKeys : undefined,
        });
      }
    }

    // --- Harness-specific components ---
    const harnessConfig = manifest.harnesses.get(harnessName);
    if (harnessConfig) {
      // Harness-specific agents
      if (harnessConfig.agents) {
        const agentDir = adapter.agentDir(scope);
        for (const agentPath of harnessConfig.agents) {
          if (adapter.name === "bob") {
            const { modes } = await readBobModes(adapter, scope, cwd);
            if (command === "rm") {
              const slug = deriveBobModeSlug(agentPath);
              const existing = modes.find((candidate) => candidate.slug === slug);
              items.push({
                type: "agent",
                name: slug,
                destination: `${adapter.agentConfigPath!(scope)}#${slug}`,
                action: existing ? "remove" : "noop",
                reason: existing ? undefined : "not found",
              });
              continue;
            }
            const content = await resolveAgentContent(agentPath, sourceDir);
            const mode = buildBobMode(content, agentPath);
            const existing = modes.find((candidate) => candidate.slug === mode.slug);
            const action = !existing ? "add" : deepEqual(existing, mode) ? "noop" : "update";
            items.push({
              type: "agent",
              name: mode.slug,
              destination: `${adapter.agentConfigPath!(scope)}#${mode.slug}`,
              action,
              reason: action === "noop" ? "unchanged" : undefined,
            });
            continue;
          }
          if (!agentDir) {
            items.push({
              type: "agent",
              name: basename(agentPath, ".md"),
              destination: "",
              action: "noop",
              reason: "not supported",
            });
            continue;
          }

          const filename = basename(agentPath).endsWith(".md")
            ? basename(agentPath)
            : `${basename(agentPath)}.md`;
          const destPath = resolve(cwd, agentDir, filename);
          const destination = join(agentDir, filename);
          const isPresent = await fileExists(destPath);

          if (command === "rm") {
            items.push({
              type: "agent",
              name: basename(agentPath, ".md"),
              destination,
              action: isPresent ? "remove" : "noop",
              reason: isPresent ? undefined : "not found",
            });
          } else {
            let action: PlanAction = "add";
            if (isPresent && !isUrl(agentPath) && !isUrl(sourceDir)) {
              const srcPath = resolve(sourceDir, agentPath);
              const unchanged = await fileContentsMatch(srcPath, destPath);
              action = unchanged ? "noop" : "update";
            } else if (isPresent) {
              action = "update";
            }
            items.push({
              type: "agent",
              name: basename(agentPath, ".md"),
              destination,
              action,
              reason: action === "noop" ? "unchanged" : undefined,
            });
          }
        }
      }

      // Harness-specific skills
      if (harnessConfig.skills) {
        for (const skillPath of harnessConfig.skills) {
          const item = await planSkillItem(adapter, skillPath, command, scope, sourceDir, cwd);
          items.push(item);
        }
      }

      // Files
      if (harnessConfig.files) {
        for (const fileMapping of harnessConfig.files) {
          const root = fileMapping.root === "workspace"
            ? resolve(cwd)
            : resolve(cwd, adapter.configRoot(scope));
          const destPath = resolveSafeDestination(root, fileMapping.dest);
          const destination = fileMapping.root === "workspace"
            ? fileMapping.dest
            : join(adapter.configRoot(scope), fileMapping.dest);
          const isPresent = await fileExists(destPath);

          if (command === "rm") {
            items.push({
              type: "file",
              name: fileMapping.dest,
              destination,
              action: isPresent ? "remove" : "noop",
              reason: isPresent ? undefined : "not found",
            });
          } else {
            let action: PlanAction = "add";
            if (isPresent && !isUrl(fileMapping.source) && !isUrl(sourceDir)) {
              const srcPath = resolve(sourceDir, fileMapping.source);
              const unchanged = await fileContentsMatch(srcPath, destPath);
              action = unchanged ? "noop" : "update";
            } else if (isPresent) {
              action = "update";
            }
            items.push({
              type: "file",
              name: fileMapping.dest,
              destination,
              action,
              reason: action === "noop" ? "unchanged" : undefined,
            });
          }
        }
      }

      // Rules
      if (harnessConfig.rules) {
        for (const rulePath of harnessConfig.rules) {
          const dest = componentDestination(adapter, "rules", rulePath);
          const destPath = resolve(cwd, adapter.configRoot(scope), dest);
          const destination = join(adapter.configRoot(scope), dest);
          const isPresent = await fileExists(destPath);

          if (command === "rm") {
            items.push({
              type: "file",
              name: dest,
              destination,
              action: isPresent ? "remove" : "noop",
              reason: isPresent ? undefined : "not found",
            });
          } else {
            let action: PlanAction = "add";
            if (isPresent && !isUrl(rulePath) && !isUrl(sourceDir)) {
              const srcPath = resolve(sourceDir, rulePath);
              const unchanged = await fileContentsMatch(srcPath, destPath);
              action = unchanged ? "noop" : "update";
            } else if (isPresent) {
              action = "update";
            }
            items.push({
              type: "file",
              name: dest,
              destination,
              action,
              reason: action === "noop" ? "unchanged" : undefined,
            });
          }
        }
      }

      // Commands
      if (harnessConfig.commands) {
        for (const cmdPath of harnessConfig.commands) {
          const dest = componentDestination(adapter, "commands", cmdPath);
          const destPath = resolve(cwd, adapter.configRoot(scope), dest);
          const destination = join(adapter.configRoot(scope), dest);
          const isPresent = await fileExists(destPath);

          if (command === "rm") {
            items.push({
              type: "file",
              name: dest,
              destination,
              action: isPresent ? "remove" : "noop",
              reason: isPresent ? undefined : "not found",
            });
          } else {
            let action: PlanAction = "add";
            if (isPresent && !isUrl(cmdPath) && !isUrl(sourceDir)) {
              const srcPath = resolve(sourceDir, cmdPath);
              const unchanged = await fileContentsMatch(srcPath, destPath);
              action = unchanged ? "noop" : "update";
            } else if (isPresent) {
              action = "update";
            }
            items.push({
              type: "file",
              name: dest,
              destination,
              action,
              reason: action === "noop" ? "unchanged" : undefined,
            });
          }
        }
      }
    }

    plans.push({
      harnessName,
      displayName: adapter.displayName,
      detected,
      items,
    });
  }

  return plans;
}

/**
 * Plan a single skill item.
 */
async function planSkillItem(
  adapter: ReturnType<typeof getHarness>,
  skillPath: string,
  command: "add" | "rm",
  scope: Scope,
  sourceDir: string,
  cwd: string,
): Promise<PlanItem> {
  if (command === "rm" && adapter.name === "bob") {
    const skillName = toKebabCase(basename(skillPath));
    if (!skillName) throw new Error(`Skill "${skillPath}" does not produce a valid directory name`);
    const destination = join(adapter.skillDir(scope), skillName);
    const isPresent = await fileExists(resolve(cwd, destination));
    return {
      type: "skill",
      name: skillName,
      destination,
      action: isPresent ? "remove" : "noop",
      reason: isPresent ? undefined : "not found",
    };
  }
  const { absoluteSkillPath, skillName } = await resolveSkillSource(skillPath, sourceDir);
  if (adapter.name === "bob") await validateBobSkill(absoluteSkillPath, skillPath);

  const destDir = resolve(cwd, adapter.skillDir(scope));
  const destPath = join(destDir, skillName);
  const destination = join(adapter.skillDir(scope), skillName);
  const isPresent = await fileExists(destPath);

  if (command === "rm") {
    return {
      type: "skill",
      name: skillName,
      destination,
      action: isPresent ? "remove" : "noop",
      reason: isPresent ? undefined : "not found",
    };
  } else {
    let action: PlanAction = "add";
    if (isPresent && !isUrl(skillPath) && !isUrl(sourceDir)) {
      const unchanged = await dirContentsMatch(absoluteSkillPath, destPath);
      action = unchanged ? "noop" : "update";
    } else if (isPresent) {
      action = "update";
    }
    return {
      type: "skill",
      name: skillName,
      destination,
      action,
      reason: action === "noop" ? "unchanged" : undefined,
    };
  }
}

/**
 * Check if a path exists (file or directory).
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Summarize plan counts for display.
 */
export function summarizePlan(items: PlanItem[]): { toAdd: number; toRemove: number; toUpdate: number; noops: number; notFound: number } {
  let toAdd = 0, toRemove = 0, toUpdate = 0, noops = 0, notFound = 0;
  for (const item of items) {
    switch (item.action) {
      case "add": toAdd++; break;
      case "remove": toRemove++; break;
      case "update": toUpdate++; break;
      case "noop":
        noops++;
        if (item.reason === "not found") notFound++;
        break;
    }
  }
  return { toAdd, toRemove, toUpdate, noops, notFound };
}

/**
 * Deep equality check for JSON-serializable values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, i) => key === bKeys[i] && deepEqual(aObj[key], bObj[key]));
}

/**
 * Compare two files' contents. Returns true if they match.
 */
async function fileContentsMatch(srcPath: string, destPath: string): Promise<boolean> {
  try {
    const [src, dest] = await Promise.all([
      readFile(srcPath, "utf-8"),
      readFile(destPath, "utf-8"),
    ]);
    return src === dest;
  } catch {
    return false;
  }
}

/**
 * Compare two directories' file contents recursively. Returns true if all files match.
 */
async function dirContentsMatch(srcDir: string, destDir: string): Promise<boolean> {
  try {
    const srcFiles = await listFilesRecursive(srcDir);
    const destFiles = await listFilesRecursive(destDir);

    // Same set of relative paths
    const srcSet = new Set(srcFiles);
    const destSet = new Set(destFiles);
    if (srcSet.size !== destSet.size) return false;
    for (const f of srcSet) {
      if (!destSet.has(f)) return false;
    }

    // Compare each file's content
    for (const relPath of srcFiles) {
      const match = await fileContentsMatch(
        join(srcDir, relPath),
        join(destDir, relPath),
      );
      if (!match) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * List all files in a directory recursively, returning relative paths.
 */
async function listFilesRecursive(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(join(dir, entry.name), relPath));
    } else {
      files.push(relPath);
    }
  }
  return files;
}

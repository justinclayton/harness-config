import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import yaml from "js-yaml";
import type { HarnessAdapter, Scope } from "../harnesses/types.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";
import { toKebabCase } from "./skills.ts";

export interface BobMode extends Record<string, unknown> {
  slug: string;
  name: string;
  roleDefinition: string;
  groups: unknown[];
}

const BOB_GROUPS = new Set([
  "read", "edit", "execute", "mcp", "skill", "workflow", "todo",
  "subtask", "subagent", "mode",
]);

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function defaultGroups(frontmatter: Record<string, unknown>): unknown[] {
  if (Array.isArray(frontmatter.groups)) {
    for (const group of frontmatter.groups) {
      const name = Array.isArray(group) ? group[0] : group;
      if (typeof name !== "string" || !BOB_GROUPS.has(name)) {
        throw new Error(`Unsupported IBM Bob mode group: ${String(name)}`);
      }
    }
    return frontmatter.groups;
  }
  const toolValues = Array.isArray(frontmatter.tools)
    ? frontmatter.tools
    : typeof frontmatter.tools === "string"
      ? frontmatter.tools.split(",").map((tool) => tool.trim())
      : null;
  if (!toolValues) return ["read"];

  const groups = new Set<string>();
  for (const tool of toolValues) {
    if (typeof tool !== "string") continue;
    switch (tool.toLowerCase()) {
      case "read":
      case "grep":
      case "glob":
        groups.add("read");
        break;
      case "write":
      case "edit":
        groups.add("edit");
        break;
      case "bash":
      case "execute":
        groups.add("execute");
        break;
      case "mcp":
      case "skill":
      case "todo":
      case "subtask":
      case "subagent":
      case "mode":
      case "workflow":
        groups.add(tool.toLowerCase());
        break;
    }
  }
  return groups.size > 0 ? [...groups] : ["read"];
}

export function buildBobMode(
  content: string,
  sourcePath: string,
  overrides?: Record<string, unknown>,
): BobMode {
  const parsed = parseFrontmatter(content);
  const frontmatter = { ...parsed.frontmatter, ...overrides };
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null) delete frontmatter[key];
  }

  const fallbackSlug = toKebabCase(basename(sourcePath, ".md"));
  const slug = toKebabCase(stringValue(frontmatter.slug) ?? fallbackSlug);
  if (!slug) throw new Error(`IBM Bob mode from "${sourcePath}" requires a valid slug or name`);

  const roleDefinition = stringValue(frontmatter.roleDefinition) ?? parsed.body.trim();
  if (!roleDefinition) throw new Error(`IBM Bob mode "${slug}" requires a role definition`);

  const mode: BobMode = {
    slug,
    name: stringValue(frontmatter.name) ?? slug,
    roleDefinition,
    groups: defaultGroups(frontmatter),
  };
  for (const key of ["description", "whenToUse", "customInstructions", "allowedSubagents"] as const) {
    if (frontmatter[key] !== undefined) mode[key] = frontmatter[key];
  }
  if (mode.allowedSubagents !== undefined &&
      (!Array.isArray(mode.allowedSubagents) || mode.allowedSubagents.some((value) => typeof value !== "string"))) {
    throw new Error(`IBM Bob mode "${slug}" allowedSubagents must be an array of strings`);
  }
  return mode;
}

export function deriveBobModeSlug(sourcePath: string, overrides?: Record<string, unknown>): string {
  const overrideSlug = stringValue(overrides?.slug);
  const slug = toKebabCase(overrideSlug ?? basename(sourcePath, ".md"));
  if (!slug) throw new Error(`IBM Bob mode from "${sourcePath}" requires a valid slug`);
  return slug;
}

function configPath(adapter: HarnessAdapter, scope: Scope, cwd: string): string {
  if (!adapter.agentConfigPath) throw new Error(`${adapter.displayName} does not use an agent collection`);
  return resolve(cwd, adapter.agentConfigPath(scope));
}

export async function readBobModes(
  adapter: HarnessAdapter,
  scope: Scope,
  cwd: string,
): Promise<{ path: string; document: Record<string, unknown>; modes: BobMode[] }> {
  const path = configPath(adapter, scope, cwd);
  let document: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(await readFile(path, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      document = parsed as Record<string, unknown>;
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw new Error(`Invalid YAML in ${path}: ${err.message}`);
  }
  if (document.customModes !== undefined && !Array.isArray(document.customModes)) {
    throw new Error(`Invalid YAML in ${path}: customModes must be an array`);
  }
  const modes = (document.customModes ?? []) as unknown[];
  for (const mode of modes) {
    if (!mode || typeof mode !== "object" || typeof (mode as Record<string, unknown>).slug !== "string") {
      throw new Error(`Invalid YAML in ${path}: every custom mode requires a string slug`);
    }
  }
  return { path, document, modes: modes as BobMode[] };
}

async function writeBobModes(
  path: string,
  document: Record<string, unknown>,
  modes: BobMode[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, yaml.dump({ ...document, customModes: modes }, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  }), "utf-8");
}

export async function upsertBobMode(
  adapter: HarnessAdapter,
  mode: BobMode,
  scope: Scope,
  cwd: string,
): Promise<{ installed: string; unchanged?: boolean }> {
  const { path, document, modes } = await readBobModes(adapter, scope, cwd);
  const index = modes.findIndex((existing) => existing.slug === mode.slug);
  if (index >= 0 && JSON.stringify(modes[index]) === JSON.stringify(mode)) {
    return { installed: `${path}#${mode.slug}`, unchanged: true };
  }
  if (index >= 0) modes[index] = mode;
  else modes.push(mode);
  await writeBobModes(path, document, modes);
  return { installed: `${path}#${mode.slug}` };
}

export async function removeBobMode(
  adapter: HarnessAdapter,
  slug: string,
  scope: Scope,
  cwd: string,
): Promise<{ removed: string } | { skipped: string; reason: string }> {
  const { path, document, modes } = await readBobModes(adapter, scope, cwd);
  const remaining = modes.filter((mode) => mode.slug !== slug);
  if (remaining.length === modes.length) return { skipped: slug, reason: "Mode not found" };
  await writeBobModes(path, document, remaining);
  return { removed: `${path}#${slug}` };
}

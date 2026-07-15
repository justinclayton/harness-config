import { cp, rm, mkdir, readFile, readdir } from "node:fs/promises";
import { resolve, basename, join } from "node:path";
import type { HarnessAdapter, Scope } from "../harnesses/types.ts";
import { isUrl, fetchDirectoryToTemp } from "../util/fetch.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";

/**
 * Sanitize a name to kebab-case for use as directory name.
 */
export function toKebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Derive the installed skill directory name.
 * 1. Check SKILL.md frontmatter for `name` field
 * 2. Fall back to directory basename
 * Sanitized to kebab-case.
 */
export async function deriveSkillName(absoluteSkillPath: string, originalPath: string): Promise<string> {
  // Try to read SKILL.md frontmatter for name
  try {
    const skillMdPath = join(absoluteSkillPath, "SKILL.md");
    const content = await readFile(skillMdPath, "utf-8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match) {
      const nameMatch = match[1].match(/^name:\s*(.+)$/m);
      if (nameMatch) {
        const name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
        if (name) return requireSkillName(toKebabCase(name), originalPath);
      }
    }
  } catch {
    // SKILL.md doesn't exist or can't be read — fall back
  }

  // Fall back to directory basename
  return requireSkillName(toKebabCase(basename(originalPath)), originalPath);
}

function requireSkillName(name: string, source: string): string {
  if (!name) throw new Error(`Skill "${source}" does not produce a valid directory name`);
  return name;
}

export async function resolveSkillSource(
  skillPath: string,
  sourceDir: string,
): Promise<{ absoluteSkillPath: string; skillName: string }> {
  let absoluteSkillPath: string;
  if (isUrl(skillPath)) {
    absoluteSkillPath = await fetchDirectoryToTemp(skillPath);
  } else if (isUrl(sourceDir)) {
    const normalizedPath = skillPath.replace(/^\.\//, "");
    const fullUrl = sourceDir.includes("/tree/")
      ? `${sourceDir}/${normalizedPath}`
      : `${sourceDir}/tree/main/${normalizedPath}`;
    absoluteSkillPath = await fetchDirectoryToTemp(fullUrl);
  } else {
    absoluteSkillPath = resolve(sourceDir, skillPath);
  }
  return {
    absoluteSkillPath,
    skillName: await deriveSkillName(absoluteSkillPath, skillPath),
  };
}

export async function validateBobSkill(absoluteSkillPath: string, skillPath = absoluteSkillPath): Promise<void> {
  const skillFile = join(absoluteSkillPath, "SKILL.md");
  let content: string;
  try {
    content = await readFile(skillFile, "utf-8");
  } catch {
    throw new Error(`IBM Bob skill requires ${skillFile}`);
  }
  const { frontmatter } = parseFrontmatter(content);
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!name || !description) {
    throw new Error("IBM Bob skills require non-empty name and description frontmatter fields");
  }
  const folderName = toKebabCase(basename(skillPath));
  const declaredName = toKebabCase(name);
  if (!folderName || declaredName !== folderName) {
    throw new Error(`IBM Bob skill name "${name}" must match its folder "${basename(skillPath)}"`);
  }
}

export async function preflightBobSkill(skillPath: string, sourceDir: string): Promise<void> {
  const { absoluteSkillPath } = await resolveSkillSource(skillPath, sourceDir);
  await validateBobSkill(absoluteSkillPath, skillPath);
}

async function directoriesMatch(source: string, destination: string): Promise<boolean> {
  try {
    const [sourceEntries, destinationEntries] = await Promise.all([
      readdir(source, { withFileTypes: true }),
      readdir(destination, { withFileTypes: true }),
    ]);
    if (sourceEntries.length !== destinationEntries.length) return false;
    for (const entry of sourceEntries) {
      const other = destinationEntries.find((candidate) => candidate.name === entry.name);
      if (!other || other.isDirectory() !== entry.isDirectory()) return false;
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      if (entry.isDirectory()) {
        if (!await directoriesMatch(sourcePath, destinationPath)) return false;
      } else if (!(await readFile(sourcePath)).equals(await readFile(destinationPath))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Install a skill directory to a harness.
 * sourceDir: where to find the skill (manifest location, may be a URL base)
 * destCwd: where to write output (working directory)
 */
export async function addSkill(
  adapter: HarnessAdapter,
  skillPath: string,
  scope: Scope,
  sourceDir: string,
  destCwd: string,
): Promise<{ installed: string; unchanged?: boolean }> {
  const { absoluteSkillPath, skillName } = await resolveSkillSource(skillPath, sourceDir);
  if (adapter.name === "bob") await validateBobSkill(absoluteSkillPath, skillPath);
  const destDir = resolve(destCwd, adapter.skillDir(scope));
  const destPath = join(destDir, skillName);

  if (await directoriesMatch(absoluteSkillPath, destPath)) {
    return { installed: destPath, unchanged: true };
  }

  await mkdir(destDir, { recursive: true });
  await rm(destPath, { recursive: true, force: true });
  await cp(absoluteSkillPath, destPath, { recursive: true, force: true });

  return { installed: destPath };
}

/**
 * Remove a skill directory from a harness.
 */
export async function removeSkill(
  adapter: HarnessAdapter,
  skillPath: string,
  scope: Scope,
  cwd: string,
  sourceDir = cwd,
): Promise<{ removed: string } | { skipped: string; reason: string }> {
  let skillName: string;
  if (adapter.name === "bob") {
    const fallback = toKebabCase(basename(skillPath));
    if (!fallback) throw new Error(`Skill "${skillPath}" does not produce a valid directory name`);
    skillName = fallback;
  } else {
    try {
      ({ skillName } = await resolveSkillSource(skillPath, sourceDir));
    } catch (err) {
      const fallback = toKebabCase(basename(skillPath));
      if (!fallback || isUrl(skillPath) || isUrl(sourceDir)) throw err;
      skillName = fallback;
    }
  }
  const destPath = resolve(cwd, adapter.skillDir(scope), skillName);

  try {
    await rm(destPath, { recursive: true });
    return { removed: destPath };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { skipped: skillPath, reason: "Directory not found" };
    }
    throw err;
  }
}

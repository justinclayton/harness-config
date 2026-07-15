import { rm, mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename, sep } from "node:path";
import type { HarnessAdapter, Scope } from "../harnesses/types.ts";
import type { FileMapping } from "../manifest/schema.ts";
import { isUrl, fetchFileContent } from "../util/fetch.ts";
import { isContentUnchanged } from "../util/json.ts";

/**
 * Install a file mapping (escape hatch) to a harness.
 * sourceDir: where to find source files (manifest location, may be a URL base)
 * destCwd: where to write output (working directory)
 */
export async function addFile(
  adapter: HarnessAdapter,
  mapping: FileMapping,
  scope: Scope,
  sourceDir: string,
  destCwd: string,
): Promise<{ installed: string; unchanged?: boolean }> {
  const destinationRoot = mapping.root === "workspace"
    ? resolve(destCwd)
    : resolve(destCwd, adapter.configRoot(scope));
  const destPath = resolveSafeDestination(destinationRoot, mapping.dest);
  await assertNoSymlinkParents(destinationRoot, destPath);
  await mkdir(dirname(destPath), { recursive: true });

  let content: string;

  if (isUrl(mapping.source)) {
    // Fetch from URL directly
    content = await fetchFileContent(mapping.source);
  } else if (isUrl(sourceDir)) {
    // Relative path against a URL base
    const fullUrl = `${sourceDir}/${mapping.source.replace(/^\.\//,  "")}`.replace(/\/tree\//, "/blob/");
    content = await fetchFileContent(fullUrl);
  } else {
    // Local path
    const sourcePath = resolve(sourceDir, mapping.source);
    content = await readFile(sourcePath, "utf-8");
  }

  // Skip write if content is identical (idempotent)
  if (await isContentUnchanged(destPath, content)) {
    return { installed: destPath, unchanged: true };
  }

  await writeFile(destPath, content, "utf-8");
  return { installed: destPath };
}

/**
 * Remove a file mapping from a harness.
 */
export async function removeFile(
  adapter: HarnessAdapter,
  mapping: FileMapping,
  scope: Scope,
  cwd: string,
): Promise<{ removed: string } | { skipped: string; reason: string }> {
  const destinationRoot = mapping.root === "workspace"
    ? resolve(cwd)
    : resolve(cwd, adapter.configRoot(scope));
  const destPath = resolveSafeDestination(destinationRoot, mapping.dest);
  await assertNoSymlinkParents(destinationRoot, destPath);

  try {
    await rm(destPath, { recursive: true });
    return { removed: destPath };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { skipped: mapping.dest, reason: "File not found" };
    }
    throw err;
  }
}

export function resolveSafeDestination(root: string, destination: string): string {
  if (isAbsolute(destination)) throw new Error(`Destination must be relative: ${destination}`);
  const resolved = resolve(root, destination);
  const relativePath = relative(root, resolved);
  if (!relativePath) throw new Error(`Destination cannot be the configured root: ${destination}`);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Destination escapes its configured root: ${destination}`);
  }
  return resolved;
}

async function assertNoSymlinkParents(root: string, destination: string): Promise<void> {
  const parts = relative(root, destination).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Destination traverses a symbolic link: ${current}`);
      }
    } catch (err: any) {
      if (err.code === "ENOENT") return;
      throw err;
    }
  }
}

export function componentDestination(
  adapter: HarnessAdapter,
  kind: "rules" | "commands",
  sourcePath: string,
): string {
  if (adapter.name !== "bob") return `${kind}/${basename(sourcePath)}`;
  const normalized = sourcePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const marker = `${kind}/`;
  const markerIndex = normalized.indexOf(marker);
  const relativeSource = markerIndex >= 0
    ? normalized.slice(markerIndex + marker.length)
    : basename(normalized);
  return `${kind}/${relativeSource}`;
}

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";

/**
 * Safely read a TOML file. Returns empty object if the file doesn't exist.
 */
export async function readTomlFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(filePath, "utf-8");
    return parse(content) as Record<string, unknown>;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return {};
    }
    if (err.name === "TomlError") {
      throw new Error(`Invalid TOML in ${filePath}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Write a TOML file, creating parent directories as needed.
 *
 * This round-trips the whole file through parse + stringify, so unrelated
 * top-level settings are preserved but comments and key ordering are not.
 * Codex CLI's config.toml has no documented comment convention for
 * mcp_servers entries, so this is an accepted tradeoff rather than an
 * oversight.
 */
export async function writeTomlFile(
  filePath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, stringify(data) + "\n", "utf-8");
}

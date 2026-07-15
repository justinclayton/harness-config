import { z } from "zod";

// --- MCP Definition ---

const envItemSchema = z.union([
  z.string(), // bare passthrough: "VAR_NAME"
  z.record(z.string(), z.string()).refine(
    (obj) => Object.values(obj).every((v) => v.startsWith("keychain:")),
    {
      message: "Env key-value pairs must use 'keychain:' prefix (e.g., SECRET: keychain:my-service). Bare strings are used for passthrough env vars.",
    },
  ), // key-value: { VAR_NAME: "keychain:service" }
]);

const mcpBaseSchema = z.object({
  env: z.array(envItemSchema).optional(),
  alwaysAllow: z.array(z.string()).optional(),
  disabled: z.boolean().optional(),
});

const mcpStdioSchema = mcpBaseSchema.extend({
  stdio: z.union([z.string(), z.array(z.string())]),
  cwd: z.string().optional(),
  url: z.undefined().optional(),
  auth: z.undefined().optional(),
  headers: z.undefined().optional(),
  transport: z.undefined().optional(),
});

const mcpHttpSchema = mcpBaseSchema.extend({
  url: z.string().url(),
  auth: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  transport: z.enum(["streamable-http", "sse"]).default("streamable-http"),
  stdio: z.undefined().optional(),
  cwd: z.undefined().optional(),
});

export const mcpDefSchema = z.union([mcpStdioSchema, mcpHttpSchema]);

// --- Harness names ---

export const harnessNames = [
  "claude",
  "opencode",
  "copilot",
  "pi",
  "bob",
] as const;

export type HarnessName = (typeof harnessNames)[number];

export const harnessNameSchema = z.enum(harnessNames);

// --- File mapping (escape hatch) ---

const fileMappingSchema = z.object({
  source: z.string(),
  dest: z.string(),
  root: z.enum(["config", "workspace"]).optional(),
});

// --- Harness-specific config ---

const harnessConfigSchema = z
  .object({
    agents: z.array(z.string()).optional(),
    rules: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
    files: z.array(fileMappingSchema).optional(),
  })
  .nullable();

// --- Harnesses field (union type) ---

// Simple form: array of harness names
const harnessesArraySchema = z.array(harnessNameSchema);

// Rich form: map of harness name → config | null
const harnessesMapSchema = z.record(harnessNameSchema, harnessConfigSchema);

export const harnessesSchema = z.union([harnessesArraySchema, harnessesMapSchema]);

// --- Universal agent entry ---

// Simple form: bare string path
// Rich form: object with `source` + per-harness override keys
const universalAgentEntrySchema = z.union([
  z.string(),
  z.object({ source: z.string() }).passthrough(),
]);

// --- Top-level manifest ---

export const manifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  harnesses: harnessesSchema,
  mcps: z.record(z.string(), mcpDefSchema).optional(),
  skills: z.array(z.string()).optional(),
  agents: z.array(universalAgentEntrySchema).optional(),
});

// --- Inferred types ---

export type ManifestConfig = z.infer<typeof manifestSchema>;
export type McpDef = z.infer<typeof mcpDefSchema>;
export type HarnessesField = z.infer<typeof harnessesSchema>;
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;
export type FileMapping = z.infer<typeof fileMappingSchema>;
export type EnvItem = z.infer<typeof envItemSchema>;

// --- Universal agent (normalized) ---

export interface UniversalAgent {
  /** Source file path (relative to manifest baseDir) */
  source: string;
  /** Per-harness frontmatter overrides */
  overrides: Map<HarnessName, Record<string, unknown>>;
}

// --- Normalized types (post-parsing) ---

export interface NormalizedManifest {
  name: string;
  description?: string;
  harnesses: Map<HarnessName, HarnessConfig | null>;
  mcps: Record<string, McpDef>;
  skills: string[];
  /** Universal agents (top-level agents field) */
  agents: UniversalAgent[];
  /** Base directory for resolving relative paths in the manifest */
  baseDir?: string;
}

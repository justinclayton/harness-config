import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan } from "../src/plan.ts";
import type { NormalizedManifest } from "../src/manifest/schema.ts";

describe("plan override hints", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-config-plan-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeManifest(overrides: Partial<NormalizedManifest> = {}): NormalizedManifest {
    return {
      name: "test",
      harnesses: new Map([["claude", null]]),
      mcps: {},
      skills: [],
      agents: [],
      baseDir: tmpDir,
      ...overrides,
    };
  }

  it("includes overrideKeys for universal agents with overrides", async () => {
    await mkdir(join(tmpDir, "agents"), { recursive: true });
    await writeFile(join(tmpDir, "agents", "architect.md"), "---\nname: Architect\n---\nBody.");

    const manifest = makeManifest({
      agents: [
        {
          source: "./agents/architect.md",
          overrides: new Map([
            ["claude", { model: "sonnet", tools: ["Read", "Grep"] }],
          ]),
        },
      ],
    });

    const plans = await buildPlan(manifest, "add", ["claude"], "project", tmpDir);

    expect(plans).toHaveLength(1);
    const agentItem = plans[0].items.find(i => i.type === "agent");
    expect(agentItem).toBeDefined();
    expect(agentItem!.overrideKeys).toEqual(["model", "tools"]);
  });

  it("does not include overrideKeys when no overrides for target harness", async () => {
    await mkdir(join(tmpDir, "agents"), { recursive: true });
    await writeFile(join(tmpDir, "agents", "architect.md"), "---\nname: Architect\n---\nBody.");

    const manifest = makeManifest({
      harnesses: new Map([["claude", null], ["opencode", null]]),
      agents: [
        {
          source: "./agents/architect.md",
          overrides: new Map([
            ["claude", { model: "sonnet" }],
            // No overrides for opencode
          ]),
        },
      ],
    });

    const plans = await buildPlan(manifest, "add", ["opencode"], "project", tmpDir);

    expect(plans).toHaveLength(1);
    const agentItem = plans[0].items.find(i => i.type === "agent");
    expect(agentItem).toBeDefined();
    expect(agentItem!.overrideKeys).toBeUndefined();
  });

  it("excludes null-value keys from overrideKeys hint", async () => {
    await mkdir(join(tmpDir, "agents"), { recursive: true });
    await writeFile(join(tmpDir, "agents", "architect.md"), "---\nname: Architect\ntools:\n  - Read\n---\nBody.");

    const manifest = makeManifest({
      agents: [
        {
          source: "./agents/architect.md",
          overrides: new Map([
            ["claude", { model: "sonnet", tools: null }],
          ]),
        },
      ],
    });

    const plans = await buildPlan(manifest, "add", ["claude"], "project", tmpDir);

    expect(plans).toHaveLength(1);
    const agentItem = plans[0].items.find(i => i.type === "agent");
    expect(agentItem).toBeDefined();
    // Only "model" should appear since tools is null (deletion)
    expect(agentItem!.overrideKeys).toEqual(["model"]);
  });

  it("reads an existing TOML-format MCP config (Codex) instead of mis-parsing it as JSON", async () => {
    await mkdir(join(tmpDir, ".codex"), { recursive: true });
    await writeFile(
      join(tmpDir, ".codex", "config.toml"),
      '[mcp_servers.fetch]\ncommand = "npx"\nargs = [ "-y", "@anthropic/mcp-fetch" ]\n',
    );

    const manifest = makeManifest({
      harnesses: new Map([["codex", null]]),
      mcps: { fetch: { stdio: "npx -y @anthropic/mcp-fetch" } },
    });

    const plans = await buildPlan(manifest, "add", ["codex"], "project", tmpDir);

    expect(plans).toHaveLength(1);
    const mcpItem = plans[0].items.find(i => i.type === "mcp" && i.name === "fetch");
    expect(mcpItem).toBeDefined();
    expect(mcpItem!.action).toBe("noop");
    expect(mcpItem!.reason).toBe("unchanged");
  });

  it("does not include overrideKeys on rm command", async () => {
    await mkdir(join(tmpDir, ".claude", "agents"), { recursive: true });
    await writeFile(join(tmpDir, ".claude", "agents", "architect.md"), "---\nname: Architect\n---\nBody.");
    await mkdir(join(tmpDir, "agents"), { recursive: true });
    await writeFile(join(tmpDir, "agents", "architect.md"), "---\nname: Architect\n---\nBody.");

    const manifest = makeManifest({
      agents: [
        {
          source: "./agents/architect.md",
          overrides: new Map([
            ["claude", { model: "sonnet" }],
          ]),
        },
      ],
    });

    const plans = await buildPlan(manifest, "rm", ["claude"], "project", tmpDir);

    expect(plans).toHaveLength(1);
    const agentItem = plans[0].items.find(i => i.type === "agent");
    expect(agentItem).toBeDefined();
    expect(agentItem!.overrideKeys).toBeUndefined();
  });

  it("shows no overrideKeys when all override values are null", async () => {
    await mkdir(join(tmpDir, "agents"), { recursive: true });
    await writeFile(join(tmpDir, "agents", "architect.md"), "---\nname: Architect\nmodel: sonnet\n---\nBody.");

    const manifest = makeManifest({
      agents: [
        {
          source: "./agents/architect.md",
          overrides: new Map([
            ["claude", { model: null }],
          ]),
        },
      ],
    });

    const plans = await buildPlan(manifest, "add", ["claude"], "project", tmpDir);

    expect(plans).toHaveLength(1);
    const agentItem = plans[0].items.find(i => i.type === "agent");
    expect(agentItem).toBeDefined();
    // All overrides are null (deletions), so no positive keys to show
    expect(agentItem!.overrideKeys).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAdd, executeRm } from "../src/engine.ts";
import type { NormalizedManifest } from "../src/manifest/schema.ts";

describe("engine integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-config-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeManifest(overrides: Partial<NormalizedManifest> = {}): NormalizedManifest {
    return {
      name: "test",
      harnesses: new Map([["claude", null], ["opencode", null]]),
      mcps: {},
      skills: [],
      ...overrides,
    };
  }

  describe("add MCPs", () => {
    it("creates MCP configs for all target harnesses", async () => {
      const manifest = makeManifest({
        mcps: {
          fetch: {
            stdio: "npx -y @anthropic/mcp-fetch",
            env: ["HTTP_PROXY"],
          },
        },
      });

      const result = await executeAdd(manifest, {
        scope: "project",
        cwd: tmpDir,
      });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].mcps).toEqual(["fetch"]);
      expect(result.results[1].mcps).toEqual(["fetch"]);

      // Check Claude config
      const claudeConfig = JSON.parse(await readFile(join(tmpDir, ".mcp.json"), "utf-8"));
      expect(claudeConfig.mcpServers.fetch).toEqual({
        command: "npx",
        args: ["-y", "@anthropic/mcp-fetch"],
        env: { HTTP_PROXY: "${env:HTTP_PROXY}" },
      });

      // Check OpenCode config
      const ocConfig = JSON.parse(await readFile(join(tmpDir, "opencode.json"), "utf-8"));
      expect(ocConfig.mcp.fetch).toEqual({
        type: "local",
        command: ["npx", "-y", "@anthropic/mcp-fetch"],
        environment: { HTTP_PROXY: "{env:HTTP_PROXY}" },
      });
    });

    it("merges into existing config without overwriting other servers", async () => {
      // Write existing config
      await writeFile(
        join(tmpDir, ".mcp.json"),
        JSON.stringify({
          mcpServers: { existing: { command: "foo", args: [] } },
        }),
      );

      const manifest = makeManifest({
        harnesses: new Map([["claude", null]]),
        mcps: { newServer: { stdio: "new-cmd" } },
      });

      await executeAdd(manifest, { scope: "project", cwd: tmpDir });

      const config = JSON.parse(await readFile(join(tmpDir, ".mcp.json"), "utf-8"));
      expect(config.mcpServers.existing).toEqual({ command: "foo", args: [] });
      expect(config.mcpServers.newServer).toBeDefined();
    });

    it("is idempotent — running twice produces same result", async () => {
      const manifest = makeManifest({
        harnesses: new Map([["claude", null]]),
        mcps: { server: { stdio: "cmd arg1 arg2" } },
      });

      await executeAdd(manifest, { scope: "project", cwd: tmpDir });
      const first = await readFile(join(tmpDir, ".mcp.json"), "utf-8");

      await executeAdd(manifest, { scope: "project", cwd: tmpDir });
      const second = await readFile(join(tmpDir, ".mcp.json"), "utf-8");

      expect(first).toBe(second);
    });
  });

  describe("rm MCPs", () => {
    it("removes named servers from config", async () => {
      await writeFile(
        join(tmpDir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            keep: { command: "keep", args: [] },
            remove: { command: "remove", args: [] },
          },
        }),
      );

      const manifest = makeManifest({
        harnesses: new Map([["claude", null]]),
        mcps: { remove: { stdio: "__placeholder__" } as any },
      });

      await executeRm(manifest, { scope: "project", cwd: tmpDir });

      const config = JSON.parse(await readFile(join(tmpDir, ".mcp.json"), "utf-8"));
      expect(config.mcpServers.keep).toBeDefined();
      expect(config.mcpServers.remove).toBeUndefined();
    });

    it("is idempotent — removing non-existent is a no-op", async () => {
      await writeFile(join(tmpDir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));

      const manifest = makeManifest({
        harnesses: new Map([["claude", null]]),
        mcps: { nonexistent: { stdio: "__placeholder__" } as any },
      });

      // Should not throw
      const result = await executeRm(manifest, { scope: "project", cwd: tmpDir });
      expect(result.results[0].mcps).toEqual(["nonexistent"]);
    });
  });

  describe("add agents", () => {
    it("installs agent with frontmatter transform", async () => {
      // Create agent source file
      const agentContent = `---
name: Architect
model: claude-sonnet-4-20250514
mode: agent
---
You are a software architect.`;
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(join(tmpDir, "agents", "architect.md"), agentContent);

      const manifest = makeManifest({
        harnesses: new Map([["claude", { agents: ["./agents/architect.md"] }]]),
      });

      await executeAdd(manifest, { scope: "project", cwd: tmpDir });

      const installed = await readFile(join(tmpDir, ".claude", "agents", "architect.md"), "utf-8");
      expect(installed).toContain("name: Architect");
      expect(installed).toContain("model: claude-sonnet-4-20250514");
      expect(installed).toContain("mode: agent");
      expect(installed).toContain("You are a software architect.");
    });

    it("installs agents for harnesses that support them", async () => {
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(join(tmpDir, "agents", "test.md"), "---\nname: Test\n---\nBody");

      const manifest = makeManifest({
        harnesses: new Map([["pi", { agents: ["./agents/test.md"] }]]),
      });

      const result = await executeAdd(manifest, { scope: "project", cwd: tmpDir });
      expect(result.results[0].agents).toHaveLength(1);
      expect(result.results[0].agents[0].name).toBe("test.md");
    });

    it("detects unchanged agents and skips write", async () => {
      const agentContent = `---\nname: Architect\n---\nYou are a software architect.`;
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(join(tmpDir, "agents", "architect.md"), agentContent);

      const manifest = makeManifest({
        harnesses: new Map([["claude", { agents: ["./agents/architect.md"] }]]),
      });

      // First install
      await executeAdd(manifest, { scope: "project", cwd: tmpDir });
      const firstContent = await readFile(join(tmpDir, ".claude", "agents", "architect.md"), "utf-8");

      // Second install — should detect unchanged
      const { stat } = await import("node:fs/promises");
      const beforeStat = await stat(join(tmpDir, ".claude", "agents", "architect.md"));

      // Small delay to ensure mtime would differ if rewritten
      await new Promise(r => setTimeout(r, 50));
      await executeAdd(manifest, { scope: "project", cwd: tmpDir });

      const afterStat = await stat(join(tmpDir, ".claude", "agents", "architect.md"));
      const secondContent = await readFile(join(tmpDir, ".claude", "agents", "architect.md"), "utf-8");

      expect(firstContent).toBe(secondContent);
      // mtime should NOT have changed (file wasn't rewritten)
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    });
  });

  describe("add skills", () => {
    it("copies skill directory to harness skill dir", async () => {
      // Create skill source
      await mkdir(join(tmpDir, "skills", "my-skill"), { recursive: true });
      await writeFile(join(tmpDir, "skills", "my-skill", "SKILL.md"), "# My Skill");

      const manifest = makeManifest({
        harnesses: new Map([["claude", null]]),
        skills: ["./skills/my-skill"],
      });

      await executeAdd(manifest, { scope: "project", cwd: tmpDir });

      const skillMd = await readFile(join(tmpDir, ".claude", "skills", "my-skill", "SKILL.md"), "utf-8");
      expect(skillMd).toBe("# My Skill");
    });

    it("validates and exactly synchronizes Bob skills", async () => {
      const source = join(tmpDir, "source", "code-review");
      const destination = join(tmpDir, "dest");
      await mkdir(join(source, "references"), { recursive: true });
      await writeFile(join(source, "SKILL.md"), "---\nname: code-review\ndescription: Review code\n---\nInstructions");
      await writeFile(join(source, "references", "old.md"), "old");

      const manifest = makeManifest({
        harnesses: new Map([["bob", null]]),
        skills: ["./code-review"],
        baseDir: join(tmpDir, "source"),
      });
      await executeAdd(manifest, { scope: "project", cwd: destination });

      await rm(join(source, "references", "old.md"));
      await writeFile(join(source, "references", "new.md"), "new");
      await executeAdd(manifest, { scope: "project", cwd: destination });

      await expect(access(join(destination, ".bob", "skills", "code-review", "references", "old.md"))).rejects.toThrow();
      expect(await readFile(join(destination, ".bob", "skills", "code-review", "references", "new.md"), "utf-8")).toBe("new");

      await executeRm(manifest, { scope: "project", cwd: destination });
      await expect(access(join(destination, ".bob", "skills", "code-review"))).rejects.toThrow();
    });

    it("rejects Bob skills without required metadata", async () => {
      const source = join(tmpDir, "invalid-skill");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "---\nname: invalid\n---\nBody");
      const manifest = makeManifest({
        harnesses: new Map([["bob", null]]),
        skills: ["./invalid-skill"],
        baseDir: tmpDir,
      });
      await expect(executeAdd(manifest, { scope: "project", cwd: tmpDir })).rejects.toThrow(/name and description/);
    });

    it("rejects Bob skill names that do not match their folder", async () => {
      const source = join(tmpDir, "skill-folder");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "---\nname: another-name\ndescription: Description\n---\nBody");
      const manifest = makeManifest({
        harnesses: new Map([["bob", null]]),
        skills: ["./skill-folder"],
        baseDir: tmpDir,
      });
      await expect(executeAdd(manifest, { scope: "project", cwd: tmpDir })).rejects.toThrow(/must match its folder/);
    });
  });

  describe("IBM Bob modes and files", () => {
    it("merges, updates, and removes modes by slug", async () => {
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await mkdir(join(tmpDir, ".bob"), { recursive: true });
      await writeFile(join(tmpDir, ".bob", "custom_modes.yaml"), `customModes:\n  - slug: existing\n    name: Existing\n    roleDefinition: Keep me\n    groups: [read]\n`);
      await writeFile(join(tmpDir, "agents", "reviewer.md"), `---\nname: Reviewer\ndescription: Reviews changes\ntools: [Read, Grep]\nwhenToUse: Use for reviews\n---\nReview code carefully.`);
      const manifest = makeManifest({
        harnesses: new Map([["bob", { agents: ["./agents/reviewer.md"] }]]),
        baseDir: tmpDir,
      });

      await executeAdd(manifest, { scope: "project", cwd: tmpDir });
      let modes = await readFile(join(tmpDir, ".bob", "custom_modes.yaml"), "utf-8");
      expect(modes).toContain("slug: existing");
      expect(modes).toContain("slug: reviewer");
      expect(modes).toContain("roleDefinition: Review code carefully.");
      expect(modes).toContain("- read");

      await writeFile(join(tmpDir, "agents", "reviewer.md"), `---\nname: Reviewer\ndescription: Reviews changes\ngroups: [read, skill]\n---\nUpdated role.`);
      await executeAdd(manifest, { scope: "project", cwd: tmpDir });
      modes = await readFile(join(tmpDir, ".bob", "custom_modes.yaml"), "utf-8");
      expect(modes).toContain("roleDefinition: Updated role.");
      expect(modes.match(/slug: reviewer/g)).toHaveLength(1);

      await executeRm(manifest, { scope: "project", cwd: tmpDir });
      modes = await readFile(join(tmpDir, ".bob", "custom_modes.yaml"), "utf-8");
      expect(modes).toContain("slug: existing");
      expect(modes).not.toContain("slug: reviewer");
    });

    it("preserves nested rules and commands and supports workspace AGENTS.md", async () => {
      await mkdir(join(tmpDir, "assets", "rules", "security"), { recursive: true });
      await mkdir(join(tmpDir, "assets", "commands", "release"), { recursive: true });
      await writeFile(join(tmpDir, "assets", "rules", "security", "review.md"), "rule");
      await writeFile(join(tmpDir, "assets", "commands", "release", "deploy.md"), "command");
      await writeFile(join(tmpDir, "assets", "AGENTS.md"), "context");
      const manifest = makeManifest({
        harnesses: new Map([["bob", {
          rules: ["./assets/rules/security/review.md"],
          commands: ["./assets/commands/release/deploy.md"],
          files: [{ source: "./assets/AGENTS.md", dest: "AGENTS.md", root: "workspace" }],
        }]]),
        baseDir: tmpDir,
      });

      await executeAdd(manifest, { scope: "project", cwd: tmpDir });
      expect(await readFile(join(tmpDir, ".bob", "rules", "security", "review.md"), "utf-8")).toBe("rule");
      expect(await readFile(join(tmpDir, ".bob", "commands", "release", "deploy.md"), "utf-8")).toBe("command");
      expect(await readFile(join(tmpDir, "AGENTS.md"), "utf-8")).toBe("context");
    });

    it("rejects file destinations outside their root", async () => {
      await writeFile(join(tmpDir, "source.txt"), "content");
      const manifest = makeManifest({
        harnesses: new Map([["bob", { files: [{ source: "./source.txt", dest: "../escape.txt" }] }]]),
        baseDir: tmpDir,
      });
      await expect(executeAdd(manifest, { scope: "project", cwd: tmpDir })).rejects.toThrow(/escapes/);
    });

    it("rejects root-equivalent file destinations", async () => {
      await writeFile(join(tmpDir, "source.txt"), "content");
      const manifest = makeManifest({
        harnesses: new Map([["bob", { files: [{ source: "./source.txt", dest: "." }] }]]),
        baseDir: tmpDir,
      });
      await expect(executeAdd(manifest, { scope: "project", cwd: tmpDir })).rejects.toThrow(/configured root/);
    });

    it("uses filenames as stable default mode slugs", async () => {
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(join(tmpDir, "agents", "reviewer.md"), "---\nname: Friendly Reviewer\n---\nReview code.");
      const manifest = makeManifest({
        harnesses: new Map([["bob", { agents: ["./agents/reviewer.md"] }]]),
        baseDir: tmpDir,
      });
      await executeAdd(manifest, { scope: "project", cwd: tmpDir });
      expect(await readFile(join(tmpDir, ".bob", "custom_modes.yaml"), "utf-8")).toContain("slug: reviewer");
    });

    it("preflights invalid Bob skills before writing MCP config", async () => {
      const source = join(tmpDir, "bad-skill");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "---\nname: bad\n---\nBody");
      const manifest = makeManifest({
        harnesses: new Map([["bob", null]]),
        mcps: { local: { stdio: "node server.js" } },
        skills: ["./bad-skill"],
        baseDir: tmpDir,
      });
      await expect(executeAdd(manifest, { scope: "project", cwd: tmpDir })).rejects.toThrow();
      await expect(access(join(tmpDir, ".bob", "mcp.json"))).rejects.toThrow();
    });
  });

  describe("harness filtering", () => {
    it("only targets specified harnesses with --harness filter", async () => {
      const manifest = makeManifest({
        mcps: { server: { stdio: "cmd" } },
      });

      const result = await executeAdd(manifest, {
        scope: "project",
        cwd: tmpDir,
        harnesses: ["claude"],
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].harness).toBe("Claude Code");
    });

    it("installs universal components to undeclared harness targets without throwing", async () => {
      const manifest = makeManifest({
        harnesses: new Map([["claude", null]]),
        mcps: { server: { stdio: "cmd" } },
      });

      const result = await executeAdd(manifest, {
        scope: "project",
        cwd: tmpDir,
        harnesses: ["pi"],
      });

      // Should not throw — undeclared harnesses are allowed
      // Warning is now handled by CLI layer, not engine
      expect(result.warnings).toEqual([]);
      // Universal components (MCPs) still install to the undeclared harness
      expect(result.results).toHaveLength(1);
      expect(result.results[0].mcps).toEqual(["server"]);
    });

    it("skips harness-specific components for undeclared harness targets", async () => {
      // Create agent source (declared for claude only)
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(join(tmpDir, "agents", "architect.md"), "---\nname: Architect\n---\nBody");

      const manifest = makeManifest({
        harnesses: new Map([["claude", { agents: ["./agents/architect.md"] }]]),
        mcps: { server: { stdio: "cmd" } },
        skills: [],
      });

      // Target pi (undeclared) — should get universal MCPs but not claude-specific agents
      const result = await executeAdd(manifest, {
        scope: "project",
        cwd: tmpDir,
        harnesses: ["pi"],
      });

      expect(result.warnings).toHaveLength(0);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].mcps).toEqual(["server"]); // universal: installed
      expect(result.results[0].agents).toEqual([]);        // harness-specific: skipped
    });
  });

  describe("universal agents", () => {
    it("installs universal agents to all target harnesses", async () => {
      // Create agent source
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(join(tmpDir, "agents", "architect.md"), "---\nname: Architect\n---\nYou are an architect.");

      const manifest = makeManifest({
        agents: [
          { source: "./agents/architect.md", overrides: new Map() },
        ],
      });

      const result = await executeAdd(manifest, {
        scope: "project",
        cwd: tmpDir,
      });

      // Should install to both claude and opencode (the declared harnesses)
      expect(result.results).toHaveLength(2);
      expect(result.results[0].agents).toHaveLength(1);
      expect(result.results[0].agents[0].name).toBe("architect.md");
      expect(result.results[1].agents).toHaveLength(1);
      expect(result.results[1].agents[0].name).toBe("architect.md");

      // Verify file exists in claude agent dir
      const claudeContent = await readFile(join(tmpDir, ".claude", "agents", "architect.md"), "utf-8");
      expect(claudeContent).toContain("You are an architect.");
    });

    it("removes universal agents from all target harnesses", async () => {
      // Install first
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(join(tmpDir, "agents", "architect.md"), "---\nname: Architect\n---\nBody");

      const manifest = makeManifest({
        agents: [
          { source: "./agents/architect.md", overrides: new Map() },
        ],
      });

      await executeAdd(manifest, { scope: "project", cwd: tmpDir });

      // Now remove
      const result = await executeRm(manifest, { scope: "project", cwd: tmpDir });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].agents).toHaveLength(1);
      expect(result.results[0].agents[0].name).toBe("architect.md");
    });

    it("installs universal agents to undeclared harnesses", async () => {
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(join(tmpDir, "agents", "architect.md"), "---\nname: Architect\n---\nBody");

      const manifest = makeManifest({
        harnesses: new Map([["claude", null]]),
        agents: [
          { source: "./agents/architect.md", overrides: new Map() },
        ],
      });

      // Target pi (undeclared) — universal agents should still install
      const result = await executeAdd(manifest, {
        scope: "project",
        cwd: tmpDir,
        harnesses: ["pi"],
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].agents).toHaveLength(1);
      expect(result.results[0].agents[0].name).toBe("architect.md");
    });

    it("applies frontmatter overrides for the target harness", async () => {
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(
        join(tmpDir, "agents", "architect.md"),
        "---\nname: Architect\ndescription: A software architect\n---\nYou are an architect.",
      );

      const manifest = makeManifest({
        agents: [
          {
            source: "./agents/architect.md",
            overrides: new Map([
              ["claude", { model: "sonnet", tools: ["Read", "Grep"] }],
              ["opencode", { model: "claude-sonnet", steps: 30 }],
            ]),
          },
        ],
      });

      const result = await executeAdd(manifest, {
        scope: "project",
        cwd: tmpDir,
      });

      expect(result.results).toHaveLength(2);

      // Claude should have model and tools merged
      const claudeContent = await readFile(
        join(tmpDir, ".claude", "agents", "architect.md"),
        "utf-8",
      );
      expect(claudeContent).toContain("model: sonnet");
      expect(claudeContent).toContain("- Read");
      expect(claudeContent).toContain("- Grep");
      expect(claudeContent).toContain("name: Architect");
      expect(claudeContent).toContain("You are an architect.");

      // OpenCode should have model and steps merged
      const opencodeContent = await readFile(
        join(tmpDir, ".opencode", "agents", "architect.md"),
        "utf-8",
      );
      expect(opencodeContent).toContain("model: claude-sonnet");
      expect(opencodeContent).toContain("steps: 30");
      expect(opencodeContent).toContain("name: Architect");
      expect(opencodeContent).toContain("You are an architect.");
    });

    it("copies as-is when no overrides exist for target harness", async () => {
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      const sourceContent = "---\nname: Architect\n---\nYou are an architect.";
      await writeFile(join(tmpDir, "agents", "architect.md"), sourceContent);

      const manifest = makeManifest({
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

      const result = await executeAdd(manifest, {
        scope: "project",
        cwd: tmpDir,
      });

      expect(result.results).toHaveLength(2);

      // OpenCode should get the source as-is (no overrides)
      const opencodeContent = await readFile(
        join(tmpDir, ".opencode", "agents", "architect.md"),
        "utf-8",
      );
      expect(opencodeContent).toBe(sourceContent);
    });

    it("removes keys when override value is null", async () => {
      await mkdir(join(tmpDir, "agents"), { recursive: true });
      await writeFile(
        join(tmpDir, "agents", "architect.md"),
        "---\nname: Architect\nmodel: haiku\ntools:\n  - Read\n  - Write\n---\nBody.",
      );

      const manifest = makeManifest({
        agents: [
          {
            source: "./agents/architect.md",
            overrides: new Map([
              ["claude", { tools: null }],
            ]),
          },
        ],
      });

      const result = await executeAdd(manifest, {
        scope: "project",
        cwd: tmpDir,
        harnesses: ["claude"],
      });

      expect(result.results).toHaveLength(1);

      const claudeContent = await readFile(
        join(tmpDir, ".claude", "agents", "architect.md"),
        "utf-8",
      );
      expect(claudeContent).toContain("name: Architect");
      expect(claudeContent).toContain("model: haiku");
      expect(claudeContent).not.toContain("tools");
      expect(claudeContent).not.toContain("Read");
      expect(claudeContent).toContain("Body.");
    });
  });
});

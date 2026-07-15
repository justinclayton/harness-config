import { describe, it, expect } from "vitest";
import {
  buildComponentTreeOptions,
  countManifestComponents,
  filterManifest,
  encodeComponentKey,
  decodeComponentKey,
} from "../src/filter.ts";
import type { NormalizedManifest, HarnessName } from "../src/manifest/schema.ts";

function makeManifest(overrides: Partial<NormalizedManifest> = {}): NormalizedManifest {
  return {
    name: "test-manifest",
    description: "A test manifest",
    harnesses: new Map([["claude", null]]),
    mcps: {},
    skills: [],
    ...overrides,
  };
}

describe("Component key encoding/decoding", () => {
  it("encodes and decodes universal MCP key", () => {
    const key = { type: "mcp" as const, harness: "", name: "github" };
    const encoded = encodeComponentKey(key);
    expect(encoded).toBe("mcp::github");
    expect(decodeComponentKey(encoded)).toEqual(key);
  });

  it("encodes and decodes universal skill key", () => {
    const key = { type: "skill" as const, harness: "", name: "code-review" };
    const encoded = encodeComponentKey(key);
    expect(encoded).toBe("skill::code-review");
    expect(decodeComponentKey(encoded)).toEqual(key);
  });

  it("encodes and decodes harness-specific agent key", () => {
    const key = { type: "agent" as const, harness: "claude", name: "architect.md" };
    const encoded = encodeComponentKey(key);
    expect(encoded).toBe("agent:claude:architect.md");
    expect(decodeComponentKey(encoded)).toEqual(key);
  });

  it("encodes and decodes file key with path separators", () => {
    const key = { type: "file" as const, harness: "pi", name: "config/settings.json" };
    const encoded = encodeComponentKey(key);
    expect(encoded).toBe("file:pi:config/settings.json");
    expect(decodeComponentKey(encoded)).toEqual(key);
  });
});

describe("buildComponentTreeOptions", () => {
  it("creates MCPs group for universal MCPs", () => {
    const manifest = makeManifest({
      mcps: {
        github: { stdio: "npx github-mcp" },
        filesystem: { stdio: "npx fs-mcp" },
      },
    });

    const { options, initialValues } = buildComponentTreeOptions(manifest, ["claude"], ["claude"]);

    expect(options["MCPs"]).toHaveLength(2);
    expect(options["MCPs"][0].value).toBe("mcp::github");
    expect(options["MCPs"][0].label).toBe("github");
    expect(options["MCPs"][1].value).toBe("mcp::filesystem");
    expect(options["MCPs"][1].label).toBe("filesystem");
    // Universal MCPs are always pre-selected
    expect(initialValues).toContain("mcp::github");
    expect(initialValues).toContain("mcp::filesystem");
  });

  it("creates Skills group for universal skills", () => {
    const manifest = makeManifest({
      skills: ["./skills/code-review", "./skills/testing"],
    });

    const { options, initialValues } = buildComponentTreeOptions(manifest, ["claude"], ["claude"]);

    expect(options["Skills"]).toHaveLength(2);
    expect(options["Skills"][0].value).toBe("skill::code-review");
    expect(options["Skills"][0].label).toBe("code-review");
    expect(options["Skills"][1].value).toBe("skill::testing");
    // Universal skills are always pre-selected
    expect(initialValues).toContain("skill::code-review");
    expect(initialValues).toContain("skill::testing");
  });

  it("creates harness-specific groups with display name", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", { agents: ["./agents/architect.md", "./agents/reviewer.md"] }],
      ]),
    });

    const { options, initialValues } = buildComponentTreeOptions(manifest, ["claude"], ["claude"]);

    // Claude Code is the display name for claude
    expect(options["Claude Code > Agents"]).toHaveLength(2);
    expect(options["Claude Code > Agents"][0].value).toBe("agent:claude:architect.md");
    expect(options["Claude Code > Agents"][0].label).toBe("architect");
    expect(options["Claude Code > Agents"][1].value).toBe("agent:claude:reviewer.md");
    expect(options["Claude Code > Agents"][1].label).toBe("reviewer");
    // Selected harness components are pre-selected
    expect(initialValues).toContain("agent:claude:architect.md");
    expect(initialValues).toContain("agent:claude:reviewer.md");
  });

  it("does NOT pre-select components from unselected harnesses", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", { agents: ["./agents/architect.md"] }],
        ["pi", { skills: ["./skills/architecture"] }],
      ]),
    });

    // User selected only claude
    const { options, initialValues } = buildComponentTreeOptions(manifest, ["claude"], ["claude", "pi"]);

    // Claude agent IS pre-selected
    expect(initialValues).toContain("agent:claude:architect.md");
    // Pi skill is NOT pre-selected
    expect(initialValues).not.toContain("skill:pi:architecture");
    // But Pi items still appear in the options
    expect(options["Pi > Skills"]).toHaveLength(1);
    expect(options["Pi > Skills"][0].hint).toBe("pi");
  });

  it("annotates unsupported harness groups", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", { agents: ["./agents/architect.md"] }],
        ["opencode", { agents: ["./agents/architect.md"] }],
      ]),
    });

    // opencode is not in declaredHarnesses (unsupported)
    const { options } = buildComponentTreeOptions(manifest, ["claude"], ["claude"]);

    // Claude is supported, no annotation
    const claudeKey = Object.keys(options).find(k => k.startsWith("Claude Code"));
    expect(claudeKey).toBe("Claude Code > Agents");

    // OpenCode is unsupported, should have annotation
    const opencodeKey = Object.keys(options).find(k => k.startsWith("OpenCode"));
    expect(opencodeKey).toContain("(unsupported)");
  });

  it("creates separate groups for different component types under same harness", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", {
          agents: ["./agents/architect.md"],
          rules: ["./rules/standards.md"],
          skills: ["./skills/review"],
        }],
      ]),
    });

    const { options } = buildComponentTreeOptions(manifest, ["claude"], ["claude"]);

    expect(options["Claude Code > Agents"]).toHaveLength(1);
    expect(options["Claude Code > Rules"]).toHaveLength(1);
    expect(options["Claude Code > Skills"]).toHaveLength(1);
  });

  it("omits empty categories", () => {
    const manifest = makeManifest({
      mcps: {},
      skills: [],
      harnesses: new Map([["claude", null]]),
    });

    const { options } = buildComponentTreeOptions(manifest, ["claude"], ["claude"]);

    expect(Object.keys(options)).toHaveLength(0);
  });

  it("handles files with dest paths in harness-specific section", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", { files: [{ source: "./files/config.json", dest: "config/settings.json" }] }],
      ]),
    });

    const { options } = buildComponentTreeOptions(manifest, ["claude"], ["claude"]);

    expect(options["Claude Code > Files"]).toHaveLength(1);
    expect(options["Claude Code > Files"][0].value).toBe("file:claude:config/settings.json");
    expect(options["Claude Code > Files"][0].label).toBe("config/settings.json");
  });

  it("preserves workspace-root file mappings through filtering", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["bob", { files: [{ source: "./AGENTS.md", dest: "AGENTS.md", root: "workspace" }] }],
      ]),
    });
    const filtered = filterManifest(manifest, ["file:bob:AGENTS.md"]);
    expect(filtered.harnesses.get("bob")?.files).toEqual([
      { source: "./AGENTS.md", dest: "AGENTS.md", root: "workspace" },
    ]);
  });
});

describe("countManifestComponents", () => {
  it("counts zero for empty manifest", () => {
    const manifest = makeManifest();
    expect(countManifestComponents(manifest)).toBe(0);
  });

  it("counts MCPs and skills", () => {
    const manifest = makeManifest({
      mcps: { github: { stdio: "cmd" }, fs: { stdio: "cmd2" } },
      skills: ["./skills/a", "./skills/b", "./skills/c"],
    });
    expect(countManifestComponents(manifest)).toBe(5);
  });

  it("counts harness-specific components", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", {
          agents: ["./agents/a.md", "./agents/b.md"],
          rules: ["./rules/r.md"],
          skills: ["./skills/s"],
          commands: ["./commands/c.md"],
          files: [{ source: "./f", dest: "d" }],
        }],
      ]),
    });
    expect(countManifestComponents(manifest)).toBe(6);
  });

  it("skips null harness configs", () => {
    const manifest = makeManifest({
      mcps: { server: { stdio: "cmd" } },
      harnesses: new Map([["claude", null], ["pi", null]]),
    });
    expect(countManifestComponents(manifest)).toBe(1);
  });
});

describe("filterManifest", () => {
  it("returns full manifest when all keys selected", () => {
    const manifest = makeManifest({
      mcps: { github: { stdio: "cmd" }, fs: { stdio: "cmd2" } },
      skills: ["./skills/code-review"],
      harnesses: new Map([
        ["claude", { agents: ["./agents/architect.md"] }],
      ]),
    });

    const allKeys = [
      "mcp::github",
      "mcp::fs",
      "skill::code-review",
      "agent:claude:architect.md",
    ];

    const filtered = filterManifest(manifest, allKeys);

    expect(Object.keys(filtered.mcps)).toEqual(["github", "fs"]);
    expect(filtered.skills).toEqual(["./skills/code-review"]);
    expect(filtered.harnesses.get("claude")?.agents).toEqual(["./agents/architect.md"]);
  });

  it("filters out deselected MCPs", () => {
    const manifest = makeManifest({
      mcps: { github: { stdio: "cmd" }, fs: { stdio: "cmd2" } },
    });

    const filtered = filterManifest(manifest, ["mcp::github"]);

    expect(Object.keys(filtered.mcps)).toEqual(["github"]);
    expect(filtered.mcps["fs"]).toBeUndefined();
  });

  it("filters out deselected universal skills", () => {
    const manifest = makeManifest({
      skills: ["./skills/code-review", "./skills/testing"],
    });

    const filtered = filterManifest(manifest, ["skill::code-review"]);

    expect(filtered.skills).toEqual(["./skills/code-review"]);
  });

  it("filters out deselected harness-specific agents", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", { agents: ["./agents/architect.md", "./agents/reviewer.md"] }],
      ]),
    });

    const filtered = filterManifest(manifest, ["agent:claude:architect.md"]);

    expect(filtered.harnesses.get("claude")?.agents).toEqual(["./agents/architect.md"]);
  });

  it("sets harness config to null when all components filtered out", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", { agents: ["./agents/architect.md"] }],
      ]),
    });

    const filtered = filterManifest(manifest, []);

    expect(filtered.harnesses.get("claude")).toBeNull();
  });

  it("preserves manifest metadata", () => {
    const manifest = makeManifest({
      name: "my-config",
      description: "A description",
      baseDir: "/some/path",
    });

    const filtered = filterManifest(manifest, []);

    expect(filtered.name).toBe("my-config");
    expect(filtered.description).toBe("A description");
    expect(filtered.baseDir).toBe("/some/path");
  });

  it("handles empty selection gracefully", () => {
    const manifest = makeManifest({
      mcps: { github: { stdio: "cmd" } },
      skills: ["./skills/review"],
      harnesses: new Map([
        ["claude", { agents: ["./agents/arch.md"], rules: ["./rules/r.md"] }],
      ]),
    });

    const filtered = filterManifest(manifest, []);

    expect(Object.keys(filtered.mcps)).toEqual([]);
    expect(filtered.skills).toEqual([]);
    expect(filtered.harnesses.get("claude")).toBeNull();
  });

  it("filters harness-specific files by dest path", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", {
          files: [
            { source: "./files/a.json", dest: "config/a.json" },
            { source: "./files/b.json", dest: "config/b.json" },
          ],
        }],
      ]),
    });

    const filtered = filterManifest(manifest, ["file:claude:config/a.json"]);

    expect(filtered.harnesses.get("claude")?.files).toEqual([
      { source: "./files/a.json", dest: "config/a.json" },
    ]);
  });

  it("filters harness-specific rules", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", { rules: ["./rules/standards.md", "./rules/style.md"] }],
      ]),
    });

    const filtered = filterManifest(manifest, ["rule:claude:standards.md"]);

    expect(filtered.harnesses.get("claude")?.rules).toEqual(["./rules/standards.md"]);
  });

  it("filters harness-specific commands", () => {
    const manifest = makeManifest({
      harnesses: new Map([
        ["claude", { commands: ["./commands/deploy.md", "./commands/test.md"] }],
      ]),
    });

    const filtered = filterManifest(manifest, ["command:claude:deploy.md"]);

    expect(filtered.harnesses.get("claude")?.commands).toEqual(["./commands/deploy.md"]);
  });

  it("preserves null harness configs (declared but no components)", () => {
    const manifest = makeManifest({
      mcps: { github: { stdio: "cmd" } },
      harnesses: new Map([
        ["claude", null],
        ["pi", { agents: ["./agents/a.md"] }],
      ]),
    });

    const filtered = filterManifest(manifest, ["mcp::github", "agent:pi:a.md"]);

    expect(filtered.harnesses.get("claude")).toBeNull();
    expect(filtered.harnesses.get("pi")?.agents).toEqual(["./agents/a.md"]);
  });

  it("handles complex manifest with mixed selection", () => {
    const manifest = makeManifest({
      mcps: { github: { stdio: "cmd" }, slack: { stdio: "cmd2" } },
      skills: ["./skills/review", "./skills/deploy"],
      harnesses: new Map([
        ["claude", {
          agents: ["./agents/architect.md", "./agents/reviewer.md"],
          rules: ["./rules/standards.md"],
        }],
        ["pi", { skills: ["./skills/architecture"] }],
      ]),
    });

    const selected = [
      "mcp::github",           // keep github, drop slack
      "skill::review",         // keep review, drop deploy
      "agent:claude:architect.md", // keep architect, drop reviewer
      // drop claude rules entirely
      "skill:pi:architecture", // keep pi skill
    ];

    const filtered = filterManifest(manifest, selected);

    expect(Object.keys(filtered.mcps)).toEqual(["github"]);
    expect(filtered.skills).toEqual(["./skills/review"]);
    expect(filtered.harnesses.get("claude")?.agents).toEqual(["./agents/architect.md"]);
    expect(filtered.harnesses.get("claude")?.rules).toBeUndefined();
    expect(filtered.harnesses.get("pi")?.skills).toEqual(["./skills/architecture"]);
  });
});

describe("Universal agents in component tree and filtering", () => {
  function makeManifest(overrides: Partial<NormalizedManifest> = {}): NormalizedManifest {
    return {
      name: "test-manifest",
      description: "A test manifest",
      harnesses: new Map([["claude", null]]),
      mcps: {},
      skills: [],
      agents: [],
      ...overrides,
    };
  }

  describe("buildComponentTreeOptions with universal agents", () => {
    it("creates Agents group for universal agents", () => {
      const manifest = makeManifest({
        agents: [
          { source: "./agents/architect.md", overrides: new Map() },
          { source: "./agents/reviewer.md", overrides: new Map() },
        ],
      });

      const { options, initialValues } = buildComponentTreeOptions(manifest, ["claude"], ["claude"]);

      expect(options["Agents"]).toHaveLength(2);
      expect(options["Agents"][0].value).toBe("agent::architect.md");
      expect(options["Agents"][0].label).toBe("architect");
      expect(options["Agents"][1].value).toBe("agent::reviewer.md");
      expect(options["Agents"][1].label).toBe("reviewer");
      // Universal agents are always pre-selected
      expect(initialValues).toContain("agent::architect.md");
      expect(initialValues).toContain("agent::reviewer.md");
    });

    it("does not create Agents group when no universal agents exist", () => {
      const manifest = makeManifest({ agents: [] });

      const { options } = buildComponentTreeOptions(manifest, ["claude"], ["claude"]);

      expect(options["Agents"]).toBeUndefined();
    });
  });

  describe("countManifestComponents with universal agents", () => {
    it("includes universal agents in count", () => {
      const manifest = makeManifest({
        mcps: { server: { stdio: "cmd" } },
        agents: [
          { source: "./agents/a.md", overrides: new Map() },
          { source: "./agents/b.md", overrides: new Map() },
        ],
      });
      expect(countManifestComponents(manifest)).toBe(3); // 1 mcp + 2 agents
    });
  });

  describe("filterManifest with universal agents", () => {
    it("filters universal agents by selected keys", () => {
      const manifest = makeManifest({
        agents: [
          { source: "./agents/architect.md", overrides: new Map() },
          { source: "./agents/reviewer.md", overrides: new Map() },
        ],
      });

      const filtered = filterManifest(manifest, ["agent::architect.md"]);

      expect(filtered.agents).toHaveLength(1);
      expect(filtered.agents[0].source).toBe("./agents/architect.md");
    });

    it("returns empty agents when none selected", () => {
      const manifest = makeManifest({
        agents: [
          { source: "./agents/architect.md", overrides: new Map() },
        ],
      });

      const filtered = filterManifest(manifest, []);

      expect(filtered.agents).toHaveLength(0);
    });

    it("preserves agent overrides through filtering", () => {
      const overrides = new Map<HarnessName, Record<string, unknown>>([
        ["claude", { model: "sonnet" }],
      ]);
      const manifest = makeManifest({
        agents: [
          { source: "./agents/architect.md", overrides },
        ],
      });

      const filtered = filterManifest(manifest, ["agent::architect.md"]);

      expect(filtered.agents[0].overrides.get("claude")).toEqual({ model: "sonnet" });
    });
  });
});

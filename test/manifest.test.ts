import { describe, it, expect } from "vitest";
import { parseManifestYaml, ManifestParseError } from "../src/manifest/parse.ts";
import type { NormalizedManifest } from "../src/manifest/schema.ts";

describe("manifest parsing", () => {
  it("parses a minimal valid manifest", () => {
    const yaml = `
name: test
harnesses: [claude]
`;
    const result = parseManifestYaml(yaml);
    expect(result.name).toBe("test");
    expect(result.harnesses.has("claude")).toBe(true);
    expect(result.mcps).toEqual({});
    expect(result.skills).toEqual([]);
  });

  it("parses harnesses as an array", () => {
    const yaml = `
name: test
harnesses: [claude, opencode, pi]
`;
    const result = parseManifestYaml(yaml);
    expect(Array.from(result.harnesses.keys())).toEqual(["claude", "opencode", "pi"]);
  });

  it("parses harnesses as a map with null values", () => {
    const yaml = `
name: test
harnesses:
  claude:
  opencode:
`;
    const result = parseManifestYaml(yaml);
    expect(result.harnesses.has("claude")).toBe(true);
    expect(result.harnesses.has("opencode")).toBe(true);
    expect(result.harnesses.get("claude")).toBeNull();
  });

  it("parses harnesses as a map with config", () => {
    const yaml = `
name: test
harnesses:
  claude:
    rules:
      - ./rules/style.md
    skills:
      - ./skills/code-review
`;
    const result = parseManifestYaml(yaml);
    const claudeConfig = result.harnesses.get("claude");
    expect(claudeConfig).not.toBeNull();
    expect(claudeConfig!.rules).toEqual(["./rules/style.md"]);
    expect(claudeConfig!.skills).toEqual(["./skills/code-review"]);
  });

  it("parses stdio MCP", () => {
    const yaml = `
name: test
harnesses: [claude]
mcps:
  fetch:
    stdio: "npx -y @anthropic/mcp-fetch"
    env:
      - HTTP_PROXY
`;
    const result = parseManifestYaml(yaml);
    const mcp = result.mcps.fetch;
    expect("stdio" in mcp && mcp.stdio).toBe("npx -y @anthropic/mcp-fetch");
    expect(mcp.env).toEqual(["HTTP_PROXY"]);
  });

  it("parses HTTP MCP with auth", () => {
    const yaml = `
name: test
harnesses: [claude]
mcps:
  github:
    url: https://api.githubcopilot.com/mcp/
    auth: env:GH_TOKEN
`;
    const result = parseManifestYaml(yaml);
    const mcp = result.mcps.github;
    expect("url" in mcp && mcp.url).toBe("https://api.githubcopilot.com/mcp/");
    expect("auth" in mcp && mcp.auth).toBe("env:GH_TOKEN");
    expect("transport" in mcp && mcp.transport).toBe("streamable-http");
  });

  it("parses Bob-compatible MCP options", () => {
    const result = parseManifestYaml(`
name: test
harnesses: [bob]
mcps:
  local:
    stdio: node server.js
    cwd: ./tools
    alwaysAllow: [search]
    disabled: false
  legacy:
    url: https://example.com/events
    transport: sse
`);
    expect(result.mcps.local).toMatchObject({ cwd: "./tools", alwaysAllow: ["search"], disabled: false });
    expect(result.mcps.legacy).toMatchObject({ transport: "sse" });
  });

  it("parses HTTP MCP with headers", () => {
    const yaml = `
name: test
harnesses: [claude]
mcps:
  custom:
    url: https://api.example.com/mcp/
    auth: env:TOKEN
    headers:
      X-Tenant-ID: env:MY_TENANT
`;
    const result = parseManifestYaml(yaml);
    const mcp = result.mcps.custom;
    expect("headers" in mcp && mcp.headers).toEqual({ "X-Tenant-ID": "env:MY_TENANT" });
  });

  it("parses env with keychain references", () => {
    const yaml = `
name: test
harnesses: [claude]
mcps:
  fetch:
    stdio: "npx -y @anthropic/mcp-fetch"
    env:
      - HTTP_PROXY
      - API_SECRET: keychain:api-secret
`;
    const result = parseManifestYaml(yaml);
    const mcp = result.mcps.fetch;
    expect(mcp.env).toEqual([
      "HTTP_PROXY",
      { API_SECRET: "keychain:api-secret" },
    ]);
  });

  it("parses agents list in harness config", () => {
    const yaml = `
name: test
harnesses:
  claude:
    agents:
      - ./agents/architect.md
      - ./agents/reviewer.md
`;
    const result = parseManifestYaml(yaml);
    const claudeConfig = result.harnesses.get("claude");
    expect(claudeConfig?.agents).toEqual(["./agents/architect.md", "./agents/reviewer.md"]);
  });

  it("parses skills list", () => {
    const yaml = `
name: test
harnesses: [claude]
skills:
  - ./skills/code-review
`;
    const result = parseManifestYaml(yaml);
    expect(result.skills).toEqual(["./skills/code-review"]);
  });

  it("parses files escape hatch in harness config", () => {
    const yaml = `
name: test
harnesses:
  claude:
    files:
      - source: ./custom/file.txt
        dest: settings/file.txt
`;
    const result = parseManifestYaml(yaml);
    const claudeConfig = result.harnesses.get("claude");
    expect(claudeConfig!.files).toEqual([{ source: "./custom/file.txt", dest: "settings/file.txt" }]);
  });

  it("parses workspace-root file destinations", () => {
    const result = parseManifestYaml(`
name: test
harnesses:
  bob:
    files:
      - source: ./AGENTS.md
        dest: AGENTS.md
        root: workspace
`);
    expect(result.harnesses.get("bob")?.files).toEqual([
      { source: "./AGENTS.md", dest: "AGENTS.md", root: "workspace" },
    ]);
  });

  it("rejects manifest without name", () => {
    const yaml = `
harnesses: [claude]
`;
    expect(() => parseManifestYaml(yaml)).toThrow(ManifestParseError);
  });

  it("rejects manifest without harnesses", () => {
    const yaml = `
name: test
`;
    expect(() => parseManifestYaml(yaml)).toThrow(ManifestParseError);
  });

  it("rejects invalid harness name", () => {
    const yaml = `
name: test
harnesses: [claude, invalid]
`;
    expect(() => parseManifestYaml(yaml)).toThrow(ManifestParseError);
  });

  it("rejects MCP with both stdio and url", () => {
    const yaml = `
name: test
harnesses: [claude]
mcps:
  bad:
    stdio: "command"
    url: https://example.com
`;
    expect(() => parseManifestYaml(yaml)).toThrow(ManifestParseError);
  });

  it("rejects invalid YAML", () => {
    expect(() => parseManifestYaml("{{invalid")).toThrow(ManifestParseError);
  });

  it("rejects non-object YAML", () => {
    expect(() => parseManifestYaml("just a string")).toThrow(ManifestParseError);
  });

  it("rejects env key-value without keychain: prefix", () => {
    const yaml = `
name: test
harnesses: [claude]
mcps:
  bad:
    stdio: "command"
    env:
      - SECRET: some-literal-value
`;
    expect(() => parseManifestYaml(yaml)).toThrow(ManifestParseError);
  });

  it("accepts env key-value with keychain: prefix", () => {
    const yaml = `
name: test
harnesses: [claude]
mcps:
  good:
    stdio: "command"
    env:
      - SECRET: keychain:my-service
`;
    const result = parseManifestYaml(yaml);
    expect(result.mcps.good.env).toEqual([{ SECRET: "keychain:my-service" }]);
  });

  // --- Universal agents ---

  it("parses universal agents as bare string paths", () => {
    const yaml = `
name: test
harnesses: [claude]
agents:
  - ./agents/architect.md
  - ./agents/reviewer.md
`;
    const result = parseManifestYaml(yaml);
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0].source).toBe("./agents/architect.md");
    expect(result.agents[0].overrides.size).toBe(0);
    expect(result.agents[1].source).toBe("./agents/reviewer.md");
  });

  it("parses universal agents with source + harness overrides", () => {
    const yaml = `
name: test
harnesses: [claude, pi]
agents:
  - source: ./agents/architect.md
    claude:
      model: sonnet
      tools:
        - Read
        - Grep
    pi:
      model: anthropic/claude-sonnet-4
      thinking: high
      max_turns: 30
`;
    const result = parseManifestYaml(yaml);
    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0];
    expect(agent.source).toBe("./agents/architect.md");
    expect(agent.overrides.size).toBe(2);
    expect(agent.overrides.get("claude")).toEqual({ model: "sonnet", tools: ["Read", "Grep"] });
    expect(agent.overrides.get("pi")).toEqual({ model: "anthropic/claude-sonnet-4", thinking: "high", max_turns: 30 });
  });

  it("parses mixed bare string and object agent entries", () => {
    const yaml = `
name: test
harnesses: [claude]
agents:
  - ./agents/simple.md
  - source: ./agents/configured.md
    claude:
      model: sonnet
`;
    const result = parseManifestYaml(yaml);
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0].source).toBe("./agents/simple.md");
    expect(result.agents[0].overrides.size).toBe(0);
    expect(result.agents[1].source).toBe("./agents/configured.md");
    expect(result.agents[1].overrides.get("claude")).toEqual({ model: "sonnet" });
  });

  it("ignores non-harness keys in agent object entries", () => {
    const yaml = `
name: test
harnesses: [claude]
agents:
  - source: ./agents/architect.md
    claude:
      model: sonnet
    some_random_key:
      foo: bar
`;
    const result = parseManifestYaml(yaml);
    const agent = result.agents[0];
    // Only valid harness names become overrides
    expect(agent.overrides.size).toBe(1);
    expect(agent.overrides.has("claude")).toBe(true);
  });

  it("defaults agents to empty array when not provided", () => {
    const yaml = `
name: test
harnesses: [claude]
`;
    const result = parseManifestYaml(yaml);
    expect(result.agents).toEqual([]);
  });

  it("detects conflict between universal and harness-specific agent", () => {
    const yaml = `
name: test
harnesses:
  claude:
    agents:
      - ./claude-agents/architect.md
agents:
  - ./agents/architect.md
`;
    expect(() => parseManifestYaml(yaml)).toThrow(ManifestParseError);
    expect(() => parseManifestYaml(yaml)).toThrow(/Conflict/);
  });

  it("does not conflict when basenames are different", () => {
    const yaml = `
name: test
harnesses:
  claude:
    agents:
      - ./claude-agents/reviewer.md
agents:
  - ./agents/architect.md
`;
    const result = parseManifestYaml(yaml);
    expect(result.agents).toHaveLength(1);
    expect(result.harnesses.get("claude")?.agents).toEqual(["./claude-agents/reviewer.md"]);
  });

  it("detects conflict even when paths differ but basenames match", () => {
    const yaml = `
name: test
harnesses:
  pi:
    agents:
      - ./pi/special/architect.md
agents:
  - ./universal/architect.md
`;
    expect(() => parseManifestYaml(yaml)).toThrow(/Conflict/);
    expect(() => parseManifestYaml(yaml)).toThrow(/architect\.md/);
  });
});

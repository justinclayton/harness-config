import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { claude } from "../src/harnesses/claude.ts";
import { opencode } from "../src/harnesses/opencode.ts";
import { copilot } from "../src/harnesses/copilot.ts";
import { pi } from "../src/harnesses/pi.ts";
import { bob } from "../src/harnesses/bob.ts";
import { isHarnessDetected, isBinaryInstalled, clearDetectionCache } from "../src/harnesses/index.ts";
import type { McpDef } from "../src/manifest/schema.ts";

describe("harness MCP translation", () => {
  const stdioMcp: McpDef = {
    stdio: "npx -y @anthropic/mcp-fetch",
    env: ["HTTP_PROXY"],
  };

  const httpMcp: McpDef = {
    url: "https://api.githubcopilot.com/mcp/",
    auth: "env:GH_TOKEN",
  };

  const httpMcpWithHeaders: McpDef = {
    url: "https://api.example.com/mcp/",
    auth: "env:TOKEN",
    headers: { "X-Tenant-ID": "env:MY_TENANT" },
  };

  describe("Claude Code", () => {
    it("translates stdio MCP", () => {
      const result = claude.translateMcp("fetch", stdioMcp);
      expect(result).toEqual({
        command: "npx",
        args: ["-y", "@anthropic/mcp-fetch"],
        env: { HTTP_PROXY: "${env:HTTP_PROXY}" },
      });
    });

    it("translates HTTP MCP with auth", () => {
      const result = claude.translateMcp("github", httpMcp);
      expect(result).toEqual({
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${env:GH_TOKEN}" },
      });
    });

    it("translates HTTP MCP with headers", () => {
      const result = claude.translateMcp("custom", httpMcpWithHeaders);
      expect(result).toEqual({
        url: "https://api.example.com/mcp/",
        headers: {
          Authorization: "Bearer ${env:TOKEN}",
          "X-Tenant-ID": "${env:MY_TENANT}",
        },
      });
    });

    it("uses wrapper path when provided", () => {
      const result = claude.translateMcp("fetch", stdioMcp, "/home/user/.harness-config/wrappers/fetch.sh");
      expect(result).toEqual({
        command: "/home/user/.harness-config/wrappers/fetch.sh",
        args: [],
        env: { HTTP_PROXY: "${env:HTTP_PROXY}" },
      });
    });
  });

  describe("OpenCode", () => {
    it("translates stdio MCP with type:local and command array", () => {
      const result = opencode.translateMcp("fetch", stdioMcp);
      expect(result).toEqual({
        type: "local",
        command: ["npx", "-y", "@anthropic/mcp-fetch"],
        environment: { HTTP_PROXY: "{env:HTTP_PROXY}" },
      });
    });

    it("translates HTTP MCP with type:remote", () => {
      const result = opencode.translateMcp("github", httpMcp);
      expect(result).toEqual({
        type: "remote",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer {env:GH_TOKEN}" },
      });
    });
  });

  describe("GitHub Copilot", () => {
    it("translates stdio MCP with type:stdio", () => {
      const result = copilot.translateMcp("fetch", stdioMcp);
      expect(result).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@anthropic/mcp-fetch"],
        env: { HTTP_PROXY: "${env:HTTP_PROXY}" },
      });
    });

    it("translates HTTP MCP with type:http", () => {
      const result = copilot.translateMcp("github", httpMcp);
      expect(result).toEqual({
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${env:GH_TOKEN}" },
      });
    });
  });

  describe("Pi", () => {
    it("translates stdio MCP same as Claude", () => {
      const result = pi.translateMcp("fetch", stdioMcp);
      expect(result).toEqual({
        command: "npx",
        args: ["-y", "@anthropic/mcp-fetch"],
        env: { HTTP_PROXY: "${env:HTTP_PROXY}" },
      });
    });

    it("translates HTTP MCP same as Claude", () => {
      const result = pi.translateMcp("github", httpMcp);
      expect(result).toEqual({
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${env:GH_TOKEN}" },
      });
    });

    it("uses wrapper path when provided", () => {
      const result = pi.translateMcp("fetch", stdioMcp, "/home/user/.harness-config/wrappers/fetch.sh");
      expect(result).toEqual({
        command: "/home/user/.harness-config/wrappers/fetch.sh",
        args: [],
        env: { HTTP_PROXY: "${env:HTTP_PROXY}" },
      });
    });
  });

  describe("IBM Bob", () => {
    it("translates stdio MCP with command/args", () => {
      const result = bob.translateMcp("fetch", { stdio: stdioMcp.stdio });
      expect(result).toEqual({
        command: "npx",
        args: ["-y", "@anthropic/mcp-fetch"],
      });
    });

    it("translates HTTP MCP with type:streamable-http", () => {
      const result = bob.translateMcp("github", {
        url: "https://api.githubcopilot.com/mcp/",
        auth: "literal-token",
      });
      expect(result).toEqual({
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer literal-token" },
      });
    });

    it("translates legacy SSE without a type discriminator", () => {
      expect(bob.translateMcp("legacy", {
        url: "https://api.example.com/events",
        transport: "sse",
      })).toEqual({ url: "https://api.example.com/events" });
    });

    it("rejects undocumented header interpolation", () => {
      expect(() => bob.translateMcp("github", httpMcp)).toThrow(/does not document/);
    });

    it("uses wrapper path when provided", () => {
      const result = bob.translateMcp("fetch", {
        stdio: stdioMcp.stdio,
        env: [{ TOKEN: "keychain:token" }],
      }, "/home/user/.harness-config/wrappers/fetch.sh");
      expect(result).toEqual({
        command: "/home/user/.harness-config/wrappers/fetch.sh",
        args: [],
      });
    });
  });
});

describe("harness config paths", () => {
  it("Claude project MCP path is .mcp.json", () => {
    expect(claude.mcpConfigPath("project")).toBe(".mcp.json");
  });

  it("OpenCode project MCP path is opencode.json", () => {
    expect(opencode.mcpConfigPath("project")).toBe("opencode.json");
  });

  it("Copilot project MCP path is .github/copilot/mcp.json", () => {
    expect(copilot.mcpConfigPath("project")).toContain(".github");
    expect(copilot.mcpConfigPath("project")).toContain("mcp.json");
  });

  it("Pi project MCP path is .mcp.json", () => {
    expect(pi.mcpConfigPath("project")).toBe(".mcp.json");
  });

  it("Pi supports agents", () => {
    expect(pi.agentDir("project")).toBe(".agents/skills");
    expect(pi.supportsAgents).toBe(true);
  });

  it("Pi skill dir is .pi/skills", () => {
    expect(pi.skillDir("project")).toContain(".pi");
    expect(pi.skillDir("project")).toContain("skills");
  });

  it("Bob project MCP path is .bob/mcp.json", () => {
    expect(bob.mcpConfigPath("project")).toContain(".bob");
    expect(bob.mcpConfigPath("project")).toContain("mcp.json");
  });

  it("Bob IDE global MCP path is ~/.bob/settings/mcp.json", () => {
    expect(bob.mcpConfigPath("global")).toMatch(/\.bob\/settings\/mcp\.json$/);
  });

  it("Bob supports agents through custom modes", () => {
    expect(bob.agentDir("project")).toBeNull();
    expect(bob.agentConfigPath?.("project")).toBe(".bob/custom_modes.yaml");
    expect(bob.agentConfigPath?.("global")).toMatch(/\.bob\/settings\/custom_modes\.yaml$/);
    expect(bob.supportsAgents).toBe(true);
  });

  it("Bob skill dir is .bob/skills", () => {
    expect(bob.skillDir("project")).toContain(".bob");
    expect(bob.skillDir("project")).toContain("skills");
  });
});

describe("harness detection", () => {
  beforeEach(() => {
    clearDetectionCache();
  });

  afterEach(() => {
    clearDetectionCache();
    vi.restoreAllMocks();
  });

  describe("binaryNames configuration", () => {
    it("Claude checks for 'claude' binary", () => {
      expect(claude.binaryNames).toEqual(["claude"]);
    });

    it("Pi checks for 'pi' binary", () => {
      expect(pi.binaryNames).toEqual(["pi"]);
    });

    it("OpenCode checks for 'opencode' binary", () => {
      expect(opencode.binaryNames).toEqual(["opencode"]);
    });

    it("Copilot checks for 'copilot' OR 'code' binary", () => {
      expect(copilot.binaryNames).toEqual(["copilot", "code"]);
    });

    it("Bob checks for the IDE binary", () => {
      expect(bob.binaryNames).toEqual(["bobide"]);
    });
  });

  describe("isBinaryInstalled", () => {
    it("returns true for a binary that exists (node)", () => {
      // 'node' is guaranteed to be available in test environment
      expect(isBinaryInstalled("node")).toBe(true);
    });

    it("returns false for a binary that does not exist", () => {
      expect(isBinaryInstalled("__nonexistent_binary_xyz__")).toBe(false);
    });

    it("caches results across calls", () => {
      const result1 = isBinaryInstalled("node");
      const result2 = isBinaryInstalled("node");
      expect(result1).toBe(result2);
    });

    it("cache is cleared by clearDetectionCache", () => {
      isBinaryInstalled("node");
      clearDetectionCache();
      // After clearing, it should still work (just re-executes)
      expect(isBinaryInstalled("node")).toBe(true);
    });
  });

  describe("isHarnessDetected", () => {
    it("returns true if any binaryName is found", () => {
      // Create a mock adapter with 'node' as a binary (always available)
      const mockAdapter = { ...claude, binaryNames: ["__missing__", "node"] };
      expect(isHarnessDetected(mockAdapter)).toBe(true);
    });

    it("returns false if no binaryNames are found", () => {
      const mockAdapter = { ...claude, binaryNames: ["__missing_a__", "__missing_b__"] };
      expect(isHarnessDetected(mockAdapter)).toBe(false);
    });

    it("is not scope-aware (no scope/cwd parameters)", () => {
      // The function signature only takes an adapter — verify it works
      // without scope or cwd arguments
      const mockAdapter = { ...claude, binaryNames: ["node"] };
      expect(isHarnessDetected(mockAdapter)).toBe(true);
    });
  });
});

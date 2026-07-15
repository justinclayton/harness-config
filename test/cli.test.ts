import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseArgs, buildHarnessPickerOptions, computeCiHarnessTargets } from "../src/cli.ts";
import { clearDetectionCache, seedDetectionCache } from "../src/harnesses/index.ts";
import { harnessNames } from "../src/manifest/schema.ts";
import { bob } from "../src/harnesses/bob.ts";

describe("CLI argument parsing", () => {
  function argv(...args: string[]): string[] {
    return ["node", "harness-config", ...args];
  }

  it("parses add command", () => {
    const result = parseArgs(argv("add"));
    expect(result.command).toBe("add");
  });

  it("parses rm command", () => {
    const result = parseArgs(argv("rm"));
    expect(result.command).toBe("rm");
  });

  it("parses manifest path", () => {
    const result = parseArgs(argv("add", "./my-config.yaml"));
    expect(result.command).toBe("add");
    expect(result.manifestPath).toBe("./my-config.yaml");
  });

  it("parses --harness flag (single)", () => {
    const result = parseArgs(argv("add", "--harness", "claude"));
    expect(result.harnesses).toEqual(["claude"]);
  });

  it("parses --harness flag (multiple)", () => {
    const result = parseArgs(argv("add", "--harness", "claude", "--harness", "opencode"));
    expect(result.harnesses).toEqual(["claude", "opencode"]);
  });

  it("parses --global flag", () => {
    const result = parseArgs(argv("add", "--global"));
    expect(result.global).toBe(true);
  });

  it("parses -g shorthand", () => {
    const result = parseArgs(argv("add", "-g"));
    expect(result.global).toBe(true);
  });

  it("parses --yes flag", () => {
    const result = parseArgs(argv("add", "--yes"));
    expect(result.yes).toBe(true);
  });

  it("parses -y shorthand", () => {
    const result = parseArgs(argv("add", "-y"));
    expect(result.yes).toBe(true);
  });

  it("parses --help", () => {
    const result = parseArgs(argv("--help"));
    expect(result.command).toBe("help");
  });

  it("parses -h", () => {
    const result = parseArgs(argv("-h"));
    expect(result.command).toBe("help");
  });

  it("parses --version", () => {
    const result = parseArgs(argv("--version"));
    expect(result.command).toBe("version");
  });

  it("parses -v", () => {
    const result = parseArgs(argv("-v"));
    expect(result.command).toBe("version");
  });

  it("throws on invalid harness name", () => {
    expect(() => parseArgs(argv("add", "--harness", "invalid"))).toThrow(/Invalid harness/);
  });

  it("throws on unknown flag", () => {
    expect(() => parseArgs(argv("add", "--unknown"))).toThrow(/Unknown flag/);
  });

  it("parses complex combined command", () => {
    const result = parseArgs(argv(
      "add", "./config.yaml",
      "--harness", "claude",
      "--harness", "opencode",
      "--global",
      "--yes",
    ));
    expect(result.command).toBe("add");
    expect(result.manifestPath).toBe("./config.yaml");
    expect(result.harnesses).toEqual(["claude", "opencode"]);
    expect(result.global).toBe(true);
    expect(result.yes).toBe(true);
  });
});

describe("Harness picker options", () => {
  beforeEach(() => {
    clearDetectionCache();
  });

  afterEach(() => {
    clearDetectionCache();
  });

  function mockDetection(installedBinaries: string[]) {
    // Seed cache so that listed binaries are "found" and all others are not
    const allBinaries = ["claude", "pi", "opencode", "copilot", "code", "bobide"];
    const entries: Record<string, boolean> = {};
    for (const bin of allBinaries) {
      entries[bin] = installedBinaries.includes(bin);
    }
    for (const path of bob.detectionPaths ?? []) entries[`path:${path}`] = false;
    seedDetectionCache(entries);
  }

  describe("buildHarnessPickerOptions", () => {
    it("shows ALL known harnesses regardless of what's declared", () => {
      mockDetection([]);
      const options = buildHarnessPickerOptions(["claude"]);
      expect(options).toHaveLength(harnessNames.length);
      expect(options.map(o => o.value)).toEqual([...harnessNames]);
    });

    it("marks declared harnesses as supported with no hint", () => {
      mockDetection([]);
      const options = buildHarnessPickerOptions(["claude", "pi"]);
      const claude = options.find(o => o.value === "claude")!;
      const pi = options.find(o => o.value === "pi")!;
      expect(claude.supported).toBe(true);
      expect(claude.hint).toBeUndefined();
      expect(pi.supported).toBe(true);
      expect(pi.hint).toBeUndefined();
    });

    it("marks undeclared harnesses as unsupported with hint", () => {
      mockDetection([]);
      const options = buildHarnessPickerOptions(["claude"]);
      const opencode = options.find(o => o.value === "opencode")!;
      const copilot = options.find(o => o.value === "copilot")!;
      expect(opencode.supported).toBe(false);
      expect(opencode.hint).toBe("unsupported");
      expect(copilot.supported).toBe(false);
      expect(copilot.hint).toBe("unsupported");
    });

    it("marks detected harnesses with detected=true", () => {
      mockDetection(["claude", "pi"]);
      const options = buildHarnessPickerOptions(["claude"]);
      const claude = options.find(o => o.value === "claude")!;
      const pi = options.find(o => o.value === "pi")!;
      const opencode = options.find(o => o.value === "opencode")!;
      expect(claude.detected).toBe(true);
      expect(pi.detected).toBe(true);
      expect(opencode.detected).toBe(false);
    });

    it("uses pc.dim on undetected harness labels (distinguishable in TTY)", () => {
      mockDetection(["claude"]);
      const options = buildHarnessPickerOptions(["claude", "pi"]);
      const claude = options.find(o => o.value === "claude")!;
      const pi = options.find(o => o.value === "pi")!;
      // Claude is detected — label should be the plain display name
      expect(claude.label).toBe("Claude Code");
      expect(claude.detected).toBe(true);
      // Pi is NOT detected — detected flag should be false
      // In a TTY, pc.dim() adds ANSI codes; in tests (non-TTY) it may not
      expect(pi.detected).toBe(false);
      expect(pi.label).toContain("Pi");
    });
  });

  describe("computeCiHarnessTargets", () => {
    it("returns supported ∩ detected when some are detected", () => {
      mockDetection(["claude"]);
      const result = computeCiHarnessTargets(["claude", "pi"]);
      expect(result.harnesses).toEqual(["claude"]);
      expect(result.fellBack).toBe(false);
    });

    it("falls back to all supported when none are detected", () => {
      mockDetection([]);
      const result = computeCiHarnessTargets(["claude", "pi"]);
      expect(result.harnesses).toEqual(["claude", "pi"]);
      expect(result.fellBack).toBe(true);
    });

    it("only includes supported harnesses even if others are detected", () => {
      mockDetection(["claude", "opencode"]);
      const result = computeCiHarnessTargets(["claude"]);
      expect(result.harnesses).toEqual(["claude"]);
      expect(result.fellBack).toBe(false);
    });
  });
});

import * as p from "@clack/prompts";
import pc from "picocolors";
import { basename } from "node:path";
import { homedir } from "node:os";
import { parseManifestFile, getDefaultManifestPath, ManifestParseError } from "./manifest/parse.ts";
import { harnessNames, type HarnessName, type NormalizedManifest } from "./manifest/schema.ts";
import { discoverManifestsInDir, discoverManifestsInGitHub, isDirectory, isGitHubDirUrl, type DiscoveredManifest } from "./manifest/discover.ts";
import { executeAdd, executeRm, type EngineOptions, type EngineResult, type ProgressEvent } from "./engine.ts";
import { getHarness, isHarnessDetected, type Scope } from "./harnesses/index.ts";
import { isUrl } from "./util/fetch.ts";
import { buildPlan, summarizePlan, type HarnessPlan, type PlanItem } from "./plan.ts";
import { validateKeychainRefsStructured, type MissingKeychainItem } from "./keychain/resolve.ts";
import { buildComponentTreeOptions, countManifestComponents, filterManifest } from "./filter.ts";

/**
 * Replace the user's home directory with ~ in displayed paths.
 */
function shortenPath(filepath: string): string {
  const home = homedir();
  if (filepath.startsWith(home)) {
    return "~" + filepath.slice(home.length);
  }
  return filepath;
}

const VERSION = "0.1.0";

interface ParsedArgs {
  command: "add" | "rm" | "help" | "version";
  manifestPath?: string;
  harnesses: HarnessName[];
  allHarnesses: boolean;
  global: boolean;
  yes: boolean;
  skipKeychainCheck: boolean;
}

/**
 * Parse CLI arguments into structured form.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // Remove node and script path
  const result: ParsedArgs = {
    command: "help",
    harnesses: [],
    allHarnesses: false,
    global: false,
    yes: false,
    skipKeychainCheck: false,
  };

  let i = 0;

  // First non-flag arg is the command
  if (args.length > 0 && !args[0].startsWith("-")) {
    const cmd = args[0];
    if (cmd === "add" || cmd === "rm") {
      result.command = cmd;
      i = 1;
    } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
      result.command = "help";
      return result;
    } else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
      result.command = "version";
      return result;
    }
  }

  // Parse remaining args
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.command = "help";
      return result;
    }
    if (arg === "--version" || arg === "-v") {
      result.command = "version";
      return result;
    }
    if (arg === "--global" || arg === "-g") {
      result.global = true;
    } else if (arg === "--yes" || arg === "-y") {
      result.yes = true;
    } else if (arg === "--skip-keychain-check") {
      result.skipKeychainCheck = true;
    } else if (arg === "--harness") {
      i++;
      const value = args[i];
      if (value === "all") {
        result.allHarnesses = true;
      } else if (value && harnessNames.includes(value as HarnessName)) {
        result.harnesses.push(value as HarnessName);
      } else {
        throw new Error(
          `Invalid harness: "${value}". Valid: all, ${harnessNames.join(", ")}`,
        );
      }
    } else if (!arg.startsWith("-")) {
      // Positional arg after command = manifest path
      result.manifestPath = arg;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }

    i++;
  }

  return result;
}

export interface HarnessPickerOption {
  value: HarnessName;
  label: string;
  hint: string | undefined;
  detected: boolean;
  supported: boolean;
}

/**
 * Build the harness picker options showing ALL known harnesses with annotations.
 * Exported for testability.
 */
export function buildHarnessPickerOptions(declaredHarnesses: HarnessName[]): HarnessPickerOption[] {
  return harnessNames.map((name) => {
    const adapter = getHarness(name);
    const detected = isHarnessDetected(adapter);
    const supported = declaredHarnesses.includes(name);
    // Dim label for undetected harnesses
    const label = detected ? adapter.displayName : pc.dim(adapter.displayName);
    // Show (unsupported) hint for harnesses not declared in the manifest
    const hint = supported ? undefined : "unsupported";
    return {
      value: name,
      label,
      hint,
      detected,
      supported,
    };
  });
}

/**
 * Compute the default harness targets for --yes (CI) mode.
 * Returns supported ∩ detected, or falls back to all supported if none detected.
 * Exported for testability.
 */
export function computeCiHarnessTargets(declaredHarnesses: HarnessName[]): { harnesses: HarnessName[]; fellBack: boolean } {
  const supportedAndDetected = declaredHarnesses.filter((name) => {
    const adapter = getHarness(name);
    return isHarnessDetected(adapter);
  });
  if (supportedAndDetected.length > 0) {
    return { harnesses: supportedAndDetected, fellBack: false };
  }
  return { harnesses: declaredHarnesses, fellBack: true };
}

/**
 * Interactive harness picker — shows ALL known harnesses with detection + support annotations.
 * Pre-selects harnesses that are both supported (declared in manifest) AND detected (binary installed).
 */
async function selectHarnesses(declaredHarnesses: HarnessName[], command: "add" | "rm"): Promise<HarnessName[]> {
  const options = buildHarnessPickerOptions(declaredHarnesses);

  // Pre-select only harnesses that are BOTH supported AND detected
  const initialValues = options
    .filter((o) => o.detected && o.supported)
    .map((o) => o.value);

  const message = command === "add"
    ? "Which harnesses should we install to?"
    : "Which harnesses should we remove from?";

  const hint = pc.dim(`  space`) + pc.dim(" = toggle, ") + pc.dim(`enter`) + pc.dim(" = confirm");

  const selected = await p.multiselect({
    message: `${message}\n${hint}`,
    options,
    initialValues,
    required: true,
  });

  if (p.isCancel(selected)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  return selected as HarnessName[];
}

/**
 * Manifest picker — lets user choose which manifest to use when a directory contains multiple.
 */
async function selectManifest(manifests: DiscoveredManifest[]): Promise<string> {
  const options = manifests.map((m) => ({
    value: m.path,
    label: m.name,
    hint: m.description,
  }));

  const selected = await p.select({
    message: "Which manifest?",
    options,
  });

  if (p.isCancel(selected)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  return selected as string;
}

/**
 * Display manifest identity and components (shown before harness picker for context).
 */
function displayManifestInfo(manifest: NormalizedManifest): void {
  // Title with visual weight — name and description on one line
  const title = manifest.name === "__ephemeral__" ? "Direct operation" : manifest.name;
  const titleLine = manifest.description
    ? `${pc.bold(pc.cyan(title))}: ${pc.dim(manifest.description)}`
    : pc.bold(pc.cyan(title));
  p.log.message(titleLine);
}

/**
 * Display a Terraform-style execution plan for each harness.
 */
function displayPlan(plans: HarnessPlan[]): void {
  for (const plan of plans) {
    const detectedHint = plan.detected ? pc.green(" \u2713 detected") : pc.dim(" (new)");
    const { toAdd, toRemove, toUpdate, noops, notFound } = summarizePlan(plan.items);

    // Summary line
    const summaryParts: string[] = [];
    if (toAdd > 0) summaryParts.push(pc.green(`${toAdd} to add`));
    if (toRemove > 0) summaryParts.push(pc.red(`${toRemove} to remove`));
    if (toUpdate > 0) summaryParts.push(pc.yellow(`${toUpdate} to update`));
    if (notFound > 0) summaryParts.push(pc.dim(`${notFound} not found`));
    else if (noops > 0) summaryParts.push(pc.dim(`${noops} unchanged`));

    // Header: harness name + detection + plan summary
    p.log.info(
      `${pc.bold(plan.displayName)}${detectedHint}\n` +
      summaryParts.join(", "),
    );

    // Item-by-item plan lines
    const lines = plan.items.map((item) => formatPlanItem(item));
    if (lines.length > 0) {
      p.log.message(lines.join("\n"));
    }
  }
}

/**
 * Format a single plan item as a line with prefix indicator.
 */
function formatPlanItem(item: PlanItem): string {
  const label = `${item.type} ${pc.bold(`"${item.name}"`)}`;
  const dest = shortenPath(item.destination);
  const overrideHint = item.overrideKeys && item.overrideKeys.length > 0
    ? `  ${pc.dim(`(+ ${item.overrideKeys.join(", ")})`)}`
    : "";

  switch (item.action) {
    case "add":
      return `  ${pc.green("+")} ${label}  ${pc.dim("\u2192")} ${pc.dim(dest)}${overrideHint}`;
    case "remove":
      return `  ${pc.red("-")} ${label}  ${pc.dim("\u2192")} ${pc.dim(dest)}`;
    case "update":
      return `  ${pc.yellow("~")} ${label}  ${pc.dim("\u2192")} ${pc.dim(dest)}${overrideHint}`;
    case "noop":
      return `  ${pc.dim("\u25cb")} ${label}  ${pc.dim(item.reason ?? "no-op")}`;
  }
}

/**
 * Display keychain warnings with actionable fix instructions.
 * Returns true if there are missing items.
 */
function displayKeychainWarnings(missing: MissingKeychainItem[], platformWarning?: string): boolean {
  if (platformWarning) {
    p.log.warn(platformWarning);
    return false; // Platform issue, not actionable missing items
  }

  if (missing.length === 0) return false;

  // Group by MCP name for cleaner display
  const byMcp = new Map<string, MissingKeychainItem[]>();
  for (const item of missing) {
    const existing = byMcp.get(item.mcpName) ?? [];
    existing.push(item);
    byMcp.set(item.mcpName, existing);
  }

  const lines: string[] = [];
  for (const [mcpName, items] of byMcp) {
    lines.push(`  MCP ${pc.bold(`"${mcpName}"`)} requires keychain secrets that aren't set up yet:`);
    for (const item of items) {
      lines.push(`    ${pc.dim(item.context)} ${pc.dim("\u2192")} keychain item ${pc.yellow(`"${item.service}"`)}`);
    }
  }

  lines.push("");
  lines.push(`  ${pc.dim("To add a secret to macOS Keychain:")}`);
  const uniqueServices = [...new Set(missing.map((item) => item.service))];
  for (const service of uniqueServices) {
    lines.push(`    ${pc.cyan(`security add-generic-password -s "${service}" -a "<username>" -w "<secret>"`)}`);
  }
  p.log.warn(`Missing keychain secrets\n\n${lines.join("\n")}`);
  return true;
}

/**
 * Build a confirmation message from the plan.
 */
function buildConfirmFromPlan(plans: HarnessPlan[], _command: "add" | "rm"): string {
  let totalActions = 0;
  for (const plan of plans) {
    const { toAdd, toRemove, toUpdate } = summarizePlan(plan.items);
    totalActions += toAdd + toRemove + toUpdate;
  }

  if (totalActions === 0) {
    return "Nothing to do. Continue?";
  }

  const harnessLabel = plans.map((pl) => pl.displayName).join(", ");
  return `Apply plan to ${harnessLabel}?`;
}

/**
 * Display compact results after execution.
 * Only shows warnings for truly unexpected issues; the plan already provided detail.
 */
function displayResults(result: EngineResult): void {
  for (const warning of result.warnings) {
    p.log.warn(warning);
  }
}

/**
 * Format a progress event as a line for real-time display.
 */
function formatProgressEvent(event: ProgressEvent): string {
  const label = `${event.type} ${pc.bold(`"${event.name}"`)}`;
  const dest = shortenPath(event.path);

  switch (event.action) {
    case "added":
      return `  ${pc.green("✓")} ${pc.green("added")} ${label}  ${pc.dim("→")} ${pc.dim(dest)}`;
    case "updated":
      return `  ${pc.yellow("✓")} ${pc.yellow("updated")} ${label}  ${pc.dim("→")} ${pc.dim(dest)}`;
    case "removed":
      return `  ${pc.red("✓")} ${pc.red("removed")} ${label}  ${pc.dim("→")} ${pc.dim(dest)}`;
    case "unchanged":
      return `  ${pc.dim("○")} ${pc.dim("unchanged")} ${label}`;
    case "skipped":
      return `  ${pc.dim("○")} ${pc.dim("skipped")} ${label}`;
  }
}

/**
 * Print help text.
 */
function printHelp(): void {
  console.log(`
${pc.bold("harness-config")} \u2014 Declare your AI coding setup once, install it to any harness.

${pc.bold("Usage:")}
  harness-config add [manifest-path] [options]
  harness-config rm [manifest-path] [options]

${pc.bold("Commands:")}
  add     Install components from manifest
  rm      Remove components declared in manifest

${pc.bold("Options:")}
  --harness <name>          Target harness (repeatable: claude, opencode, copilot, pi, bob, all)
  --global, -g              Write to global (home directory) configs instead of project
  --yes, -y                 Skip confirmation prompts (CI-friendly)
  --skip-keychain-check     Skip keychain secret validation
  --help, -h                Show this help
  --version, -v             Show version
`);
}

/**
 * Main CLI entry point.
 */
export async function main(): Promise<void> {
  let args: ParsedArgs;

  try {
    args = parseArgs(process.argv);
  } catch (err: any) {
    p.log.error(err.message);
    process.exit(1);
  }

  if (args.command === "help") {
    printHelp();
    return;
  }

  if (args.command === "version") {
    console.log(VERSION);
    return;
  }

  const scope: Scope = args.global ? "global" : "project";
  const scopeSuffix = args.global ? pc.dim(" \u2500\u2500 global") : "";
  p.intro(pc.bgCyan(pc.black(` harness-config ${args.command} `)) + scopeSuffix);

  try {
    // Resolve manifest path — may involve discovery if a directory/repo is given
    let manifest: NormalizedManifest;
    let manifestPath = args.manifestPath ?? getDefaultManifestPath();

    // Check if the path is a directory (local or GitHub) — discover manifests
    const isDir = isUrl(manifestPath) ? isGitHubDirUrl(manifestPath) : await isDirectory(manifestPath);

    if (isDir) {
      const spinner = p.spinner();
      if (isUrl(manifestPath)) spinner.start("Discovering manifests");

      const discovered = isUrl(manifestPath)
        ? await discoverManifestsInGitHub(manifestPath)
        : await discoverManifestsInDir(manifestPath);

      if (isUrl(manifestPath)) spinner.stop(`Found ${discovered.length} manifest${discovered.length !== 1 ? "s" : ""}`);

      if (discovered.length === 0) {
        throw new ManifestParseError(`No valid manifests found in: ${shortenPath(manifestPath)}`);
      }

      if (discovered.length === 1) {
        // Only one manifest — use it directly
        p.log.step(`Discovered 1 manifest in ${pc.dim(shortenPath(manifestPath))}`);
        manifestPath = discovered[0].path;
      } else {
        // Multiple manifests — present picker
        p.log.step(`Discovered ${discovered.length} manifests in ${pc.dim(shortenPath(manifestPath))}`);
        manifestPath = await selectManifest(discovered);
      }
    }

    // Load the manifest — show spinner for URL fetches
    if (isUrl(manifestPath)) {
      const spinner = p.spinner();
      spinner.start("Fetching manifest");
      try {
        manifest = await parseManifestFile(manifestPath);
      } catch (err) {
        spinner.stop("Failed to fetch manifest");
        throw err;
      }
      spinner.stop("Manifest fetched");
    } else {
      manifest = await parseManifestFile(manifestPath);
    }

    // Show manifest identity + components first (gives context for harness picker)
    displayManifestInfo(manifest);

    // Determine target harnesses
    let targetHarnesses: HarnessName[] | undefined;
    const declaredHarnesses = Array.from(manifest.harnesses.keys());

    if (args.allHarnesses) {
      // --harness all — use all harnesses declared in the manifest
      targetHarnesses = declaredHarnesses;
    } else if (args.harnesses.length > 0) {
      // Explicit --harness flags — use those
      targetHarnesses = args.harnesses;
    } else if (!args.yes) {
      // Interactive mode — always show harness picker
      const selected = await selectHarnesses(declaredHarnesses, args.command);
      targetHarnesses = selected;
    } else {
      // --yes with no --harness → default to supported ∩ detected, fallback to all supported
      const { harnesses: ciTargets, fellBack } = computeCiHarnessTargets(declaredHarnesses);
      if (fellBack) {
        p.log.warn("No supported harnesses detected on this machine. Targeting all supported harnesses.");
      }
      targetHarnesses = ciTargets;
    }

    // Warn about unsupported harnesses immediately after selection
    const unsupportedSelected = (targetHarnesses ?? []).filter((h) => !declaredHarnesses.includes(h));
    for (const name of unsupportedSelected) {
      const verb = args.command === "add" ? "installed to" : "removed from";
      p.log.warn(`Harness "${name}" is not declared in this manifest -- only universal components will be ${verb} ${name}.`);
    }

    // Resolve final harness list for display
    const finalHarnesses = targetHarnesses ?? Array.from(manifest.harnesses.keys());

    // Component tree picker — let user select subset of components
    let activeManifest = manifest;
    if (!args.yes && countManifestComponents(manifest) > 1) {
      const { options: treeOptions, initialValues } = buildComponentTreeOptions(
        manifest,
        finalHarnesses,
        declaredHarnesses,
      );

      // Only show tree if there are options to select from
      if (Object.keys(treeOptions).length > 0) {
        const hint = pc.dim(`  space`) + pc.dim(" = toggle, ") + pc.dim(`enter`) + pc.dim(" = confirm");
        const selected = await p.groupMultiselect({
          message: `Select components to install\n${hint}`,
          options: treeOptions,
          initialValues,
          required: true,
          selectableGroups: true,
        });

        if (p.isCancel(selected)) {
          p.cancel("Operation cancelled.");
          process.exit(0);
        }

        const selectedKeys = selected as string[];
        // Only filter if user deselected something
        if (selectedKeys.length < initialValues.length || !initialValues.every((v) => selectedKeys.includes(v))) {
          activeManifest = filterManifest(manifest, selectedKeys);
        }
      }
    }

    // Build and display execution plan
    const plans = await buildPlan(activeManifest, args.command, finalHarnesses, scope, process.cwd());
    displayPlan(plans);

    // Validate keychain references (before confirmation)
    let hasMissingKeychain = false;
    if (args.command === "add" && !args.skipKeychainCheck && Object.keys(activeManifest.mcps).length > 0) {
      const { missing, platformWarning } = await validateKeychainRefsStructured(activeManifest.mcps);
      hasMissingKeychain = displayKeychainWarnings(missing, platformWarning);

      // In --yes (CI) mode, fail if keychain items are missing
      if (hasMissingKeychain && args.yes) {
        p.log.error("Missing keychain secrets in non-interactive mode. Use --skip-keychain-check to proceed anyway.");
        process.exit(1);
      }
    }

    // Check if there's anything to do
    const totalActions = plans.reduce((sum, plan) => {
      const { toAdd, toRemove, toUpdate } = summarizePlan(plan.items);
      return sum + toAdd + toRemove + toUpdate;
    }, 0);

    if (totalActions === 0) {
      p.outro(pc.dim("Nothing to do — already in desired state."));
      return;
    }

    // Confirm unless --yes
    if (!args.yes) {
      const confirmed = await p.confirm({
        message: buildConfirmFromPlan(plans, args.command),
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }
    }

    // Execute
    const progressLines: string[] = [];
    const onProgress = (event: ProgressEvent) => {
      if (event.action !== "unchanged" && event.action !== "skipped") {
        progressLines.push(formatProgressEvent(event));
      }
    };

    const options: EngineOptions = {
      harnesses: targetHarnesses,
      scope,
      cwd: process.cwd(),
      onProgress,
    };

    const result =
      args.command === "add"
        ? await executeAdd(activeManifest, options)
        : await executeRm(activeManifest, options);

    // Display execution log
    if (progressLines.length > 0) {
      p.log.step(progressLines.join("\n"));
    }

    // Display results (only warnings)
    displayResults(result);
    p.outro(pc.green("Done!"));
  } catch (err: any) {
    if (err instanceof ManifestParseError) {
      p.log.error(`Manifest error: ${err.message}`);
      if (err.details) {
        p.log.error(JSON.stringify(err.details, null, 2));
      }
    } else {
      p.log.error(err.message);
    }
    process.exit(1);
  }
}

main();

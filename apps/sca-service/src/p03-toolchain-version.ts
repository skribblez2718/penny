const COMPONENTS = {
  "joern-cli": false,
  php2cpg: true,
  jssrc2cpg: true,
} as const;

export type ScaP03JoernComponentV1 = keyof typeof COMPONENTS;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Parse an exact, bounded Joern package listing from the digest-pinned image.
 * Frontends must have one runtime package and one same-version launcher package;
 * the CLI must have exactly one runtime package. Extra or duplicate matches fail.
 */
export function parseScaP03JoernPackageListingV1(
  output: string,
  component: ScaP03JoernComponentV1
): string {
  if (
    output.length < 1 ||
    output.length > 4096 ||
    output.includes("\u0000") ||
    output.includes("\r")
  )
    throw new Error("p03_joern_package_listing_invalid");
  const lines = output
    .trimEnd()
    .split("\n")
    .map((line) => line.trim());
  if (lines.some((line) => line.length === 0) || new Set(lines).size !== lines.length)
    throw new Error("p03_joern_package_listing_invalid");
  const version = "([0-9]+(?:\\.[0-9]+){1,5})";
  const prefix = `io\\.joern\\.${escapeRegex(component)}-`;
  const main = new RegExp(`^${prefix}${version}\\.jar$`, "u");
  const launcher = new RegExp(`^${prefix}${version}-launcher\\.jar$`, "u");
  const mainMatches = lines.map((line) => line.match(main)).filter((match) => match !== null);
  const launcherMatches = lines
    .map((line) => line.match(launcher))
    .filter((match) => match !== null);
  const launcherRequired = COMPONENTS[component];
  if (
    mainMatches.length !== 1 ||
    launcherMatches.length !== (launcherRequired ? 1 : 0) ||
    lines.length !== (launcherRequired ? 2 : 1) ||
    (launcherRequired && launcherMatches[0]?.[1] !== mainMatches[0]?.[1])
  )
    throw new Error("p03_joern_package_listing_invalid");
  const measured = mainMatches[0]?.[1];
  if (measured === undefined) throw new Error("p03_joern_package_listing_invalid");
  return measured;
}

/** Prove the expected launcher resolves and successfully loads its help entrypoint. */
export function assertScaP03JoernLauncherProbeV1(resolved: string, help: string): void {
  if (
    resolved.trim() !== "/opt/joern/joern-cli/joern" ||
    !help.startsWith("Usage: joern [options] [<cpg.bin>]\n") ||
    help.includes("Unknown option") ||
    help.length > 64 * 1024 ||
    help.includes("\u0000")
  )
    throw new Error("p03_joern_launcher_probe_invalid");
}

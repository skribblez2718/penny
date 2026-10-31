import { describe, expect, it } from "vitest";
import {
  assertScaP03JoernLauncherProbeV1,
  parseScaP03JoernPackageListingV1,
} from "../src/p03-toolchain-version.js";

describe("P03 Joern toolchain version probes", () => {
  it("accepts one exact CLI package and same-version frontend launcher pairs", () => {
    expect(parseScaP03JoernPackageListingV1("io.joern.joern-cli-4.0.627.jar\n", "joern-cli")).toBe(
      "4.0.627"
    );
    expect(
      parseScaP03JoernPackageListingV1(
        "io.joern.php2cpg-4.0.627-launcher.jar\nio.joern.php2cpg-4.0.627.jar\n",
        "php2cpg"
      )
    ).toBe("4.0.627");
    assertScaP03JoernLauncherProbeV1(
      "/opt/joern/joern-cli/joern\n",
      "Usage: joern [options] [<cpg.bin>]\n\nScript execution\n"
    );
  });

  it("rejects duplicate, mismatched, extra, and non-loading package claims", () => {
    expect(() =>
      parseScaP03JoernPackageListingV1(
        "io.joern.joern-cli-4.0.627.jar\nio.joern.joern-cli-9.9.9.jar\n",
        "joern-cli"
      )
    ).toThrow("p03_joern_package_listing_invalid");
    expect(() =>
      parseScaP03JoernPackageListingV1(
        "io.joern.jssrc2cpg-4.0.627.jar\nio.joern.jssrc2cpg-4.0.628-launcher.jar\n",
        "jssrc2cpg"
      )
    ).toThrow("p03_joern_package_listing_invalid");
    expect(() =>
      assertScaP03JoernLauncherProbeV1(
        "/opt/joern/joern-cli/joern\n",
        "Warning: Unknown option --version\n"
      )
    ).toThrow("p03_joern_launcher_probe_invalid");
  });
});

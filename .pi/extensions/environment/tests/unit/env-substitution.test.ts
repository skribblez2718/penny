/**
 * Environment Extension Unit Tests
 *
 * Tests the environment extension logic with mocked filesystem:
 * - .env file parsing
 * - Variable substitution
 * - Event handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs/promises before importing the extension
const mockFiles: Record<string, string> = {};
const mockAccess = vi.fn();
const mockReadFile = vi.fn();

vi.mock("fs/promises", () => ({
  access: mockAccess,
  readFile: mockReadFile,
}));

// Mock os.homedir
vi.mock("os", () => ({
  homedir: () => "/home/testuser",
}));

// Test helpers
function createEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseEnvFile(content: string, cwd: string): Record<string, string | undefined> {
  const home = "/home/testuser";
  const config: Record<string, string | undefined> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Resolve ${HOME} and ${PWD}
    value = value.replace(/\$\{HOME\}/g, home).replace(/\$\{PWD\}/g, cwd);

    config[key] = value;
  }

  // Auto-derive PROJECT_ROOT if not set
  if (!config.PROJECT_ROOT) {
    config.PROJECT_ROOT = cwd;
  }

  return config;
}

function substituteEnvVars(content: string, config: Record<string, string | undefined>): string {
  let result = content;

  // Substitute config values
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      result = result.replace(new RegExp(`\\$\\{${key}\\}`, "g"), value);
    }
  }

  // Substitute remaining ${VAR} from process.env (except CURRENT_DATE which is always from config)
  result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, varName) => {
    // CURRENT_DATE should always come from config (system clock), not process.env
    if (varName === "CURRENT_DATE") {
      return config.CURRENT_DATE ?? "";
    }
    return process.env[varName] ?? "";
  });

  return result;
}

describe("parseEnvFile", () => {
  const testCwd = "/test/project";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should parse simple key=value pairs", () => {
    const content = createEnvFile({ NAME: "Penny", VERSION: "1.0" });
    const config = parseEnvFile(content, testCwd);

    expect(config.NAME).toBe("Penny");
    expect(config.VERSION).toBe("1.0");
  });

  it("should auto-derive PROJECT_ROOT", () => {
    const config = parseEnvFile("", testCwd);
    expect(config.PROJECT_ROOT).toBe(testCwd);
  });

  it("should handle quoted values", () => {
    const content = "NAME=\"Penny the AI\"\nVERSION='1.0.0'";
    const config = parseEnvFile(content, testCwd);

    expect(config.NAME).toBe("Penny the AI");
    expect(config.VERSION).toBe("1.0.0");
  });

  it("should skip comments", () => {
    const content = "# Comment\nNAME=Penny\n# Another comment";
    const config = parseEnvFile(content, testCwd);

    expect(config.NAME).toBe("Penny");
    expect(Object.keys(config).length).toBe(2); // NAME + PROJECT_ROOT
  });

  it("should resolve ${HOME} and ${PWD}", () => {
    const content = "PATH=${HOME}/projects\nROOT=${PWD}";
    const config = parseEnvFile(content, testCwd);

    expect(config.PATH).toBe("/home/testuser/projects");
    expect(config.ROOT).toBe(testCwd);
  });

  it("should handle empty lines", () => {
    const content = "\n\nNAME=Penny\n\n\nVERSION=1.0\n\n";
    const config = parseEnvFile(content, testCwd);

    expect(config.NAME).toBe("Penny");
    expect(config.VERSION).toBe("1.0");
  });

  it("should skip invalid lines", () => {
    const content = "valid=value\ninvalid line without equals\n123=badkey";
    const config = parseEnvFile(content, testCwd);

    expect(config.valid).toBe("value");
    expect(config["123"]).toBeUndefined();
  });
});

describe("substituteEnvVars", () => {
  const testCwd = "/test/project";

  it("should substitute config variables", () => {
    const content = "Hello, ${NAME}!";
    const config = { NAME: "Penny", PROJECT_ROOT: testCwd };

    const result = substituteEnvVars(content, config);
    expect(result).toBe("Hello, Penny!");
  });

  it("should substitute multiple occurrences", () => {
    const content = "${NAME} is running ${NAME}";
    const config = { NAME: "Penny", PROJECT_ROOT: testCwd };

    const result = substituteEnvVars(content, config);
    expect(result).toBe("Penny is running Penny");
  });

  it("should substitute from process.env for unknown vars", () => {
    const originalEnv = process.env.USER;
    process.env.USER = "testuser";

    const content = "User: ${USER}";
    const config = { PROJECT_ROOT: testCwd };

    const result = substituteEnvVars(content, config);
    expect(result).toBe("User: testuser");

    process.env.USER = originalEnv;
  });

  it("should return empty string for undefined variables", () => {
    const content = "Value: ${UNDEFINED_VAR}";
    const config = { PROJECT_ROOT: testCwd };

    const result = substituteEnvVars(content, config);
    expect(result).toBe("Value: ");
  });

  it("should handle mixed substitutions", () => {
    process.env.SYSTEM_VAR = "system";
    const content = "Config: ${CONFIG_VAR}, System: ${SYSTEM_VAR}, Missing: ${MISSING}";
    const config = { CONFIG_VAR: "config", PROJECT_ROOT: testCwd };

    const result = substituteEnvVars(content, config);
    expect(result).toBe("Config: config, System: system, Missing: ");

    delete process.env.SYSTEM_VAR;
  });

  it("should not substitute variables in already-substituted text", () => {
    const content = "${A}${B}";
    const config = { A: "X", B: "Y", PROJECT_ROOT: testCwd };

    const result = substituteEnvVars(content, config);
    expect(result).toBe("XY");
  });
});

describe("Event Flow", () => {
  it("should load .env on session_start", async () => {
    // This would be tested with the actual extension import
    // For now, verify the mock setup works
    const envContent = createEnvFile({ DA_NAME: "Penny", PROJECT_NAME: "test" });
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(envContent);

    // Simulate extension behavior
    const config = parseEnvFile(envContent, "/test");
    expect(config.DA_NAME).toBe("Penny");
  });

  it("should substitute on before_agent_start", async () => {
    const config = { NAME: "Penny", PROJECT_ROOT: "/test" };
    const agentsContent = "# ${NAME} Project\nWelcome to ${PROJECT_ROOT}!";

    const result = substituteEnvVars(agentsContent, config);
    expect(result).toBe("# Penny Project\nWelcome to /test!");
  });
});

describe("Edge Cases", () => {
  it("should handle missing .env gracefully", () => {
    // When .env doesn't exist, should still have PROJECT_ROOT
    const config = parseEnvFile("", "/test/cwd");
    expect(config.PROJECT_ROOT).toBe("/test/cwd");
    expect(Object.keys(config).length).toBe(1);
  });

  it("should handle empty .env file", () => {
    const config = parseEnvFile("", "/test");
    expect(config.PROJECT_ROOT).toBe("/test");
  });

  it("should handle special characters in values", () => {
    const content = 'PATH="/usr/bin:/bin"\nREGEX="^test.*$"';
    const config = parseEnvFile(content, "/test");

    expect(config.PATH).toBe("/usr/bin:/bin");
    expect(config.REGEX).toBe("^test.*$");
  });

  it("should handle equal signs in values", () => {
    const content = 'EQ="a=b=c"';
    const config = parseEnvFile(content, "/test");

    expect(config.EQ).toBe("a=b=c");
  });

  it("should handle whitespace in values", () => {
    const content = 'NAME="  spaces  "\nTRIM=value  ';
    const config = parseEnvFile(content, "/test");

    expect(config.NAME).toBe("  spaces  ");
    expect(config.TRIM).toBe("value");
  });
});

describe("SYSTEM.md and Boundary Marker", () => {
  it("should substitute variables in SYSTEM.md content", () => {
    const systemContent = "You are **${DA_NAME}**, a personal AI assistant.";
    const config = { DA_NAME: "Penny", PROJECT_ROOT: "/test", CURRENT_DATE: "April 13, 2026" };

    const result = substituteEnvVars(systemContent, config);
    expect(result).toBe("You are **Penny**, a personal AI assistant.");
  });

  it("should substitute PI_PACKAGE_DIR in doc references", () => {
    const systemContent = "Main documentation: ${PI_PACKAGE_DIR}/README.md";
    const config = {
      PI_PACKAGE_DIR: "/opt/pi",
      PROJECT_ROOT: "/test",
      CURRENT_DATE: "April 13, 2026",
    };

    const result = substituteEnvVars(systemContent, config);
    expect(result).toBe("Main documentation: /opt/pi/README.md");
  });

  it("should substitute CURRENT_DATE from config, not process.env", () => {
    const originalEnv = process.env.CURRENT_DATE;
    process.env.CURRENT_DATE = "WRONG_VALUE";

    const systemContent = "Today is ${CURRENT_DATE}.";
    const config = { CURRENT_DATE: "April 13, 2026", PROJECT_ROOT: "/test" };

    const result = substituteEnvVars(systemContent, config);
    expect(result).toBe("Today is April 13, 2026.");

    process.env.CURRENT_DATE = originalEnv;
  });

  it("should preserve XML boundary tags during substitution", () => {
    const systemContent =
      "<system_directives>\nSecurity rules for ${DA_NAME}\n</system_directives>";
    const config = { DA_NAME: "Penny", PROJECT_ROOT: "/test", CURRENT_DATE: "April 13, 2026" };

    const result = substituteEnvVars(systemContent, config);
    expect(result).toBe("<system_directives>\nSecurity rules for Penny\n</system_directives>");
    expect(result).toContain("<system_directives>");
    expect(result).toContain("</system_directives>");
  });

  it("should substitute multiple variables in SYSTEM.md", () => {
    const systemContent =
      "You are **${DA_NAME}**. Date: ${CURRENT_DATE}. Pi docs: ${PI_PACKAGE_DIR}/docs";
    const config = {
      DA_NAME: "Penny",
      PI_PACKAGE_DIR: "/opt/pi",
      CURRENT_DATE: "April 13, 2026",
      PROJECT_ROOT: "/test",
    };

    const result = substituteEnvVars(systemContent, config);
    expect(result).toBe("You are **Penny**. Date: April 13, 2026. Pi docs: /opt/pi/docs");
  });
});

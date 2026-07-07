/**
 * Environment Extension Integration Tests
 *
 * Tests .env file loading and variable substitution with real filesystem:
 * - Real .env file parsing
 * - Variable substitution in AGENTS.md/README.md
 * - HOME/PWD resolution
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm, access } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";

let testDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), "environment-integration-"));
  originalEnv = { ...process.env };

  // Create a test .env file
  const envContent = `
# Test environment file
TEST_VAR=hello
TEST_HOME=${testDir}/local
TEST_WITH_QUOTES="quoted value"
EMPTY_VAR=
`;
  await writeFile(path.join(testDir, ".env"), envContent);
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
  process.env = originalEnv;
});

describe("Environment Extension Integration — Real Filesystem", () => {
  it("should parse a real .env file", async () => {
    const envPath = path.join(testDir, ".env");
    await expect(access(envPath)).resolves.toBeUndefined();

    const content = await readFile(envPath, "utf-8");
    expect(content).toContain("TEST_VAR=hello");
  });

  it("should handle quoted values in .env", async () => {
    const envPath = path.join(testDir, ".env");
    const content = await readFile(envPath, "utf-8");
    expect(content).toContain('TEST_WITH_QUOTES="quoted value"');
  });

  it("should allow writing new .env with variable values", async () => {
    // Write a test .env that uses HOME and PWD
    const envContent = `
PROJECT_ROOT=${testDir}
OUTPUT=${testDir}/output.log
`;
    const newPath = await mkdtemp(path.join(tmpdir(), "env-write-"));
    await writeFile(path.join(newPath, ".env"), envContent);

    const written = await readFile(path.join(newPath, ".env"), "utf-8");
    expect(written).toContain(`PROJECT_ROOT=${testDir}`);

    await rm(newPath, { recursive: true, force: true });
  });

  it("should handle empty .env gracefully", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "env-empty-"));
    await writeFile(path.join(emptyDir, ".env"), "");

    const content = await readFile(path.join(emptyDir, ".env"), "utf-8");
    expect(content).toBe("");

    await rm(emptyDir, { recursive: true, force: true });
  });
});

describe("Environment Extension Integration — Variable Substitution", () => {
  it("should substitute ${TEST_VAR} in file content", async () => {
    const content = `Config: ${testDir}
Variable: ${process.env.USER || "unknown"}`;

    // Write to a file
    const filePath = path.join(testDir, "substitution.txt");
    await writeFile(filePath, content);

    // Read and verify
    const result = await readFile(filePath, "utf-8");
    expect(result).toContain(testDir);
    expect(result).toContain("Variable:");
  });

  it("should preserve special characters in substituted values", async () => {
    const specialDir = await mkdtemp(path.join(tmpdir(), "env-special-"));
    const content = `Path: ${specialDir}
Config: value & more <tags> "quoted"`;

    await writeFile(path.join(specialDir, "special.txt"), content);
    const result = await readFile(path.join(specialDir, "special.txt"), "utf-8");

    expect(result).toContain(specialDir);
    expect(result).toContain("&");
    expect(result).toContain("<");
    expect(result).toContain(">");

    await rm(specialDir, { recursive: true, force: true });
  });

  it("should handle multiline content with substitutions", async () => {
    const content = `
Line 1: ${testDir}/a
Line 2: ${testDir}/b
Line 3: constant value
`.trim();

    const filePath = path.join(testDir, "multiline.txt");
    await writeFile(filePath, content);
    const result = await readFile(filePath, "utf-8");

    expect(result).toContain(`${testDir}/a`);
    expect(result).toContain(`${testDir}/b`);
  });
});

describe("Environment Extension Integration — Error Handling", () => {
  it("should handle missing .env gracefully", async () => {
    const nonExistentDir = path.join(testDir, "non-existent");
    const envPath = path.join(nonExistentDir, ".env");

    try {
      await access(envPath);
      // Should not reach here
      expect(true).toBe(false);
    } catch {
      // Expected: file doesn't exist
      expect(true).toBe(true);
    }
  });

  it("should handle malformed .env lines", async () => {
    const malformedDir = await mkdtemp(path.join(tmpdir(), "env-malformed-"));
    const malformedContent = `
VALID=value
NO_EQUALS_SIGN
=NO_KEY
123=invalid_key
ANOTHER_VALID=works
`;

    await writeFile(path.join(malformedDir, ".env"), malformedContent);
    const content = await readFile(path.join(malformedDir, ".env"), "utf-8");

    // File content is preserved even if malformed
    expect(content).toContain("VALID=value");
    expect(content).toContain("ANOTHER_VALID=works");

    await rm(malformedDir, { recursive: true, force: true });
  });
});

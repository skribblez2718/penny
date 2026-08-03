import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ProcessInvocation {
  command: string;
  args: string[];
}

export interface AgentProcessIsolation {
  protectedPaths: string[];
  /**
   * Paths the model-controlled process must be able to WRITE inside the
   * sandbox — the agent runtime's own state, not orchestration authority.
   *
   * Required because `--ro-bind / /` makes even the agent's own state directory
   * read-only. An OAuth provider refreshes its token by rewriting its
   * credential file, so under a read-only bind the agent exits with
   * "No API key found" immediately after emitting its session event — even
   * though the credential file is perfectly readable.
   *
   * Bound BEFORE the protected tmpfs mounts, so an owner-protected path nested
   * under a writable path is still shadowed (later bwrap mounts win).
   */
  writablePaths?: string[];
  requireSandbox: boolean;
  sandboxExecutable?: string;
}

export function isolatedAgentEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  delete isolated.PENNY_RECEIPT_HMAC_KEY;
  delete isolated.PENNY_APPROVAL_HMAC_KEY;
  return isolated;
}

/**
 * Put the model-controlled process in a mount namespace where the target stays
 * writable but owner-only orchestration/receipt paths are shadowed by private
 * tmpfs mounts. Same-UID chmod is not an authority boundary; this namespace is.
 */
export function buildIsolatedAgentInvocation<T extends ProcessInvocation>(
  invocation: T,
  cwd: string,
  isolation: AgentProcessIsolation
): ProcessInvocation {
  const sandbox = isolation.sandboxExecutable ?? "/usr/bin/bwrap";
  if (!fs.existsSync(sandbox)) {
    if (isolation.requireSandbox) {
      throw new Error(`required agent filesystem sandbox is unavailable: ${sandbox}`);
    }
    return invocation;
  }
  const writableRoot = fs.realpathSync(cwd);
  if (!fs.statSync(writableRoot).isDirectory()) {
    throw new Error(`agent working directory is not a directory: ${writableRoot}`);
  }
  const protectedPaths = isolation.protectedPaths.map((candidate) => {
    if (!path.isAbsolute(candidate) || fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`unsafe protected agent path: ${candidate}`);
    }
    const canonical = fs.realpathSync(candidate);
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error(`protected agent path is not a directory: ${canonical}`);
    }
    return canonical;
  });
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--dev-bind",
    "/dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    os.tmpdir(),
    os.tmpdir(),
    "--bind",
    writableRoot,
    writableRoot,
  ];
  // Writable agent-runtime state first …
  for (const candidate of isolation.writablePaths ?? []) {
    if (!path.isAbsolute(candidate)) {
      throw new Error(`unsafe writable agent path: ${candidate}`);
    }
    if (!fs.existsSync(candidate)) {
      continue; // nothing to bind; absence is not an error
    }
    if (fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`unsafe writable agent path: ${candidate}`);
    }
    const canonical = fs.realpathSync(candidate);
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error(`writable agent path is not a directory: ${canonical}`);
    }
    args.push("--bind", canonical, canonical);
  }
  // … then the owner-protected shadows, which must win over anything above.
  for (const protectedPath of protectedPaths) {
    args.push("--tmpfs", protectedPath);
  }
  args.push("--chdir", writableRoot, "--", invocation.command, ...invocation.args);
  return { command: sandbox, args };
}

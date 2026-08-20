export const ARTIFACT_DISPATCH_MODE_ENV = "PENNY_ARTIFACT_DISPATCH_MODE";

export type ArtifactDispatchMode = "active" | "paused";
export type ArtifactDispatchPauseCode =
  | "ARTIFACT_DISPATCH_PAUSED"
  | "ARTIFACT_DISPATCH_MODE_INVALID";

export interface ArtifactDispatchControl {
  mode: ArtifactDispatchMode;
  code: "ARTIFACT_DISPATCH_ACTIVE" | ArtifactDispatchPauseCode;
  reason: string;
  dispatchAllowed: boolean;
}

export interface ArtifactDispatchRecovery {
  action: "recover";
  run_id: string;
  requires_dispatch_mode: "active";
  checkpoint_preserved: true;
}

export interface ArtifactDispatchPause {
  schema_version: 1;
  action: "paused";
  code: ArtifactDispatchPauseCode;
  reason: string;
  retryable: true;
  dispatch_mode: "paused";
  run_status: string;
  state_id: string;
  session_id: string;
  run_id: string;
  recovery: ArtifactDispatchRecovery;
}

/** Resolve the owner environment exactly; absent defaults active and unknown fails closed. */
export function artifactDispatchControl(
  env: Readonly<Record<string, string | undefined>> = process.env
): ArtifactDispatchControl {
  const configured = env[ARTIFACT_DISPATCH_MODE_ENV];
  if (configured === undefined || configured === "active") {
    return {
      mode: "active",
      code: "ARTIFACT_DISPATCH_ACTIVE",
      reason: "artifact workflow dispatch is active",
      dispatchAllowed: true,
    };
  }
  if (configured === "paused") {
    return {
      mode: "paused",
      code: "ARTIFACT_DISPATCH_PAUSED",
      reason:
        "new agent, tool, and fan-out dispatch is paused by the execution owner; the durable checkpoint remains pending",
      dispatchAllowed: false,
    };
  }
  return {
    mode: "paused",
    code: "ARTIFACT_DISPATCH_MODE_INVALID",
    reason:
      `${ARTIFACT_DISPATCH_MODE_ENV} must be exactly 'active' or 'paused'; ` +
      "unknown configuration fails closed without advancing the run",
    dispatchAllowed: false,
  };
}

/** Build the driver's defense-in-depth pause when an older engine emits work. */
export function localArtifactDispatchPause(
  control: ArtifactDispatchControl,
  identity: { state_id?: string; session_id?: string; run_id?: string }
): ArtifactDispatchPause {
  if (control.dispatchAllowed || control.code === "ARTIFACT_DISPATCH_ACTIVE") {
    throw new Error("active artifact dispatch control cannot build a paused result");
  }
  const runId = identity.run_id || "";
  return {
    schema_version: 1,
    action: "paused",
    code: control.code,
    reason: control.reason,
    retryable: true,
    dispatch_mode: "paused",
    run_status: "running",
    state_id: identity.state_id || "unknown",
    session_id: identity.session_id || "",
    run_id: runId,
    recovery: {
      action: "recover",
      run_id: runId,
      requires_dispatch_mode: "active",
      checkpoint_preserved: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PAUSE_FIELDS = new Set([
  "schema_version",
  "action",
  "code",
  "reason",
  "retryable",
  "dispatch_mode",
  "run_status",
  "state_id",
  "session_id",
  "run_id",
  "recovery",
]);

/** Validate the closed dispatch-pause schema before exposing it as a result. */
export function parseArtifactDispatchPause(value: unknown): ArtifactDispatchPause {
  if (!isRecord(value) || Object.keys(value).some((key) => !PAUSE_FIELDS.has(key))) {
    throw new Error("artifact dispatch pause has unknown or malformed fields");
  }
  const code = value.code;
  if (code !== "ARTIFACT_DISPATCH_PAUSED" && code !== "ARTIFACT_DISPATCH_MODE_INVALID") {
    throw new Error("artifact dispatch pause code is unsupported");
  }
  if (
    value.schema_version !== 1 ||
    value.action !== "paused" ||
    value.retryable !== true ||
    value.dispatch_mode !== "paused" ||
    typeof value.reason !== "string" ||
    !value.reason ||
    typeof value.run_status !== "string" ||
    !value.run_status ||
    typeof value.state_id !== "string" ||
    !value.state_id ||
    typeof value.session_id !== "string" ||
    typeof value.run_id !== "string" ||
    !isRecord(value.recovery)
  ) {
    throw new Error("artifact dispatch pause is missing required typed fields");
  }
  const recovery = value.recovery;
  if (
    Object.keys(recovery).some(
      (key) => !["action", "run_id", "requires_dispatch_mode", "checkpoint_preserved"].includes(key)
    ) ||
    recovery.action !== "recover" ||
    recovery.run_id !== value.run_id ||
    recovery.requires_dispatch_mode !== "active" ||
    recovery.checkpoint_preserved !== true
  ) {
    throw new Error("artifact dispatch pause recovery directive is invalid");
  }
  return value as unknown as ArtifactDispatchPause;
}

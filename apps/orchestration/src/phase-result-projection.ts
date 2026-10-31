import { Type, type Static } from "typebox";

import type { ArtifactReader } from "./artifact-store.js";
import {
  ConfidenceSchema,
  JsonValueSchema,
  validateContract,
  type ArtifactRef,
  type InputArtifacts,
} from "./contracts.js";

/** Host code, never a task/model-selected parser. Identity participates in registration binding. */
export const PhaseResultProjectionDeclarationV1Schema = Type.Object(
  {
    schema_id: Type.String({ pattern: "^penny\\.[a-z0-9-]+\\.v1$" }),
    schema_version: Type.Literal(1),
    registration_name: Type.String({ minLength: 1 }),
    state_id: Type.String({ minLength: 1 }),
    agent: Type.String({ minLength: 1 }),
    result_schema_id: Type.String({ minLength: 1 }),
    result_schema_version: Type.Literal(1),
  },
  { additionalProperties: false }
);
export type PhaseResultProjectionDeclarationV1 = Readonly<
  Static<typeof PhaseResultProjectionDeclarationV1Schema>
>;

export const PhaseResultProjectionV1Schema = Type.Object(
  {
    confidence: ConfidenceSchema,
    details: Type.Record(Type.String(), JsonValueSchema),
  },
  { additionalProperties: false }
);
export type PhaseResultProjectionV1 = Readonly<Static<typeof PhaseResultProjectionV1Schema>>;

export interface PhaseResultProjectorV1 {
  readonly declaration: PhaseResultProjectionDeclarationV1;
  /** Pure transient view of exact captured bytes and owner-selected operands. No state/receipt writes. */
  project(input: {
    readonly bytes: Uint8Array;
    readonly source: ArtifactRef;
    readonly inputArtifacts: InputArtifacts;
    readonly artifacts: Pick<ArtifactReader, "readById" | "refById">;
  }): PhaseResultProjectionV1;
}

export function validatePhaseResultProjector(input: {
  readonly projector: PhaseResultProjectorV1;
  readonly registrationName: string;
  readonly stateId: string;
  readonly agent: string;
  readonly resultSchemaId: string;
  readonly resultSchemaVersion: number;
}): void {
  const declaration = validateContract(
    PhaseResultProjectionDeclarationV1Schema,
    input.projector.declaration,
    "phase result projection declaration"
  );
  if (
    typeof input.projector.project !== "function" ||
    declaration.registration_name !== input.registrationName ||
    declaration.state_id !== input.stateId ||
    declaration.agent !== input.agent ||
    declaration.result_schema_id !== input.resultSchemaId ||
    declaration.result_schema_version !== input.resultSchemaVersion
  ) {
    throw new Error("phase result projection is missing or misbound");
  }
}

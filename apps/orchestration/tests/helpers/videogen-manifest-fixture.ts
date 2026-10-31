import {
  ArtifactRefSchema,
  JsonValueSchema,
  validateContract,
  type JsonValue,
} from "../../dist/contracts.js";
import {
  buildVideogenRuntimeManifest,
  type VideogenRuntimeManifestV1,
} from "../../dist/videogen/runtime-manifest.js";
import path from "node:path";
import { symlinkSync, writeFileSync } from "node:fs";
import { ArtifactStore } from "../../dist/artifact-store.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { initializePennyState } from "../../dist/state/index.js";
import { loadRuntimeConfig } from "../../dist/config.js";
import { FoundationFixture } from "./videogen-foundation-fixtures.js";
import { setup } from "./videogen-executor-fixture.js";

/** Disposable catalog-bound project for the default extension, without backend/media helpers. */
export class ManifestVideogenFixture extends FoundationFixture {
  declare readonly project_id: string;
  declare readonly store: ArtifactStore;
  declare readonly checkpointer: Checkpointer;
  readonly stateRoot: string;
  constructor() {
    super();
    this.stateRoot = path.join(this.root, "state");
    this.store.close();
    this.checkpointer.close();
    initializePennyState(this.root, { env: { PENNY_STATE_ROOT: this.stateRoot } });
    const config = loadRuntimeConfig(this.root, { PENNY_STATE_ROOT: this.stateRoot });
    this.project_id = config.projectId;
    this.store = ArtifactStore.openExisting(config.artifactRoot, { projectId: this.project_id });
    this.checkpointer = Checkpointer.openExisting(config.dbPath, undefined, {
      projectId: this.project_id,
    });
    const repository = path.resolve(import.meta.dirname, "../../../..");
    symlinkSync(path.join(repository, ".pi"), path.join(this.root, ".pi"), "dir");
    symlinkSync(path.join(repository, "docs"), path.join(this.root, "docs"), "dir");
    writeFileSync(path.join(this.root, "AGENTS.md"), "# Offline manifest test project\n", {
      mode: 0o600,
    });
  }
}

/** Complete portable JSON fixture, not a deployment. All synthetic dependencies are embedded;
 * no ref to the generating store, operator path, endpoint or preexisting artifact survives. */
export function minimalVideogenManifest(f: FoundationFixture): VideogenRuntimeManifestV1 {
  const config = setup(f).providers.config;
  const artifacts: VideogenRuntimeManifestV1["artifacts"] = [];
  const ids = new Map<string, string>();
  function template(value: JsonValue): JsonValue {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(template);
    if ("artifact_id" in value) {
      const ref = validateContract(ArtifactRefSchema, value, "fixture input ref");
      let id = ids.get(ref.artifact_id);
      if (id === undefined) {
        id = `fixture-${ids.size + 1}`;
        ids.set(ref.artifact_id, id);
        const bytes = f.store.read(ref);
        let content: JsonValue;
        try {
          content = validateContract(JsonValueSchema, JSON.parse(bytes.toString()), "fixture JSON");
        } catch {
          content = bytes.toString();
        }
        artifacts.push({
          id,
          kind: ref.kind,
          media_type: ref.media_type,
          ...(ref.content_schema === undefined ? {} : { schema_id: ref.content_schema.schema_id }),
          source: { json: template(content) },
        });
      }
      return { $artifact: id };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, template(child)]));
  }
  return buildVideogenRuntimeManifest({
    artifacts,
    config: template(validateContract(JsonValueSchema, config, "fixture configuration")),
    recipes: [],
    adapters: [],
  });
}

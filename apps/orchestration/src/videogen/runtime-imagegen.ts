import type { HostOperationAdapterV1 } from "../host-operations/contracts.js";
import type { ImagegenStartAdmissionProvidersV1 } from "../imagegen/types.js";
import type { ImageAssetAuthority } from "../imagegen/asset-authority.js";
import {
  ComfyImagegenOperationAdapter,
  COMFY_IMAGEGEN_ADAPTER_ID,
} from "../imagegen/operation-owner.js";
import {
  ComfyImagegenReadinessAdapter,
  COMFY_IMAGEGEN_READINESS_ADAPTER_ID,
} from "../imagegen/readiness-operation.js";
import { ImageInputUploadAdapter, IMAGE_INPUT_UPLOAD_ADAPTER } from "../imagegen/input-upload.js";
/** Compiled, fixed image adapters with per-child current parent custody. No profile enable/repin. */
export function videogenImagegenAdapters(
  providers: ImagegenStartAdmissionProvidersV1,
  assets: (childRunId: string) => ImageAssetAuthority
): ReadonlyMap<string, HostOperationAdapterV1> {
  const factories = new Map<string, (assets: ImageAssetAuthority) => HostOperationAdapterV1>([
    [
      COMFY_IMAGEGEN_ADAPTER_ID,
      (a) => new ComfyImagegenOperationAdapter({ ...providers, assets: a, cache_results: true }),
    ],
    [
      COMFY_IMAGEGEN_READINESS_ADAPTER_ID,
      (a) => new ComfyImagegenReadinessAdapter({ ...providers, assets: a, cache_results: true }),
    ],
    [IMAGE_INPUT_UPLOAD_ADAPTER, (a) => new ImageInputUploadAdapter({ ...providers, assets: a })],
  ]);
  return new Map(
    [...factories].map(([id, factory]) => {
      const cache = new Map<string, HostOperationAdapterV1>();
      const adapter = (runId: string) => {
        let found = cache.get(runId);
        if (found === undefined) {
          found = factory(assets(runId));
          cache.set(runId, found);
        }
        return found;
      };
      return [
        id,
        {
          adapter_id: id,
          inspectRequest: (input) => adapter(input.directive.identity.run_id).inspectRequest(input),
          run: (ctx) => adapter(ctx.directive.identity.run_id).run(ctx),
        } satisfies HostOperationAdapterV1,
      ];
    })
  );
}

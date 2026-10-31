const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface InactivityFetchResult {
  readonly response: Response;
  readonly text: string;
}

export async function fetchTextWithInactivity(
  input: string | URL | Request,
  init: RequestInit,
  inactivityIntervalMs: number,
  fetchImplementation: typeof fetch = fetch,
  maximumResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
): Promise<InactivityFetchResult> {
  if (!Number.isSafeInteger(inactivityIntervalMs) || inactivityIntervalMs <= 0) {
    throw new Error("fetch inactivity interval must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes <= 0) {
    throw new Error("fetch response bound must be a positive integer");
  }

  const controller = new AbortController();
  const callerSignal = init.signal ?? undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityExpired = false;
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  const renewInactivity = (): void => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      inactivityExpired = true;
      controller.abort(new Error("fetch became inactive"));
    }, inactivityIntervalMs);
    inactivityTimer.unref?.();
  };

  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  renewInactivity();

  try {
    const response = await fetchImplementation(input, { ...init, signal: controller.signal });
    renewInactivity();
    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maximumResponseBytes) {
        throw new Error("fetch response exceeded its byte bound");
      }
      return { response, text: bytes.toString("utf8") };
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        total += chunk.length;
        if (total > maximumResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error("fetch response exceeded its byte bound");
        }
        if (chunk.length > 0) renewInactivity();
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return { response, text: Buffer.concat(chunks, total).toString("utf8") };
  } catch (error) {
    if (inactivityExpired) throw new Error("fetch became inactive", { cause: error });
    throw error;
  } finally {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

import { executeMemoize } from "execution-engine";

// executeMemoize stores entries on `this`; keep one receiver for all calls.
const requests = { executeMemoize };

/** Share pending work without retaining a completed result or rejected promise. */
export async function shareModelRequest<T>(
  identity: unknown,
  request: () => Promise<T>
): Promise<{ value: T; shared: boolean }> {
  let shared = false;
  const value = await requests.executeMemoize(request, [identity], {
    functionId: "ai-release-notes:llm",
    ttl: 0,
    onMemoizeEvent: event => { shared = event.isMemoized; },
  });
  return { value, shared };
}

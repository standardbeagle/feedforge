import type { FeedStore } from "./registry";

export async function resolveFeedId(url: URL, store: FeedStore): Promise<string | null> {
  const segment = url.pathname.split("/").filter(Boolean)[0] ?? null;
  const mapped = await store.resolveHost(url.hostname);
  if (mapped) return segment ?? mapped;
  return segment;
}

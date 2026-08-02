import { parseFeed, buildRss, FeedParseError } from "./normalize";
import type { FeedEntry, FeedStore, StoredFeed } from "./registry";

export interface PollResult {
  id: string;
  status: "ok" | "not-modified" | "skipped" | "error";
  message?: string;
}

export async function pollFeed(
  entry: FeedEntry,
  store: FeedStore,
  fetchFn: typeof fetch = fetch,
): Promise<PollResult> {
  const existing = await store.getFeed(entry.id);
  if (
    existing &&
    Date.now() - Date.parse(existing.meta.last_fetched) < entry.poll_minutes * 60_000
  ) {
    return { id: entry.id, status: "skipped" };
  }

  const headers = new Headers({ "user-agent": "feedforge/0.1 (+https://github.com/)" });
  if (existing?.meta.etag) headers.set("if-none-match", existing.meta.etag);
  if (existing?.meta.last_modified) headers.set("if-modified-since", existing.meta.last_modified);

  const fail = async (message: string): Promise<PollResult> => {
    if (existing) {
      await store.putFeed(entry.id, {
        ...existing,
        meta: {
          ...existing.meta,
          last_fetched: new Date().toISOString(),
          error_count: existing.meta.error_count + 1,
          last_error: message,
        },
      });
    }
    return { id: entry.id, status: "error", message };
  };

  let res: Response;
  try {
    res = await fetchFn(entry.origin, { headers });
  } catch (e) {
    return fail(`fetch failed: ${(e as Error).message}`);
  }

  if (res.status === 304 && existing) {
    await store.putFeed(entry.id, {
      ...existing,
      meta: { ...existing.meta, last_fetched: new Date().toISOString(), error_count: 0 },
    });
    return { id: entry.id, status: "not-modified" };
  }
  if (!res.ok) return fail(`origin returned HTTP ${res.status}`);

  const body = await res.text();
  try {
    const doc = parseFeed(body);
    const stored: StoredFeed = {
      xml: buildRss(doc),
      meta: {
        etag: res.headers.get("etag") ?? undefined,
        last_modified: res.headers.get("last-modified") ?? undefined,
        last_fetched: new Date().toISOString(),
        title: doc.title,
        item_count: doc.items.length,
        error_count: 0,
      },
    };
    await store.putFeed(entry.id, stored);
    return { id: entry.id, status: "ok" };
  } catch (e) {
    if (e instanceof FeedParseError) return fail(`unparseable feed: ${e.message}`);
    throw e;
  }
}

export async function pollAll(
  store: FeedStore,
  fetchFn: typeof fetch = fetch,
): Promise<PollResult[]> {
  const { feeds } = await store.getRegistry();
  const results: PollResult[] = [];
  const BATCH = 5;
  for (let i = 0; i < feeds.length; i += BATCH) {
    const batch = await Promise.all(feeds.slice(i, i + BATCH).map((f) => pollFeed(f, store, fetchFn)));
    results.push(...batch);
  }
  return results;
}

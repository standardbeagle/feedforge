import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import rss from "./fixtures/valid-rss.xml?raw";
import { KVFeedStore, type FeedEntry, type StoredFeed } from "../src/registry";
import { pollFeed, pollAll } from "../src/poller";

const entry: FeedEntry = { id: "blog", origin: "https://origin.test/rss", poll_minutes: 30, created_at: "2026-08-01T00:00:00Z" };

const resp = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

const fetcher = (r: Response) => (async () => r.clone()) as typeof fetch;

describe("pollFeed", () => {
  it("fetches, normalizes, and stores a new feed", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const result = await pollFeed(entry, store, fetcher(resp(rss, 200, { etag: "v1" })));
    expect(result.status).toBe("ok");
    const stored = await store.getFeed("blog");
    expect(stored!.meta.title).toBe("Example Blog");
    expect(stored!.meta.item_count).toBe(1);
    expect(stored!.meta.etag).toBe("v1");
    expect(stored!.meta.error_count).toBe(0);
  });

  it("sends conditional headers and keeps body on 304", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const prior: StoredFeed = {
      xml: "<old/>",
      meta: { etag: "v1", last_modified: "Mon, 01 Jun 2026 00:00:00 GMT", last_fetched: "2020-01-01T00:00:00Z", title: "T", item_count: 0, error_count: 0 },
    };
    await store.putFeed("blog", prior);
    let seen: Record<string, string> = {};
    const f = (async (_u: any, init: any) => {
      seen = Object.fromEntries(new Headers(init.headers).entries());
      return resp("", 304);
    }) as typeof fetch;
    const result = await pollFeed(entry, store, f);
    expect(result.status).toBe("not-modified");
    expect(seen["if-none-match"]).toBe("v1");
    expect(seen["if-modified-since"]).toBe("Mon, 01 Jun 2026 00:00:00 GMT");
    const stored = await store.getFeed("blog");
    expect(stored!.xml).toBe("<old/>");
    expect(stored!.meta.last_fetched).not.toBe("2020-01-01T00:00:00Z");
  });

  it("skips feeds fetched within their poll interval", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putFeed("blog", {
      xml: "<x/>",
      meta: { last_fetched: new Date().toISOString(), title: "T", item_count: 0, error_count: 0 },
    });
    const result = await pollFeed(entry, store, fetcher(resp(rss)));
    expect(result.status).toBe("skipped");
  });

  it("keeps last-good copy and counts origin errors", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putFeed("blog", {
      xml: "<good/>",
      meta: { last_fetched: "2020-01-01T00:00:00Z", title: "T", item_count: 1, error_count: 0 },
    });
    const result = await pollFeed(entry, store, fetcher(resp("down", 502)));
    expect(result.status).toBe("error");
    const stored = await store.getFeed("blog");
    expect(stored!.xml).toBe("<good/>");
    expect(stored!.meta.error_count).toBe(1);
    expect(stored!.meta.last_error).toContain("502");
  });

  it("marks unparseable origins as error", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const result = await pollFeed(entry, store, fetcher(resp("<html>nope</html>")));
    expect(result.status).toBe("error");
    expect((await store.getFeed("blog"))).toBeNull();
  });
});

describe("pollAll", () => {
  it("polls every registered feed", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({
      feeds: [
        entry,
        { ...entry, id: "blog2", origin: "https://origin.test/rss2" },
      ],
      domains: {},
    });
    const results = await pollAll(store, fetcher(resp(rss)));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });
});

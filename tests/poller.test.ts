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

  it("handles fetch rejection as error, keeping last-good", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putFeed("blog", {
      xml: "<good/>",
      meta: { last_fetched: "2020-01-01T00:00:00Z", title: "T", item_count: 1, error_count: 0 },
    });
    const throwing = (async () => { throw new Error("network down"); }) as typeof fetch;
    const result = await pollFeed(entry, store, throwing);
    expect(result.status).toBe("error");
    expect(result.message).toContain("network down");
    expect((await store.getFeed("blog"))!.xml).toBe("<good/>");
  });

  it("keeps last-good when body is unparseable and a prior copy exists", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putFeed("blog", {
      xml: "<good/>",
      meta: { last_fetched: "2020-01-01T00:00:00Z", title: "T", item_count: 1, error_count: 0 },
    });
    const result = await pollFeed(entry, store, fetcher(resp("<html>nope</html>")));
    expect(result.status).toBe("error");
    const stored = await store.getFeed("blog");
    expect(stored!.xml).toBe("<good/>");
    expect(stored!.meta.error_count).toBe(1);
  });

  it("rejects oversized origin bodies", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const big = resp("x", 200, { "content-length": String(6 * 1024 * 1024) });
    const result = await pollFeed(entry, store, fetcher(big));
    expect(result.status).toBe("error");
    expect(result.message).toContain("too large");
  });

  it("measures the cap in bytes, not UTF-16 units", async () => {
    const store = new KVFeedStore(env.FEEDS);
    // 3 UTF-8 bytes per char: 1.8M chars is 5.4MB of body but only 1.8M string
    // units, so a length-based check waves it through. No content-length header,
    // as on a chunked response, so line-64's early check cannot catch it either.
    const multibyte = "あ".repeat(1_800_000);
    expect(multibyte.length).toBeLessThan(5 * 1024 * 1024);
    const result = await pollFeed({ ...entry, id: "mb" }, store, fetcher(resp(multibyte)));
    expect(result.status).toBe("error");
    expect(result.message).toContain("too large");
  }, 20_000);

  it("records a content hash and holds Last-Modified steady across identical polls", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const e: FeedEntry = { ...entry, id: "hash", poll_minutes: 0 };
    const first = await pollFeed(e, store, fetcher(resp(rss)));
    expect(first.feed!.meta.xml_hash).toMatch(/^[0-9a-f]{64}$/);
    const builtAt = first.feed!.meta.last_built;
    expect(builtAt).toBeTruthy();

    const second = await pollFeed(e, store, fetcher(resp(rss)));
    expect(second.feed!.meta.xml_hash).toBe(first.feed!.meta.xml_hash);
    // Same bytes, so subscribers' cached copies must not be invalidated.
    expect(second.feed!.meta.last_built).toBe(builtAt);
    expect(second.feed!.meta.last_fetched).not.toBe(first.feed!.meta.last_fetched);
  });

  it("keeps only max_items when the feed sets one", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const many = rss.replace(
      "</channel>",
      Array.from({ length: 5 }, (_, i) => `<item><title>extra ${i}</title><link>https://e.test/${i}</link></item>`).join("") + "</channel>",
    );
    const capped = await pollFeed({ ...entry, id: "cap", max_items: 2 }, store, fetcher(resp(many)));
    expect(capped.feed!.meta.item_count).toBe(2);

    const uncapped = await pollFeed({ ...entry, id: "nocap" }, store, fetcher(resp(many)));
    expect(uncapped.feed!.meta.item_count).toBe(6);
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

  it("continues polling other feeds when one throws unexpectedly", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({
      feeds: [entry, { ...entry, id: "blog2", origin: "https://origin.test/rss2" }],
      domains: {},
    });
    const wrapped: KVFeedStore = {
      getRegistry: () => store.getRegistry(),
      putRegistry: (reg) => store.putRegistry(reg),
      putFeed: (id, feed) => store.putFeed(id, feed),
      resolveHost: (h) => store.resolveHost(h),
      getFeed: async (id: string) => {
        if (id === "blog2") throw new Error("KV exploded");
        return store.getFeed(id);
      },
    } as KVFeedStore;
    const results = await pollAll(wrapped, fetcher(resp(rss)));
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === "blog")!.status).toBe("ok");
    expect(results.find((r) => r.id === "blog2")!.status).toBe("error");
    expect(results.find((r) => r.id === "blog2")!.message).toContain("KV exploded");
  });
});

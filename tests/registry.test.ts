import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { KVFeedStore } from "../src/registry";

describe("KVFeedStore", () => {
  it("returns empty registry when unset", async () => {
    const store = new KVFeedStore(env.FEEDS);
    expect(await store.getRegistry()).toEqual({ feeds: [], domains: {} });
  });

  it("round-trips a registry", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const reg = {
      feeds: [{ id: "blog", origin: "https://example.com/rss", poll_minutes: 30, created_at: "2026-08-01T00:00:00Z" }],
      domains: { "feeds.example.org": "blog" },
    };
    await store.putRegistry(reg);
    expect(await store.getRegistry()).toEqual(reg);
  });

  it("round-trips a stored feed", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const feed = {
      xml: "<rss/>",
      meta: { last_fetched: "2026-08-01T00:00:00Z", title: "T", item_count: 0, error_count: 0 },
    };
    await store.putFeed("blog", feed);
    expect(await store.getFeed("blog")).toEqual(feed);
    expect(await store.getFeed("missing")).toBeNull();
  });

  it("resolves hostnames", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({ feeds: [], domains: { "feeds.example.org": "blog" } });
    expect(await store.resolveHost("feeds.example.org")).toBe("blog");
    expect(await store.resolveHost("other.org")).toBeNull();
  });
});

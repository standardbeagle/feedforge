import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { KVFeedStore } from "../src/registry";
import { resolveFeedId } from "../src/router";

describe("resolveFeedId", () => {
  it("resolves path segment on unmapped hosts", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({ feeds: [], domains: {} });
    expect(await resolveFeedId(new URL("https://feeds.example.com/blog"), store)).toBe("blog");
    expect(await resolveFeedId(new URL("https://feeds.example.com/"), store)).toBeNull();
  });

  it("resolves mapped host root to its feed", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({ feeds: [], domains: { "feeds.example.org": "blog" } });
    expect(await resolveFeedId(new URL("https://feeds.example.org/"), store)).toBe("blog");
    expect(await resolveFeedId(new URL("https://feeds.example.org/other"), store)).toBe("other");
  });
});

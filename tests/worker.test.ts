import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import rss from "./fixtures/valid-rss.xml?raw";
import { KVFeedStore } from "../src/registry";

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const store = new KVFeedStore(env.FEEDS);
  await store.putRegistry({
    feeds: [{ id: "blog", origin: "https://origin.test/rss", poll_minutes: 30, created_at: "2026-08-01T00:00:00Z" }],
    domains: { "feeds.example.org": "blog" },
  });
  fetchMock.get("https://origin.test").intercept({ path: "/rss" }).reply(200, rss).persist();
});

describe("fetch handler", () => {
  it("serves stored RSS as application/rss+xml", async () => {
    const res = await SELF.fetch("https://feeds.example.com/blog", {
      headers: { accept: "application/rss+xml", "user-agent": "FreshRSS/1.24" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    expect(await res.text()).toContain("Example Blog");
  });

  it("serves Atom when ?format=atom", async () => {
    const res = await SELF.fetch("https://feeds.example.com/blog?format=atom", {
      headers: { "user-agent": "FreshRSS/1.24" },
    });
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    expect(await res.text()).toContain("<feed");
  });

  it("serves browser HTML to browsers", async () => {
    const res = await SELF.fetch("https://feeds.example.com/blog", {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/126" },
    });
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Subscribe");
  });

  it("serves feed at mapped domain root (MyBrand)", async () => {
    const res = await SELF.fetch("https://feeds.example.org/", {
      headers: { "user-agent": "FreshRSS/1.24" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Example Blog");
  });

  it("returns 404 for unknown feeds", async () => {
    const res = await SELF.fetch("https://feeds.example.com/nope");
    expect(res.status).toBe(404);
  });

  it("sets X-Feed-Stale when origin errors have accumulated", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putFeed("blog", {
      xml: rss,
      meta: {
        last_fetched: new Date().toISOString(),
        title: "Example Blog",
        item_count: 1,
        error_count: 2,
        last_error: "HTTP 502",
      },
    });
    const res = await SELF.fetch("https://feeds.example.com/blog", {
      headers: { "user-agent": "FreshRSS/1.24" },
    });
    expect(res.headers.get("x-feed-stale")).toBe("true");
  });
});

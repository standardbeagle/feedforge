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
    domains: {},
  });
});

const call = (id: string, token?: string) =>
  SELF.fetch(`https://feeds.example.com/api/feeds/${id}/refresh`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("refresh webhook", () => {
  it("forces a poll and returns the result", async () => {
    fetchMock.get("https://origin.test").intercept({ path: "/rss" }).reply(200, rss);
    const res = await call("blog", "test-refresh-secret");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ id: "blog", status: "ok" });
    const stored = await new KVFeedStore(env.FEEDS).getFeed("blog");
    expect(stored!.meta.title).toBe("Example Blog");
  });

  it("bypasses the poll-interval skip", async () => {
    fetchMock.get("https://origin.test").intercept({ path: "/rss" }).reply(200, rss).persist();
    await call("blog", "test-refresh-secret");
    const second = await call("blog", "test-refresh-secret");
    expect(((await second.json()) as any).status).toBe("ok"); // not "skipped"
  });

  it("requires the shared secret", async () => {
    expect((await call("blog")).status).toBe(401);
    expect((await call("blog", "wrong")).status).toBe(403);
  });

  it("404s unknown feeds", async () => {
    expect((await call("ghost", "test-refresh-secret")).status).toBe(404);
  });
});

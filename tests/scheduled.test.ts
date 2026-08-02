import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF, fetchMock, createScheduledController } from "cloudflare:test";
import rss from "./fixtures/valid-rss.xml?raw";
import worker from "../src/worker";
import { KVFeedStore } from "../src/registry";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock.get("https://origin.test").intercept({ path: "/rss" }).reply(200, rss);
});

describe("scheduled handler", () => {
  it("polls all registered feeds on cron", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({
      feeds: [
        {
          id: "cronblog",
          origin: "https://origin.test/rss",
          poll_minutes: 30,
          created_at: "2026-08-01T00:00:00Z",
        },
      ],
      domains: {},
    });
    const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: "*/30 * * * *" });
    let pending: Promise<any> | undefined;
    await worker.scheduled(ctrl as any, env, {
      waitUntil: (p: Promise<any>) => {
        pending = p;
      },
    } as any);
    await pending;
    const stored = await store.getFeed("cronblog");
    expect(stored).not.toBeNull();
    expect(stored!.meta.title).toBe("Example Blog");
    const res = await SELF.fetch("https://feeds.example.com/cronblog", {
      headers: { "user-agent": "Miniflux/2.0" },
    });
    expect(await res.text()).toContain("First Post");
  });
});

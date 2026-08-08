import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import rss from "./fixtures/valid-rss.xml?raw";
import { KVFeedStore } from "../src/registry";
import { isNotModified, etagFor } from "../src/conditional";

const READER = { "user-agent": "FreshRSS/1.24" };

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const store = new KVFeedStore(env.FEEDS);
  await store.putRegistry({
    feeds: [{ id: "cond", origin: "https://cond.test/rss", poll_minutes: 30, created_at: "2026-08-01T00:00:00Z" }],
    domains: {},
  });
  fetchMock.get("https://cond.test").intercept({ path: "/rss" }).reply(200, rss).persist();
});

describe("isNotModified", () => {
  const etag = etagFor("a".repeat(64), "rss");

  it("matches a listed tag, a wildcard, and a weak form", () => {
    const req = (h: Record<string, string>) => new Request("https://x.test/f", { headers: h });
    expect(isNotModified(req({ "if-none-match": etag }), etag, null)).toBe(true);
    expect(isNotModified(req({ "if-none-match": "*" }), etag, null)).toBe(true);
    expect(isNotModified(req({ "if-none-match": `W/${etag}` }), etag, null)).toBe(true);
    expect(isNotModified(req({ "if-none-match": `"other", ${etag}` }), etag, null)).toBe(true);
    expect(isNotModified(req({ "if-none-match": '"other"' }), etag, null)).toBe(false);
  });

  it("ignores If-Modified-Since when If-None-Match is present, per RFC 9110", () => {
    const built = "2026-08-01T00:00:00.000Z";
    const req = new Request("https://x.test/f", {
      headers: { "if-none-match": '"stale"', "if-modified-since": "Sat, 02 Aug 2026 00:00:00 GMT" },
    });
    expect(isNotModified(req, etag, built)).toBe(false);
  });

  it("falls back to If-Modified-Since alone", () => {
    const built = "2026-08-01T00:00:00.000Z";
    const at = (d: string) => new Request("https://x.test/f", { headers: { "if-modified-since": d } });
    expect(isNotModified(at("Sat, 01 Aug 2026 00:00:00 GMT"), etag, built)).toBe(true);
    expect(isNotModified(at("Fri, 31 Jul 2026 00:00:00 GMT"), etag, built)).toBe(false);
    expect(isNotModified(at("not a date"), etag, built)).toBe(false);
  });
});

describe("subscriber conditional GET", () => {
  it("serves an ETag and Last-Modified with the feed", async () => {
    const res = await SELF.fetch("https://feeds.example.com/cond", { headers: READER });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}-rss"$/);
    expect(res.headers.get("last-modified")).toBeTruthy();
  });

  it("answers 304 with an empty body when the reader's copy is current", async () => {
    const first = await SELF.fetch("https://feeds.example.com/cond", { headers: READER });
    const etag = first.headers.get("etag")!;
    const second = await SELF.fetch("https://feeds.example.com/cond", {
      headers: { ...READER, "if-none-match": etag },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("still returns the body when the tag does not match", async () => {
    const res = await SELF.fetch("https://feeds.example.com/cond", {
      headers: { ...READER, "if-none-match": '"not-the-current-tag"' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Example Blog");
  });

  it("gives each representation its own tag so one cannot suppress another", async () => {
    const asRss = await SELF.fetch("https://feeds.example.com/cond", { headers: READER });
    const asAtom = await SELF.fetch("https://feeds.example.com/cond?format=atom", { headers: READER });
    expect(asRss.headers.get("etag")).not.toBe(asAtom.headers.get("etag"));

    const crossed = await SELF.fetch("https://feeds.example.com/cond?format=atom", {
      headers: { ...READER, "if-none-match": asRss.headers.get("etag")! },
    });
    expect(crossed.status).toBe(200);
  });

  it("honours If-Modified-Since on its own", async () => {
    const first = await SELF.fetch("https://feeds.example.com/cond", { headers: READER });
    const lastModified = first.headers.get("last-modified")!;
    const res = await SELF.fetch("https://feeds.example.com/cond", {
      headers: { ...READER, "if-modified-since": lastModified },
    });
    expect(res.status).toBe(304);
  });
});

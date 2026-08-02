import { describe, it, expect } from "vitest";
import { addFeed, removeFeed, mapDomain } from "../src/cli";
import type { Registry } from "../src/registry";

const base: Registry = { feeds: [], domains: {} };

describe("cli registry edits", () => {
  it("adds a feed", () => {
    const reg = addFeed(base, "blog", "https://example.com/rss");
    expect(reg.feeds[0]).toMatchObject({ id: "blog", origin: "https://example.com/rss", poll_minutes: 30 });
  });

  it("rejects duplicate ids", () => {
    const reg = addFeed(base, "blog", "https://example.com/rss");
    expect(() => addFeed(reg, "blog", "https://other/rss")).toThrow(/already exists/);
  });

  it("removes a feed and its domain mappings", () => {
    let reg = addFeed(base, "blog", "https://example.com/rss");
    reg = mapDomain(reg, "feeds.example.org", "blog");
    reg = removeFeed(reg, "blog");
    expect(reg.feeds).toHaveLength(0);
    expect(reg.domains).toEqual({});
  });

  it("maps a domain to an existing feed", () => {
    const reg = addFeed(base, "blog", "https://example.com/rss");
    expect(() => mapDomain(reg, "feeds.example.org", "ghost")).toThrow(/no feed/);
    expect(mapDomain(reg, "feeds.example.org", "blog").domains["feeds.example.org"]).toBe("blog");
  });
});

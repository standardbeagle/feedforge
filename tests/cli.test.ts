import { describe, it, expect } from "vitest";
import { addFeed, removeFeed, mapDomain, setMaxItems, isNotFoundError } from "../src/cli";
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

  it("sets and clears max_items", () => {
    const reg = addFeed(base, "blog", "https://example.com/rss");
    expect(setMaxItems(reg, "blog", 25).feeds[0].max_items).toBe(25);
    expect(setMaxItems(setMaxItems(reg, "blog", 25), "blog", null).feeds[0].max_items).toBeUndefined();
  });

  it("rejects a nonsensical max_items or an unknown feed", () => {
    const reg = addFeed(base, "blog", "https://example.com/rss");
    expect(() => setMaxItems(reg, "blog", 0)).toThrow(/positive integer/);
    expect(() => setMaxItems(reg, "blog", 1.5)).toThrow(/positive integer/);
    expect(() => setMaxItems(reg, "nope", 5)).toThrow(/no feed with id/);
  });

  it("classifies not-found vs real errors", () => {
    expect(isNotFoundError("A key with that name does not exist.")).toBe(true);
    expect(isNotFoundError("network unreachable")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { parseFeed } from "../src/normalize";
import { renderFeedPage } from "../src/view";
import rss from "./fixtures/valid-rss.xml?raw";

const doc = parseFeed(rss);

describe("renderFeedPage", () => {
  it("renders title, items, and subscribe call-to-action", () => {
    const html = renderFeedPage(doc, "https://feeds.example.com/blog", null);
    expect(html).toContain("Example Blog");
    expect(html).toContain("First Post");
    expect(html).toContain("https://feeds.example.com/blog");
    expect(html.toLowerCase()).toContain("subscribe");
    expect(html).toContain("<!doctype html>");
  });

  it("escapes HTML in feed content", () => {
    const evil = { ...doc, title: `<script>alert(1)</script>` };
    const html = renderFeedPage(evil, "https://feeds.example.com/blog", null);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("blocks javascript: URLs in item links", () => {
    const evil = {
      ...doc,
      items: [{ title: "click", link: "javascript:alert(1)", guid: "g" }],
    };
    const html = renderFeedPage(evil, "https://feeds.example.com/blog", null);
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });

  it("shows a staleness warning", () => {
    const html = renderFeedPage(doc, "https://feeds.example.com/blog", "origin returned HTTP 502");
    expect(html).toContain("502");
    expect(html.toLowerCase()).toContain("stale");
  });
});

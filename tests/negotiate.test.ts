import { describe, it, expect } from "vitest";
import { chooseFormat } from "../src/negotiate";

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8";

const pick = (path: string, accept: string, ua = "") =>
  chooseFormat(new URL(`https://feeds.example.com${path}`), accept, ua);

describe("chooseFormat", () => {
  it("defaults to RSS when the client states no preference", () => {
    expect(pick("/blog", "")).toBe("rss");
    expect(pick("/blog", "*/*")).toBe("rss");
  });

  it("serves HTML to a browser that ranks text/html above every feed type", () => {
    expect(pick("/blog", BROWSER_ACCEPT, CHROME)).toBe("html");
  });

  it("serves RSS to a reader that accepts HTML but ranks a feed type at least as high", () => {
    expect(pick("/blog", "application/rss+xml,text/html;q=0.9", "SomeUnknownReader/2.0")).toBe("rss");
    expect(pick("/blog", "text/html,application/rss+xml", "SomeUnknownReader/2.0")).toBe("rss");
  });

  it("serves RSS to a known aggregator regardless of Accept", () => {
    expect(pick("/blog", BROWSER_ACCEPT, "Feedly/1.0 (+http://feedly.com; 42 subscribers)")).toBe("rss");
  });

  it("honours ?format= over both Accept and user-agent", () => {
    expect(pick("/blog?format=atom", BROWSER_ACCEPT, CHROME)).toBe("atom");
    expect(pick("/blog?format=rss", BROWSER_ACCEPT, CHROME)).toBe("rss");
    expect(pick("/blog?format=xml", BROWSER_ACCEPT, CHROME)).toBe("rss");
    expect(pick("/blog?format=html", "application/rss+xml", "FreshRSS/1.24")).toBe("html");
  });
});

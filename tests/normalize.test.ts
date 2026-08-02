import { describe, it, expect } from "vitest";
import { parseFeed, FeedParseError } from "../src/normalize";
import validRss from "./fixtures/valid-rss.xml?raw";
import validAtom from "./fixtures/valid-atom.xml?raw";
import bareAmpersand from "./fixtures/bare-ampersand.xml?raw";

const fixtures: Record<string, string> = {
  "valid-rss.xml": validRss,
  "valid-atom.xml": validAtom,
  "bare-ampersand.xml": bareAmpersand,
};
const fixture = (name: string) => fixtures[name];

describe("parseFeed", () => {
  it("parses RSS 2.0", () => {
    const doc = parseFeed(fixture("valid-rss.xml"));
    expect(doc.title).toBe("Example Blog");
    expect(doc.link).toBe("https://example.com");
    expect(doc.description).toBe("An example blog");
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]).toMatchObject({
      title: "First Post",
      link: "https://example.com/first",
      guid: "https://example.com/first",
      pubDate: "Mon, 01 Jun 2026 12:00:00 GMT",
    });
  });

  it("parses Atom", () => {
    const doc = parseFeed(fixture("valid-atom.xml"));
    expect(doc.title).toBe("Atom Blog");
    expect(doc.link).toBe("https://example.org");
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].title).toBe("Atom Post");
    expect(doc.items[0].link).toBe("https://example.org/post");
  });

  it("repairs bare ampersands", () => {
    const doc = parseFeed(fixture("bare-ampersand.xml"));
    expect(doc.title).toBe("Tom & Jerry Blog");
    expect(doc.description).toBe("Mixed & broken");
    expect(doc.items[0].link).toBe("https://example.net/p?x=1&y=2");
  });

  it("throws FeedParseError on non-feed XML", () => {
    expect(() => parseFeed("<html><body>nope</body></html>")).toThrow(FeedParseError);
  });

  it("preserves ampersands inside CDATA", () => {
    const doc = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel>
      <title>T</title><link>https://x</link><description><![CDATA[Tom & Jerry <b>html</b>]]></description>
      <item><title>i</title><link>https://x/1</link><guid>g</guid></item>
    </channel></rss>`);
    expect(doc.description).toBe("Tom & Jerry <b>html</b>");
  });
});

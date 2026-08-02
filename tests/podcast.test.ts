import { describe, it, expect } from "vitest";
import podcastXml from "./fixtures/podcast.xml?raw";
import { parseFeed } from "../src/normalize";

const doc = parseFeed(podcastXml);

describe("podcast parsing", () => {
  it("parses item enclosures", () => {
    expect(doc.items[0].enclosure).toEqual({
      url: "https://cdn.example.com/ep3.mp3",
      length: 12345678,
      type: "audio/mpeg",
    });
  });

  it("parses itunes channel fields", () => {
    expect(doc.itunes).toMatchObject({
      author: "Deploy Bot",
      image: "https://pod.example.com/cover.jpg",
      summary: "Weekly deploys",
      ownerName: "The Bot",
      ownerEmail: "bot@pod.example.com",
      explicit: "no",
      type: "episodic",
    });
    expect(doc.itunes!.categories).toEqual(["Technology", "Podcasting"]);
  });

  it("parses podcast channel fields", () => {
    expect(doc.podcast!.guid).toBe("9b024349-ccf0-5f69-a609-6b82873eab3a");
    expect(doc.podcast!.locked).toBe("yes");
    expect(doc.podcast!.lockedOwner).toBe("bot@pod.example.com");
    expect(doc.podcast!.medium).toBe("podcast");
    expect(doc.podcast!.persons).toEqual([
      { name: "Deploy Bot", role: "host", img: "https://pod.example.com/bot.png" },
    ]);
    expect(doc.podcast!.funding).toEqual([
      { url: "https://pod.example.com/support", message: "Support the show" },
    ]);
    expect(doc.podcast!.location).toEqual({ name: "Austin, TX", geo: "geo:30.2672,97.7431", osm: "R113314" });
    expect(doc.podcast!.value).toMatchObject({
      type: "lightning",
      method: "keysend",
      recipients: [{ name: "host", address: "03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a", type: "node", split: 100 }],
    });
  });

  it("parses item-level podcast fields", () => {
    const item = doc.items[0];
    expect(item.itunes).toEqual({ duration: "32:14", episode: 3, season: 1, episodeType: "full" });
    expect(item.podcast!.chaptersUrl).toBe("https://pod.example.com/ep3-chapters.json");
    expect(item.podcast!.transcripts).toEqual([
      { url: "https://pod.example.com/ep3.vtt", type: "text/vtt", language: "en" },
    ]);
    expect(item.content_encoded).toBe("<p>Full show notes</p>");
  });

  it("normalizes and drops invalid enum values", () => {
    const d = parseFeed(`<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
      <title>t</title><link>https://x</link><description>d</description>
      <itunes:explicit>TRUE</itunes:explicit>
      <podcast:medium>hologram</podcast:medium>
      <item><title>i</title><link>https://x/1</link><guid>g</guid>
        <itunes:episodeType>directors-cut</itunes:episodeType>
        <itunes:episode>not-a-number</itunes:episode>
      </item></channel></rss>`);
    expect(d.itunes!.explicit).toBe("yes");
    expect(d.podcast!.medium).toBeUndefined();
    expect(d.items[0].itunes!.episodeType).toBeUndefined();
    expect(d.items[0].itunes!.episode).toBeUndefined();
  });
});

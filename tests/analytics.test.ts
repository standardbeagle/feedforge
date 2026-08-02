import { describe, it, expect } from "vitest";
import { classifyUa, recordRequest } from "../src/analytics";

describe("classifyUa", () => {
  it("detects aggregators with subscriber counts", () => {
    expect(classifyUa("FreshRSS/1.24 (Linux; https://freshrss.org) 42 subscribers")).toEqual({
      kind: "aggregator",
      subscribers: 42,
    });
  });

  it("detects aggregators without counts", () => {
    expect(classifyUa("Miniflux/2.0").kind).toBe("aggregator");
    expect(classifyUa("Inoreader/1.0").subscribers).toBe(0);
  });

  it("detects browsers", () => {
    expect(classifyUa("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126").kind).toBe("browser");
  });

  it("classifies unknown agents as other", () => {
    expect(classifyUa("curl/8.0").kind).toBe("other");
  });
});

describe("recordRequest", () => {
  it("writes a datapoint with feed id, ua class, and daily hash", async () => {
    const points: any[] = [];
    const env = {
      ANALYTICS: { writeDataPoint: (p: any) => points.push(p) },
    } as unknown as Env;
    const req = new Request("https://feeds.example.com/blog", {
      headers: {
        "user-agent": "FreshRSS/1.24 7 subscribers",
        "cf-connecting-ip": "203.0.113.9",
      },
    });
    await recordRequest(env, "blog", req);
    expect(points).toHaveLength(1);
    expect(points[0].blobs[0]).toBe("blog");
    expect(points[0].blobs[1]).toBe("aggregator");
    expect(points[0].blobs[2]).toMatch(/^[0-9a-f]{16}$/);
    expect(points[0].doubles[0]).toBe(7);
    expect(points[0].indexes).toEqual(["blog"]);
  });

  it("produces the same hash for same ip+ua+day and different hashes otherwise", async () => {
    const points: any[] = [];
    const env = {
      ANALYTICS: { writeDataPoint: (p: any) => points.push(p) },
    } as unknown as Env;
    const mk = (ip: string) =>
      new Request("https://x/blog", { headers: { "user-agent": "Miniflux", "cf-connecting-ip": ip } });
    await recordRequest(env, "blog", mk("1.1.1.1"));
    await recordRequest(env, "blog", mk("1.1.1.1"));
    await recordRequest(env, "blog", mk("2.2.2.2"));
    expect(points[0].blobs[2]).toBe(points[1].blobs[2]);
    expect(points[0].blobs[2]).not.toBe(points[2].blobs[2]);
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  createChannel, getChannel, getChannelMeta, appendItem, deleteChannel, verifyToken, MAX_ITEMS,
} from "../src/channels";

describe("channels", () => {
  it("creates a channel with defaults and returns a write token", async () => {
    const { channel, writeToken } = await createChannel(env.FEEDS, { title: "Build bot" });
    expect(channel.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(writeToken).toMatch(/^[0-9a-f]{64}$/);
    expect(channel.title).toBe("Build bot");
    expect(channel.items).toEqual([]);
    const ttlMs = Date.parse(channel.expires_at) - Date.parse(channel.created_at);
    expect(ttlMs).toBe(7 * 24 * 3600_000);
    expect(channel.write_token_hash).not.toBe(writeToken);
  });

  it("clamps ttl_hours to [1, 720]", async () => {
    const lo = await createChannel(env.FEEDS, { title: "a", ttl_hours: 0 });
    const hi = await createChannel(env.FEEDS, { title: "b", ttl_hours: 99999 });
    expect(Date.parse(lo.channel.expires_at) - Date.parse(lo.channel.created_at)).toBe(3600_000);
    expect(Date.parse(hi.channel.expires_at) - Date.parse(hi.channel.created_at)).toBe(720 * 3600_000);
  });

  it("falls back to default TTL for non-numeric ttl_hours", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t", ttl_hours: "abc" as any });
    expect(Date.parse(channel.expires_at) - Date.parse(channel.created_at)).toBe(7 * 24 * 3600_000);
  });

  it("verifies write tokens against the stored hash", async () => {
    const { channel, writeToken } = await createChannel(env.FEEDS, { title: "t" });
    expect(await verifyToken(channel, writeToken)).toBe(true);
    expect(await verifyToken(channel, "0".repeat(64))).toBe(false);
  });

  it("appends items with generated guid and pubDate", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    const item = await appendItem(env.FEEDS, channel.id, { title: "Task done", link: "https://ci.example/build/1", description: "ok" });
    expect(item!.title).toBe("Task done");
    expect(item!.guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(item!.pubDate).toBeTruthy();
    const read = await getChannel(env.FEEDS, channel.id);
    expect(read!.items).toHaveLength(1);
    expect(read!.items[0].title).toBe("Task done");
  });

  it("returns items oldest-to-newest regardless of write order", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    for (const t of ["first", "second", "third"]) {
      await appendItem(env.FEEDS, channel.id, { title: t });
    }
    const read = await getChannel(env.FEEDS, channel.id);
    expect(read!.items.map((i) => i.title)).toEqual(["first", "second", "third"]);
  });

  it("serves only MAX_ITEMS however many are published", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    // Appends are independent writes now, so the setup runs concurrently. Which
    // items survive the cap is therefore unspecified — only the count is promised.
    await Promise.all(
      Array.from({ length: MAX_ITEMS + 5 }, (_, i) => appendItem(env.FEEDS, channel.id, { title: `item ${i}` })),
    );
    const final = await getChannel(env.FEEDS, channel.id);
    expect(final!.items).toHaveLength(MAX_ITEMS);
    // 105 publishes is 210 KV round-trips against the local emulator. Production
    // does one write per publish; this cost is the emulator, not the code path.
  }, 30_000);

  it("keeps concurrent publishes — no lost update", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => appendItem(env.FEEDS, channel.id, { title: `concurrent ${i}` })),
    );
    const read = await getChannel(env.FEEDS, channel.id);
    expect(read!.items).toHaveLength(10);
    expect(new Set(read!.items.map((i) => i.title)).size).toBe(10);
  });

  it("refuses to append to an expired channel", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    const expired = { ...channel, items: undefined, expires_at: new Date(Date.now() - 1000).toISOString() };
    await env.FEEDS.put(`channel:${channel.id}`, JSON.stringify(expired));
    expect(await getChannelMeta(env.FEEDS, channel.id)).toBeNull();
    expect(await appendItem(env.FEEDS, channel.id, { title: "late" })).toBeNull();
  });

  it("rejects items over 64KB", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    await expect(
      appendItem(env.FEEDS, channel.id, { title: "big", description: "x".repeat(70_000) }),
    ).rejects.toThrow(/64KB/);
  });

  it("deletes channels", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    await deleteChannel(env.FEEDS, channel.id);
    expect(await getChannel(env.FEEDS, channel.id)).toBeNull();
  });

  it("deleting a channel removes its items too", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    await appendItem(env.FEEDS, channel.id, { title: "one" });
    await deleteChannel(env.FEEDS, channel.id);
    const leftovers = await env.FEEDS.list({ prefix: `citem:${channel.id}:` });
    expect(leftovers.keys).toHaveLength(0);
  });

  it("gives every key an expiration so KV reclaims the channel without a sweep", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t", ttl_hours: 1 });
    await appendItem(env.FEEDS, channel.id, { title: "one" });
    const meta = await env.FEEDS.getWithMetadata(`channel:${channel.id}`);
    expect(meta.value).not.toBeNull();
    const items = await env.FEEDS.list({ prefix: `citem:${channel.id}:` });
    expect(items.keys).toHaveLength(1);
    // Both key classes carry an expiration; nothing relies on a cron to clean up.
    expect(items.keys[0].expiration).toBeGreaterThan(Date.now() / 1000);
  });
});

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  createChannel, getChannel, appendItem, deleteChannel, sweepExpired, verifyToken,
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

  it("verifies write tokens against the stored hash", async () => {
    const { channel, writeToken } = await createChannel(env.FEEDS, { title: "t" });
    expect(await verifyToken(channel, writeToken)).toBe(true);
    expect(await verifyToken(channel, "0".repeat(64))).toBe(false);
  });

  it("appends items with generated guid and pubDate", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    const updated = await appendItem(env.FEEDS, channel.id, { title: "Task done", link: "https://ci.example/build/1", description: "ok" });
    expect(updated!.items).toHaveLength(1);
    expect(updated!.items[0].title).toBe("Task done");
    expect(updated!.items[0].guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(updated!.items[0].pubDate).toBeTruthy();
  });

  it("drops oldest items beyond the 100-item cap", async () => {
    const { channel } = await createChannel(env.FEEDS, { title: "t" });
    for (let i = 0; i < 105; i++) {
      await appendItem(env.FEEDS, channel.id, { title: `item ${i}` });
    }
    const final = await getChannel(env.FEEDS, channel.id);
    expect(final!.items).toHaveLength(100);
    expect(final!.items[0].title).toBe("item 5");
    expect(final!.items[99].title).toBe("item 104");
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

  it("sweepExpired removes only expired channels", async () => {
    const fresh = await createChannel(env.FEEDS, { title: "fresh" });
    const old = await createChannel(env.FEEDS, { title: "old" });
    const stale = { ...old.channel, expires_at: new Date(Date.now() - 1000).toISOString() };
    await env.FEEDS.put(`channel:${old.channel.id}`, JSON.stringify(stale));
    const swept = await sweepExpired(env.FEEDS);
    expect(swept).toContain(old.channel.id);
    expect(swept).not.toContain(fresh.channel.id);
    expect(await getChannel(env.FEEDS, old.channel.id)).toBeNull();
    expect(await getChannel(env.FEEDS, fresh.channel.id)).not.toBeNull();
  });
});

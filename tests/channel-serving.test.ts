import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function mkChannelWithItem() {
  const create = await SELF.fetch("https://feeds.example.com/api/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Deploy bot", description: "deploy notifications" }),
  });
  const ch = (await create.json()) as any;
  await SELF.fetch(`https://feeds.example.com/api/channels/${ch.id}/items`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ch.write_token}` },
    body: JSON.stringify({ title: "v42 deployed", link: "https://ci.example/v42" }),
  });
  return ch;
}

describe("channel feed serving", () => {
  it("serves a channel as RSS at /<id>", async () => {
    const ch = await mkChannelWithItem();
    const res = await SELF.fetch(`https://feeds.example.com/${ch.id}`, {
      headers: { "user-agent": "Miniflux/2.0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    const body = await res.text();
    expect(body).toContain("Deploy bot");
    expect(body).toContain("v42 deployed");
  });

  it("serves the browser view for channels", async () => {
    const ch = await mkChannelWithItem();
    const res = await SELF.fetch(`https://feeds.example.com/${ch.id}`, {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 Chrome/126" },
    });
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Deploy bot");
  });

  it("serves Atom format for channels", async () => {
    const ch = await mkChannelWithItem();
    const res = await SELF.fetch(`https://feeds.example.com/${ch.id}?format=atom`, {
      headers: { "user-agent": "Miniflux/2.0" },
    });
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    expect(await res.text()).toContain("v42 deployed");
  });

  it("404s after channel deletion", async () => {
    const ch = await mkChannelWithItem();
    await SELF.fetch(`https://feeds.example.com/api/channels/${ch.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ch.write_token}` },
    });
    const res = await SELF.fetch(`https://feeds.example.com/${ch.id}`, {
      headers: { "user-agent": "Miniflux/2.0" },
    });
    expect(res.status).toBe(404);
  });

  it("sweeps expired channels on cron", async () => {
    const { env } = await import("cloudflare:test");
    const create = await SELF.fetch("https://feeds.example.com/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "doomed" }),
    });
    const ch = (await create.json()) as any;
    const raw = await env.FEEDS.get(`channel:${ch.id}`);
    const expired = { ...JSON.parse(raw!), expires_at: new Date(Date.now() - 1000).toISOString() };
    await env.FEEDS.put(`channel:${ch.id}`, JSON.stringify(expired));
    const { createScheduledController } = await import("cloudflare:test");
    const worker = (await import("../src/worker")).default;
    const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: "*/30 * * * *" });
    let pending: Promise<any> | undefined;
    await worker.scheduled(ctrl as any, env, { waitUntil: (p: Promise<any>) => { pending = p; } } as any);
    await pending;
    expect(await env.FEEDS.get(`channel:${ch.id}`)).toBeNull();
  });
});

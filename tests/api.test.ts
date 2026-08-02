import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function mkChannel(body: object = { title: "CI bot", ttl_hours: 2 }) {
  const res = await SELF.fetch("https://feeds.example.com/api/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as any };
}

describe("channel API", () => {
  it("creates a channel and returns id, token, feed_url, expiry", async () => {
    const { res, json } = await mkChannel();
    expect(res.status).toBe(201);
    expect(json.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.write_token).toMatch(/^[0-9a-f]{64}$/);
    expect(json.feed_url).toBe(`https://feeds.example.com/${json.id}`);
    expect(json.expires_at).toBeTruthy();
  });

  it("rejects create without a title", async () => {
    const { res } = await mkChannel({});
    expect(res.status).toBe(400);
  });

  it("publishes an item with the write token", async () => {
    const { json } = await mkChannel();
    const res = await SELF.fetch(`https://feeds.example.com/api/channels/${json.id}/items`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${json.write_token}`,
      },
      body: JSON.stringify({ title: "Build finished", link: "https://ci.example/1", description: "green" }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects publish without or with wrong token", async () => {
    const { json } = await mkChannel();
    const noAuth = await SELF.fetch(`https://feeds.example.com/api/channels/${json.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(noAuth.status).toBe(401);
    const badAuth = await SELF.fetch(`https://feeds.example.com/api/channels/${json.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${"f".repeat(64)}` },
      body: JSON.stringify({ title: "x" }),
    });
    expect(badAuth.status).toBe(403);
  });

  it("returns 404 publishing to a missing channel", async () => {
    const res = await SELF.fetch(`https://feeds.example.com/api/channels/${crypto.randomUUID()}/items`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${"f".repeat(64)}` },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("deletes a channel with the write token", async () => {
    const { json } = await mkChannel();
    const res = await SELF.fetch(`https://feeds.example.com/api/channels/${json.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${json.write_token}` },
    });
    expect(res.status).toBe(204);
    const again = await SELF.fetch(`https://feeds.example.com/api/channels/${json.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${json.write_token}` },
    });
    expect(again.status).toBe(404);
  });

  it("rejects oversized items", async () => {
    const { json } = await mkChannel();
    const res = await SELF.fetch(`https://feeds.example.com/api/channels/${json.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${json.write_token}` },
      body: JSON.stringify({ title: "big", description: "x".repeat(70_000) }),
    });
    expect(res.status).toBe(413);
  });
});

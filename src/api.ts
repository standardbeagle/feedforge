import { createChannel, getChannel, appendItem, deleteChannel, verifyToken } from "./channels";
import { KVFeedStore } from "./registry";
import { pollFeed } from "./poller";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bearer(request: Request): string | null {
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

async function authedChannel(env: Env, id: string, request: Request): Promise<Response | import("./channels").Channel> {
  const channel = await getChannel(env.FEEDS, id);
  if (!channel) return json({ error: "channel not found" }, 404);
  const token = bearer(request);
  if (!token) return json({ error: "missing bearer token" }, 401);
  if (!(await verifyToken(channel, token))) return json({ error: "invalid token" }, 403);
  return channel;
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "POST" && Number(request.headers.get("content-length") ?? 0) > 128 * 1024) {
    return json({ error: "request body too large" }, 413);
  }
  const parts = url.pathname.split("/").filter(Boolean); // ["api","channels",<id>?,"items"?]

  if (parts[1] === "feeds" && parts[3] === "refresh" && parts.length === 4 && request.method === "POST") {
    const secret = env.REFRESH_TOKEN;
    if (!secret) return json({ error: "not found" }, 404);
    const token = bearer(request);
    if (!token) return json({ error: "missing bearer token" }, 401);
    if (token !== secret) return json({ error: "invalid token" }, 403);
    const store = new KVFeedStore(env.FEEDS);
    const { feeds } = await store.getRegistry();
    const entry = feeds.find((f) => f.id === parts[2]);
    if (!entry) return json({ error: "feed not found" }, 404);
    const result = await pollFeed(entry, store, fetch, { force: true });
    return json(
      { id: result.id, status: result.status, message: result.message },
      result.status === "error" ? 502 : 200,
    );
  }

  if (parts[1] !== "channels") return json({ error: "not found" }, 404);

  if (request.method === "POST" && parts.length === 2) {
    let body: { title?: string; description?: string; ttl_hours?: number };
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!body.title || typeof body.title !== "string") {
      return json({ error: "title is required" }, 400);
    }
    const { channel, writeToken } = await createChannel(env.FEEDS, body as { title: string });
    return json({
      id: channel.id,
      write_token: writeToken,
      feed_url: `${url.origin}/${channel.id}`,
      expires_at: channel.expires_at,
    }, 201);
  }

  const id = parts[2];
  if (!id) return json({ error: "not found" }, 404);

  if (request.method === "POST" && parts[3] === "items") {
    const auth = await authedChannel(env, id, request);
    if (auth instanceof Response) return auth;
    let item: { title?: string; link?: string; description?: string };
    try {
      item = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!item.title || typeof item.title !== "string") {
      return json({ error: "title is required" }, 400);
    }
    try {
      await appendItem(env.FEEDS, id, item as { title: string });
    } catch (e) {
      if ((e as Error).message.includes("64KB")) return json({ error: (e as Error).message }, 413);
      throw e;
    }
    return json({ ok: true }, 201);
  }

  if (request.method === "DELETE" && parts.length === 3) {
    const auth = await authedChannel(env, id, request);
    if (auth instanceof Response) return auth;
    await deleteChannel(env.FEEDS, id);
    return new Response(null, { status: 204 });
  }

  return json({ error: "not found" }, 404);
}

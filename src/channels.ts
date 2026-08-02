export interface ChannelItem {
  title: string;
  link?: string;
  guid: string;
  pubDate: string;
  description?: string;
}

export interface Channel {
  id: string;
  title: string;
  description: string;
  write_token_hash: string;
  created_at: string;
  expires_at: string;
  items: ChannelItem[];
}

export const MAX_ITEMS = 100;
export const MAX_ITEM_BYTES = 64 * 1024;
const DEFAULT_TTL_HOURS = 24 * 7;
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 24 * 30;

async function sha256hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createChannel(
  kv: KVNamespace,
  opts: { title: string; description?: string; ttl_hours?: number },
): Promise<{ channel: Channel; writeToken: string }> {
  const ttl = Math.min(Math.max(opts.ttl_hours ?? DEFAULT_TTL_HOURS, MIN_TTL_HOURS), MAX_TTL_HOURS);
  const now = Date.now();
  const writeToken = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const channel: Channel = {
    id: crypto.randomUUID(),
    title: opts.title,
    description: opts.description ?? "",
    write_token_hash: await sha256hex(writeToken),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * 3600_000).toISOString(),
    items: [],
  };
  await kv.put(`channel:${channel.id}`, JSON.stringify(channel));
  return { channel, writeToken };
}

export async function getChannel(kv: KVNamespace, id: string): Promise<Channel | null> {
  const raw = await kv.get(`channel:${id}`);
  if (!raw) return null;
  const channel = JSON.parse(raw) as Channel;
  if (Date.parse(channel.expires_at) <= Date.now()) return null;
  return channel;
}

export async function verifyToken(channel: Channel, token: string): Promise<boolean> {
  return (await sha256hex(token)) === channel.write_token_hash;
}

export async function appendItem(
  kv: KVNamespace,
  id: string,
  item: { title: string; link?: string; description?: string },
): Promise<Channel | null> {
  const size = new TextEncoder().encode(
    item.title + (item.link ?? "") + (item.description ?? ""),
  ).byteLength;
  if (size > MAX_ITEM_BYTES) throw new Error(`item exceeds 64KB limit (${size} bytes)`);

  const channel = await getChannel(kv, id);
  if (!channel) return null;
  channel.items.push({
    title: item.title,
    link: item.link,
    description: item.description,
    guid: crypto.randomUUID(),
    pubDate: new Date().toUTCString(),
  });
  if (channel.items.length > MAX_ITEMS) {
    channel.items = channel.items.slice(channel.items.length - MAX_ITEMS);
  }
  await kv.put(`channel:${id}`, JSON.stringify(channel));
  return channel;
}

export async function deleteChannel(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(`channel:${id}`);
}

export async function sweepExpired(kv: KVNamespace): Promise<string[]> {
  const swept: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "channel:", cursor });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (raw && Date.parse(JSON.parse(raw).expires_at) <= Date.now()) {
        await kv.delete(key.name);
        swept.push(key.name.slice("channel:".length));
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return swept;
}

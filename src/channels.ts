export interface ChannelItem {
  title: string;
  link?: string;
  guid: string;
  pubDate: string;
  description?: string;
}

/** Everything about a channel except its items. One KV key, written only at create. */
export interface ChannelMeta {
  id: string;
  title: string;
  description: string;
  write_token_hash: string;
  created_at: string;
  expires_at: string;
}

export interface Channel extends ChannelMeta {
  items: ChannelItem[];
}

/**
 * How many items the feed serves. Items past this are simply never read; they are
 * not deleted eagerly, because doing so would put an O(items) list on every publish
 * to reclaim keys that expire with the channel anyway.
 */
export const MAX_ITEMS = 100;
export const MAX_ITEM_BYTES = 64 * 1024;
const DEFAULT_TTL_HOURS = 24 * 7;
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 24 * 30;
/** KV rejects any expirationTtl below 60s. */
const MIN_KV_TTL_SECONDS = 60;

const metaKey = (id: string) => `channel:${id}`;
const itemPrefix = (id: string) => `citem:${id}:`;

/** Year-10000 ceiling, so a descending sort key stays 13 digits and never goes negative. */
const KEY_TIME_CEILING = 9_999_999_999_999;

/**
 * Keys sort newest-first, which is what makes a read one bounded KV list: asking for
 * MAX_ITEMS keys returns exactly the items the feed serves, with no pagination and
 * no values loaded to decide ordering.
 */
const itemKey = (id: string, atMs: number) =>
  `${itemPrefix(id)}${String(KEY_TIME_CEILING - atMs).padStart(13, "0")}:${crypto.randomUUID()}`;

async function sha256hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Seconds a key written now should live for, so KV expires the channel itself. */
function ttlSecondsUntil(expiresAt: string): number {
  const remaining = Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000);
  return Math.max(remaining, MIN_KV_TTL_SECONDS);
}

export async function createChannel(
  kv: KVNamespace,
  opts: { title: string; description?: string; ttl_hours?: number },
): Promise<{ channel: Channel; writeToken: string }> {
  const raw = typeof opts.ttl_hours === "number" && Number.isFinite(opts.ttl_hours) ? opts.ttl_hours : DEFAULT_TTL_HOURS;
  const ttl = Math.min(Math.max(raw, MIN_TTL_HOURS), MAX_TTL_HOURS);
  const now = Date.now();
  const writeToken = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const meta: ChannelMeta = {
    id: crypto.randomUUID(),
    title: opts.title,
    description: opts.description ?? "",
    write_token_hash: await sha256hex(writeToken),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * 3600_000).toISOString(),
  };
  await kv.put(metaKey(meta.id), JSON.stringify(meta), {
    expirationTtl: ttlSecondsUntil(meta.expires_at),
  });
  return { channel: { ...meta, items: [] }, writeToken };
}

export async function getChannelMeta(kv: KVNamespace, id: string): Promise<ChannelMeta | null> {
  const raw = await kv.get(metaKey(id));
  if (!raw) return null;
  const meta = JSON.parse(raw) as ChannelMeta;
  // KV expiry is eventual; the stored timestamp is authoritative.
  if (Date.parse(meta.expires_at) <= Date.now()) return null;
  return meta;
}

/** Newest first, capped — one KV list page, never the whole channel history. */
async function listItems(kv: KVNamespace, id: string): Promise<ChannelItem[]> {
  const page = await kv.list({ prefix: itemPrefix(id), limit: MAX_ITEMS });
  const raws = await Promise.all(page.keys.map((k) => kv.get(k.name)));
  // A key can expire between the list and the get; a hole is not an error.
  const newestFirst = raws
    .filter((r): r is string => r !== null)
    .map((r) => JSON.parse(r) as ChannelItem);
  return newestFirst.reverse();
}

export async function getChannel(kv: KVNamespace, id: string): Promise<Channel | null> {
  const meta = await getChannelMeta(kv, id);
  if (!meta) return null;
  return { ...meta, items: await listItems(kv, id) };
}

export async function verifyToken(channel: ChannelMeta, token: string): Promise<boolean> {
  return timingSafeEqual(await sha256hex(token), channel.write_token_hash);
}

/** Compares in time proportional to length only, never to the position of a mismatch. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Appends by writing a key no other request will pick, so concurrent publishers
 * cannot clobber each other — the previous read-modify-write of a single items
 * array silently dropped one of any two simultaneous items.
 */
export async function appendItem(
  kv: KVNamespace,
  id: string,
  item: { title: string; link?: string; description?: string },
): Promise<ChannelItem | null> {
  const size = new TextEncoder().encode(
    item.title + (item.link ?? "") + (item.description ?? ""),
  ).byteLength;
  if (size > MAX_ITEM_BYTES) throw new Error(`item exceeds 64KB limit (${size} bytes)`);

  const meta = await getChannelMeta(kv, id);
  if (!meta) return null;

  const now = Date.now();
  const stored: ChannelItem = {
    title: item.title,
    link: item.link,
    description: item.description,
    guid: crypto.randomUUID(),
    pubDate: new Date(now).toUTCString(),
  };
  // A single put with a key nobody else will choose. No read-modify-write, so
  // there is nothing for a concurrent publisher to clobber.
  await kv.put(itemKey(id, now), JSON.stringify(stored), {
    expirationTtl: ttlSecondsUntil(meta.expires_at),
  });
  return stored;
}

export async function deleteChannel(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(metaKey(id));
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: itemPrefix(id), cursor });
    await Promise.all(page.keys.map((k) => kv.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

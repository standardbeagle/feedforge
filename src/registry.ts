export interface FeedEntry {
  id: string;
  origin: string;
  poll_minutes: number;
  created_at: string;
}

export interface Registry {
  feeds: FeedEntry[];
  domains: Record<string, string>;
}

export interface FeedMeta {
  etag?: string;
  last_modified?: string;
  last_fetched: string;
  title: string;
  item_count: number;
  error_count: number;
  last_error?: string;
}

export interface StoredFeed {
  xml: string;
  meta: FeedMeta;
}

export interface FeedStore {
  getRegistry(): Promise<Registry>;
  putRegistry(reg: Registry): Promise<void>;
  getFeed(id: string): Promise<StoredFeed | null>;
  putFeed(id: string, feed: StoredFeed): Promise<void>;
  resolveHost(hostname: string): Promise<string | null>;
}

export class KVFeedStore implements FeedStore {
  constructor(private kv: KVNamespace) {}

  async getRegistry(): Promise<Registry> {
    const raw = await this.kv.get("feeds.json");
    return raw ? JSON.parse(raw) : { feeds: [], domains: {} };
  }

  async putRegistry(reg: Registry): Promise<void> {
    await this.kv.put("feeds.json", JSON.stringify(reg));
  }

  async getFeed(id: string): Promise<StoredFeed | null> {
    const raw = await this.kv.get(`feed:${id}`);
    return raw ? JSON.parse(raw) : null;
  }

  async putFeed(id: string, feed: StoredFeed): Promise<void> {
    await this.kv.put(`feed:${id}`, JSON.stringify(feed));
  }

  async resolveHost(hostname: string): Promise<string | null> {
    const reg = await this.getRegistry();
    return reg.domains[hostname] ?? null;
  }
}

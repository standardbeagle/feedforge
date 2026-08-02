# FeedBurner Clone on Cloudflare — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal FeedBurner clone on Cloudflare Workers: cron-polled feed proxying/normalization, aggregate analytics, browser-friendly feed view, and MyBrand custom domains.

**Architecture:** Single TypeScript Worker with `fetch` + `scheduled` handlers. Cron polls origins, normalizes to RSS 2.0, stores in KV. Fetch handler resolves feed id from hostname (MyBrand) or path, records an Analytics Engine datapoint, serves XML or an HTML landing page. Feed registry lives in KV (`feeds.json`), managed by a Node CLI wrapping wrangler.

**Tech Stack:** TypeScript, Cloudflare Workers, KV, Analytics Engine, Cron Triggers, fast-xml-parser, Vitest + @cloudflare/vitest-pool-workers, tsx (CLI).

**Spec:** `docs/superpowers/specs/2026-08-01-feedburner-cloudflare-design.md`

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts` | Project config |
| `src/normalize.ts` | Parse RSS2/Atom/RDF → `FeedDoc`; emit RSS2/Atom XML |
| `src/registry.ts` | `FeedStore` interface + KV implementation |
| `src/poller.ts` | Origin polling with conditional GET, error handling |
| `src/router.ts` | Hostname/path → feed id resolution |
| `src/analytics.ts` | UA classification, subscriber estimate, datapoint emission |
| `src/view.ts` | Browser-friendly HTML feed page |
| `src/worker.ts` | Entry point wiring fetch + scheduled |
| `src/cli.ts` | Feed management CLI (add/remove/list/map-domain) |
| `tests/*.test.ts`, `tests/fixtures/*.xml` | Unit + integration tests |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "feedforge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "feeds": "tsx src/cli.ts"
  },
  "dependencies": {
    "fast-xml-parser": "^4.4.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20250617.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0",
    "wrangler": "^3.60.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests"]
}
```

`wrangler.toml` (placeholder KV id replaced at deploy time; Miniflare accepts any id for tests):
```toml
name = "feedforge"
main = "src/worker.ts"
compatibility_date = "2025-06-01"

[triggers]
crons = ["*/30 * * * *"]

[[kv_namespaces]]
binding = "FEEDS"
id = "00000000000000000000000000000000"

[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "feedforge"
```

`vitest.config.ts`:
```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
```

`.gitignore`:
```
node_modules/
dist/
.wrangler/
```

- [ ] **Step 2: Install and verify toolchain**

Run: `npm install && npx tsc --noEmit`
Expected: installs cleanly, tsc exits 0 (no source files yet is fine)

- [ ] **Step 3: Commit**

```bash
git add package.json tsconfig.json wrangler.toml vitest.config.ts .gitignore package-lock.json
git commit -m "chore: scaffold Worker project with vitest workers pool"
```

---

### Task 2: XML sanitize + feed parsing (`parseFeed`)

**Files:**
- Create: `src/normalize.ts`
- Create: `tests/fixtures/valid-rss.xml`
- Create: `tests/fixtures/valid-atom.xml`
- Create: `tests/fixtures/bare-ampersand.xml`
- Test: `tests/normalize.test.ts`

- [ ] **Step 1: Write fixtures**

`tests/fixtures/valid-rss.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com</link>
    <description>An example blog</description>
    <item>
      <title>First Post</title>
      <link>https://example.com/first</link>
      <guid>https://example.com/first</guid>
      <pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate>
      <description>Hello world</description>
    </item>
  </channel>
</rss>
```

`tests/fixtures/valid-atom.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <link href="https://example.org"/>
  <id>https://example.org/feed</id>
  <updated>2026-06-01T12:00:00Z</updated>
  <entry>
    <title>Atom Post</title>
    <link href="https://example.org/post"/>
    <id>https://example.org/post</id>
    <updated>2026-06-01T12:00:00Z</updated>
    <summary>Atom hello</summary>
  </entry>
</feed>
```

`tests/fixtures/bare-ampersand.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Tom &amp; Jerry Blog</title>
    <link>https://example.net?a=1&b=2</link>
    <description>Mixed & broken</description>
    <item>
      <title>Post &amp; More</title>
      <link>https://example.net/p?x=1&y=2</link>
      <guid>g1</guid>
    </item>
  </channel>
</rss>
```

- [ ] **Step 2: Write the failing test**

`tests/normalize.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFeed, FeedParseError } from "../src/normalize";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseFeed", () => {
  it("parses RSS 2.0", () => {
    const doc = parseFeed(fixture("valid-rss.xml"));
    expect(doc.title).toBe("Example Blog");
    expect(doc.link).toBe("https://example.com");
    expect(doc.description).toBe("An example blog");
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]).toMatchObject({
      title: "First Post",
      link: "https://example.com/first",
      guid: "https://example.com/first",
      pubDate: "Mon, 01 Jun 2026 12:00:00 GMT",
    });
  });

  it("parses Atom", () => {
    const doc = parseFeed(fixture("valid-atom.xml"));
    expect(doc.title).toBe("Atom Blog");
    expect(doc.link).toBe("https://example.org");
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].title).toBe("Atom Post");
    expect(doc.items[0].link).toBe("https://example.org/post");
  });

  it("repairs bare ampersands", () => {
    const doc = parseFeed(fixture("bare-ampersand.xml"));
    expect(doc.title).toBe("Tom & Jerry Blog");
    expect(doc.description).toBe("Mixed & broken");
    expect(doc.items[0].link).toBe("https://example.net/p?x=1&y=2");
  });

  it("throws FeedParseError on non-feed XML", () => {
    expect(() => parseFeed("<html><body>nope</body></html>")).toThrow(FeedParseError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/normalize.test.ts`
Expected: FAIL — `../src/normalize` does not exist

- [ ] **Step 4: Implement `src/normalize.ts`**

```ts
import { XMLParser, XMLBuilder } from "fast-xml-parser";

export interface FeedItem {
  title: string;
  link: string;
  guid: string;
  pubDate?: string;
  description?: string;
}

export interface FeedDoc {
  title: string;
  link: string;
  description: string;
  items: FeedItem[];
}

export class FeedParseError extends Error {}

const parserOpts = { ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false };

export function sanitizeXml(raw: string): string {
  return raw.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return String(o["#text"] ?? "");
  }
  return String(v);
}

function atomLink(v: unknown): string {
  for (const l of asArray(v as object | object[])) {
    const o = l as Record<string, unknown>;
    if (o["@_rel"] === undefined || o["@_rel"] === "alternate") {
      return String(o["@_href"] ?? text(l));
    }
  }
  return "";
}

export function parseFeed(raw: string): FeedDoc {
  let doc: Record<string, any>;
  try {
    doc = new XMLParser(parserOpts).parse(sanitizeXml(raw));
  } catch (e) {
    throw new FeedParseError(`XML parse failed: ${(e as Error).message}`);
  }

  const channel = doc.rss?.channel ?? doc["rdf:RDF"]?.channel;
  if (channel) {
    const rawItems = asArray<any>(channel.item ?? doc["rdf:RDF"]?.item);
    return {
      title: text(channel.title),
      link: text(channel.link),
      description: text(channel.description),
      items: rawItems.map((i) => ({
        title: text(i.title),
        link: text(i.link),
        guid: text(i.guid ?? i.link),
        pubDate: text(i.pubDate ?? i["dc:date"]) || undefined,
        description: text(i.description) || undefined,
      })),
    };
  }

  if (doc.feed) {
    const f = doc.feed;
    return {
      title: text(f.title),
      link: atomLink(f.link),
      description: text(f.subtitle),
      items: asArray<any>(f.entry).map((e) => ({
        title: text(e.title),
        link: atomLink(e.link),
        guid: text(e.id) || atomLink(e.link),
        pubDate: text(e.published ?? e.updated) || undefined,
        description: text(e.summary ?? e.content) || undefined,
      })),
    };
  }

  throw new FeedParseError("Document is not RSS or Atom");
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  suppressBooleanAttributes: false,
});

const XML_DECL = `<?xml version="1.0" encoding="UTF-8"?>\n`;

export function buildRss(doc: FeedDoc): string {
  const channel: Record<string, unknown> = {
    title: doc.title,
    link: doc.link,
    description: doc.description,
    item: doc.items.map((i) => {
      const item: Record<string, string> = {
        title: i.title,
        link: i.link,
        guid: i.guid,
      };
      if (i.pubDate) item.pubDate = i.pubDate;
      if (i.description) item.description = i.description;
      return item;
    }),
  };
  return XML_DECL + builder.build({ rss: { "@_version": "2.0", channel } });
}

export function buildAtom(doc: FeedDoc): string {
  const updated = doc.items[0]?.pubDate ?? new Date(0).toISOString();
  return XML_DECL + builder.build({
    feed: {
      "@_xmlns": "http://www.w3.org/2005/Atom",
      title: doc.title,
      link: { "@_href": doc.link },
      id: doc.link,
      updated,
      entry: doc.items.map((i) => ({
        title: i.title,
        link: { "@_href": i.link },
        id: i.guid,
        updated: i.pubDate ?? updated,
        summary: i.description ?? "",
      })),
    },
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/normalize.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/normalize.ts tests/normalize.test.ts tests/fixtures/
git commit -m "feat: parse RSS2/Atom/RDF into FeedDoc with ampersand repair"
```

---

### Task 3: Emit RSS 2.0 and Atom (`buildRss`, `buildAtom`)

The emitters were written in Task 2; this task adds round-trip tests.

**Files:**
- Modify: `tests/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/normalize.test.ts`:
```ts
import { buildRss, buildAtom } from "../src/normalize";

describe("emit round-trip", () => {
  it("RSS output re-parses to the same doc", () => {
    const doc = parseFeed(fixture("valid-rss.xml"));
    const out = buildRss(doc);
    expect(parseFeed(out)).toEqual(doc);
  });

  it("Atom input emits valid RSS", () => {
    const doc = parseFeed(fixture("valid-atom.xml"));
    const out = buildRss(doc);
    const back = parseFeed(out);
    expect(back.title).toBe("Atom Blog");
    expect(back.items[0].link).toBe("https://example.org/post");
  });

  it("Atom output re-parses to the same doc", () => {
    const doc = parseFeed(fixture("valid-rss.xml"));
    const back = parseFeed(buildAtom(doc));
    expect(back.title).toBe(doc.title);
    expect(back.items[0].link).toBe(doc.items[0].link);
  });

  it("escapes special characters in output", () => {
    const doc = parseFeed(fixture("bare-ampersand.xml"));
    const out = buildRss(doc);
    expect(out).toContain("Tom &amp; Jerry Blog");
    expect(out).not.toMatch(/&(?!amp|lt|gt|quot|apos|#)/);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/normalize.test.ts`
Expected: PASS all 8 tests. If round-trip mismatches appear (e.g. empty-string vs undefined optional fields), normalize the comparison — set optional fields to `undefined` only when absent in both, or adjust `buildRss` to omit empty descriptions. Fix in `src/normalize.ts`, not by weakening assertions.

- [ ] **Step 3: Commit**

```bash
git add src/normalize.ts tests/normalize.test.ts
git commit -m "feat: emit valid RSS 2.0 and Atom from FeedDoc"
```

---

### Task 4: KV feed registry (`FeedStore`)

**Files:**
- Create: `src/registry.ts`
- Test: `tests/registry.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/registry.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { KVFeedStore } from "../src/registry";

describe("KVFeedStore", () => {
  it("returns empty registry when unset", async () => {
    const store = new KVFeedStore(env.FEEDS);
    expect(await store.getRegistry()).toEqual({ feeds: [], domains: {} });
  });

  it("round-trips a registry", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const reg = {
      feeds: [{ id: "blog", origin: "https://example.com/rss", poll_minutes: 30, created_at: "2026-08-01T00:00:00Z" }],
      domains: { "feeds.example.org": "blog" },
    };
    await store.putRegistry(reg);
    expect(await store.getRegistry()).toEqual(reg);
  });

  it("round-trips a stored feed", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const feed = {
      xml: "<rss/>",
      meta: { last_fetched: "2026-08-01T00:00:00Z", title: "T", item_count: 0, error_count: 0 },
    };
    await store.putFeed("blog", feed);
    expect(await store.getFeed("blog")).toEqual(feed);
    expect(await store.getFeed("missing")).toBeNull();
  });

  it("resolves hostnames", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({ feeds: [], domains: { "feeds.example.org": "blog" } });
    expect(await store.resolveHost("feeds.example.org")).toBe("blog");
    expect(await store.resolveHost("other.org")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — `../src/registry` does not exist

- [ ] **Step 3: Implement `src/registry.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/registry.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts tests/registry.test.ts
git commit -m "feat: KV-backed feed registry and feed body store"
```

---

### Task 5: Poller (`pollFeed`, `pollAll`)

**Files:**
- Create: `src/poller.ts`
- Test: `tests/poller.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/poller.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { readFileSync } from "node:fs";
import { KVFeedStore, type FeedEntry, type StoredFeed } from "../src/registry";
import { pollFeed, pollAll } from "../src/poller";

const rss = readFileSync(new URL("./fixtures/valid-rss.xml", import.meta.url), "utf8");
const entry: FeedEntry = { id: "blog", origin: "https://origin.test/rss", poll_minutes: 30, created_at: "2026-08-01T00:00:00Z" };

const resp = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

const fetcher = (r: Response) => (async () => r.clone()) as typeof fetch;

describe("pollFeed", () => {
  it("fetches, normalizes, and stores a new feed", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const result = await pollFeed(entry, store, fetcher(resp(rss, 200, { etag: "v1" })));
    expect(result.status).toBe("ok");
    const stored = await store.getFeed("blog");
    expect(stored!.meta.title).toBe("Example Blog");
    expect(stored!.meta.item_count).toBe(1);
    expect(stored!.meta.etag).toBe("v1");
    expect(stored!.meta.error_count).toBe(0);
  });

  it("sends conditional headers and keeps body on 304", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const prior: StoredFeed = {
      xml: "<old/>",
      meta: { etag: "v1", last_modified: "Mon, 01 Jun 2026 00:00:00 GMT", last_fetched: "2020-01-01T00:00:00Z", title: "T", item_count: 0, error_count: 0 },
    };
    await store.putFeed("blog", prior);
    let seen: Record<string, string> = {};
    const f = (async (_u: any, init: any) => {
      seen = Object.fromEntries(new Headers(init.headers).entries());
      return resp("", 304);
    }) as typeof fetch;
    const result = await pollFeed(entry, store, f);
    expect(result.status).toBe("not-modified");
    expect(seen["if-none-match"]).toBe("v1");
    expect(seen["if-modified-since"]).toBe("Mon, 01 Jun 2026 00:00:00 GMT");
    const stored = await store.getFeed("blog");
    expect(stored!.xml).toBe("<old/>");
    expect(stored!.meta.last_fetched).not.toBe("2020-01-01T00:00:00Z");
  });

  it("skips feeds fetched within their poll interval", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putFeed("blog", {
      xml: "<x/>",
      meta: { last_fetched: new Date().toISOString(), title: "T", item_count: 0, error_count: 0 },
    });
    const result = await pollFeed(entry, store, fetcher(resp(rss)));
    expect(result.status).toBe("skipped");
  });

  it("keeps last-good copy and counts origin errors", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putFeed("blog", {
      xml: "<good/>",
      meta: { last_fetched: "2020-01-01T00:00:00Z", title: "T", item_count: 1, error_count: 0 },
    });
    const result = await pollFeed(entry, store, fetcher(resp("down", 502)));
    expect(result.status).toBe("error");
    const stored = await store.getFeed("blog");
    expect(stored!.xml).toBe("<good/>");
    expect(stored!.meta.error_count).toBe(1);
    expect(stored!.meta.last_error).toContain("502");
  });

  it("marks unparseable origins as error", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const result = await pollFeed(entry, store, fetcher(resp("<html>nope</html>")));
    expect(result.status).toBe("error");
    expect((await store.getFeed("blog"))).toBeNull();
  });
});

describe("pollAll", () => {
  it("polls every registered feed", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({
      feeds: [
        entry,
        { ...entry, id: "blog2", origin: "https://origin.test/rss2" },
      ],
      domains: {},
    });
    const results = await pollAll(store, fetcher(resp(rss)));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/poller.test.ts`
Expected: FAIL — `../src/poller` does not exist

- [ ] **Step 3: Implement `src/poller.ts`**

```ts
import { parseFeed, buildRss, FeedParseError } from "./normalize";
import type { FeedEntry, FeedStore, StoredFeed } from "./registry";

export interface PollResult {
  id: string;
  status: "ok" | "not-modified" | "skipped" | "error";
  message?: string;
}

export async function pollFeed(
  entry: FeedEntry,
  store: FeedStore,
  fetchFn: typeof fetch = fetch,
): Promise<PollResult> {
  const existing = await store.getFeed(entry.id);
  if (
    existing &&
    Date.now() - Date.parse(existing.meta.last_fetched) < entry.poll_minutes * 60_000
  ) {
    return { id: entry.id, status: "skipped" };
  }

  const headers = new Headers({ "user-agent": "feedforge/0.1 (+https://github.com/)" });
  if (existing?.meta.etag) headers.set("if-none-match", existing.meta.etag);
  if (existing?.meta.last_modified) headers.set("if-modified-since", existing.meta.last_modified);

  const fail = async (message: string): Promise<PollResult> => {
    if (existing) {
      await store.putFeed(entry.id, {
        ...existing,
        meta: {
          ...existing.meta,
          last_fetched: new Date().toISOString(),
          error_count: existing.meta.error_count + 1,
          last_error: message,
        },
      });
    }
    return { id: entry.id, status: "error", message };
  };

  let res: Response;
  try {
    res = await fetchFn(entry.origin, { headers });
  } catch (e) {
    return fail(`fetch failed: ${(e as Error).message}`);
  }

  if (res.status === 304 && existing) {
    await store.putFeed(entry.id, {
      ...existing,
      meta: { ...existing.meta, last_fetched: new Date().toISOString(), error_count: 0 },
    });
    return { id: entry.id, status: "not-modified" };
  }
  if (!res.ok) return fail(`origin returned HTTP ${res.status}`);

  const body = await res.text();
  try {
    const doc = parseFeed(body);
    const stored: StoredFeed = {
      xml: buildRss(doc),
      meta: {
        etag: res.headers.get("etag") ?? undefined,
        last_modified: res.headers.get("last-modified") ?? undefined,
        last_fetched: new Date().toISOString(),
        title: doc.title,
        item_count: doc.items.length,
        error_count: 0,
      },
    };
    await store.putFeed(entry.id, stored);
    return { id: entry.id, status: "ok" };
  } catch (e) {
    if (e instanceof FeedParseError) return fail(`unparseable feed: ${e.message}`);
    throw e;
  }
}

export async function pollAll(
  store: FeedStore,
  fetchFn: typeof fetch = fetch,
): Promise<PollResult[]> {
  const { feeds } = await store.getRegistry();
  const results: PollResult[] = [];
  const BATCH = 5;
  for (let i = 0; i < feeds.length; i += BATCH) {
    const batch = await Promise.all(feeds.slice(i, i + BATCH).map((f) => pollFeed(f, store, fetchFn)));
    results.push(...batch);
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/poller.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/poller.ts tests/poller.test.ts
git commit -m "feat: cron poller with conditional GET and last-good fallback"
```

---

### Task 6: Router + fetch handler (XML serving, format negotiation)

**Files:**
- Create: `src/router.ts`
- Create: `src/worker.ts`
- Test: `tests/router.test.ts`
- Test: `tests/worker.test.ts`

- [ ] **Step 1: Write the failing router test**

`tests/router.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { KVFeedStore } from "../src/registry";
import { resolveFeedId } from "../src/router";

describe("resolveFeedId", () => {
  it("resolves path segment on unmapped hosts", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({ feeds: [], domains: {} });
    expect(await resolveFeedId(new URL("https://feeds.example.com/blog"), store)).toBe("blog");
    expect(await resolveFeedId(new URL("https://feeds.example.com/"), store)).toBeNull();
  });

  it("resolves mapped host root to its feed", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({ feeds: [], domains: { "feeds.example.org": "blog" } });
    expect(await resolveFeedId(new URL("https://feeds.example.org/"), store)).toBe("blog");
    expect(await resolveFeedId(new URL("https://feeds.example.org/other"), store)).toBe("other");
  });
});
```

- [ ] **Step 2: Implement `src/router.ts`**

```ts
import type { FeedStore } from "./registry";

export async function resolveFeedId(url: URL, store: FeedStore): Promise<string | null> {
  const segment = url.pathname.split("/").filter(Boolean)[0] ?? null;
  const mapped = await store.resolveHost(url.hostname);
  if (mapped) return segment ?? mapped;
  return segment;
}
```

- [ ] **Step 3: Write the failing worker test**

`tests/worker.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { readFileSync } from "node:fs";
import { KVFeedStore } from "../src/registry";

const rss = readFileSync(new URL("./fixtures/valid-rss.xml", import.meta.url), "utf8");

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const store = new KVFeedStore(env.FEEDS);
  await store.putRegistry({
    feeds: [{ id: "blog", origin: "https://origin.test/rss", poll_minutes: 30, created_at: "2026-08-01T00:00:00Z" }],
    domains: { "feeds.example.org": "blog" },
  });
  fetchMock.get("https://origin.test").intercept({ path: "/rss" }).reply(200, rss);
});

describe("fetch handler", () => {
  it("serves stored RSS as application/rss+xml", async () => {
    const res = await SELF.fetch("https://feeds.example.com/blog", {
      headers: { accept: "application/rss+xml", "user-agent": "FreshRSS/1.24" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    expect(await res.text()).toContain("Example Blog");
  });

  it("serves Atom when ?format=atom", async () => {
    const res = await SELF.fetch("https://feeds.example.com/blog?format=atom", {
      headers: { "user-agent": "FreshRSS/1.24" },
    });
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    expect(await res.text()).toContain("<feed");
  });

  it("serves browser HTML to browsers", async () => {
    const res = await SELF.fetch("https://feeds.example.com/blog", {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/126" },
    });
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Subscribe");
  });

  it("serves feed at mapped domain root (MyBrand)", async () => {
    const res = await SELF.fetch("https://feeds.example.org/", {
      headers: { "user-agent": "FreshRSS/1.24" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Example Blog");
  });

  it("returns 404 for unknown feeds", async () => {
    const res = await SELF.fetch("https://feeds.example.com/nope");
    expect(res.status).toBe(404);
  });

  it("sets X-Feed-Stale when origin errors have accumulated", async () => {
    const store = new KVFeedStore(env.FEEDS);
    const feed = (await store.getFeed("blog"))!;
    await store.putFeed("blog", { ...feed, meta: { ...feed.meta, error_count: 2, last_error: "HTTP 502" } });
    const res = await SELF.fetch("https://feeds.example.com/blog", {
      headers: { "user-agent": "FreshRSS/1.24" },
    });
    expect(res.headers.get("x-feed-stale")).toBe("true");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/router.test.ts tests/worker.test.ts`
Expected: FAIL — `../src/router` and `../src/worker` do not exist

- [ ] **Step 5: Implement `src/worker.ts` and stubs it needs**

`src/analytics.ts` (stub, replaced in Task 7):
```ts
export function classifyUa(ua: string): { kind: "aggregator" | "browser" | "other"; subscribers: number } {
  return { kind: "other", subscribers: 0 };
}

export function recordRequest(env: Env, feedId: string, request: Request): void {}
```

`src/view.ts` (stub, replaced in Task 8):
```ts
import type { FeedDoc } from "./normalize";

export function renderFeedPage(doc: FeedDoc, feedUrl: string, stale: string | null): string {
  return `<!doctype html><title>${doc.title}</title><p>Subscribe</p>`;
}
```

`src/env.d.ts`:
```ts
interface Env {
  FEEDS: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
}
```

`src/worker.ts`:
```ts
import { KVFeedStore } from "./registry";
import { pollAll } from "./poller";
import { resolveFeedId } from "./router";
import { parseFeed, buildAtom } from "./normalize";
import { classifyUa, recordRequest } from "./analytics";
import { renderFeedPage } from "./view";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const store = new KVFeedStore(env.FEEDS);
    const feedId = await resolveFeedId(url, store);
    if (!feedId) return new Response("Not found", { status: 404 });

    const ua = request.headers.get("user-agent") ?? "";
    recordRequest(env, feedId, request);

    const stored = await store.getFeed(feedId);
    if (!stored) return new Response("Feed not found", { status: 404 });

    const doc = parseFeed(stored.xml);
    const stale = stored.meta.error_count > 0 ? (stored.meta.last_error ?? "stale") : null;
    const staleHeader = stale ? { "x-feed-stale": "true" } : {};

    const wantsHtml =
      (request.headers.get("accept") ?? "").includes("text/html") &&
      classifyUa(ua).kind !== "aggregator";

    if (wantsHtml) {
      return new Response(renderFeedPage(doc, url.toString(), stale), {
        headers: { "content-type": "text/html; charset=utf-8", ...staleHeader },
      });
    }

    if (url.searchParams.get("format") === "atom") {
      return new Response(buildAtom(doc), {
        headers: { "content-type": "application/atom+xml; charset=utf-8", ...staleHeader },
      });
    }

    return new Response(stored.xml, {
      headers: { "content-type": "application/rss+xml; charset=utf-8", ...staleHeader },
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollAll(new KVFeedStore(env.FEEDS)).then(() => undefined));
  },
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/router.test.ts tests/worker.test.ts`
Expected: PASS. Note: the first worker test depends on the cron poller never having run — the fetch handler serves from KV, which is empty on first request. To make the suite pass, the worker's fetch handler must do an inline first-fetch on KV miss: replace the `if (!stored)` block with:

```ts
    let stored = await store.getFeed(feedId);
    if (!stored) {
      const reg = await store.getRegistry();
      const entry = reg.feeds.find((f) => f.id === feedId);
      if (!entry) return new Response("Feed not found", { status: 404 });
      const { pollFeed } = await import("./poller");
      const result = await pollFeed(entry, store);
      if (result.status === "error" && !(await store.getFeed(feedId))) {
        return new Response(`Feed unavailable: ${result.message}`, { status: 502 });
      }
      stored = (await store.getFeed(feedId))!;
    }
```

Also update the "unknown feeds" test: `nope` is not in the registry, so it 404s via the registry lookup (not the KV miss) — no test change needed. Re-run until green.

- [ ] **Step 7: Commit**

```bash
git add src/router.ts src/worker.ts src/analytics.ts src/view.ts src/env.d.ts tests/router.test.ts tests/worker.test.ts
git commit -m "feat: serve feeds from KV with format negotiation and inline first-fetch"
```

---

### Task 7: Analytics (UA classification + datapoints)

**Files:**
- Modify: `src/analytics.ts`
- Test: `tests/analytics.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/analytics.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/analytics.test.ts`
Expected: FAIL — stub returns wrong values

- [ ] **Step 3: Implement `src/analytics.ts`**

```ts
const AGGREGATOR_PATTERNS = [
  /freshrss/i, /miniflux/i, /inoreader/i, /feedly/i, /newsblur/i,
  /tiny tiny rss/i, /tt-rss/i, /feedparser/i, /netnewswire/i,
  /reeder/i, /feedbin/i, /akregator/i, /liferea/i, /rssguard/i,
  /feedly/i, /flipboard/i, /feed validator/i,
];

export function classifyUa(ua: string): { kind: "aggregator" | "browser" | "other"; subscribers: number } {
  const m = ua.match(/(\d+)\s+subscribers/i);
  const subscribers = m ? parseInt(m[1], 10) : 0;
  if (AGGREGATOR_PATTERNS.some((p) => p.test(ua)) || m) {
    return { kind: "aggregator", subscribers };
  }
  if (/mozilla\/|chrome\/|safari\/|firefox\/|edge\//i.test(ua)) {
    return { kind: "browser", subscribers: 0 };
  }
  return { kind: "other", subscribers: 0 };
}

async function dailyHash(ip: string, ua: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${ip}|${ua}|${day}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export async function recordRequest(env: Env, feedId: string, request: Request): Promise<void> {
  const ua = request.headers.get("user-agent") ?? "";
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const { kind, subscribers } = classifyUa(ua);
  const hash = await dailyHash(ip, ua);
  env.ANALYTICS.writeDataPoint({
    blobs: [feedId, kind, hash],
    doubles: [subscribers],
    indexes: [feedId],
  });
}
```

Update `src/worker.ts` fetch handler: change `recordRequest(env, feedId, request);` to `ctx.waitUntil(recordRequest(env, feedId, request));`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/analytics.test.ts tests/worker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/analytics.ts src/worker.ts tests/analytics.test.ts
git commit -m "feat: UA classification, subscriber estimates, Analytics Engine datapoints"
```

---

### Task 8: Browser-friendly feed view

**Files:**
- Modify: `src/view.ts`
- Test: `tests/view.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/view.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseFeed } from "../src/normalize";
import { renderFeedPage } from "../src/view";
import { readFileSync } from "node:fs";

const doc = parseFeed(readFileSync(new URL("./fixtures/valid-rss.xml", import.meta.url), "utf8"));

describe("renderFeedPage", () => {
  it("renders title, items, and subscribe call-to-action", () => {
    const html = renderFeedPage(doc, "https://feeds.example.com/blog", null);
    expect(html).toContain("Example Blog");
    expect(html).toContain("First Post");
    expect(html).toContain("https://feeds.example.com/blog");
    expect(html.toLowerCase()).toContain("subscribe");
    expect(html).toContain("<!doctype html>");
  });

  it("escapes HTML in feed content", () => {
    const evil = { ...doc, title: `<script>alert(1)</script>` };
    const html = renderFeedPage(evil, "https://feeds.example.com/blog", null);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows a staleness warning", () => {
    const html = renderFeedPage(doc, "https://feeds.example.com/blog", "origin returned HTTP 502");
    expect(html).toContain("502");
    expect(html.toLowerCase()).toContain("stale");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/view.test.ts`
Expected: FAIL — stub lacks required markup

- [ ] **Step 3: Implement `src/view.ts`**

```ts
import type { FeedDoc } from "./normalize";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderFeedPage(doc: FeedDoc, feedUrl: string, stale: string | null): string {
  const items = doc.items
    .slice(0, 25)
    .map(
      (i) => `<li><a href="${esc(i.link)}">${esc(i.title)}</a>${
        i.pubDate ? ` <time>${esc(i.pubDate)}</time>` : ""
      }</li>`,
    )
    .join("\n");

  const warning = stale
    ? `<p class="stale">This feed is stale — the origin could not be fetched (${esc(stale)}). Showing the last good copy.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)} — feed</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  .subscribe { background: #f4f4f4; border: 1px solid #ddd; border-radius: 8px; padding: 1rem; }
  .subscribe code { word-break: break-all; }
  .stale { background: #fff3cd; border: 1px solid #ffe69c; border-radius: 8px; padding: .75rem; }
  time { color: #666; font-size: .85em; }
</style>
</head>
<body>
<h1>${esc(doc.title)}</h1>
<p>${esc(doc.description)}</p>
${warning}
<div class="subscribe">
  <p>This is an RSS feed. Subscribe by copying this URL into your feed reader:</p>
  <code>${esc(feedUrl)}</code>
</div>
<h2>Recent items</h2>
<ul>
${items}
</ul>
</body>
</html>`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/view.test.ts tests/worker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/view.ts tests/view.test.ts
git commit -m "feat: browser-friendly feed landing page with subscribe CTA"
```

---

### Task 9: Management CLI

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Pure registry-edit helpers are factored out for testability. `tests/cli.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { addFeed, removeFeed, mapDomain } from "../src/cli";
import type { Registry } from "../src/registry";

const base: Registry = { feeds: [], domains: {} };

describe("cli registry edits", () => {
  it("adds a feed", () => {
    const reg = addFeed(base, "blog", "https://example.com/rss");
    expect(reg.feeds[0]).toMatchObject({ id: "blog", origin: "https://example.com/rss", poll_minutes: 30 });
  });

  it("rejects duplicate ids", () => {
    const reg = addFeed(base, "blog", "https://example.com/rss");
    expect(() => addFeed(reg, "blog", "https://other/rss")).toThrow(/already exists/);
  });

  it("removes a feed and its domain mappings", () => {
    let reg = addFeed(base, "blog", "https://example.com/rss");
    reg = mapDomain(reg, "feeds.example.org", "blog");
    reg = removeFeed(reg, "blog");
    expect(reg.feeds).toHaveLength(0);
    expect(reg.domains).toEqual({});
  });

  it("maps a domain to an existing feed", () => {
    const reg = addFeed(base, "blog", "https://example.com/rss");
    expect(() => mapDomain(reg, "feeds.example.org", "ghost")).toThrow(/no feed/);
    expect(mapDomain(reg, "feeds.example.org", "blog").domains["feeds.example.org"]).toBe("blog");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `../src/cli` does not exist

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseFeed } from "./normalize";
import type { Registry } from "./registry";

export function addFeed(reg: Registry, id: string, origin: string): Registry {
  if (reg.feeds.some((f) => f.id === id)) throw new Error(`feed '${id}' already exists`);
  return {
    ...reg,
    feeds: [...reg.feeds, { id, origin, poll_minutes: 30, created_at: new Date().toISOString() }],
  };
}

export function removeFeed(reg: Registry, id: string): Registry {
  return {
    feeds: reg.feeds.filter((f) => f.id !== id),
    domains: Object.fromEntries(Object.entries(reg.domains).filter(([, v]) => v !== id)),
  };
}

export function mapDomain(reg: Registry, hostname: string, id: string): Registry {
  if (!reg.feeds.some((f) => f.id === id)) throw new Error(`no feed with id '${id}'`);
  return { ...reg, domains: { ...reg.domains, [hostname]: id } };
}

function kvNamespaceId(): string {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const m = toml.match(/kv_namespaces[\s\S]*?id\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no kv namespace id in wrangler.toml");
  return m[1];
}

function kvGet(key: string): string | null {
  try {
    const out = execFileSync(
      "npx", ["wrangler", "kv", "key", "get", key, "--namespace-id", kvNamespaceId(), "--remote"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

function kvPut(key: string, value: string): void {
  execFileSync(
    "npx", ["wrangler", "kv", "key", "put", key, value, "--namespace-id", kvNamespaceId(), "--remote"],
    { stdio: "inherit" },
  );
}

async function getRegistry(): Promise<Registry> {
  const raw = kvGet("feeds.json");
  return raw ? JSON.parse(raw) : { feeds: [], domains: {} };
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  const reg = await getRegistry();

  switch (cmd) {
    case "add": {
      const [id, origin] = args;
      if (!id || !origin) throw new Error("usage: feeds add <name> <origin-url>");
      const res = await fetch(origin, { headers: { "user-agent": "feedforge-cli/0.1" } });
      if (!res.ok) throw new Error(`origin returned HTTP ${res.status}`);
      parseFeed(await res.text());
      kvPut("feeds.json", JSON.stringify(addFeed(reg, id, origin)));
      console.log(`added '${id}'. It will be polled on the next cron run.`);
      break;
    }
    case "remove": {
      const [id] = args;
      if (!id) throw new Error("usage: feeds remove <name>");
      kvPut("feeds.json", JSON.stringify(removeFeed(reg, id)));
      console.log(`removed '${id}'`);
      break;
    }
    case "list": {
      for (const f of reg.feeds) {
        const raw = kvGet(`feed:${f.id}`);
        const meta = raw ? JSON.parse(raw).meta : null;
        const status = meta
          ? meta.error_count > 0
            ? `ERROR(${meta.error_count}): ${meta.last_error}`
            : `ok, ${meta.item_count} items, fetched ${meta.last_fetched}`
          : "not yet polled";
        console.log(`${f.id}\t${f.origin}\t${status}`);
      }
      const domains = Object.entries(reg.domains);
      if (domains.length) {
        console.log("\ndomains:");
        for (const [h, id] of domains) console.log(`  ${h} -> ${id}`);
      }
      break;
    }
    case "map-domain": {
      const [hostname, id] = args;
      if (!hostname || !id) throw new Error("usage: feeds map-domain <hostname> <name>");
      kvPut("feeds.json", JSON.stringify(mapDomain(reg, hostname, id)));
      console.log(`mapped ${hostname} -> ${id}`);
      console.log(`\nAdd this to wrangler.toml and redeploy:\n`);
      console.log(`[[routes]]\ncustom_domain = "${hostname}"`);
      break;
    }
    default:
      console.log("usage: feeds <add|remove|list|map-domain> ...");
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS. Note: `src/cli.ts` must import cleanly in the workers vitest pool — `node:child_process`/`node:fs` top-level imports work in tests but guard `main()` with the argv check so nothing executes on import.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: feed management CLI wrapping wrangler KV"
```

---

### Task 10: End-to-end cron test + README + deploy prep

**Files:**
- Test: `tests/scheduled.test.ts`
- Create: `README.md`
- Modify: `wrangler.toml`

- [ ] **Step 1: Write the failing scheduled test**

`tests/scheduled.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF, fetchMock, createScheduledController } from "cloudflare:test";
import { readFileSync } from "node:fs";
import worker from "../src/worker";
import { KVFeedStore } from "../src/registry";

const rss = readFileSync(new URL("./fixtures/valid-rss.xml", import.meta.url), "utf8");

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock.get("https://origin.test").intercept({ path: "/rss" }).reply(200, rss);
});

describe("scheduled handler", () => {
  it("polls all registered feeds on cron", async () => {
    const store = new KVFeedStore(env.FEEDS);
    await store.putRegistry({
      feeds: [{ id: "cronblog", origin: "https://origin.test/rss", poll_minutes: 30, created_at: "2026-08-01T00:00:00Z" }],
      domains: {},
    });
    const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: "*/30 * * * *" });
    await worker.scheduled(ctrl, env, { waitUntil: (p: Promise<any>) => p } as any);
    const stored = await store.getFeed("cronblog");
    expect(stored).not.toBeNull();
    expect(stored!.meta.title).toBe("Example Blog");
    const res = await SELF.fetch("https://feeds.example.com/cronblog", {
      headers: { "user-agent": "Miniflux/2.0" },
    });
    expect(await res.text()).toContain("First Post");
  });
});
```

- [ ] **Step 2: Run full suite**

Run: `npx vitest run`
Expected: all suites PASS

- [ ] **Step 3: Write `README.md`**

```markdown
# feedforge

Open-source FeedBurner clone on Cloudflare's free tier: feed proxying/normalization,
aggregate analytics, browser-friendly feed pages, and custom-domain (MyBrand) hosting.

## Setup

1. `npm install`
2. Create the KV namespace: `npx wrangler kv namespace create FEEDS`
3. Put the returned id into `wrangler.toml` (`kv_namespaces.id`)
4. Set your Workers route/custom domain in `wrangler.toml`
5. `npm run deploy`

## Managing feeds

    npm run feeds -- add myblog https://example.com/rss.xml
    npm run feeds -- list
    npm run feeds -- remove myblog
    npm run feeds -- map-domain feeds.example.org myblog

## Using feeds

- Feed URL: `https://<your-worker-domain>/myblog` (Atom: append `?format=atom`)
- Open the URL in a browser for a subscribe-friendly landing page.

## Stats

Datapoints land in the `feedforge` Analytics Engine dataset:
`blobs: [feed_id, ua_class, daily_hash]`, `doubles: [subscribers]`.
Example query (Cloudflare GraphQL API, `analyticsEngine` dataset):

    SELECT blob1 AS feed, count() AS requests, sum(double1) AS reported_subscribers
    FROM feedforge
    WHERE timestamp > NOW() - INTERVAL '1' DAY
    GROUP BY feed

Daily unique subscribers ≈ count of distinct `blob3` per feed per day.

## Architecture

Cron (`scheduled`) polls origins with conditional GET, normalizes RSS2/Atom/RDF to
valid RSS 2.0, stores in KV. `fetch` resolves feed id from hostname (MyBrand map) or
path, records an Analytics Engine datapoint, serves XML or the HTML landing page.
Origin failures keep serving the last good copy with an `X-Feed-Stale` header.

## License

MIT
```

- [ ] **Step 4: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests PASS

- [ ] **Step 5: Commit**

```bash
git add tests/scheduled.test.ts README.md
git commit -m "test: cron cycle e2e; docs: setup and usage README"
```

---

## Self-Review Notes

- **Spec coverage:** proxying/normalization (T2–3), cron-poll + store (T5), aggregate analytics (T7), browser view (T8), MyBrand (T4 resolveHost, T6 router, T9 map-domain), CLI-only admin (T9), error handling/last-good (T5, T6 X-Feed-Stale), tests (every task + T10 e2e), deployment (T1 wrangler.toml, T10 README). RSS-to-email, click tracking, multi-user — explicitly deferred per spec.
- **Type consistency:** `FeedDoc`/`FeedItem` (T2) used by T3, T5, T6, T8. `FeedStore`/`Registry`/`StoredFeed` (T4) used by T5, T6, T9, T10. `classifyUa`/`recordRequest` signatures identical between T6 stub and T7 implementation.
- **Known follow-ups (not plan blockers):** KV id placeholder in wrangler.toml must be replaced before deploy (README step 2 covers it); `X-Feed-Stale` test in T6 mutates shared KV state — run suites sequentially (vitest workers pool default isolates per file, so this is safe).

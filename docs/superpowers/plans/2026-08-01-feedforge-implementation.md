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

### Task 11: Channel store + ring buffer (`src/channels.ts`)

**Files:**
- Create: `src/channels.ts`
- Test: `tests/channels.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/channels.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/channels.test.ts`
Expected: FAIL — `../src/channels` does not exist

- [ ] **Step 3: Implement `src/channels.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/channels.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/channels.ts tests/channels.test.ts
git commit -m "feat: short-lived channel store with capability tokens and ring buffer"
```

---

### Task 12: Channel API routes (create / publish / delete)

**Files:**
- Create: `src/api.ts`
- Modify: `src/worker.ts`
- Test: `tests/api.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/api.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api.test.ts`
Expected: FAIL — `/api/*` routes 404

- [ ] **Step 3: Implement `src/api.ts`**

```ts
import { createChannel, getChannel, appendItem, deleteChannel, verifyToken } from "./channels";

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
  const parts = url.pathname.split("/").filter(Boolean); // ["api","channels",<id>?,"items"?]

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
```

Wire into `src/worker.ts` fetch handler, at the top:

```ts
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
```

Add the import: `import { handleApi } from "./api";`

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/worker.ts tests/api.test.ts
git commit -m "feat: channel REST API with bearer capability tokens"
```

---

### Task 13: Serve channels as feeds + cron expiry sweep

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/router.ts`
- Test: `tests/channel-serving.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/channel-serving.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/channel-serving.test.ts`
Expected: FAIL — channel ids aren't resolvable feeds yet

- [ ] **Step 3: Wire channel serving into `src/worker.ts`**

In the fetch handler, after `resolveFeedId` returns null and before the 404, treat the first path segment as a possible channel id. Replace the resolution block:

```ts
    const feedId = await resolveFeedId(url, store);
    const channelId = feedId ?? url.pathname.split("/").filter(Boolean)[0] ?? null;
    if (!channelId) return new Response("Not found", { status: 404 });

    const ua = request.headers.get("user-agent") ?? "";
    ctx.waitUntil(recordRequest(env, channelId, request));

    let doc: FeedDoc;
    let stale: string | null = null;
    let staleHeader: Record<string, string> = {};

    const stored = feedId ? await store.getFeed(feedId) : null;
    if (stored) {
      doc = parseFeed(stored.xml);
      stale = stored.meta.error_count > 0 ? (stored.meta.last_error ?? "stale") : null;
    } else {
      const channel = await getChannel(env.FEEDS, channelId);
      if (channel) {
        doc = {
          title: channel.title,
          link: `${url.origin}/${channel.id}`,
          description: channel.description,
          items: channel.items.map((i) => ({
            title: i.title,
            link: i.link ?? `${url.origin}/${channel.id}`,
            guid: i.guid,
            pubDate: i.pubDate,
            description: i.description,
          })),
        };
      } else if (feedId) {
        // registry feed never polled: inline first-fetch (existing Task 6 logic)
        const reg = await store.getRegistry();
        const entry = reg.feeds.find((f) => f.id === feedId);
        if (!entry) return new Response("Feed not found", { status: 404 });
        const { pollFeed } = await import("./poller");
        const result = await pollFeed(entry, store);
        const after = await store.getFeed(feedId);
        if (!after) return new Response(`Feed unavailable: ${result.message}`, { status: 502 });
        doc = parseFeed(after.xml);
      } else {
        return new Response("Feed not found", { status: 404 });
      }
    }
    if (stale) staleHeader = { "x-feed-stale": "true" };
```

The remainder (wantsHtml / format=atom / RSS response) is unchanged but operates on `doc` and builds RSS via `buildRss(doc)` when the stored-xml path wasn't taken — restructure so the final RSS response is:

```ts
    return new Response(stored ? stored.xml : buildRss(doc), {
      headers: { "content-type": "application/rss+xml; charset=utf-8", ...staleHeader },
    });
```

Add imports: `import { getChannel } from "./channels";`, `import { buildRss, type FeedDoc } from "./normalize";` (merge with existing normalize import).

Also update `scheduled` in `src/worker.ts` to sweep expired channels:

```ts
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await pollAll(new KVFeedStore(env.FEEDS));
        await sweepExpired(env.FEEDS);
      })(),
    );
  },
```

Add `import { sweepExpired } from "./channels";`.

- [ ] **Step 4: Run full suite**

Run: `npx vitest run`
Expected: all suites PASS (including prior worker tests — registry feeds must still resolve through the same code path)

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts src/router.ts tests/channel-serving.test.ts
git commit -m "feat: serve channels as feeds; sweep expired channels on cron"
```

---

### Task 14: Channel docs + end-to-end coordination example

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add channels section to `README.md`**

Insert before the `## Architecture` section:

```markdown
## Short-lived channels (agent coordination)

Channels are feeds published *to* feedforge — for agent/human coordination. A
long-running task creates a channel, posts items as it progresses, and a human's
feed reader (or another agent) consumes the updates.

Create a channel:

    curl -X POST https://<your-worker-domain>/api/channels \
      -H 'content-type: application/json' \
      -d '{"title": "Deploy bot", "ttl_hours": 24}'

    # => {"id":"...","write_token":"...","feed_url":"https://.../<id>","expires_at":"..."}

Subscribe to `feed_url` in any feed reader. Publish an item:

    curl -X POST https://<your-worker-domain>/api/channels/<id>/items \
      -H 'authorization: Bearer <write_token>' \
      -H 'content-type: application/json' \
      -d '{"title": "v42 deployed", "link": "https://ci.example/v42"}'

Delete early (channels also auto-expire after `ttl_hours`, default 7 days, max 30):

    curl -X DELETE https://<your-worker-domain>/api/channels/<id> \
      -H 'authorization: Bearer <write_token>'

Limits: 100 items per channel (oldest dropped), 64KB per item. Reading a channel
feed is public — the id is unguessable. Only the SHA-256 hash of the write token
is stored.
```

- [ ] **Step 2: Run full verification**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: channel API usage for agent coordination"
```

---

## Self-Review Notes

- **Spec coverage:** proxying/normalization (T2–3), cron-poll + store (T5), aggregate analytics (T7), browser view (T8), MyBrand (T4 resolveHost, T6 router, T9 map-domain), CLI-only admin (T9), error handling/last-good (T5, T6 X-Feed-Stale), tests (every task + T10 e2e), deployment (T1 wrangler.toml, T10 README), channels (T11 store, T12 API, T13 serving+sweep, T14 docs). RSS-to-email, click tracking, multi-user — explicitly deferred per spec.
- **Type consistency:** `FeedDoc`/`FeedItem` (T2) used by T3, T5, T6, T8. `FeedStore`/`Registry`/`StoredFeed` (T4) used by T5, T6, T9, T10. `classifyUa`/`recordRequest` signatures identical between T6 stub and T7 implementation.
- **Known follow-ups (not plan blockers):** KV id placeholder in wrangler.toml must be replaced before deploy (README step 2 covers it); `X-Feed-Stale` test in T6 mutates shared KV state — run suites sequentially (vitest workers pool default isolates per file, so this is safe).

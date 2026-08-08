import { KVFeedStore } from "./registry";
import { pollAll, pollFeed } from "./poller";
import { resolveFeedId } from "./router";
import { parseFeed, buildAtom, buildRss, type FeedDoc } from "./normalize";
import { recordRequest } from "./analytics";
import { renderFeedPage, renderLandingPage } from "./view";
import { handleApi } from "./api";
import { getChannel } from "./channels";
import { chooseFormat, type Format } from "./negotiate";
import { etagFor, isNotModified, sha256hex } from "./conditional";
import ogPng from "./assets/og.png";

const CONTENT_TYPES: Record<Format, string> = {
  rss: "application/rss+xml; charset=utf-8",
  atom: "application/atom+xml; charset=utf-8",
  html: "text/html; charset=utf-8",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/og.png") {
      return new Response(ogPng, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400, immutable",
        },
      });
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    const store = new KVFeedStore(env.FEEDS);
    const feedId = await resolveFeedId(url, store);
    const entry = feedId ? (await store.getRegistry()).feeds.find((f) => f.id === feedId) : undefined;
    const maxAge = entry ? entry.poll_minutes * 60 : 60;
    const format = chooseFormat(url, request.headers.get("accept") ?? "", request.headers.get("user-agent") ?? "");

    let storedXml: string | null = null;
    let xmlHash: string | null = null;
    let lastBuilt: string | null = null;
    let stale: string | null = null;
    // Parsing a large feed costs more than everything else on this path combined,
    // and the RSS response never needs it — so it stays behind a thunk.
    let parsed: FeedDoc | null = null;
    let docSource: (() => FeedDoc) | null = null;
    const doc = (): FeedDoc => (parsed ??= docSource!());

    const stored = feedId ? await store.getFeed(feedId) : null;
    if (stored) {
      storedXml = stored.xml;
      xmlHash = stored.meta.xml_hash ?? null;
      lastBuilt = stored.meta.last_built ?? null;
      docSource = () => parseFeed(stored.xml);
      stale = stored.meta.error_count > 0 ? (stored.meta.last_error ?? "stale") : null;
    } else if (feedId && entry) {
      const result = await pollFeed(entry, store);
      const feed = result.feed ?? (await store.getFeed(feedId));
      if (!feed) {
        return result.status === "error"
          ? new Response(`Feed unavailable: ${result.message}`, { status: 502 })
          : new Response("Feed temporarily unavailable", { status: 503 });
      }
      storedXml = feed.xml;
      xmlHash = feed.meta.xml_hash ?? null;
      lastBuilt = feed.meta.last_built ?? null;
      docSource = () => parseFeed(feed.xml);
    } else {
      const channelId = feedId ?? url.pathname.split("/").filter(Boolean)[0] ?? null;
      if (!channelId) {
        if (request.method === "GET") {
          const reg = await store.getRegistry();
          const feeds = await Promise.all(
            reg.feeds.map(async (f) => ({
              id: f.id,
              title: (await store.getFeed(f.id))?.meta.title ?? f.id,
            })),
          );
          return new Response(renderLandingPage(url.host, feeds), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("Not found", { status: 404 });
      }
      const channel = await getChannel(env.FEEDS, channelId);
      if (!channel) return new Response("Feed not found", { status: 404 });
      lastBuilt = channel.items.at(-1)?.pubDate ?? channel.created_at;
      const built: FeedDoc = {
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
      docSource = () => built;
    }

    const recordId = feedId ?? doc().link.split("/").pop()!;
    ctx.waitUntil(recordRequest(env, recordId, request));

    let body: string;
    if (format === "atom") body = buildAtom(doc());
    else if (format === "html") body = renderFeedPage(doc(), url.toString(), stale);
    else body = storedXml ?? buildRss(doc());

    // Hashing the stored body would undo the point of skipping the parse, so the
    // poller's precomputed hash is used whenever the bytes came straight from KV.
    const contentHash = format === "rss" && storedXml !== null && xmlHash ? xmlHash : await sha256hex(body);
    const etag = etagFor(contentHash, format);

    const headers = new Headers({
      "content-type": CONTENT_TYPES[format],
      etag,
      "cache-control": `public, max-age=${maxAge}`,
    });
    if (lastBuilt) {
      const built = new Date(lastBuilt);
      if (!Number.isNaN(built.getTime())) headers.set("last-modified", built.toUTCString());
    }
    if (stale) headers.set("x-feed-stale", "true");

    // A validator match means the reader already has these exact bytes; the body is
    // where essentially all of a feed's bandwidth goes, so this is the whole point.
    if (isNotModified(request, etag, headers.get("last-modified"))) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { headers });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Channel keys carry an expirationTtl, so KV reclaims them without a sweep.
    ctx.waitUntil(pollAll(new KVFeedStore(env.FEEDS)));
  },
};

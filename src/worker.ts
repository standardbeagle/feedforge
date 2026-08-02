import { KVFeedStore } from "./registry";
import { pollAll, pollFeed } from "./poller";
import { resolveFeedId } from "./router";
import { parseFeed, buildAtom, buildRss, type FeedDoc } from "./normalize";
import { classifyUa, recordRequest } from "./analytics";
import { renderFeedPage } from "./view";
import { handleApi } from "./api";
import { getChannel, sweepExpired } from "./channels";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    const store = new KVFeedStore(env.FEEDS);
    const feedId = await resolveFeedId(url, store);

    let doc: FeedDoc;
    let storedXml: string | null = null;
    let stale: string | null = null;

    const stored = feedId ? await store.getFeed(feedId) : null;
    if (stored) {
      doc = parseFeed(stored.xml);
      storedXml = stored.xml;
      stale = stored.meta.error_count > 0 ? (stored.meta.last_error ?? "stale") : null;
    } else {
      const reg = feedId ? await store.getRegistry() : null;
      const entry = feedId ? reg!.feeds.find((f) => f.id === feedId) : undefined;
      if (feedId && entry) {
        const result = await pollFeed(entry, store);
        if (result.status === "error") {
          const after = await store.getFeed(feedId);
          if (!after) return new Response(`Feed unavailable: ${result.message}`, { status: 502 });
          doc = parseFeed(after.xml);
          storedXml = after.xml;
        } else {
          const feed = result.feed ?? (await store.getFeed(feedId));
          if (!feed) return new Response("Feed temporarily unavailable", { status: 503 });
          doc = parseFeed(feed.xml);
          storedXml = feed.xml;
        }
      } else {
        const channelId = feedId ?? url.pathname.split("/").filter(Boolean)[0] ?? null;
        const channel = channelId ? await getChannel(env.FEEDS, channelId) : null;
        if (!channel) return new Response("Feed not found", { status: 404 });
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
      }
    }

    const recordId = feedId ?? doc.link.split("/").pop()!;
    ctx.waitUntil(recordRequest(env, recordId, request));

    const staleHeader: Record<string, string> = stale ? { "x-feed-stale": "true" } : {};
    const ua = request.headers.get("user-agent") ?? "";

    if (url.searchParams.get("format") === "atom") {
      return new Response(buildAtom(doc), {
        headers: { "content-type": "application/atom+xml; charset=utf-8", ...staleHeader },
      });
    }

    const wantsHtml =
      (request.headers.get("accept") ?? "").includes("text/html") &&
      classifyUa(ua).kind !== "aggregator";

    if (wantsHtml) {
      return new Response(renderFeedPage(doc, url.toString(), stale), {
        headers: { "content-type": "text/html; charset=utf-8", ...staleHeader },
      });
    }

    return new Response(storedXml ?? buildRss(doc), {
      headers: { "content-type": "application/rss+xml; charset=utf-8", ...staleHeader },
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await pollAll(new KVFeedStore(env.FEEDS));
        await sweepExpired(env.FEEDS);
      })(),
    );
  },
};

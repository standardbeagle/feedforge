import { KVFeedStore } from "./registry";
import { pollAll, pollFeed } from "./poller";
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

    recordRequest(env, feedId, request);

    let stored = await store.getFeed(feedId);
    if (!stored) {
      const reg = await store.getRegistry();
      const entry = reg.feeds.find((f) => f.id === feedId);
      if (!entry) return new Response("Feed not found", { status: 404 });
      const result = await pollFeed(entry, store);
      if (result.status === "error") {
        stored = await store.getFeed(feedId);
        if (!stored) {
          return new Response(`Feed unavailable: ${result.message}`, { status: 502 });
        }
      } else {
        stored = result.feed ?? (await store.getFeed(feedId));
        if (!stored) {
          return new Response("Feed temporarily unavailable", { status: 503 });
        }
      }
    }

    const doc = parseFeed(stored.xml);
    const stale = stored.meta.error_count > 0 ? (stored.meta.last_error ?? "stale") : null;
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

    return new Response(stored.xml, {
      headers: { "content-type": "application/rss+xml; charset=utf-8", ...staleHeader },
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollAll(new KVFeedStore(env.FEEDS)).then(() => undefined));
  },
};

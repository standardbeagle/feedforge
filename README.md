# feedforge

[![CI](https://github.com/standardbeagle/feedforge/actions/workflows/ci.yml/badge.svg)](https://github.com/standardbeagle/feedforge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/cloudflare-workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Docs](https://img.shields.io/badge/docs-dev.standardbeagle.com-8A2BE2)](https://dev.standardbeagle.com)

An open-source FeedBurner replacement that runs on Cloudflare's free tier. Point it
at your RSS/Atom/RDF feed and it gives you a stable feed URL served from
Cloudflare's edge — your origin sees one conditional GET per poll interval instead
of one request per subscriber. It also does what FeedBurner never did: agents can
publish short-lived feeds directly through a REST API, so a long-running task can
notify your feed reader when it finishes.

- **Feed proxying** — parses RSS 2.0, Atom, and RDF; repairs malformed XML; emits valid RSS 2.0 or Atom (`?format=atom`)
- **Podcasting 2.0** — enclosures, itunes fields, podcast namespace tags, and `content:encoded` survive normalization
- **Analytics** — subscriber estimates and daily reach in Analytics Engine, with a privacy-preserving daily-rotating reader hash
- **Short-lived channels** — capability-token REST API for agent/human coordination over RSS
- **Browser view** — every feed URL doubles as a subscribe-friendly landing page
- **MyBrand** — map your own domain to a feed
- **Refresh webhook** — hosts ping, feedforge re-polls immediately

Docs: **https://dev.standardbeagle.com**

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

## Refresh webhook

Hosts can trigger an immediate refresh instead of waiting for the cron interval:

    npx wrangler secret put REFRESH_TOKEN   # one-time setup

    curl -X POST https://<your-worker-domain>/api/feeds/myblog/refresh \
      -H 'authorization: Bearer <REFRESH_TOKEN>'

    # => {"id":"myblog","status":"ok"}

The refresh bypasses the poll interval but still sends conditional headers, so a
no-change ping costs one 304. If `REFRESH_TOKEN` is unset the route is disabled.

## Podcasts

Podcast feeds are fully supported: enclosures, itunes channel/item fields
(author, image, categories, explicit, duration, episode/season/episodeType,
owner, type), Podcasting 2.0 tags (guid, locked, medium, person, funding,
location, value/valueRecipient, chapters, transcript), and content:encoded all
survive normalization. Invalid enum values (explicit, episodeType, medium) are
dropped on parse. Audio bytes are never proxied — enclosure URLs pass through
to the listener's client.

## Stats

Datapoints land in the `feedforge` Analytics Engine dataset:
`blobs: [feed_id, ua_class, daily_hash]`, `doubles: [subscribers]`.
Example query (Cloudflare GraphQL API, `analyticsEngine` dataset):

    SELECT blob1 AS feed, count() AS requests, sum(double1) AS reported_subscribers
    FROM feedforge
    WHERE timestamp > NOW() - INTERVAL '1' DAY
    GROUP BY feed

Daily unique subscribers ≈ count of distinct `blob3` per feed per day.

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

## Architecture

Cron (`scheduled`) polls origins with conditional GET, normalizes RSS2/Atom/RDF to
valid RSS 2.0, stores in KV. `fetch` resolves feed id from hostname (MyBrand map) or
path, records an Analytics Engine datapoint, serves XML or the HTML landing page.
Origin failures keep serving the last good copy with an `X-Feed-Stale` header.

## License

MIT

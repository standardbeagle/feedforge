# FeedBurner Clone on Cloudflare — Design Spec

Date: 2026-08-01
Status: Approved (pending user review)

## Overview

An open-source reimplementation of Google FeedBurner's core features, built on Cloudflare's low-cost primitives. Personal/single-tenant first, architected so the feed registry and identity layers can be swapped for multi-tenant operation later.

## Scope

**In scope:**
- Feed proxying/rewriting: stable feed URLs, origin fetch, normalization/repair to valid RSS 2.0 and Atom output
- Feed analytics: subscriber estimates, daily request counts, per-feed aggregates
- Browser-friendly feed view: styled HTML landing page for humans who open a feed URL
- MyBrand: map custom domains to feeds
- Short-lived channels: capability-token API for agents to create/publish/delete ephemeral feeds

**Out of scope (explicitly deferred):**
- RSS-to-email subscriptions
- Per-item click tracking (design leaves room to add later)
- Multi-user accounts / dashboards (CLI-only administration)
- Monetization / FeedFlare / splicing

## Architecture

Option A: **Worker + KV + Cron + Analytics Engine.**

### Components

1. **Worker (`src/worker.ts`)** — TypeScript, three entry points:
   - `fetch`: serves feeds from KV, renders browser view, records analytics
   - `scheduled`: cron trigger, polls all registered origin feeds
2. **CLI (`src/cli.ts`)** — Node script wrapping wrangler for feed management: `add`, `remove`, `list`, `map-domain`
3. **Feed normalization module (`src/normalize.ts`)** — parse RSS 2.0 / Atom / RDF, emit valid RSS 2.0 (and Atom on `?format=atom`), repair common malformations
4. **Analytics module (`src/analytics.ts`)** — datapoint emission + subscriber estimation heuristic

### Cloudflare bindings

| Binding | Purpose | Cost notes |
|---|---|---|
| Workers | fetch + scheduled handlers | free tier: 100k req/day |
| KV namespace | feed bodies (`feed:<id>`), registry + host map (`feeds.json`) | free: 100k reads/day |
| Analytics Engine | per-request datapoints | free |
| Cron Triggers | poll schedule (default `*/30 * * * *`, per-feed override) | free |

## Data flow

**Poll cycle (`scheduled`):**
1. Read registry from KV
2. For each feed: fetch origin with `If-None-Match` / `If-Modified-Since`
3. On 304: update `last_checked`, done
4. On 200: parse + normalize → store XML in KV under `feed:<id>` with metadata (`etag`, `last_modified`, `last_fetched`, `title`, `item_count`)
5. On error: keep last-good copy, increment `error_count`, record `last_error`

**Serve cycle (`fetch`):**
1. Resolve feed id from path (`/<name>`) or hostname (MyBrand map)
2. Record Analytics Engine datapoint: `feed_id`, UA class (aggregator/browser), hashed IP+UA for subscriber estimation
3. If `Accept: text/html` and not a known aggregator UA → render browser view (HTML with feed summary + subscribe buttons + raw XML link)
4. Else serve stored XML from KV with `Cache-Control: public, max-age=<poll interval>` and content-type by format

**Subscriber estimation** (FeedBurner-style heuristic): unique (hashed IP + UA) pairs per 24h window where UA is a known aggregator; aggregators reporting `N subscribers` in UA string use that number directly.

## Feed registry schema

```json
{
  "feeds": [
    {
      "id": "myblog",
      "origin": "https://example.com/rss.xml",
      "poll_minutes": 30,
      "created_at": "2026-08-01T00:00:00Z"
    }
  ],
  "domains": { "feeds.example.org": "myblog" }
}
```

Stored as single KV value `feeds.json` (single-tenant scale; swap to D1 table for multi-tenant later).

## CLI

`pnpm feeds <command>` wrapping wrangler KV writes:

- `add <name> <origin-url>` — validates origin returns a parseable feed, adds to registry
- `remove <name>`
- `list` — shows feeds, last fetch status, error counts
- `map-domain <hostname> <name>` — adds host mapping + prints the wrangler route to add

Admin has no web surface; security = possession of the Cloudflare account.

## MyBrand

- KV key `feeds.json` holds host mappings (`domains`) → feed id; resolved first in the fetch handler
- Custom domains attached via Workers custom-domain routes, added to `wrangler.toml` (CLI prints the exact block)
- On the mapped host, `/` serves the feed; path-based feeds still work on the primary domain

## Error handling

- Origin down/invalid → serve last-good feed, `X-Feed-Stale: true` header, error surfaced in browser view and `feeds list`
- Unparseable origin → feed marked `broken`, serves 502 with explanation page (browser) / plain error (aggregator)
- KV miss for registered feed (never polled yet) → trigger inline fetch once, then store

## Testing

- **Unit**: normalization (fixture corpus of valid + malformed RSS/Atom/RDF), subscriber heuristic, host/path resolution
- **Integration**: Miniflare — full poll cycle against local fixture origin server; fetch handler content-type negotiation
- **Load sanity**: `scheduled` handler processes N feeds within CPU time limits (batch fetch with bounded concurrency)

## Deployment

- `wrangler.toml` in repo; `pnpm deploy` → `wrangler deploy`
- Repo includes: Worker source, CLI, fixtures, tests, README with setup (create KV namespace, set account id, add routes)
- License: MIT

## Short-lived channels (agent/human coordination)

Channels are feeds published *to* feedforge rather than proxied from an origin — for agent/agent and agent/human coordination (e.g. a long-running task posts an item when it completes; the human's feed reader picks it up).

- **Storage**: KV key `channel:<id>` → `{ id, title, description, write_token_hash, created_at, expires_at, items[] }`. Items form a ring buffer: max 100 items (oldest dropped), max 64KB per item body.
- **API** (same Worker, JSON):
  - `POST /api/channels` `{title, description?, ttl_hours?}` → `201 {id, write_token, feed_url, expires_at}`. `id` and `write_token` are random (UUID / 32-byte hex); only the SHA-256 hash of the token is stored.
  - `POST /api/channels/<id>/items` `{title, link?, description?}` with `Authorization: Bearer <write_token>` → appends item (`guid` = UUID, `pubDate` = now).
  - `DELETE /api/channels/<id>` with bearer token → removes the channel.
- **Serving**: fetch handler falls through from registry feeds to channels; channel XML rendered on the fly with the same `buildRss` pipeline — analytics, browser view, and MyBrand path all apply unchanged.
- **Expiry**: TTL default 7 days, min 1 hour, max 30 days. Lazy 404 on expired read/write; cron sweep lists `channel:` prefix and deletes expired entries.

## Refresh webhook

Hosts can notify feedforge of new content instead of waiting for the cron interval (FeedBurner PING equivalent):

- `POST /api/feeds/<id>/refresh` → forces an immediate `pollFeed` (bypasses the poll-interval skip; conditional GET still applies, so a no-change ping costs one 304).
- **Auth**: shared secret via `REFRESH_TOKEN` (wrangler secret). `Authorization: Bearer <token>` required; if the secret is unset the route is disabled (404). 401 missing token, 403 wrong token.
- Response: `200 {id, status, message?}` (status = pollFeed result), 404 unknown feed.

## Podcast support (Podcasting 2.0 model)

The normalizer models podcast metadata as typed fields instead of dropping it:

- **Enclosures**: `<enclosure url length type>` parsed and re-emitted; Atom output maps them to `<link rel="enclosure">`. Audio bytes are never proxied — enclosure URLs pass through absolute.
- **itunes:** channel: author, image, summary, owner name/email, explicit (normalized yes/no), type (episodic/serial), categories (nested flattened). Item: duration, image, explicit, episode, season, episodeType (full/trailer/bonus).
- **podcast:** channel: guid, locked (+owner), medium (whitelisted), person[], funding[], location (name/geo/osm), value (type/method/suggested + recipients). Item: chapters url, transcript[], person[], episode, season.
- **content:encoded** passed through at item level.
- Enum fields validated on parse (explicit, episodeType, medium); invalid values dropped. `xmlns:itunes` / `xmlns:podcast` / `xmlns:content` declared on RSS output only when used.

## Future extension points (designed-for, not built)

- Feed registry behind a `FeedStore` interface → D1 implementation for multi-tenant
- Per-item click tracking via redirect endpoint (needs write path — Analytics Engine or D1)
- RSS-to-email via Cron + an email API

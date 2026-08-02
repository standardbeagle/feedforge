---
title: Architecture
description: How feedforge's pieces fit together on Cloudflare primitives.
---

One TypeScript worker, one KV namespace, one Analytics Engine dataset, one cron
trigger.

## Data flow

**Poll (cron, every 30 minutes):** `scheduled` reads the registry, fetches each
origin with `If-None-Match` / `If-Modified-Since` (batched five at a time),
parses and normalizes the body to valid RSS 2.0, and stores it under
`feed:<id>` in KV alongside fetch metadata (etag, last-modified, item count,
error count). Failures keep the last good copy and increment the error count.
The same run sweeps expired channels.

**Serve:** `fetch` resolves the feed id from the hostname (MyBrand map in
`feeds.json`) or the first path segment. Registry feeds serve the stored XML
verbatim; channels render from their item list on the fly. Every request writes
one Analytics Engine datapoint. A registered feed that has never been polled is
fetched inline on first request.

## Storage layout

| Key | Value |
| --- | --- |
| `feeds.json` | registry: feed entries + domain map |
| `feed:<id>` | normalized XML + poll metadata |
| `channel:<id>` | channel record: items ring buffer, expiry, write-token hash |

## Design choices

- **KV over R2/D1** — feed bodies are small, reads dominate, and KV is free at
  this volume. The registry sits behind a `FeedStore` interface so D1 can
  replace it if the service ever goes multi-tenant.
- **Last-good fallback** — origin outages are invisible to subscribers; staleness
  surfaces through `X-Feed-Stale` and the browser view instead of an error page.
- **Capability tokens over accounts** — channel writes need a token only the
  creator sees; reads need nothing. There is no user database to protect.
- **Daily-rotating reader hash** — subscriber counting without cross-day
  tracking.

## Cost

At personal scale everything fits Cloudflare's free tier: 100k worker requests
and 100k KV reads per day, Analytics Engine included. The cron runs 48 times a
day regardless of traffic.

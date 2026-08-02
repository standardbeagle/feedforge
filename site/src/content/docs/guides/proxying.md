---
title: Proxying feeds
description: Register origin feeds, serve them from the edge, and map custom domains.
---

A proxied feed is an origin URL that feedforge polls, normalizes, and re-serves
from a stable URL on your worker domain.

## Managing feeds with the CLI

The `feeds` CLI wraps wrangler and edits the registry in KV:

```bash
npm run feeds -- add myblog https://example.com/rss.xml
npm run feeds -- list
npm run feeds -- remove myblog
```

`add` fetches the origin and parses it before writing, so typos and dead URLs
fail at registration time instead of at poll time.

## Serving

| Request | Response |
| --- | --- |
| Feed reader → `/<name>` | Normalized RSS 2.0, `application/rss+xml` |
| `/<name>?format=atom` | Atom 1.0, `application/atom+xml` |
| Browser → `/<name>` | HTML landing page with subscribe call-to-action |

Polls honor `ETag` and `Last-Modified`, so unchanged feeds cost a single 304.
Served XML carries `Cache-Control: public, max-age=<poll interval>`.

## Failure behavior

When the origin errors or returns something unparseable, feedforge keeps serving
the last good copy and sets an `X-Feed-Stale: true` header. The browser view
shows the warning; `feeds list` shows the error count and message. A broken
origin with no stored copy returns 502.

## Custom domains (MyBrand)

Map your own hostname to a feed:

```bash
npm run feeds -- map-domain feeds.example.org myblog
```

The CLI prints the `[[routes]]` block to add to `wrangler.toml`. Redeploy, and
`https://feeds.example.org/` serves the feed directly.

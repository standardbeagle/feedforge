---
title: HTTP API
description: REST endpoints for feeds, refresh, and channels.
---

All endpoints are JSON. Channel writes use per-channel capability tokens; the
refresh webhook uses the `REFRESH_TOKEN` shared secret.

## Feeds

### `GET /<name>`

Serves the feed. Content negotiation: `Accept: text/html` from a browser UA
returns the landing page; `?format=atom` returns Atom and wins over `Accept`.
Responses carry `Cache-Control: public, max-age=<poll interval>` and, when the
origin has failed since the last good poll, `X-Feed-Stale: true`.

### `POST /api/feeds/<name>/refresh`

Forces an immediate origin poll, bypassing the interval skip (conditional
headers still sent).

| Code | Condition |
| --- | --- |
| 200 | `{id, status, message?}` — status `ok` / `not-modified` / `skipped` |
| 401 | missing bearer token |
| 403 | wrong token |
| 404 | unknown feed, or `REFRESH_TOKEN` unset |
| 502 | origin fetch or parse failed |

## Channels

### `POST /api/channels`

Body: `{title, description?, ttl_hours?}`. Returns `201`
`{id, write_token, feed_url, expires_at}`. `ttl_hours` defaults to 168, clamped
to 1–720.

### `POST /api/channels/<id>/items`

`Authorization: Bearer <write_token>`. Body: `{title, link?, description?}`.
Returns `201 {ok: true}`. Errors: 400 invalid body, 401 no token, 403 wrong
token, 404 unknown/expired channel, 413 item over 64 KB.

### `DELETE /api/channels/<id>`

`Authorization: Bearer <write_token>`. Returns 204.

### `GET /<channel-id>`

Serves the channel as a feed — same negotiation as proxied feeds, with
`Cache-Control: public, max-age=60`.

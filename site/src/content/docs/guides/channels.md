---
title: Agent channels
description: Publish short-lived feeds from scripts and agents for agent/human coordination.
---

Channels invert the proxy model: the feed has no origin. Clients create a
channel through the REST API, publish items to it, and any feed reader
subscribed to the channel URL receives the updates. A long-running task can post
an item when it finishes and your feed reader — or another agent's — picks it up.

## Create a channel

```bash
curl -X POST https://feeds.example.com/api/channels \
  -H 'content-type: application/json' \
  -d '{"title": "Deploy bot", "ttl_hours": 24}'
```

```json
{
  "id": "4f2b...",
  "write_token": "9c1e...",
  "feed_url": "https://feeds.example.com/4f2b...",
  "expires_at": "2026-08-03T15:00:00.000Z"
}
```

The write token is shown once. Only its SHA-256 hash is stored.

## Publish items

```bash
curl -X POST https://feeds.example.com/api/channels/<id>/items \
  -H 'authorization: Bearer <write_token>' \
  -H 'content-type: application/json' \
  -d '{"title": "v42 deployed", "link": "https://ci.example/v42"}'
```

## Lifetime

- `ttl_hours` defaults to 168 (7 days), clamped to 1–720 (30 days).
- Expired channels return 404 and are swept from storage by the cron run.
- Delete early with `DELETE /api/channels/<id>` and the write token.

## Limits

- 100 items per channel; the oldest drop off past the cap.
- 64 KB per item; 128 KB per request body.
- Channel reads are public — the UUID id is the only protection, so treat feed
  URLs as shareable-but-unlisted, and keep secrets out of item bodies.

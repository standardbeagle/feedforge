---
title: Refresh webhook
description: Let hosts trigger an immediate feed refresh instead of waiting for the cron interval.
---

Static generators and CMSs can ping feedforge the moment they publish, the same
role FeedBurner's old PING interface played.

## Setup

```bash
npx wrangler secret put REFRESH_TOKEN
```

If `REFRESH_TOKEN` is unset, the route returns 404 — the webhook is off until
you choose a secret.

## Ping

```bash
curl -X POST https://feeds.example.com/api/feeds/myblog/refresh \
  -H 'authorization: Bearer <REFRESH_TOKEN>'
```

```json
{ "id": "myblog", "status": "ok" }
```

The refresh bypasses the poll-interval skip but still sends conditional headers,
so pinging when nothing changed costs one 304 against your origin.

## Status codes

| Code | Meaning |
| --- | --- |
| 200 | Poll ran; `status` is `ok`, `not-modified`, or `skipped` |
| 401 | Missing `Authorization: Bearer` header |
| 403 | Wrong token |
| 404 | Unknown feed id, or `REFRESH_TOKEN` unset |
| 502 | Origin fetch or parse failed |

## Wiring it into a build

GitHub Actions example, after your site deploys:

```yaml
- name: Ping feedforge
  run: |
    curl -fsS -X POST https://feeds.example.com/api/feeds/myblog/refresh \
      -H "authorization: Bearer ${{ secrets.FEEDFORGE_REFRESH_TOKEN }}"
```

---
title: Analytics
description: Subscriber estimates and daily reach via Cloudflare Analytics Engine.
---

Every feed request writes one datapoint to the `feedforge` Analytics Engine
dataset:

| Field | Content |
| --- | --- |
| `blob1` | feed id |
| `blob2` | UA class: `aggregator`, `browser`, or `other` |
| `blob3` | daily reader hash |
| `double1` | subscriber count reported in the UA string |

## Subscriber estimation

FeedBurner estimated subscribers from aggregator self-reporting plus unique
client signatures; feedforge does the same. Many readers send a UA like
`FreshRSS/1.24 ... 42 subscribers` — that count lands in `double1`. The reader
hash is `SHA-256(ip | user-agent | UTC day)` truncated to 16 hex chars, so it
counts daily unique readers without tracking anyone across days.

## Querying

Analytics Engine data is queried through the Cloudflare GraphQL API:

```sql
SELECT blob1 AS feed, count() AS requests, sum(double1) AS reported_subscribers
FROM feedforge
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY feed
```

Daily unique subscribers ≈ count of distinct `blob3` per feed per day.

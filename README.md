# feedforge

Open-source FeedBurner clone on Cloudflare's free tier: feed proxying/normalization,
aggregate analytics, browser-friendly feed pages, and custom-domain (MyBrand) hosting.

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

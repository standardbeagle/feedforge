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

## Architecture

Cron (`scheduled`) polls origins with conditional GET, normalizes RSS2/Atom/RDF to
valid RSS 2.0, stores in KV. `fetch` resolves feed id from hostname (MyBrand map) or
path, records an Analytics Engine datapoint, serves XML or the HTML landing page.
Origin failures keep serving the last good copy with an `X-Feed-Stale` header.

## License

MIT

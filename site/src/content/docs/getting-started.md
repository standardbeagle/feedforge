---
title: Getting started
description: Deploy your own feedforge instance on Cloudflare Workers in five steps.
---

You need a Cloudflare account (the free plan works) and Node.js 22+.

## 1. Clone and install

```bash
git clone https://github.com/standardbeagle/feedforge.git
cd feedforge
npm install
```

## 2. Create the KV namespace

```bash
npx wrangler kv namespace create FEEDS
```

Wrangler prints an `id`. Put it in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "FEEDS"
id = "<the id wrangler printed>"
```

## 3. Set your route

Add a custom domain or route in `wrangler.toml` so the worker answers on your
hostname:

```toml
[[routes]]
custom_domain = "feeds.example.com"
```

## 4. Deploy

```bash
npm run deploy
```

## 5. Register your first feed

```bash
npm run feeds -- add myblog https://example.com/rss.xml
```

The CLI fetches the origin once to confirm it parses, then writes the registry.
The cron trigger polls every 30 minutes; the first subscriber request also
triggers an immediate poll, so the feed works right away:

```
https://feeds.example.com/myblog
```

Open that URL in a browser and you get the landing page; point a feed reader at
it and you get RSS 2.0.

## Verify

```bash
npm run feeds -- list
```

Shows each registered feed with its last fetch status and error count.

---
title: feedforge
description: Open-source FeedBurner replacement on Cloudflare Workers — feed proxying, analytics, Podcasting 2.0, and agent-coordination channels.
---

feedforge is an open-source [FeedBurner](https://en.wikipedia.org/wiki/FeedBurner)
replacement that runs on Cloudflare's free tier. Point it at your RSS, Atom, or RDF
feed and it gives you a stable feed URL served from Cloudflare's edge. Your origin
sees one conditional GET per poll interval instead of one request per subscriber.

It also does what FeedBurner never did: agents can publish short-lived feeds
directly through a REST API, so a long-running task can notify your feed reader
when it finishes.

## What you get

- **Feed proxying** — parses RSS 2.0, Atom, and RDF; repairs malformed XML; emits
  valid RSS 2.0 or Atom (`?format=atom`).
- **Podcasting 2.0** — enclosures, itunes fields, podcast namespace tags, and
  `content:encoded` survive normalization.
- **Analytics** — subscriber estimates and daily reach in Cloudflare Analytics
  Engine, with a privacy-preserving daily-rotating reader hash.
- **Short-lived channels** — capability-token REST API for agent/human
  coordination over RSS.
- **Browser view** — every feed URL doubles as a subscribe-friendly landing page.
- **MyBrand** — map your own domain to a feed.
- **Refresh webhook** — hosts ping, feedforge re-polls immediately.

## Where to go next

- [Getting started](./getting-started/) — deploy your own instance in five steps.
- [Proxying feeds](./guides/proxying/) — register feeds and manage them with the CLI.
- [Agent channels](./guides/channels/) — publish ephemeral feeds from scripts and agents.
- [Architecture](./reference/architecture/) — how the pieces fit together.

## Source

Everything is MIT-licensed at
[github.com/standardbeagle/feedforge](https://github.com/standardbeagle/feedforge).

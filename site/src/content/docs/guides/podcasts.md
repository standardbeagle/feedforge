---
title: Podcasts
description: Podcasting 2.0 and itunes metadata survive feedforge normalization.
---

Podcast feeds work through the same proxying path as any RSS feed — register the
origin with `feeds add` and listeners subscribe to the feedforge URL. The value
is in what survives the round-trip.

## What the normalizer preserves

**Enclosures** — `<enclosure url length type>` at the item level. Audio bytes
are never proxied; enclosure URLs pass through to the listener's client, so your
CDN keeps its own download stats.

**itunes fields** — channel: author, image, summary, owner name/email, explicit,
type, categories (nested categories flatten). Item: duration, image, explicit,
episode, season, episodeType.

**Podcasting 2.0 tags** — channel: guid, locked, medium, person, funding,
location, value/valueRecipient. Item: chapters, transcript, person, episode,
season.

**content:encoded** — full-text HTML bodies.

`xmlns:itunes`, `xmlns:podcast`, and `xmlns:content` are declared on the output
only when the feed actually uses them. Atom output (`?format=atom`) maps
enclosures to `<link rel="enclosure">`.

## Validation

Enum fields are checked on parse and invalid values dropped:

| Field | Accepted |
| --- | --- |
| `itunes:explicit` | yes/no/true/false, normalized to yes/no |
| `itunes:episodeType` | full, trailer, bonus |
| `podcast:medium` | podcast, music, video, film, audiobook, newsletter, blog, publisher, course, mixed, list |

A feed that passes through feedforge stays valid — normalization repairs
malformed XML before it reaches podcatchers.

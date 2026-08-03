import type { FeedDoc } from "./normalize";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface LandingFeed {
  id: string;
  title: string;
}

export function renderLandingPage(host: string, feeds: LandingFeed[]): string {
  const feedItems = feeds
    .map(
      (f) => `<li><a href="/${esc(f.id)}">${esc(f.title)}</a> <code>https://${esc(host)}/${esc(f.id)}</code></li>`,
    )
    .join("\n");
  const feedSection = feeds.length
    ? `<h2>Feeds on this host</h2>\n<ul>\n${feedItems}\n</ul>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>feedforge — open-source FeedBurner on Cloudflare Workers</title>
<meta name="description" content="feedforge proxies your RSS, Atom, or RDF feed to a stable URL on Cloudflare's edge: normalization, Podcasting 2.0 support, subscriber analytics, and short-lived channels for agent/human coordination.">
<link rel="canonical" href="https://${esc(host)}/">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="feedforge — open-source FeedBurner on Cloudflare Workers">
<meta property="og:description" content="Stable feed URLs served from Cloudflare's edge. Feed proxying, Podcasting 2.0, analytics, and agent-coordination channels.">
<meta property="og:url" content="https://${esc(host)}/">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "feedforge",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Cloudflare Workers",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "url": "https://github.com/standardbeagle/feedforge",
  "description": "Open-source FeedBurner replacement on Cloudflare Workers: feed proxying and normalization, Podcasting 2.0, subscriber analytics, and short-lived agent-coordination channels."
}
</script>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  h1 { margin-bottom: 0; }
  .tag { color: #555; margin-top: .25rem; }
  code { background: #f4f4f4; padding: .1em .3em; border-radius: 4px; word-break: break-all; }
  ul { padding-left: 1.25rem; }
  nav { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #ddd; color: #555; font-size: .95em; }
</style>
</head>
<body>
<h1>feedforge</h1>
<p class="tag">Open-source FeedBurner on Cloudflare Workers.</p>
<p>Point feedforge at your RSS, Atom, or RDF feed and it serves a stable feed URL
from Cloudflare's edge. Your origin sees one conditional GET per poll interval
instead of one request per subscriber. Agents can also publish short-lived feeds
directly through a REST API, so a long-running task can notify your feed reader
when it finishes.</p>
<ul>
  <li>Feed proxying — RSS 2.0, Atom, and RDF parsed, repaired, and re-emitted as valid RSS 2.0 or Atom</li>
  <li>Podcasting 2.0 — enclosures, itunes fields, and podcast namespace tags survive normalization</li>
  <li>Analytics — subscriber estimates and daily reach with a privacy-preserving reader hash</li>
  <li>Short-lived channels — capability-token REST API for agent/human coordination</li>
  <li>Browser view — every feed URL doubles as a subscribe-friendly landing page</li>
</ul>
${feedSection}
<nav>
  <a href="https://dev.standardbeagle.com/feedforge/">Docs</a> ·
  <a href="https://github.com/standardbeagle/feedforge">GitHub</a> · MIT licensed
</nav>
</body>
</html>`;
}

export function renderFeedPage(doc: FeedDoc, feedUrl: string, stale: string | null): string {
  const safeHref = (u: string) => (/^https?:\/\//i.test(u) ? esc(u) : "#");
  const items = doc.items
    .slice(0, 25)
    .map(
      (i) => `<li><a href="${safeHref(i.link)}">${esc(i.title)}</a>${
        i.pubDate ? ` <time>${esc(i.pubDate)}</time>` : ""
      }</li>`,
    )
    .join("\n");

  const warning = stale
    ? `<p class="stale">This feed is stale — the origin could not be fetched (${esc(stale)}). Showing the last good copy.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)} — feed</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  .subscribe { background: #f4f4f4; border: 1px solid #ddd; border-radius: 8px; padding: 1rem; }
  .subscribe code { word-break: break-all; }
  .stale { background: #fff3cd; border: 1px solid #ffe69c; border-radius: 8px; padding: .75rem; }
  time { color: #666; font-size: .85em; }
</style>
</head>
<body>
<h1>${esc(doc.title)}</h1>
<p>${esc(doc.description)}</p>
${warning}
<div class="subscribe">
  <p>This is an RSS feed. Subscribe by copying this URL into your feed reader:</p>
  <code>${esc(feedUrl)}</code>
</div>
<h2>Recent items</h2>
<ul>
${items}
</ul>
</body>
</html>`;
}

import type { FeedDoc } from "./normalize";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

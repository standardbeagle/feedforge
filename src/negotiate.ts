import { classifyUa } from "./analytics";

export type Format = "rss" | "atom" | "html";

const FEED_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/rdf+xml",
  "application/xml",
  "text/xml",
];

/** Highest q-value the Accept header assigns to any of `types`, ignoring wildcards. */
function quality(accept: string, types: string[]): number {
  let best = 0;
  for (const part of accept.split(",")) {
    const [rawType, ...params] = part.trim().split(";");
    const type = rawType.trim().toLowerCase();
    if (!types.includes(type)) continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam ? parseFloat(qParam.slice(2)) : 1;
    if (Number.isFinite(q) && q > best) best = q;
  }
  return best;
}

/**
 * Pick the representation to serve. A feed is the default: HTML is only chosen
 * when the client explicitly prefers text/html over every feed type (a browser),
 * and never for a known aggregator. `?format=` always wins.
 */
export function chooseFormat(url: URL, accept: string, ua: string): Format {
  const explicit = url.searchParams.get("format");
  if (explicit === "atom") return "atom";
  if (explicit === "rss" || explicit === "xml") return "rss";
  if (explicit === "html") return "html";

  if (classifyUa(ua).kind === "aggregator") return "rss";

  const htmlQ = quality(accept, ["text/html", "application/xhtml+xml"]);
  const feedQ = quality(accept, FEED_TYPES);
  return htmlQ > feedQ ? "html" : "rss";
}

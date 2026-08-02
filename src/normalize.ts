import { XMLParser, XMLBuilder } from "fast-xml-parser";

export interface FeedItem {
  title: string;
  link: string;
  guid: string;
  pubDate?: string;
  description?: string;
}

export interface FeedDoc {
  title: string;
  link: string;
  description: string;
  items: FeedItem[];
}

export class FeedParseError extends Error {}

const parserOpts = { ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false };

export function sanitizeXml(raw: string): string {
  return raw.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return String(o["#text"] ?? "");
  }
  return String(v);
}

function atomLink(v: unknown): string {
  for (const l of asArray(v as object | object[])) {
    const o = l as Record<string, unknown>;
    if (o["@_rel"] === undefined || o["@_rel"] === "alternate") {
      return String(o["@_href"] ?? text(l));
    }
  }
  return "";
}

export function parseFeed(raw: string): FeedDoc {
  let doc: Record<string, any>;
  try {
    doc = new XMLParser(parserOpts).parse(sanitizeXml(raw));
  } catch (e) {
    throw new FeedParseError(`XML parse failed: ${(e as Error).message}`);
  }

  const channel = doc.rss?.channel ?? doc["rdf:RDF"]?.channel;
  if (channel) {
    const rawItems = asArray<any>(channel.item ?? doc["rdf:RDF"]?.item);
    return {
      title: text(channel.title),
      link: text(channel.link),
      description: text(channel.description),
      items: rawItems.map((i) => ({
        title: text(i.title),
        link: text(i.link),
        guid: text(i.guid ?? i.link),
        pubDate: text(i.pubDate ?? i["dc:date"]) || undefined,
        description: text(i.description) || undefined,
      })),
    };
  }

  if (doc.feed) {
    const f = doc.feed;
    return {
      title: text(f.title),
      link: atomLink(f.link),
      description: text(f.subtitle),
      items: asArray<any>(f.entry).map((e) => ({
        title: text(e.title),
        link: atomLink(e.link),
        guid: text(e.id) || atomLink(e.link),
        pubDate: text(e.published ?? e.updated) || undefined,
        description: text(e.summary ?? e.content) || undefined,
      })),
    };
  }

  throw new FeedParseError("Document is not RSS or Atom");
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  suppressBooleanAttributes: false,
});

const XML_DECL = `<?xml version="1.0" encoding="UTF-8"?>\n`;

export function buildRss(doc: FeedDoc): string {
  const channel: Record<string, unknown> = {
    title: doc.title,
    link: doc.link,
    description: doc.description,
    item: doc.items.map((i) => {
      const item: Record<string, string> = {
        title: i.title,
        link: i.link,
        guid: i.guid,
      };
      if (i.pubDate) item.pubDate = i.pubDate;
      if (i.description) item.description = i.description;
      return item;
    }),
  };
  return XML_DECL + builder.build({ rss: { "@_version": "2.0", channel } });
}

export function buildAtom(doc: FeedDoc): string {
  const updated = doc.items[0]?.pubDate ?? new Date(0).toISOString();
  return XML_DECL + builder.build({
    feed: {
      "@_xmlns": "http://www.w3.org/2005/Atom",
      title: doc.title,
      link: { "@_href": doc.link },
      id: doc.link,
      updated,
      entry: doc.items.map((i) => ({
        title: i.title,
        link: { "@_href": i.link },
        id: i.guid,
        updated: i.pubDate ?? updated,
        summary: i.description ?? "",
      })),
    },
  });
}

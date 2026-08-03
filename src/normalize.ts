import { XMLParser, XMLBuilder } from "fast-xml-parser";
import type {
  Enclosure,
  ItunesChannel,
  ItunesItem,
  PodcastChannelMeta,
  PodcastItemMeta,
  PodcastPerson,
} from "./podcast";

export interface FeedItem {
  title: string;
  link: string;
  guid: string;
  pubDate?: string;
  description?: string;
  enclosure?: Enclosure;
  itunes?: ItunesItem;
  podcast?: PodcastItemMeta;
  content_encoded?: string;
}

export interface FeedDoc {
  title: string;
  link: string;
  description: string;
  items: FeedItem[];
  itunes?: ItunesChannel;
  podcast?: PodcastChannelMeta;
}

export class FeedParseError extends Error {}

const parserOpts = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  processEntities: { maxTotalExpansions: 20_000 },
};

export function sanitizeXml(raw: string): string {
  return raw
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) =>
      part.startsWith("<![CDATA[")
        ? part
        : part.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;"),
    )
    .join("");
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

function atomEnclosure(v: unknown): Enclosure | undefined {
  for (const l of asArray(v as object | object[])) {
    const o = l as Record<string, unknown>;
    if (o["@_rel"] === "enclosure") {
      const url = attr(o, "href");
      if (!url) return undefined;
      return compact({ url, length: intOr(attr(o, "length")), type: attr(o, "type") });
    }
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return text(v) || undefined;
}

function attr(o: unknown, name: string): string | undefined {
  if (o === null || typeof o !== "object") return undefined;
  const v = (o as Record<string, unknown>)["@_" + name];
  return v === undefined ? undefined : String(v);
}

function yesNo(v: unknown): "yes" | "no" | undefined {
  const s = text(v).toLowerCase();
  if (s === "yes" || s === "true") return "yes";
  if (s === "no" || s === "false") return "no";
  return undefined;
}

function intOr(v: unknown): number | undefined {
  const n = parseInt(text(v), 10);
  return Number.isNaN(n) ? undefined : n;
}

function compact<T extends Record<string, unknown>>(o: T): T | undefined {
  return Object.values(o).every((v) => v === undefined) ? undefined : o;
}

const EPISODE_TYPES = new Set(["full", "trailer", "bonus"]);
const PODCAST_MEDIUMS = new Set([
  "podcast",
  "music",
  "video",
  "film",
  "audiobook",
  "newsletter",
  "blog",
  "publisher",
  "course",
  "mixed",
  "list",
]);

function collectCategories(v: unknown): string[] {
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes) {
      const t = attr(n, "text");
      if (t) out.push(t);
      if (n !== null && typeof n === "object") {
        walk(asArray((n as Record<string, unknown>)["itunes:category"]));
      }
    }
  };
  walk(asArray(v));
  return out;
}

function parsePersons(v: unknown): PodcastPerson[] | undefined {
  const persons: PodcastPerson[] = [];
  for (const p of asArray(v)) {
    const name = text(p);
    if (!name) continue;
    const person: PodcastPerson = { name };
    const role = attr(p, "role");
    if (role) person.role = role;
    const group = attr(p, "group");
    if (group) person.group = group;
    const img = attr(p, "img");
    if (img) person.img = img;
    const href = attr(p, "href");
    if (href) person.href = href;
    persons.push(person);
  }
  return persons.length ? persons : undefined;
}

function hasPrefixed(o: Record<string, any>, prefix: string): boolean {
  return Object.keys(o).some((k) => k.startsWith(prefix));
}

function parseItunesChannel(c: Record<string, any>): ItunesChannel | undefined {
  if (!hasPrefixed(c, "itunes:")) return undefined;
  const itunes: ItunesChannel = {
    author: str(c["itunes:author"]),
    image: attr(c["itunes:image"], "href"),
    summary: str(c["itunes:summary"]),
    ownerName: str(c["itunes:owner"]?.["itunes:name"]),
    ownerEmail: str(c["itunes:owner"]?.["itunes:email"]),
    explicit: yesNo(c["itunes:explicit"]),
    type: (["episodic", "serial"] as const).find((t) => t === text(c["itunes:type"])),
  };
  const categories = collectCategories(c["itunes:category"]);
  if (categories.length) itunes.categories = categories;
  return itunes;
}

function parseItunesItem(i: Record<string, any>): ItunesItem | undefined {
  if (!hasPrefixed(i, "itunes:")) return undefined;
  const episodeType = text(i["itunes:episodeType"]);
  return {
    duration: str(i["itunes:duration"]),
    image: attr(i["itunes:image"], "href"),
    explicit: yesNo(i["itunes:explicit"]),
    episode: intOr(i["itunes:episode"]),
    season: intOr(i["itunes:season"]),
    episodeType: EPISODE_TYPES.has(episodeType)
      ? (episodeType as ItunesItem["episodeType"])
      : undefined,
  };
}

function parsePodcastChannel(c: Record<string, any>): PodcastChannelMeta | undefined {
  if (!hasPrefixed(c, "podcast:")) return undefined;
  const medium = text(c["podcast:medium"]);
  const loc = c["podcast:location"];
  const locName = str(loc);
  const podcast: PodcastChannelMeta = {
    guid: str(c["podcast:guid"]),
    locked: yesNo(c["podcast:locked"]),
    lockedOwner: attr(c["podcast:locked"], "owner"),
    medium: PODCAST_MEDIUMS.has(medium) ? medium : undefined,
    persons: parsePersons(c["podcast:person"]),
    funding: asArray(c["podcast:funding"])
      .map((f): { url: string; message?: string } | undefined => {
        const url = attr(f, "url");
        if (!url) return undefined;
        return compact({ url, message: str(f) });
      })
      .filter((f) => f !== undefined),
    location: loc && locName ? { name: locName, geo: attr(loc, "geo"), osm: attr(loc, "osm") } : undefined,
    value: parsePodcastValue(c["podcast:value"]),
  };
  if (podcast.funding!.length === 0) podcast.funding = undefined;
  return podcast;
}

function parsePodcastValue(v: unknown): PodcastChannelMeta["value"] {
  if (v === null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const type = attr(o, "type");
  const method = attr(o, "method");
  if (!type || !method) return undefined;
  const recipients = asArray(o["podcast:valueRecipient"])
    .map((r) => {
      const address = attr(r, "address");
      const rtype = attr(r, "type");
      const split = intOr(attr(r, "split"));
      if (!address || !rtype || split === undefined) return undefined;
      return compact({
        name: attr(r, "name"),
        address,
        type: rtype,
        split,
        fee: attr(r, "fee") === "true" ? true : undefined,
      });
    })
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const suggestedRaw = attr(o, "suggested");
  const suggested = suggestedRaw === undefined ? undefined : parseFloat(suggestedRaw);
  return {
    type,
    method,
    suggested: suggested !== undefined && Number.isNaN(suggested) ? undefined : suggested,
    recipients,
  };
}

function parsePodcastItem(i: Record<string, any>): PodcastItemMeta | undefined {
  if (!hasPrefixed(i, "podcast:")) return undefined;
  const podcast: PodcastItemMeta = {
    chaptersUrl: attr(i["podcast:chapters"], "url"),
    transcripts: asArray(i["podcast:transcript"])
      .map((t) => {
        const url = attr(t, "url");
        const type = attr(t, "type");
        if (!url || !type) return undefined;
        return compact({ url, type, language: attr(t, "language"), rel: attr(t, "rel") });
      })
      .filter((t): t is NonNullable<typeof t> => t !== undefined),
    persons: parsePersons(i["podcast:person"]),
    episode: intOr(i["podcast:episode"]),
    season: intOr(i["podcast:season"]),
  };
  if (podcast.transcripts!.length === 0) podcast.transcripts = undefined;
  return podcast;
}

function parseEnclosure(v: unknown): Enclosure | undefined {
  const url = attr(v, "url");
  if (!url) return undefined;
  const enclosure: Enclosure = { url };
  const length = intOr(attr(v, "length"));
  if (length !== undefined) enclosure.length = length;
  const type = attr(v, "type");
  if (type) enclosure.type = type;
  return enclosure;
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
        enclosure: parseEnclosure(i.enclosure),
        itunes: parseItunesItem(i),
        podcast: parsePodcastItem(i),
        content_encoded: str(i["content:encoded"]),
      })),
      itunes: parseItunesChannel(channel),
      podcast: parsePodcastChannel(channel),
    };
  }

  if (doc.feed) {
    const f = doc.feed;
    return {
      title: text(f.title),
      link: atomLink(f.link),
      description: text(f.subtitle),
      items: asArray<any>(f.entry).map((e) => {
        const link = atomLink(e.link);
        return {
          title: text(e.title),
          link,
          guid: text(e.id) || link,
          pubDate: text(e.published ?? e.updated) || undefined,
          description: text(e.summary ?? e.content) || undefined,
          enclosure: atomEnclosure(e.link),
        };
      }),
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

function entry(o: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) o[key] = value;
}

function itunesChannelXml(t: ItunesChannel): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  entry(o, "itunes:author", t.author);
  if (t.image !== undefined) o["itunes:image"] = { "@_href": t.image };
  entry(o, "itunes:summary", t.summary);
  if (t.ownerName !== undefined || t.ownerEmail !== undefined) {
    const owner: Record<string, unknown> = {};
    entry(owner, "itunes:name", t.ownerName);
    entry(owner, "itunes:email", t.ownerEmail);
    o["itunes:owner"] = owner;
  }
  entry(o, "itunes:explicit", t.explicit);
  entry(o, "itunes:type", t.type);
  if (t.categories?.length) {
    o["itunes:category"] = t.categories.map((c) => ({ "@_text": c }));
  }
  return o;
}

function itunesItemXml(t: ItunesItem): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  entry(o, "itunes:duration", t.duration);
  if (t.image !== undefined) o["itunes:image"] = { "@_href": t.image };
  entry(o, "itunes:explicit", t.explicit);
  entry(o, "itunes:episode", t.episode);
  entry(o, "itunes:season", t.season);
  entry(o, "itunes:episodeType", t.episodeType);
  return o;
}

function personXml(p: PodcastPerson): Record<string, unknown> {
  const o: Record<string, unknown> = { "#text": p.name };
  entry(o, "@_role", p.role);
  entry(o, "@_group", p.group);
  entry(o, "@_img", p.img);
  entry(o, "@_href", p.href);
  return o;
}

function podcastChannelXml(p: PodcastChannelMeta): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  entry(o, "podcast:guid", p.guid);
  if (p.locked !== undefined) {
    const locked: Record<string, unknown> = { "#text": p.locked };
    entry(locked, "@_owner", p.lockedOwner);
    o["podcast:locked"] = locked;
  }
  entry(o, "podcast:medium", p.medium);
  if (p.persons?.length) o["podcast:person"] = p.persons.map(personXml);
  if (p.funding?.length) {
    o["podcast:funding"] = p.funding.map((f) => {
      const x: Record<string, unknown> = { "@_url": f.url };
      entry(x, "#text", f.message);
      return x;
    });
  }
  if (p.location !== undefined) {
    const loc: Record<string, unknown> = { "#text": p.location.name };
    entry(loc, "@_geo", p.location.geo);
    entry(loc, "@_osm", p.location.osm);
    o["podcast:location"] = loc;
  }
  if (p.value !== undefined) {
    const value: Record<string, unknown> = {
      "@_type": p.value.type,
      "@_method": p.value.method,
    };
    entry(value, "@_suggested", p.value.suggested);
    value["podcast:valueRecipient"] = p.value.recipients.map((r) => {
      const x: Record<string, unknown> = {
        "@_address": r.address,
        "@_type": r.type,
        "@_split": r.split,
      };
      entry(x, "@_name", r.name);
      entry(x, "@_fee", r.fee ? "true" : undefined);
      return x;
    });
    o["podcast:value"] = value;
  }
  return o;
}

function podcastItemXml(p: PodcastItemMeta): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (p.chaptersUrl !== undefined) o["podcast:chapters"] = { "@_url": p.chaptersUrl };
  if (p.transcripts?.length) {
    o["podcast:transcript"] = p.transcripts.map((t) => {
      const x: Record<string, unknown> = { "@_url": t.url, "@_type": t.type };
      entry(x, "@_language", t.language);
      entry(x, "@_rel", t.rel);
      return x;
    });
  }
  if (p.persons?.length) o["podcast:person"] = p.persons.map(personXml);
  entry(o, "podcast:episode", p.episode);
  entry(o, "podcast:season", p.season);
  return o;
}

export function buildRss(doc: FeedDoc): string {
  const useItunes = doc.itunes !== undefined || doc.items.some((i) => i.itunes !== undefined);
  const usePodcast = doc.podcast !== undefined || doc.items.some((i) => i.podcast !== undefined);
  const useContent = doc.items.some((i) => i.content_encoded !== undefined);
  const channel: Record<string, unknown> = {
    title: doc.title,
    link: doc.link,
    description: doc.description,
    ...(doc.itunes ? itunesChannelXml(doc.itunes) : {}),
    ...(doc.podcast ? podcastChannelXml(doc.podcast) : {}),
    item: doc.items.map((i) => {
      const item: Record<string, unknown> = {
        title: i.title,
        link: i.link,
        guid: i.guid,
      };
      entry(item, "pubDate", i.pubDate);
      entry(item, "description", i.description);
      if (i.enclosure) {
        const enc: Record<string, unknown> = { "@_url": i.enclosure.url };
        entry(enc, "@_length", i.enclosure.length);
        entry(enc, "@_type", i.enclosure.type);
        item.enclosure = enc;
      }
      entry(item, "content:encoded", i.content_encoded);
      Object.assign(
        item,
        i.itunes ? itunesItemXml(i.itunes) : {},
        i.podcast ? podcastItemXml(i.podcast) : {},
      );
      return item;
    }),
  };
  const rss: Record<string, unknown> = { "@_version": "2.0" };
  if (useItunes) rss["@_xmlns:itunes"] = "http://www.itunes.com/dtds/podcast-1.0.dtd";
  if (usePodcast) rss["@_xmlns:podcast"] = "https://podcastindex.org/namespace/1.0";
  if (useContent) rss["@_xmlns:content"] = "http://purl.org/rss/1.0/modules/content/";
  rss.channel = channel;
  return XML_DECL + builder.build({ rss });
}

export function rfc3339(date: string): string {
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? date : new Date(ms).toISOString();
}

export function buildAtom(doc: FeedDoc): string {
  const updated = rfc3339(doc.items[0]?.pubDate ?? new Date(0).toISOString());
  return XML_DECL + builder.build({
    feed: {
      "@_xmlns": "http://www.w3.org/2005/Atom",
      title: doc.title,
      subtitle: doc.description,
      link: { "@_href": doc.link },
      id: doc.link,
      updated,
      entry: doc.items.map((i) => {
        const links: Record<string, unknown>[] = [{ "@_href": i.link }];
        if (i.enclosure) {
          const enc: Record<string, unknown> = {
            "@_rel": "enclosure",
            "@_href": i.enclosure.url,
          };
          entry(enc, "@_type", i.enclosure.type);
          entry(enc, "@_length", i.enclosure.length);
          links.push(enc);
        }
        return {
          title: i.title,
          link: links,
          id: i.guid,
          updated: i.pubDate ? rfc3339(i.pubDate) : updated,
          summary: i.description ?? "",
        };
      }),
    },
  });
}

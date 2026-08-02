const AGGREGATOR_PATTERNS = [
  /freshrss/i, /miniflux/i, /inoreader/i, /feedly/i, /newsblur/i,
  /tiny tiny rss/i, /tt-rss/i, /feedparser/i, /netnewswire/i,
  /reeder/i, /feedbin/i, /akregator/i, /liferea/i, /rssguard/i,
  /flipboard/i, /feed validator/i,
];

export function classifyUa(ua: string): { kind: "aggregator" | "browser" | "other"; subscribers: number } {
  const m = ua.match(/(\d+)\s+subscribers/i);
  const subscribers = m ? parseInt(m[1], 10) : 0;
  if (AGGREGATOR_PATTERNS.some((p) => p.test(ua)) || m) {
    return { kind: "aggregator", subscribers };
  }
  if (/mozilla\/|chrome\/|safari\/|firefox\/|edge\//i.test(ua)) {
    return { kind: "browser", subscribers: 0 };
  }
  return { kind: "other", subscribers: 0 };
}

async function dailyHash(ip: string, ua: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${ip}|${ua}|${day}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export async function recordRequest(env: Env, feedId: string, request: Request): Promise<void> {
  const ua = request.headers.get("user-agent") ?? "";
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const { kind, subscribers } = classifyUa(ua);
  const hash = await dailyHash(ip, ua);
  env.ANALYTICS.writeDataPoint({
    blobs: [feedId, kind, hash],
    doubles: [subscribers],
    indexes: [feedId],
  });
}

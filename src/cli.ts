#!/usr/bin/env tsx
import { parseFeed } from "./normalize";
import type { Registry } from "./registry";

export function addFeed(reg: Registry, id: string, origin: string): Registry {
  if (reg.feeds.some((f) => f.id === id)) throw new Error(`feed '${id}' already exists`);
  return {
    ...reg,
    feeds: [...reg.feeds, { id, origin, poll_minutes: 30, created_at: new Date().toISOString() }],
  };
}

export function removeFeed(reg: Registry, id: string): Registry {
  return {
    feeds: reg.feeds.filter((f) => f.id !== id),
    domains: Object.fromEntries(Object.entries(reg.domains).filter(([, v]) => v !== id)),
  };
}

export function mapDomain(reg: Registry, hostname: string, id: string): Registry {
  if (!reg.feeds.some((f) => f.id === id)) throw new Error(`no feed with id '${id}'`);
  return { ...reg, domains: { ...reg.domains, [hostname]: id } };
}

export function isNotFoundError(msg: string): boolean {
  return /not (found|exist)|does not exist|10007/i.test(msg);
}

let cachedNamespaceId: string | null = null;

async function kvNamespaceId(): Promise<string> {
  if (cachedNamespaceId) return cachedNamespaceId;
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const m = toml.match(/kv_namespaces[\s\S]*?id\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no kv namespace id in wrangler.toml");
  cachedNamespaceId = m[1];
  return cachedNamespaceId;
}

async function kvGet(key: string): Promise<string | null> {
  const { execFileSync } = await import("node:child_process");
  try {
    const out = execFileSync(
      "npx", ["wrangler", "kv", "key", "get", key, "--namespace-id", await kvNamespaceId(), "--remote"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.trim() || null;
  } catch (e) {
    const msg = String((e as { stderr?: unknown })?.stderr ?? (e as Error).message ?? e);
    if (isNotFoundError(msg)) return null;
    throw new Error(`wrangler kv get '${key}' failed: ${msg}`);
  }
}

async function kvPut(key: string, value: string): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    "npx", ["wrangler", "kv", "key", "put", key, value, "--namespace-id", await kvNamespaceId(), "--remote"],
    { stdio: "inherit" },
  );
}

async function getRegistry(): Promise<Registry> {
  const raw = await kvGet("feeds.json");
  return raw ? JSON.parse(raw) : { feeds: [], domains: {} };
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  const reg = await getRegistry();

  switch (cmd) {
    case "add": {
      const [id, origin] = args;
      if (!id || !origin) throw new Error("usage: feeds add <name> <origin-url>");
      const res = await fetch(origin, { headers: { "user-agent": "feedforge-cli/0.1" } });
      if (!res.ok) throw new Error(`origin returned HTTP ${res.status}`);
      parseFeed(await res.text());
      await kvPut("feeds.json", JSON.stringify(addFeed(reg, id, origin)));
      console.log(`added '${id}'. It will be polled on the next cron run.`);
      break;
    }
    case "remove": {
      const [id] = args;
      if (!id) throw new Error("usage: feeds remove <name>");
      await kvPut("feeds.json", JSON.stringify(removeFeed(reg, id)));
      console.log(`removed '${id}'`);
      break;
    }
    case "list": {
      for (const f of reg.feeds) {
        const raw = await kvGet(`feed:${f.id}`);
        const meta = raw ? JSON.parse(raw).meta : null;
        const status = meta
          ? meta.error_count > 0
            ? `ERROR(${meta.error_count}): ${meta.last_error}`
            : `ok, ${meta.item_count} items, fetched ${meta.last_fetched}`
          : "not yet polled";
        console.log(`${f.id}\t${f.origin}\t${status}`);
      }
      const domains = Object.entries(reg.domains);
      if (domains.length) {
        console.log("\ndomains:");
        for (const [h, id] of domains) console.log(`  ${h} -> ${id}`);
      }
      break;
    }
    case "map-domain": {
      const [hostname, id] = args;
      if (!hostname || !id) throw new Error("usage: feeds map-domain <hostname> <name>");
      await kvPut("feeds.json", JSON.stringify(mapDomain(reg, hostname, id)));
      console.log(`mapped ${hostname} -> ${id}`);
      console.log(`\nAdd this to wrangler.toml and redeploy:\n`);
      console.log(`[[routes]]\ncustom_domain = "${hostname}"`);
      break;
    }
    default:
      console.log("usage: feeds <add|remove|list|map-domain> ...");
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

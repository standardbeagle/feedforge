import { writeFile } from "node:fs/promises";

/**
 * Writes one flat `sitemap.xml` (a <urlset>) instead of the
 * `sitemap-index.xml` + `sitemap-N.xml` pair that @astrojs/sitemap always emits.
 *
 * Named "@astrojs/sitemap" on purpose: Starlight auto-adds the real sitemap
 * integration unless one with that name is already registered.
 */
export default function flatSitemap() {
  let config;
  return {
    name: "@astrojs/sitemap",
    hooks: {
      "astro:config:done": ({ config: doneConfig }) => {
        config = doneConfig;
      },
      "astro:build:done": async ({ dir, pages, logger }) => {
        if (!config.site) throw new Error("sitemap.xml needs `site` in astro.config.mjs");
        const base = config.base.endsWith("/") ? config.base : `${config.base}/`;
        const urls = pages
          .map(({ pathname }) => pathname)
          .filter((pathname) => !/^404\/?$/.test(pathname))
          .map((pathname) => new URL(base + pathname, config.site).href)
          .sort();
        const body = urls.map((url) => `<url><loc>${url}</loc></url>`).join("");
        const xml =
          '<?xml version="1.0" encoding="UTF-8"?>' +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>\n`;
        await writeFile(new URL("sitemap.xml", dir), xml);
        logger.info(`sitemap.xml written with ${urls.length} URLs`);
      },
    },
  };
}

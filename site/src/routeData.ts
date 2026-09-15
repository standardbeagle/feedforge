import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// Starlight hardcodes <link rel="sitemap" href=".../sitemap-index.xml">;
// the site publishes a flat sitemap.xml instead (see sitemap.mjs).
export const onRequest = defineRouteMiddleware((context) => {
  for (const entry of context.locals.starlightRoute.head) {
    if (entry.tag === "link" && entry.attrs?.rel === "sitemap") {
      entry.attrs.href = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/sitemap.xml`;
    }
  }
});

import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://dev.standardbeagle.com",
  base: "/feedforge",
  integrations: [
    sitemap(),
    starlight({
      title: "feedforge",
      description:
        "Open-source FeedBurner replacement on Cloudflare Workers: feed proxying, analytics, Podcasting 2.0, and agent-coordination channels.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/standardbeagle/feedforge",
        },
      ],
      sidebar: [
        { label: "Getting started", slug: "getting-started" },
        {
          label: "Guides",
          items: [
            { label: "Proxying feeds", slug: "guides/proxying" },
            { label: "Refresh webhook", slug: "guides/refresh-webhook" },
            { label: "Podcasts", slug: "guides/podcasts" },
            { label: "Agent channels", slug: "guides/channels" },
            { label: "Analytics", slug: "guides/analytics" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "HTTP API", slug: "reference/api" },
            { label: "Architecture", slug: "reference/architecture" },
          ],
        },
      ],
    }),
  ],
});
